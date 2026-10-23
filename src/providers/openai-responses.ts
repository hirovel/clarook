// OpenAI Responses API 适配器:GPT 系推理内容只在这条协议上可见(摘要),推理正文加密随 opaque 回传。
// 与 chat completions 的差异全部封在这里:消息是 input 项列表、工具定义扁平、system 走 instructions、
// 推理是独立的 reasoning 项(summary 给人看,encrypted_content 必须原样回传且只在同模型族有效)。
// 无状态模式(store: false):服务端不存对话,每次请求都发全部历史,与"事件数组即真相"一致。
import type { StopReason, ToolCall, Usage } from "../events.js";
import type { Message } from "../messages.js";
import {
  type AssistantTurn,
  clampEffort,
  type EffortLevel,
  type FieldTable,
  type Provider,
  type ToolDef,
  type WireOptions,
} from "../provider.js";
import { ProviderError, parseRetryAfter } from "./errors.js";
import { fetchModelIds, linkedAbort, recordedFetch } from "./http.js";
import { mergeRetry, type RetryOptions, withRetry } from "./retry.js";
import { sseEvents, streamError } from "./sse.js";

/** 回传的推理项。id 与 encrypted_content 都原样带回;summary 只是给人看的。 */
export type ReasoningItem = {
  id: string;
  summary: { type: "summary_text"; text: string }[];
  encrypted_content?: string;
};

/** 存进 assistant/message.opaque 的形态。带模型名:推理项只在同模型族内有效。 */
export type OpenAIReasoningOpaque = {
  kind: "openai-reasoning";
  model: string;
  items: ReasoningItem[];
};

export function isOpenAIReasoningOpaque(x: unknown): x is OpenAIReasoningOpaque {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "openai-reasoning" &&
    Array.isArray((x as { items?: unknown }).items)
  );
}

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: { type: string; text: string }[];
  encrypted_content?: string;
  content?: { type: string; text?: string; refusal?: string }[];
};

