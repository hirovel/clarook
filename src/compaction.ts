import {
  type CompactionAcceptance,
  DEFAULT_COMPACTION_SETTINGS,
  DEFAULT_RECENT_TOKENS,
  SUMMARY_TEMPLATES,
  type SummaryTemplateId,
  summaryPrompt,
} from "./compaction-presets.js";
import { estimateTokens, messageTokens } from "./context.js";
import type { AgentEvent, Usage } from "./events.js";
import {
  type Composition,
  compactionState,
  composeContext,
  deriveMessages,
  isProjected,
  type Message,
} from "./messages.js";
import type { Provider } from "./provider.js";

// ---------- 保留策略槽:决定压缩时尾部保留多少原文 ----------

/**
 * 返回切点下标:events[切点..] 原文保留,切点之前可被摘要覆盖。
 * 槽的公约(不是策略自由度):切点不落在工具调用对中间 —— 由 legalizeCut 统一执行。
 */
export type PreservationPolicy = (events: readonly AgentEvent[]) => number;

/** 尾部保留固定 token 预算(默认)。 */
export function keepRecentTokens(budget = DEFAULT_RECENT_TOKENS): PreservationPolicy {
  return (events) => preserveTail(events, composeContext(events), budget);
}

/** 尾部保留窗口比例。 */
export function keepRatio(ratio = 0.3): PreservationPolicy {
  return (events) => {
    const current = composeContext(events);
    const total = current.messages.reduce((n, message) => n + messageTokens(message), 0);
    return preserveTail(events, current, total * ratio);
  };
}

/** 预算只数当前模型可见内容;投影来源把切点映回原事件,历史本身不改。 */
function preserveTail(events: readonly AgentEvent[], current: Composition, budget: number): number {
  let acc = 0;
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const message = current.messages[i];
    const source = current.provenance[i]?.event;
    if (!message || source === undefined) continue;
    const position = contextPosition(events, source);
    if (position <= 0) continue;
    acc += messageTokens(message);
    if (acc > budget) return legalizeCut(events, position + 1);
  }
  return 1;
}

/** 合成消息按其内容的位置切分,不能用后来追加记录的位置。 */
function contextPosition(events: readonly AgentEvent[], source: number): number {
  const event = events[source];
  return event?.type === "compaction"
    ? (event.coversFrom ?? 1)
    : event?.type === "tool/unresolved"
      ? event.callEvent
      : source;
}

/**
 * 切点合法化:保留区里第一条模型可见的事件必须是 user/assistant 消息,不能是工具结果(否则拆散调用对)。
 * 只给人的事件(request/retry/decision 等)不投影,落在切点上无妨;保留区为空(切到末尾)也合法。
 */
export function legalizeCut(events: readonly AgentEvent[], cut: number): number {
  let c = Math.min(cut, events.length);
  // 只定位一次尾部首条消息;不能每退一步都复制、扫描整个剩余历史。
  let first: AgentEvent | undefined;
  for (let i = c; i < events.length; i++) {
    const e = events[i];
    if (e && isProjected(e)) {
      first = e;
      break;
    }
  }
  if (
    !first ||
    first.type === "user/message" ||
    first.type === "user/shell" ||
    first.type === "assistant/message"
  )
    return c;
  while (c > 1) {
    c--;
    const e = events[c];
    if (
      e?.type === "user/message" ||
      e?.type === "assistant/message" ||
      (e?.type === "user/shell" && !e.excludeFromContext)
    )
      break;
  }
  return c;
}

// ---------- 压缩策略槽:内核管 WHEN,策略管 HOW ----------

export type CompactionPayload = {
  summary?: string;
  coversFrom?: number;
  coversUpTo?: number;
  cleared?: number[];
  tokensBefore?: number;
  /** 摘要请求的用量与耗时;策略有 LLM 调用时填。 */
  usage?: Usage;
  latencyMs?: number;
  /** 策略名与参数,给人看:这次压缩是谁做的。 */
  strategy?: string;
};

export type CompactionInput = {
  events: readonly AgentEvent[];
  window: number;
  /** 压缩后希望降到的估算 token 数。 */
  targetTokens: number;
  provider?: Provider;
  preservation?: PreservationPolicy;
  /** 手动压缩时用户附加的指示。 */
  instructions?: string;
  signal?: AbortSignal;
};

/** 返回 null = 本策略认为无事可做或未取得足够进展。 */
export type CompactionStrategy = (input: CompactionInput) => Promise<CompactionPayload | null>;

