// Anthropic Messages API 适配器:第二个 provider,同时是对内部消息抽象的验证。
// 与 OpenAI 兼容适配器的差异全部封在这里:工具结果是 user 消息里的内容块、system 是顶层字段、
// 流式事件按内容块下标分发、thinking 块带签名必须原样回传。内核其余部分一行不改。
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

/** 流式事件的最小类型,只声明用到的字段。 */
export type AnthropicEvent =
  | {
      type: "message_start";
      message: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text" }
        | { type: "tool_use"; id: string; name: string }
        | { type: "thinking" }
        | { type: "redacted_thinking"; data: string }
        | { type: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null; stop_sequence?: string | null };
      usage?: { output_tokens?: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

/** 模型的思考块,签名绑定前缀,回传时一字不能改。 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** 存进 assistant/message.opaque 的形态。带模型名:签名跨模型无效,换模型后丢弃。 */
export type AnthropicOpaque = {
  kind: "anthropic-thinking";
  model: string;
  blocks: ThinkingBlock[];
};

export function isAnthropicOpaque(x: unknown): x is AnthropicOpaque {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "anthropic-thinking" &&
    Array.isArray((x as { blocks?: unknown }).blocks)
  );
}

export type AnthropicAcc = {
  text: string;
  blocks: Map<number, { id: string; name: string; argsJson: string }>;
  thinking: Map<number, ThinkingBlock>;
  stopReason?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  error?: string;
  /** 不解释的响应元数据:id、服务模型、原始 stop_reason、stop_sequence。 */
  extras: Record<string, unknown>;
};

export function newAnthropicAcc(): AnthropicAcc {
  return { text: "", blocks: new Map(), thinking: new Map(), extras: {} };
}

/** 已累积的思考文本(给人看的那份)。 */
export function thinkingText(acc: AnthropicAcc): string {
  return [...acc.thinking.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => (b.type === "thinking" ? b.thinking : ""))
    .join("");
}

/** 喂入一个已解析的事件,返回本事件的文本增量。纯函数,不碰网络。 */
export function feedAnthropicEvent(acc: AnthropicAcc, ev: AnthropicEvent): string {
  switch (ev.type) {
    case "message_start": {
      if (ev.message.id) acc.extras.id = ev.message.id;
      if (ev.message.model) acc.extras.model = ev.message.model;
      // Anthropic 的 input_tokens 不含缓存部分;占用窗口的是三者之和。
      const u = ev.message.usage;
      if (u?.output_tokens !== undefined) acc.outputTokens = u.output_tokens;
      if (
        u &&
        (u.input_tokens ?? u.cache_read_input_tokens ?? u.cache_creation_input_tokens) !== undefined
      ) {
        acc.inputTokens =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        if (u.cache_read_input_tokens !== undefined)
          acc.cacheReadTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens !== undefined)
          acc.cacheWriteTokens = u.cache_creation_input_tokens;
      }
      return "";
    }
    case "content_block_start": {
      const b = ev.content_block;
      if (b.type === "tool_use") {
        const t = b as { id: string; name: string };
        acc.blocks.set(ev.index, { id: t.id, name: t.name, argsJson: "" });
      } else if (b.type === "thinking") {
        acc.thinking.set(ev.index, { type: "thinking", thinking: "", signature: "" });
      } else if (b.type === "redacted_thinking") {
        acc.thinking.set(ev.index, {
          type: "redacted_thinking",
          data: (b as { data: string }).data,
        });
      }
      return "";
    }
    case "content_block_delta": {
      const d = ev.delta;
      if (d.type === "text_delta") {
        const text = (d as { text: string }).text;
        acc.text += text;
        return text;
      }
      if (d.type === "input_json_delta") {
        const slot = acc.blocks.get(ev.index);
        if (slot) slot.argsJson += (d as { partial_json: string }).partial_json;
      }
      if (d.type === "thinking_delta" || d.type === "signature_delta") {
        const slot = acc.thinking.get(ev.index);
        if (slot?.type === "thinking") {
          if (d.type === "thinking_delta") slot.thinking += (d as { thinking: string }).thinking;
          else slot.signature = (d as { signature: string }).signature;
        }
      }
      return "";
    }
    case "message_delta":
      if (ev.delta.stop_reason) {
        acc.stopReason = ev.delta.stop_reason;
        acc.extras.stop_reason = ev.delta.stop_reason;
      }
      if (ev.delta.stop_sequence) acc.extras.stop_sequence = ev.delta.stop_sequence;
      if (ev.usage?.output_tokens !== undefined) acc.outputTokens = ev.usage.output_tokens;
      return "";
    case "error":
      acc.error = `${ev.error.type}: ${ev.error.message}`;
      return "";
    default:
      return "";
  }
}