/** 流式事件的最小类型,只声明用到的字段。 */
export type ResponsesEvent = {
  type: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  refusal?: string;
  item?: OutputItem;
  response?: {
    id?: string;
    model?: string;
    status?: string;
    output?: OutputItem[];
    incomplete_details?: { reason?: string };
    error?: { message?: string; code?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { message?: string; code?: string };
  message?: string;
};

type Item = {
  type: string;
  id: string;
  text: string[];
  callId: string;
  name: string;
  argsJson: string;
  summary: string;
  encrypted?: string;
};

export type ResponsesAcc = {
  items: Map<number, Item>;
  status?: string;
  incompleteReason?: string;
  usage?: Usage;
  error?: string;
  /** 不解释的响应元数据:id、服务模型、status、incomplete_details。 */
  extras: Record<string, unknown>;
};

export function newResponsesAcc(): ResponsesAcc {
  return { items: new Map(), extras: {} };
}

function itemAt(acc: ResponsesAcc, index: number, type = ""): Item {
  let it = acc.items.get(index);
  if (!it) {
    it = { type, id: "", text: [], callId: "", name: "", argsJson: "", summary: "" };
    acc.items.set(index, it);
  }
  if (type && !it.type) it.type = type;
  return it;
}

function setTextPart(it: Item, index: number, text: string): string {
  const before = it.text[index] ?? "";
  it.text[index] = text;
  // 完成快照只补尚未显示的后缀,同一部件的正文不能再次推送。
  return text.startsWith(before) ? text.slice(before.length) : "";
}

function finishItem(acc: ResponsesAcc, index: number, item: OutputItem): string {
  // 完成项以服务器给的为准:参数全文、加密推理、摘要段落与可见正文。
  const it = itemAt(acc, index, item.type);
  if (item.id) it.id = item.id;
  if (item.call_id) it.callId = item.call_id;
  if (item.name) it.name = item.name;
  if (typeof item.arguments === "string") it.argsJson = item.arguments;
  if (item.encrypted_content) it.encrypted = item.encrypted_content;
  if (item.summary) it.summary = item.summary.map((s) => s.text).join("\n\n");
  if (item.type !== "message" || !item.content) return "";
  const delta = item.content
    .map((part, partIndex) =>
      setTextPart(
        it,
        partIndex,
        part.type === "output_text"
          ? (part.text ?? "")
          : part.type === "refusal"
            ? (part.refusal ?? "")
            : "",
      ),
    )
    .join("");
  it.text.length = item.content.length;
  return delta;
}

/** 喂入一个已解析的事件,返回本事件的文本增量。纯函数,不碰网络。 */
export function feedResponsesEvent(acc: ResponsesAcc, ev: ResponsesEvent): string {
  const idx = ev.output_index ?? 0;
  switch (ev.type) {
    case "response.output_item.added": {
      const it = itemAt(acc, idx, ev.item?.type);
      if (ev.item?.id) it.id = ev.item.id;
      if (ev.item?.call_id) it.callId = ev.item.call_id;
      if (ev.item?.name) it.name = ev.item.name;
      return "";
    }
    case "response.output_text.delta":
    case "response.refusal.delta": {
      const it = itemAt(acc, idx, "message");
      const part = ev.content_index ?? 0;
      const delta = ev.delta ?? "";
      it.text[part] = (it.text[part] ?? "") + delta;
      return delta;
    }
    case "response.output_text.done":
    case "response.refusal.done": {
      const it = itemAt(acc, idx, "message");
      return setTextPart(it, ev.content_index ?? 0, ev.refusal ?? ev.text ?? "");
    }
    case "response.reasoning_summary_text.delta": {
      const it = itemAt(acc, idx, "reasoning");
      it.summary += ev.delta ?? "";
      return "";
    }
    case "response.function_call_arguments.delta": {
      const it = itemAt(acc, idx, "function_call");
      it.argsJson += ev.delta ?? "";
      return "";
    }
    case "response.output_item.done":
      return ev.item ? finishItem(acc, idx, ev.item) : "";
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const r = ev.response;
      acc.status = r?.status ?? ev.type.replace("response.", "");
      if (r?.id) acc.extras.id = r.id;
      if (r?.model) acc.extras.model = r.model;
      acc.extras.status = acc.status;
      if (r?.incomplete_details) acc.extras.incomplete_details = r.incomplete_details;
      if (r?.incomplete_details?.reason) acc.incompleteReason = r.incomplete_details.reason;
      if (r?.error?.message) acc.error = `${r.error.code ?? "error"}: ${r.error.message}`;
      // 终止事件不等于成功。缺少错误说明的 failed,以及非输出长度导致的 incomplete,
      // 都不能把此前的工具调用交给循环执行。
      else if (ev.type === "response.failed" || acc.status === "failed")
        acc.error = `${r?.error?.code ?? "response failed"}: no error details provided`;
      else if (
        (ev.type === "response.incomplete" || acc.status === "incomplete") &&
        acc.incompleteReason !== "max_output_tokens"
      )
        acc.error = `response incomplete: ${acc.incompleteReason ?? "no reason provided"}`;
      const u = r?.usage;
      if (u) {
        const cached = u.input_tokens_details?.cached_tokens;
        const reasoning = u.output_tokens_details?.reasoning_tokens;
        acc.usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          ...(cached !== undefined && { cacheReadTokens: cached }),
          ...(reasoning !== undefined && { reasoningTokens: reasoning }),
        };
      }
      return r?.output?.map((item, index) => finishItem(acc, index, item)).join("") ?? "";
    }
    case "error":
      acc.error = `${ev.error?.code ?? "error"}: ${ev.error?.message ?? ev.message ?? ""}`;
      return "";
    default:
      return "";
  }
}

/** 已累积的推理摘要(给人看的那份)。 */
export function summaryText(acc: ResponsesAcc): string {
  return [...acc.items.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, it]) => it.type === "reasoning")
    .map(([, it]) => it.summary)
    .filter(Boolean)
    .join("\n\n");
}

