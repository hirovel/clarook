// Chat Completions 协议的序列化与响应解析;内核只依赖 Provider 契约。
import type { StopReason, ToolCall, Usage } from "../events.js";
import { imageDataUrl } from "../images.js";
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

// ---------- OpenAI-compatible 适配器(先接一家,DeepSeek 走此协议) ----------

/** 同一协议下的方言差异只体现在强度参数上。 */
export type OpenAIDialect = "openai" | "deepseek";

/**
 * 强度 → 请求字段。openai:reasoning_effort 逐字直传,off 发 none。
 * deepseek:thinking 开关 + reasoning_effort 三档(low/high/max),medium 与 xhigh 按官方定义映射为 high。
 */
export function openaiEffortParams(
  level: EffortLevel | undefined,
  dialect: OpenAIDialect,
): Record<string, unknown> {
  if (level === undefined) return {};
  if (dialect === "deepseek") {
    if (level === "off") return { thinking: { type: "disabled" } };
    const mapped = level === "medium" || level === "xhigh" ? "high" : level;
    return { thinking: { type: "enabled" }, reasoning_effort: mapped };
  }
  return { reasoning_effort: level === "off" ? "none" : level };
}

/** OpenAI 兼容协议流式 chunk 的最小类型。只声明用到的字段,未声明的一律不读。 */
export type SseChunk = {
  id?: string;
  model?: string;
  system_fingerprint?: string | null;
  choices?: {
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 的缓存命中字段。 */
    prompt_cache_hit_tokens?: number;
    /** OpenAI 的缓存命中字段。 */
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

/** SSE 流的累积状态。做成纯数据 + 纯函数,流解析不碰网络即可测试。 */
export type StreamAcc = {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  finishReason?: string;
  usage?: Usage;
  /** 不解释的响应元数据。 */
  extras: Record<string, unknown>;
};

export function newAcc(): StreamAcc {
  return { text: "", reasoning: "", toolCalls: [], extras: {} };
}

/** 喂入一个已解析的 SSE chunk(data: 后面的 JSON 对象)。返回本 chunk 的文本增量。 */
export function feedChunk(acc: StreamAcc, chunk: SseChunk): string {
  const choice = chunk.choices?.[0];
  let delta = "";
  // 元数据每个 chunk 都带,记一次即可;finish_reason 原文另存,内核归一后的 stopReason 是另一回事。
  if (chunk.id && acc.extras.id === undefined) acc.extras.id = chunk.id;
  if (chunk.model && acc.extras.model === undefined) acc.extras.model = chunk.model;
  if (chunk.system_fingerprint && acc.extras.system_fingerprint === undefined)
    acc.extras.system_fingerprint = chunk.system_fingerprint;
  if (choice?.finish_reason) acc.extras.finish_reason = choice.finish_reason;
  delta = (choice?.delta?.content ?? "") + (choice?.delta?.refusal ?? "");
  acc.text += delta;
  if (choice?.delta?.reasoning_content) acc.reasoning += choice.delta.reasoning_content;
  for (const tc of choice?.delta?.tool_calls ?? []) {
    // 有些中转站不带 index(整段一次发完):带 id 的当新调用,不带的续写最后一个。
    const index =
      typeof tc.index === "number"
        ? tc.index
        : tc.id
          ? acc.toolCalls.length
          : Math.max(0, acc.toolCalls.length - 1);
    acc.toolCalls[index] ??= { id: "", name: "", argsJson: "" };
    const slot = acc.toolCalls[index] as StreamAcc["toolCalls"][number];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
  }
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (chunk.usage) {
    const u = chunk.usage;
    // prompt_tokens 含缓存命中部分,直接作为"占用窗口的输入";缓存命中单列供展示。
    const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    acc.usage = {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
      ...(reasoning !== undefined && { reasoningTokens: reasoning }),
    };
  }
  return delta;
}

export function finishAcc(acc: StreamAcc, aborted: boolean): AssistantTurn {
  if (!aborted) {
    if (!acc.finishReason) {
      // 流没有报告结束时不生成完整助手消息;已显示内容时禁止重试。
      throw new ProviderError("stream ended without finish_reason", {
        retryable: !acc.text && !acc.reasoning,
      });
    }
    if (!["stop", "length", "tool_calls"].includes(acc.finishReason)) {
      // 完整参数不代表调用获准执行;异常或未知结束理由必须留在错误路径。
      throw new ProviderError(`provider stream ended with finish_reason=${acc.finishReason}`, {
        retryable: false,
        body: acc.finishReason,
      });
    }
  }
  const toolCalls: ToolCall[] = acc.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    // 参数 JSON 解析失败不在这里报错:原样透传,让工具层校验并回喂模型。
    args: safeParse(tc.argsJson),
  }));
  // length:调用保留在 turn 里 —— 循环需要逐个补错误应答,但绝不执行。
  const stopReason: StopReason = aborted
    ? "aborted"
    : acc.finishReason === "length"
      ? "length"
      : toolCalls.length > 0
        ? "tool"
        : "end";
  return {
    text: acc.text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(acc.usage && { usage: acc.usage }),
    // reasoning_content 是模型下一轮真正读回去的全文,不是摘要。
    ...(acc.reasoning && { reasoning: acc.reasoning, reasoningKind: "full" as const }),
    ...(Object.keys(acc.extras).length > 0 && { extras: acc.extras }),
  };
}