/** 实测基准失效时只估算消息;工具定义与协议封装要等供应商回报。 */
export function contextSize(events: readonly AgentEvent[]): {
  tokens: number;
  basis: "usage" | "messages";
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === "compaction" || e.type === "context/edit" || e.type === "context/drop") break;
    if (
      e.type === "assistant/message" &&
      e.usage &&
      e.usage.inputTokens + e.usage.outputTokens > 0
    ) {
      return {
        tokens: e.usage.inputTokens + e.usage.outputTokens + estimateAfter(events.slice(i + 1)),
        basis: "usage",
      };
    }
  }
  return { tokens: estimateAfter(events), basis: "messages" };
}

/** 当前上下文占用;自动压缩与 request 事件共用这个数值口径。 */
export function contextTokens(events: readonly AgentEvent[]): number {
  return contextSize(events).tokens;
}

/** 估算一份日志(可叠加未落盘的压缩载荷)投影后的 token 量。 */
export function estimateAfter(
  events: readonly AgentEvent[],
  payload?: CompactionPayload | null,
): number {
  const view = payload
    ? [...events, { type: "compaction", at: "", ...payload } as AgentEvent]
    : events;
  return deriveMessages(view).reduce((n, m) => n + messageTokens(m), 0);
}

// ---------- 策略一:清除旧工具结果(请求内容有损,本地原文保留,零 LLM 调用) ----------

/**
 * 把保留窗之外的旧工具结果换成占位文本。清除量不足 clearAtLeast 时不动手 ——
 * 每次清除都会使缓存前缀失效一次,必须批量摊销这笔一次性成本。
 */
export function clearToolResults(
  opts: { keepRecent?: number; clearAtLeast?: number } = {},
): CompactionStrategy {
  const { keepRecent = 3, clearAtLeast = 2000 } = opts;
  return async ({ events }) => {
    const state = compactionState(events);
    const current = composeContext(events);
    const candidates: { idx: number; tokens: number }[] = [];
    for (const [i, message] of current.messages.entries()) {
      const source = current.provenance[i]?.event;
      if (source === undefined || events[source]?.type !== "tool/result") continue;
      if (state.cleared.has(source)) continue;
      candidates.push({ idx: source, tokens: messageTokens(message) });
    }
    const toClear = candidates.slice(0, Math.max(0, candidates.length - keepRecent));
    const saved = toClear.reduce((n, c) => n + c.tokens, 0);
    if (saved < clearAtLeast) return null;
    return {
      cleared: toClear.map((c) => c.idx),
      strategy: `clearToolResults(keepRecent=${keepRecent}, clearAtLeast=${clearAtLeast})`,
    };
  };
}

// ---------- 策略二:LLM 滚动摘要(有损,默认策略) ----------

export const SUMMARY_PROMPTS = {
  /** 七节结构化版;与设置页和运行模板使用同一份文本。 */
  structuredFull: summaryPrompt("clarook-detailed"),
  /** 不固定章节的简洁版。 */
  minimal: summaryPrompt("minimal"),
} as const;