function safeParse(s: string): unknown {
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

export function finishResponsesAcc(acc: ResponsesAcc, aborted: boolean, model = ""): AssistantTurn {
  const ordered = [...acc.items.entries()].sort(([a], [b]) => a - b).map(([, it]) => it);
  const text = ordered
    .filter((it) => it.type === "message")
    .map((it) => it.text.join(""))
    .join("");
  const toolCalls: ToolCall[] = ordered
    .filter((it) => it.type === "function_call")
    .map((it) => ({ id: it.callId || it.id, name: it.name, args: safeParse(it.argsJson) }));
  const items: ReasoningItem[] = ordered
    .filter((it) => it.type === "reasoning" && (it.encrypted || it.id))
    .map((it) => ({
      id: it.id,
      summary: it.summary ? [{ type: "summary_text" as const, text: it.summary }] : [],
      ...(it.encrypted && { encrypted_content: it.encrypted }),
    }));
  const stopReason: StopReason = aborted
    ? "aborted"
    : acc.incompleteReason === "max_output_tokens"
      ? "length"
      : toolCalls.length > 0
        ? "tool"
        : "end";
  const reasoning = summaryText(acc);
  return {
    text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(acc.usage && { usage: acc.usage }),
    // 摘要只是给人看的;模型下一轮读的是 encrypted_content,客户端不可读、不可改。
    ...(reasoning && { reasoning, reasoningKind: "summary" as const }),
    // 打断的响应没有完整的推理项,不回传。
    ...(!aborted &&
      items.length > 0 && {
        opaque: { kind: "openai-reasoning", model, items } satisfies OpenAIReasoningOpaque,
      }),
    ...(Object.keys(acc.extras).length > 0 && { extras: acc.extras }),
  };
}

type InputItem =
  | { type: "message"; role: "user" | "assistant"; content: unknown }
  | { type: "reasoning"; id: string; summary: unknown[]; encrypted_content?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * 内部消息 → Responses 的 input 项。system 抽到 instructions;assistant 拆成 推理项 → 文本项 → 调用项;
 * 工具结果是 function_call_output。推理项只回传同模型族产生的(按模型名前缀 gpt-5 一类判定)。
 */
export function toResponsesInput(
  messages: Message[],
  opts: { model?: string } = {},
): { instructions: string | undefined; input: InputItem[]; map: number[] } {
  let instructions: string | undefined;
  const input: InputItem[] = [];
  /** 投影下标 → input 项下标(助手消息指向它产出的第一项);system 为 -1(抽到 instructions)。 */
  const map: number[] = [];
  // 模型族 = 名字里的主版本:gpt-5.5 与 gpt-5.6 同族,gpt-6 不同族。
  const family = (m: string) => m.match(/^[a-z]+-?\d+/i)?.[0].toLowerCase() ?? m;
  for (const m of messages) {
    if (m.role === "system") map.push(-1);
    else map.push(input.length);
    switch (m.role) {
      case "system":
        instructions = instructions ? `${instructions}\n\n${m.content}` : m.content;
        break;
      case "user":
        input.push({
          type: "message",
          role: "user",
          content: m.images?.length
            ? [
                ...(m.content ? [{ type: "input_text", text: m.content }] : []),
                ...m.images.map((image) => ({
                  type: "input_image",
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                  detail: "auto",
                })),
              ]
            : m.content || "(空)",
        });
        break;
      case "assistant": {
        if (
          isOpenAIReasoningOpaque(m.opaque) &&
          (!opts.model || family(m.opaque.model) === family(opts.model))
        ) {
          for (const it of m.opaque.items) input.push({ type: "reasoning", ...it });
        }
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        for (const tc of m.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: m.callId,
          output: m.content || "(空)",
        });
        break;
    }
  }
  return { instructions, input, map };
}

export type ReasoningSummary = "auto" | "concise" | "detailed";

export type OpenAIResponsesOptions = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  retry?: RetryOptions;
  effortLevels?: EffortLevel[];
  /** 要不要推理摘要;缺省 auto(能给就给)。 */
  reasoningSummary?: ReasoningSummary | "none";
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  stallTimeoutMs?: number;
};

export const OPENAI_RESPONSES_FIELDS: FieldTable = {
  protocol: "openai-responses",
  sends: [
    "model · stream: true · store: false(无状态:每次发全部历史,服务端不存)",
    "instructions:投影里的 system 消息",
    "input[]:message{role: user, content} / message{role: assistant, content[{type: output_text, text}]}",
    "input[]:reasoning{id, summary, encrypted_content}(来自事件 opaque,只在同模型族时回传,放在该轮文本与调用之前)",
    "input[]:function_call{call_id, name, arguments} / function_call_output{call_id, output}",
    "tools[{type: function, name, description, parameters}](扁平,不套 function 层)",
    "reasoning{effort, summary}:强度级别(off → none)与摘要档位;缺省只发 summary",
    "max_output_tokens:配置了 maxTokens 才发",
    "extraBody 里的任何键,逐字合并",
  ],
  reads: [
    "response.output_item.added / done:item.type = message | function_call | reasoning;done 时以 item 全量为准",
    "response.output_text.delta / done、response.refusal.delta / done → text(按 content_index 合并)",
    "message.content[]:output_text.text / refusal.refusal;response.output 完成快照补齐正文",
    "response.reasoning_summary_text.delta → reasoning(摘要,不可编辑)",
    "response.function_call_arguments.delta → 工具参数 JSON",
    "reasoning 项的 encrypted_content + id → opaque(原样回传)",
    "response.completed / incomplete / failed:usage.input_tokens / output_tokens / input_tokens_details.cached_tokens / output_tokens_details.reasoning_tokens;incomplete_details.reason = max_output_tokens → 截断",
    "error → 流内错误",
    "response.id · response.model · status · incomplete_details → extras(不解释,原样存)",
  ],
  ignores: [
    "response.created / in_progress、content_part 事件、annotations、web_search 等内置工具项",
    "推理正文只以密文返回,客户端读不到;summary 是模型另写的摘要",
  ],
};

export function openaiResponses(opts: OpenAIResponsesOptions): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...opts.extraHeaders,
  };
  const summary = opts.reasoningSummary ?? "auto";
  const wire = (messages: Message[], tools: ToolDef[], w: WireOptions = {}) => {
    const body = toResponsesInput(messages, { model: opts.model });
    const level = w.effort && clampEffort(w.effort, opts.effortLevels);
    const reasoning: Record<string, unknown> = {};
    if (level) reasoning.effort = level === "off" ? "none" : level;
    if (summary !== "none") reasoning.summary = summary;
    return {
      model: opts.model,
      ...(body.instructions && { instructions: body.instructions }),
      input: body.input,
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }),
      stream: true,
      store: false,
      ...(Object.keys(reasoning).length > 0 && { reasoning }),
      ...(opts.maxTokens !== undefined && { max_output_tokens: opts.maxTokens }),
      ...opts.extraBody,
    };
  };
  return {
    model: opts.model,
    fields: OPENAI_RESPONSES_FIELDS,
    wire,
    wireMap: (messages) => toResponsesInput(messages, { model: opts.model }).map,
    listModels: (signal) => fetchModelIds(`${baseUrl}/models`, headers, signal),
    async complete(
      messages,
      tools,
      { onDelta, onReasoning, signal, onRetry, onRaw, onRequest, record, effort } = {},
    ) {
      const body = JSON.stringify(wire(messages, tools, effort ? { effort } : {}));
      return withRetry(
        async () => {
          const acc = newResponsesAcc();
          const ac = linkedAbort(signal);
          let saved: Promise<void> | undefined;
          try {
            onRequest?.(body);
            const captured = await recordedFetch(
              `${baseUrl}/responses`,
              {
                method: "POST",
                headers,
                body,
                signal: ac.signal,
              },
              record,
            );
            const res = captured.response;
            saved = captured.saved;
            if (!res.ok || !res.body) {
              const text = await res.text();
              const retryAfterMs = parseRetryAfter(res.headers);
              throw new ProviderError(`provider ${res.status}: ${text}`, {
                status: res.status,
                body: text,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            const events = sseEvents(res.body as AsyncIterable<Uint8Array>, {
              ...(onRaw && { onRaw }),
              ...(opts.stallTimeoutMs !== undefined && { stallTimeoutMs: opts.stallTimeoutMs }),
              onStall: () => ac.abort(),
            });
            for await (const ev of events) {
              const before = summaryText(acc).length;
              const delta = feedResponsesEvent(acc, ev as ResponsesEvent);
              if (delta && onDelta) onDelta(delta);
              if (onReasoning) {
                const now = summaryText(acc);
                if (now.length > before) onReasoning(now.slice(before));
              }
            }
            if (acc.error) {
              throw new ProviderError(`provider stream error: ${acc.error}`, {
                retryable:
                  acc.items.size === 0 && /rate_limit|server_error|overloaded/i.test(acc.error),
              });
            }
            if (!acc.status) {
              throw new ProviderError("stream ended without response.completed", {
                retryable: acc.items.size === 0,
              });
            }
            return finishResponsesAcc(acc, false, opts.model);
          } catch (err) {
            if (signal?.aborted) return finishResponsesAcc(acc, true, opts.model);
            throw streamError(err, acc.items.size > 0);
          } finally {
            await saved;
          }
        },
        mergeRetry(opts.retry, { ...(signal && { signal }), ...(onRetry && { onRetry }) }),
      );
    },
  };
}
