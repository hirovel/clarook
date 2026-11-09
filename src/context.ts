import type { AgentEvent, Usage } from "./events.js";
import { deriveMessages, type Message, userShellText } from "./messages.js";
import type { ToolDef } from "./provider.js";

/**
 * 上下文构成投影:当前模型可见内容按类别的 token 分布。
 * 纯函数,按当前消息投影与工具声明计算已知文本;图片、私有回传物与协议封装未计入。
 * token 是 chars/4 估算;最近一次请求的历史实测 usage 独立带回供对照。
 */
export type ContextPart = {
  label: string;
  tokens: number;
  /** 占估算总量的比例,0-1。 */
  share: number;
  count: number;
};

export type ContextBreakdown = {
  parts: ContextPart[];
  /** 估算总量(chars/4)。 */
  estimatedTokens: number;
  window: number;
  /** 估算总量 / 窗口。 */
  usedShare: number;
  /** 最近一次请求的实测输入 token,来自 API usage;无请求时缺省。 */
  measuredTokens?: number;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 工具调用的估算:参数 JSON 加固定开销。 */
function toolCallTokens(calls: readonly { args: unknown }[]): number {
  return calls.reduce((n, tc) => n + estimateTokens(JSON.stringify(tc.args)) + 8, 0);
}

/**
 * 一条消息的估算 token。缺省与请求正文同口径:正文加工具调用参数;
 * withReasoning 时把思考文本也算上(检视器的"这条消息多大"要含它,发请求时多数供应商不算它)。
 */
export function messageTokens(m: Message, opts: { withReasoning?: boolean } = {}): number {
  const base = estimateTokens(m.content);
  if (m.role !== "assistant") return base;
  const reasoning = opts.withReasoning ? estimateTokens(m.reasoning ?? "") : 0;
  return base + reasoning + toolCallTokens(m.toolCalls);
}

/** 只计模型可见的声明字段,不把执行器与本地描述元数据当成输入。 */
export function toolDefinitionTokens(tools: readonly ToolDef[]): number {
  return tools.reduce(
    (n, { name, description, parameters }) =>
      n + estimateTokens(JSON.stringify({ name, description, parameters })),
    0,
  );
}

/** 已知文本和工具声明的粗估;图片、私有回传物与协议封装未计入。 */
export function estimateInput(
  messages: readonly Message[],
  tools: readonly ToolDef[] = [],
): number {
  return (
    messages.reduce((n, message) => n + messageTokens(message), 0) + toolDefinitionTokens(tools)
  );
}

/** 一条事件里模型可见文本的估算 token;只给人看的事件为 0。 */
export function eventTokens(e: AgentEvent): number {
  switch (e.type) {
    case "session/start":
      return estimateTokens(e.system);
    case "user/message":
      return estimateTokens(e.text);
    case "user/shell":
      return e.excludeFromContext ? 0 : estimateTokens(userShellText(e));
    case "assistant/message":
      return estimateTokens(e.text) + toolCallTokens(e.toolCalls);
    case "tool/result":
    case "tool/unresolved":
      return estimateTokens(e.content);
    default:
      return 0;
  }
}

export function contextBreakdown(
  events: readonly AgentEvent[],
  window: number,
  tools: readonly ToolDef[] = [],
): ContextBreakdown {
  const buckets = new Map<string, { tokens: number; count: number }>();
  const add = (label: string, tokens: number, count = 1) => {
    const b = buckets.get(label) ?? { tokens: 0, count: 0 };
    b.tokens += tokens;
    b.count += count;
    buckets.set(label, b);
  };

  for (const m of deriveMessages(events)) {
    switch (m.role) {
      case "system":
        add("system prompt", estimateTokens(m.content));
        break;
      case "user":
        add("user messages", estimateTokens(m.content));
        break;
      case "assistant":
        add("assistant messages", messageTokens(m));
        break;
      case "tool":
        add(`tool results ${m.name}`, estimateTokens(m.content));
        break;
    }
  }

  if (tools.length > 0) add("tool definitions", toolDefinitionTokens(tools), tools.length);

  const estimatedTokens = [...buckets.values()].reduce((n, b) => n + b.tokens, 0);
  const measured = lastUsage(events);
  const parts = [...buckets.entries()]
    .map(([label, b]) => ({
      label,
      tokens: b.tokens,
      share: estimatedTokens > 0 ? b.tokens / estimatedTokens : 0,
      count: b.count,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    parts,
    estimatedTokens,
    window,
    usedShare: window > 0 ? estimatedTokens / window : 0,
    ...(measured && { measuredTokens: measured.inputTokens }),
  };
}

function lastUsage(events: readonly AgentEvent[]): Usage | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "assistant/message" && e.usage) return e.usage;
  }
  return undefined;
}