export function finishAnthropicAcc(
  acc: AnthropicAcc,
  aborted: boolean,
  model = "",
  opts: { mode?: ThinkingMode } = {},
): AssistantTurn {
  const toolCalls: ToolCall[] = [...acc.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({ id: b.id, name: b.name, args: safeParse(b.argsJson) }));
  const stopReason: StopReason = aborted
    ? "aborted"
    : acc.stopReason === "max_tokens"
      ? "length"
      : toolCalls.length > 0
        ? "tool"
        : "end";
  const usage: Usage | undefined =
    acc.inputTokens !== undefined || acc.outputTokens !== undefined
      ? {
          inputTokens: acc.inputTokens ?? 0,
          outputTokens: acc.outputTokens ?? 0,
          ...(acc.cacheReadTokens !== undefined && { cacheReadTokens: acc.cacheReadTokens }),
          ...(acc.cacheWriteTokens !== undefined && { cacheWriteTokens: acc.cacheWriteTokens }),
        }
      : undefined;
  const reasoning = thinkingText(acc);
  // 打断的半截思考块没有签名,回传必 400,只留可读文本。
  const blocks = aborted
    ? []
    : [...acc.thinking.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
  return {
    text: acc.text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(usage && { usage }),
    // 预算模式(4.6 及更早)返回的是全文;自适应模式(4.7 起)只返回摘要或空串,模型读的正文在签名块里。
    ...(reasoning && {
      reasoning,
      reasoningKind: (opts.mode === "budget" ? "full" : "summary") as "full" | "summary",
    }),
    ...(blocks.length > 0 && {
      opaque: { kind: "anthropic-thinking", model, blocks } satisfies AnthropicOpaque,
    }),
    ...(Object.keys(acc.extras).length > 0 && { extras: acc.extras }),
  };
}

export const ANTHROPIC_FIELDS: FieldTable = {
  protocol: "anthropic(messages)",
  sends: [
    "model · max_tokens · stream: true",
    "system[{type: text, text, cache_control?}]:投影里的 system 消息抽到顶层,缺省挂缓存断点",
    "messages[].content 块:thinking{thinking, signature} / redacted_thinking{data}(来自事件 opaque,只在同模型时回传)",
    "messages[].content 块:text / tool_use{id, name, input} / tool_result{tool_use_id, content, is_error};最后一块挂 cache_control",
    "tools[{name, description, input_schema}]",
    "thinking{type: adaptive|enabled+budget_tokens|disabled} + output_config.effort:按强度级别与 thinkingMode",
    "extraBody merged unchanged; explicit per-call maxTokens overrides max_tokens without changing extraBody.thinking",
  ],
  reads: [
    "message_start.message.usage:input_tokens + cache_creation_input_tokens + cache_read_input_tokens → inputTokens;后两项单列",
    "content_block_start:text / tool_use{id, name} / thinking / redacted_thinking{data}",
    "content_block_delta:text_delta → text;input_json_delta → 工具参数;thinking_delta → reasoning;signature_delta → 签名",
    "message_delta.delta.stop_reason → stopReason(max_tokens → 截断);message_delta.usage.output_tokens → outputTokens",
    "error → 流内错误",
    "message.id · message.model · stop_reason 原文 · stop_sequence → extras(不解释,原样存)",
  ],
  ignores: [
    "message_stop、ping",
    "stop_details(refusal 分类)、citations、server tool 结果块、container",
    "thinking 文本在 4.7 起只是摘要或空串(display 参数决定),真正的推理正文在签名块里,客户端读不到",
  ],
};

function safeParse(s: string): unknown {
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

type CacheControl = { cache_control: { type: "ephemeral" } };

type WireBlock = (
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | ThinkingBlock
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
) &
  Partial<CacheControl>;

type WireSystem = ({ type: "text"; text: string } & Partial<CacheControl>)[];

/**
 * 内部消息 → Anthropic wire。结构差异:system 抽到顶层;连续的工具结果合并进同一条 user 消息
 * (协议要求紧随 assistant 的那条 user 消息包含其全部 tool_use 的应答);
 * assistant 的 thinking 块放在内容之首原样回传,只回传同一模型产生的(签名跨模型无效)。
 * cache:在系统提示词与最后一条消息的末块放缓存断点。前缀不变即命中,每一步只为新增部分付全价。
 */
export function toAnthropicWire(
  messages: Message[],
  opts: { model?: string; cache?: boolean } = {},
): {
  system: WireSystem | undefined;
  messages: { role: "user" | "assistant"; content: WireBlock[] }[];
  /** 投影下标 → wire 消息下标;system 为 -1(抽到顶层),合并进同一条 user 的工具结果共用下标。 */
  map: number[];
} {
  let systemText: string | undefined;
  const out: { role: "user" | "assistant"; content: WireBlock[] }[] = [];
  const map: number[] = [];
  // 思考块的签名绑定它之前的整个前缀:前面任何一条消息被改过,后面的思考块就都不再回传。
  let prefixEdited = false;
  // 第一条改过的消息之前的那条 wire 消息下标:编辑点断点挂在它上面。
  let editBoundary = -1;
  for (const m of messages) {
    if (m.edited && !prefixEdited) editBoundary = out.length - 1;
    if (m.edited) prefixEdited = true;
    switch (m.role) {
      case "system":
        systemText = systemText ? `${systemText}\n\n${m.content}` : m.content;
        map.push(-1);
        break;
      case "user":
        map.push(out.length);
        out.push({
          role: "user",
          content: [
            ...(m.content || !m.images?.length
              ? [{ type: "text" as const, text: m.content || "(empty)" }]
              : []),
            ...(m.images ?? []).map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
            })),
          ],
        });
        break;
      case "assistant": {
        map.push(out.length);
        const content: WireBlock[] = [];
        if (
          !prefixEdited &&
          isAnthropicOpaque(m.opaque) &&
          (!opts.model || m.opaque.model === opts.model)
        ) {
          content.push(...m.opaque.blocks);
        }
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
        }
        if (!m.content && m.toolCalls.length === 0) content.push({ type: "text", text: "(空)" });
        out.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const block: WireBlock = {
          type: "tool_result",
          tool_use_id: m.callId,
          // 空内容块会被拒绝;空结果也是结果,用占位文本表示。
          content: m.content || "(空)",
          ...(m.isError && { is_error: true }),
        };
        const last = out.at(-1);
        if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(block);
          map.push(out.length - 1);
        } else {
          map.push(out.length);
          out.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }
  const system: WireSystem | undefined =
    systemText === undefined ? undefined : [{ type: "text", text: systemText }];
  if (opts.cache) {
    const mark = <T extends object>(b: T): T & CacheControl => ({
      ...b,
      cache_control: { type: "ephemeral" },
    });
    const markLast = (msg: { content: WireBlock[] } | undefined) => {
      const last = msg?.content.at(-1);
      // 思考块不能挂断点;末块是思考块的情况只会出现在打断后,跳过即可。
      if (msg && last && last.type !== "thinking" && last.type !== "redacted_thinking") {
        msg.content[msg.content.length - 1] = mark(last);
      }
    };
    if (system?.[0]) system[0] = mark(system[0]);
    // 编辑点断点:第一条改过的消息之前那条挂断点,编辑点之前的前缀稳定命中,只有之后重算。
    if (editBoundary >= 0 && editBoundary < out.length - 1) markLast(out[editBoundary]);
    markLast(out.at(-1));
  }
  return { system, messages: out, map };
}