export const OPENAI_COMPAT_FIELDS: FieldTable = {
  protocol: "openai(chat completions)",
  sends: [
    "model · stream: true · stream_options.include_usage: true",
    "messages[].role / content(投影)",
    "messages[].reasoning_content:配置 reasoningField 时每条助手消息都带,取自事件 reasoning;没有就发空串",
    "messages[].tool_calls[{id, type: function, function{name, arguments}}]",
    "role: tool 的 tool_call_id + content",
    "tools[{type: function, function{name, description, parameters}}]",
    "reasoning_effort(openai 方言;off → none)/ thinking{type} + reasoning_effort(deepseek 方言)",
    "max_completion_tokens(openai 方言)/ max_tokens(其余):配置了 maxTokens 才发",
    "extraBody merged unchanged; explicit per-call maxTokens overrides both output-limit fields using the current dialect",
  ],
  reads: [
    "choices[0].delta.content / refusal → text",
    "choices[0].delta.reasoning_content → reasoning(全文,可编辑)",
    "choices[0].delta.tool_calls[{index, id, function{name, arguments}}] → toolCalls",
    "choices[0].finish_reason → stopReason(length → 截断;异常或未知值 → ProviderError)",
    "usage.prompt_tokens / completion_tokens → inputTokens / outputTokens",
    "usage.prompt_cache_hit_tokens 或 prompt_tokens_details.cached_tokens → cacheReadTokens",
    "usage.completion_tokens_details.reasoning_tokens → reasoningTokens",
    "id · model · system_fingerprint · finish_reason 原文 → extras(不解释,原样存)",
  ],
  ignores: [
    "logprobs、created",
    "GPT 在此协议上不返回任何推理内容,只有 reasoning_tokens 一个数字;要看推理摘要用 openai-responses 协议",
  ],
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

/**
 * 内部消息 → OpenAI wire。reasoningField 给了(如 DeepSeek 的 reasoning_content)就在每条
 * assistant 消息上带出推理内容 —— 该家带工具的多轮要求每条都有,缺失即 400。
 */
export function toWire(m: Message, reasoningField?: string): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return {
        role: "user",
        content: m.images?.length
          ? [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.images.map((image) => ({
                type: "image_url",
                image_url: { url: imageDataUrl(image) },
              })),
            ]
          : m.content,
      };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(reasoningField && { [reasoningField]: m.reasoning ?? "" }),
        ...(m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.callId, content: m.content };
  }
}

export type OpenAICompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningField?: string;
  retry?: RetryOptions;
  dialect?: OpenAIDialect;
  /** 该模型支持的强度级别;请求了不支持的就向下回退。 */
  effortLevels?: EffortLevel[];
  /** 逐字合并进请求正文的字段(透传):API 新参数不必等代码。 */
  extraBody?: Record<string, unknown>;
  /** 附加请求头(如 beta 头)。 */
  extraHeaders?: Record<string, string>;
  /** 流停滞判定:连续这么久没有字节就断开重试;0 = 不限。缺省 90 秒。 */
  stallTimeoutMs?: number;
  /** 输出 token 上限;缺省不传,用服务端默认。openai 方言发 max_completion_tokens,其余发 max_tokens。 */
  maxTokens?: number;
};

export function openaiCompat(opts: OpenAICompatOptions): Provider {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const dialect = opts.dialect ?? "openai";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...opts.extraHeaders,
  };
  const wire = (messages: Message[], tools: ToolDef[], w: WireOptions = {}) => {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: messages.map((m) => toWire(m, opts.reasoningField)),
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.maxTokens !== undefined &&
        (dialect === "openai"
          ? { max_completion_tokens: opts.maxTokens }
          : { max_tokens: opts.maxTokens })),
      ...openaiEffortParams(w.effort && clampEffort(w.effort, opts.effortLevels), dialect),
      ...opts.extraBody,
    };
    if (w.maxTokens !== undefined) {
      // 每次调用的显式额度优先;只发当前方言的一个字段,不影响下一次请求。
      delete body.max_tokens;
      delete body.max_completion_tokens;
      body[dialect === "openai" ? "max_completion_tokens" : "max_tokens"] = w.maxTokens;
    }
    return body;
  };
  return {
    model: opts.model,
    fields: OPENAI_COMPAT_FIELDS,
    wire,
    // chat completions 一条投影消息就是一条 wire 消息,顺序不变。
    wireMap: (messages) => messages.map((_, i) => i),
    listModels: (signal) => fetchModelIds(`${baseUrl}/models`, headers, signal),
    async complete(
      messages,
      tools,
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
          const acc = newAcc();
          const ac = linkedAbort(signal);
          let saved: Promise<void> | undefined;
          try {
            onRequest?.(body);
            const captured = await recordedFetch(
              `${baseUrl}/chat/completions`,
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
            for await (const chunk of events) {
              const before = acc.reasoning.length;
              const delta = feedChunk(acc, chunk as SseChunk);
              if (delta && onDelta) onDelta(delta);
              if (onReasoning && acc.reasoning.length > before) {
                onReasoning(acc.reasoning.slice(before));
              }
            }
            return finishAcc(acc, false);
          } catch (err) {
            // 打断:已流出的部分作为 aborted turn 返回,由循环记入日志,不丢真相。
            if (signal?.aborted) return finishAcc(acc, true);
            throw streamError(err, Boolean(acc.text || acc.reasoning));
          } finally {
            await saved;
          }
        },
        mergeRetry(opts.retry, { ...(signal && { signal }), ...(onRetry && { onRetry }) }),
      );
    },
  };
}