export function llmSummarize(
  opts: {
    prompt?: string;
    callStyle?: "replay" | "standalone";
    /** 独立调用时可换便宜摘要模型;缺省用主 provider。 */
    provider?: Provider;
    exemptFirstUserMessage?: boolean;
    /** 只用于本次摘要请求;0 沿用 provider 配置,未设置时用内置摘要额度。 */
    maxTokens?: number;
    /** reduced 保留 10% 收益门;smaller 与 reduced 都要求整体上下文变小。 */
    acceptance?: CompactionAcceptance;
  } = {},
): CompactionStrategy {
  const {
    prompt = summaryPrompt("pi"),
    callStyle = "replay",
    exemptFirstUserMessage = true,
    acceptance = "complete",
    maxTokens = DEFAULT_COMPACTION_SETTINGS.compactionMaxTokens,
  } = opts;
  return async (input) => {
    const provider = opts.provider ?? input.provider;
    if (!provider) return null;
    const { events } = input;
    const state = compactionState(events);
    // 保留预算与新会话的参考组合一致;短历史无覆盖范围时在请求前跳过。
    const preservation = input.preservation ?? keepRecentTokens();
    const cut = legalizeCut(events, preservation(events));

    const firstUser = events.findIndex(
      (e) => e.type === "user/message" || (e.type === "user/shell" && !e.excludeFromContext),
    );
    const from = exemptFirstUserMessage && firstUser >= 0 ? firstUser + 1 : 1;
    if (cut <= from + 1) return null; // 可覆盖区太小
    if (cut <= state.coversUpTo) return null; // 相比上次压缩无进展

    const instruction = input.instructions
      ? `${prompt}\n\nAdditional instructions from the user for this compaction: ${input.instructions}`
      : prompt;
    // 先解释截至现在的修改,再选较早的内容;截事件前缀会丢掉后置的编辑与排除。
    const current = composeContext(events);
    const prefix: Message[] = [];
    const covered: Message[] = [];
    for (const [i, message] of current.messages.entries()) {
      const source = current.provenance[i]?.event;
      if (source === undefined) continue;
      const position = contextPosition(events, source);
      if (position >= cut) continue;
      prefix.push(message);
      if (position >= from) covered.push(message);
    }
    const coveredTokens = covered.reduce((n, m) => n + messageTokens(m), 0);
    if (coveredTokens === 0) return null;
    const messages: Message[] =
      callStyle === "replay"
        ? [...prefix, { role: "user", content: instruction }]
        : [
            { role: "system", content: "You are a conversation compaction assistant." },
            { role: "user", content: `${serialize(prefix)}\n\n---\n${instruction}` },
          ];

    const startedAt = Date.now();
    const turn = await provider.complete(messages, [], {
      ...(input.signal && { signal: input.signal }),
      ...(maxTokens > 0 && { maxTokens }),
    });
    if (turn.stopReason !== "end")
      throw new Error(`Summary did not finish (${turn.stopReason}); original context retained.`);
    if (!turn.text.trim()) return null;

    const summary = turn.text.trim() + fileTrailer(covered);
    // 收益门是可选策略;完整性检查不受此选项影响。
    if (acceptance === "reduced" && estimateTokens(summary) >= coveredTokens * 0.9) return null;

    const tokensBefore = current.messages.reduce((n, m) => n + messageTokens(m), 0);
    const payload: CompactionPayload = {
      summary,
      coversFrom: from,
      coversUpTo: cut,
      tokensBefore,
      ...(turn.usage && { usage: turn.usage }),
      latencyMs: Date.now() - startedAt,
      strategy: `llmSummarize(${promptName(prompt)}, ${callStyle})`,
    };
    // 独立调用此策略也兑现应用条件;循环还会校验自定义策略组成的最终上下文。
    if (acceptance !== "complete" && estimateAfter(events, payload) >= tokensBefore) return null;
    return payload;
  };
}

/** 读过/改过的文件清单:从工具调用参数程序化提取,不依赖模型自觉。 */
function fileTrailer(messages: readonly Message[]): string {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const tc of message.toolCalls) {
      const path = (tc.args as { path?: unknown } | null)?.path;
      if (typeof path !== "string") continue;
      if (tc.name === "read") read.add(path);
      if (tc.name === "write" || tc.name === "edit") written.add(path);
    }
  }
  let out = "";
  if (read.size > 0) out += `\n\nFiles read: ${[...read].join(", ")}`;
  if (written.size > 0) out += `\nFiles written: ${[...written].join(", ")}`;
  return out;
}

function serialize(messages: Message[]): string {
  return messages
    .map((m) => {
      const head = m.role === "tool" ? `tool(${m.name})` : m.role;
      const calls =
        m.role === "assistant" && m.toolCalls.length > 0
          ? `\n[calls ${m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(", ")}]`
          : "";
      return `[${head}] ${m.content}${calls}`;
    })
    .join("\n\n");
}

// ---------- 策略三:管线(先清除,不够再摘要) ----------

export function pipeline(...strategies: CompactionStrategy[]): CompactionStrategy {
  return async (input) => {
    let acc: CompactionPayload | null = null;
    const names: string[] = [];
    for (const strategy of strategies) {
      const view = acc
        ? [...input.events, { type: "compaction", at: "", ...acc } as AgentEvent]
        : input.events;
      const p = await strategy({ ...input, events: view });
      if (!p) continue;
      names.push(p.strategy ?? "unnamed strategy");
      acc = merge(acc, p);
      if (estimateAfter(input.events, acc) <= input.targetTokens) break;
    }
    return acc ? { ...acc, strategy: `pipeline(${names.join(" → ")})` } : null;
  };
}

/** 模板名称来自同一张表;自定义文本只显示长度。 */
function promptName(prompt: string): string {
  for (const id of Object.keys(SUMMARY_TEMPLATES) as SummaryTemplateId[])
    if (summaryPrompt(id) === prompt) return id;
  return `custom ${prompt.length} chars`;
}

function merge(a: CompactionPayload | null, b: CompactionPayload): CompactionPayload {
  return {
    ...a,
    ...b,
    ...(a?.cleared || b.cleared
      ? { cleared: [...new Set([...(a?.cleared ?? []), ...(b.cleared ?? [])])] }
      : {}),
  };
}