/** adaptive:4.7+ 与 5 系,effort 直传;budget:4.6 及更早,按级别给 budget_tokens。 */
export type ThinkingMode = "adaptive" | "budget";

const BUDGETS: Record<Exclude<EffortLevel, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32000,
  max: 32000,
};

/** 强度 → 请求字段。缺省不传;off 发 disabled(不可关的模型会 400,由用户配置 effortLevels 排除 off)。 */
export function anthropicEffortParams(
  level: EffortLevel | undefined,
  mode: ThinkingMode,
  maxTokens: number,
): Record<string, unknown> {
  if (level === undefined) return {};
  if (level === "off") return { thinking: { type: "disabled" } };
  if (mode === "budget") {
    // budget_tokens 须 ≥ 1024 且 < max_tokens。
    const budget = Math.max(1024, Math.min(BUDGETS[level], maxTokens - 1));
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }
  return { thinking: { type: "adaptive" }, output_config: { effort: level } };
}

export type AnthropicOptions = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  retry?: RetryOptions;
  thinkingMode?: ThinkingMode;
  effortLevels?: EffortLevel[];
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** 提示缓存断点(缺省开):系统提示词与最后一条消息各挂一个。 */
  promptCache?: boolean;
  /** 流停滞判定毫秒数;0 = 不限。缺省 90 秒。 */
  stallTimeoutMs?: number;
};

