// 事实附注:模型自己算不出来、代码能算的确定性事实,贴在产生它的那条事件上。
// 不做状态栏:每步重写一条状态消息会让它之后的缓存失效,持久追加又会堆一串过时的状态;
// 贴在事件上的附注只出现在新增的那条消息里,前缀一个字不动。
// 三种事实:同一工具同样参数此前失败过几次;这次调用比本会话该工具的中位耗时慢得多;日期变了。
// 每种都能在配置里关掉(defaults.facts)。
import type { AgentEvent, ToolCall } from "./events.js";

export type FactsConfig = { repeats?: boolean; slow?: boolean; date?: boolean };
export const DEFAULT_FACTS: Required<FactsConfig> = { repeats: true, slow: true, date: true };

/** 慢调用的判据:至少 30 秒,且超过本会话该工具中位耗时的五倍;样本少于三个不评判。 */
export const SLOW_FLOOR_MS = 30_000;
export const SLOW_FACTOR = 5;
export const SLOW_MIN_SAMPLES = 3;

const argsKey = (args: unknown): string => JSON.stringify(args ?? null);

/** 同一工具、同样最终参数此前失败过几次;准备事实覆盖原模型参数。 */
export function priorFailures(events: readonly AgentEvent[], call: ToolCall): number {
  const key = argsKey(call.args);
  const calls = new Map<string, { name: string; key: string }>();
  let n = 0;
  for (const e of events) {
    if (e.type === "assistant/message") {
      for (const tc of e.toolCalls) calls.set(tc.id, { name: tc.name, key: argsKey(tc.args) });
    } else if (e.type === "tool/arguments") {
      calls.set(e.callId, { name: e.name, key: argsKey(e.args) });
    } else if (e.type === "tool/result" && e.isError && e.outcome !== "unknown") {
      const c = calls.get(e.callId);
      if (c && c.name === call.name && c.key === key) n += 1;
    }
  }
  return n;
}

function fmtSeconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** 这次调用比本会话该工具的中位耗时慢得多时的一句话;正常时 undefined。 */
export function slowNote(
  events: readonly AgentEvent[],
  name: string,
  durationMs: number,
): string | undefined {
  const samples: number[] = [];
  for (const e of events)
    if (e.type === "tool/result" && e.name === name && e.durationMs !== undefined)
      samples.push(e.durationMs);
  if (samples.length < SLOW_MIN_SAMPLES) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  if (durationMs < SLOW_FLOOR_MS || durationMs <= SLOW_FACTOR * median) return undefined;
  return `this ${name} call took ${fmtSeconds(durationMs)}; the median for ${name} in this session is ${fmtSeconds(median)}`;
}

/** 给一条工具结果加附注。附注在正文之后,一行方括号;没有事实就原样返回。 */
export function annotateResult(
  events: readonly AgentEvent[],
  call: ToolCall,
  result: { content: string; isError: boolean; durationMs?: number },
  cfg: FactsConfig = DEFAULT_FACTS,
): string {
  const notes: string[] = [];
  if (cfg.repeats && result.isError) {
    const n = priorFailures(events, call);
    if (n > 0)
      notes.push(
        `${call.name} failed with exactly these arguments ${n} time${n === 1 ? "" : "s"} before in this session`,
      );
  }
  if (cfg.slow && result.durationMs !== undefined) {
    const s = slowNote(events, call.name, result.durationMs);
    if (s) notes.push(s);
  }
  return notes.length > 0 ? `${result.content}\n\n[note: ${notes.join("; ")}]` : result.content;
}

/** 日期变了(相对上一次请求)时的一句话;第一次请求或同一天 undefined。 */
export function dateNote(events: readonly AgentEvent[], now = new Date()): string | undefined {
  let last: string | undefined;
  for (const e of events) if (e.type === "request") last = e.at;
  if (!last) return undefined;
  const today = now.toISOString().slice(0, 10);
  return last.slice(0, 10) === today ? undefined : `The date is now ${today}.`;
}