export function anthropic(opts: AnthropicOptions): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const maxTokens = opts.maxTokens ?? 8192;
  const cache = opts.promptCache ?? true;
  const headers = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
    ...opts.extraHeaders,
  };
  const wire = (messages: Message[], tools: ToolDef[], w: WireOptions = {}) => {
    const body = toAnthropicWire(messages, { model: opts.model, cache });
    const outputTokens = w.maxTokens ?? maxTokens;
    return {
      model: opts.model,
      max_tokens: outputTokens,
      ...(body.system && { system: body.system }),
      messages: body.messages,
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
      stream: true,
      ...anthropicEffortParams(
        w.effort && clampEffort(w.effort, opts.effortLevels),
        opts.thinkingMode ?? "adaptive",
        outputTokens,
      ),
      ...opts.extraBody,
      ...(w.maxTokens !== undefined && { max_tokens: w.maxTokens }),
    };
  };
  const mode = opts.thinkingMode ?? "adaptive";
  return {
    model: opts.model,
    fields: ANTHROPIC_FIELDS,
    wire,
    wireMap: (messages) => toAnthropicWire(messages, { model: opts.model }).map,
    listModels: (signal) => fetchModelIds(`${baseUrl}/v1/models`, headers, signal),
    async complete(
      messages: Message[],
      tools: ToolDef[],
      { onDelta, onReasoning, signal, onRetry, onRaw, onRequest, record, effort, maxTokens } = {},
    ) {
      const body = JSON.stringify(
        wire(messages, tools, {
          ...(effort && { effort }),
          ...(maxTokens !== undefined && { maxTokens }),
        }),
      );

      return withRetry(
        async () => {
          const acc = newAnthropicAcc();
          const ac = linkedAbort(signal);
          let saved: Promise<void> | undefined;
          try {
            onRequest?.(body);
            const captured = await recordedFetch(
              `${baseUrl}/v1/messages`,
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
              const before = thinkingText(acc).length;
              const delta = feedAnthropicEvent(acc, ev as AnthropicEvent);
              if (delta && onDelta) onDelta(delta);
              if (onReasoning) {
                const now = thinkingText(acc);
                if (now.length > before) onReasoning(now.slice(before));
              }
            }
            if (acc.error) {
              // HTTP 200 之后流内报错(如 overloaded_error):尚未吐字时可重试。
              throw new ProviderError(`provider stream error: ${acc.error}`, {
                retryable: !acc.text && /overloaded|api_error|rate_limit/i.test(acc.error),
                body: acc.error,
              });
            }
            if (!acc.stopReason) {
              throw new ProviderError("stream ended without message_delta", {
                retryable: !acc.text,
              });
            }
            return finishAnthropicAcc(acc, false, opts.model, { mode });
          } catch (err) {
            if (signal?.aborted) return finishAnthropicAcc(acc, true, opts.model, { mode });
            throw streamError(err, Boolean(acc.text || thinkingText(acc)));
          } finally {
            await saved;
          }
        },
        mergeRetry(opts.retry, { ...(signal && { signal }), ...(onRetry && { onRetry }) }),
      );
    },
  };
}
