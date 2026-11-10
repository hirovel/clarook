import { type AgentEvent, now, type ToolCall } from "./events.js";
import type { EventLog } from "./log.js";

type UnresolvedCall = {
  event: number;
  call: ToolCall;
  recovery?: { event: number; content: string };
  result?: { event: number; content: string };
  execution?: number;
};

/** 无结果只表示缺少证据;不能据此断言工具没有启动或没有副作用。 */
export function unresolvedCalls(
  events: readonly AgentEvent[],
  upTo = events.length,
): UnresolvedCall[] {
  const pending = new Map<string, UnresolvedCall>();
  const latest = new Map<string, string>();
  for (let i = 0; i < upTo; i++) {
    const e = events[i];
    if (e?.type === "assistant/message") {
      for (const call of e.toolCalls) {
        const key = `${i}:${call.id}`;
        pending.set(key, { event: i, call });
        latest.set(call.id, key);
      }
    } else if (e?.type === "tool/executed") {
      const item = pending.get(`${e.callEvent}:${e.callId}`);
      if (item?.call.name === e.name) item.execution = i;
    } else if (e?.type === "tool/result") {
      const key = latest.get(e.callId);
      if (key) {
        const item = pending.get(key);
        if (e.outcome === "unknown" && item) item.result = { event: i, content: e.content };
        else pending.delete(key);
      }
    } else if (e?.type === "tool/unresolved") {
      const item = pending.get(`${e.callEvent}:${e.callId}`);
      if (item) item.recovery = { event: i, content: e.content };
    }
  }
  return [...pending.values()];
}

/** 用户命令的未完成记录,从原有开始/结果配对派生。 */
export function pendingUserShells(events: readonly AgentEvent[]) {
  const shells = new Map<string, Extract<AgentEvent, { type: "ext/event" }>>();
  for (const event of events) {
    if (event.type === "ext/event" && event.source === "shell" && event.kind === "start")
      shells.set(String(event.payload.id), event);
    else if (event.type === "user/shell") shells.delete(event.id);
  }
  return shells;
}

/** 显式恢复或强制退出时记录事实,不触发模型或工具;已有说明不重复追加。 */
export function recordUnresolvedCalls(log: EventLog, reason: "restore" | "exit" = "restore"): void {
  for (const { event, call, recovery, result, execution } of unresolvedCalls(log.events)) {
    if (recovery || result) continue;
    log.append({
      type: "tool/unresolved",
      at: now(),
      callEvent: event,
      callId: call.id,
      name: call.name,
      content:
        execution !== undefined
          ? `An execution result was recorded for this tool call, but no final result for the model was recorded ${reason === "exit" ? "when force exit was requested" : "before the session was restored"}. No automatic retry was performed. Review the execution result and actual state before deciding whether to continue, using the existing tool permissions.`
          : `No result was recorded for this tool call ${reason === "exit" ? "when force exit was requested" : "before the session was restored"}. Its execution outcome is unknown; it may have produced side effects. No automatic retry was performed. Check the actual state before deciding whether to retry or continue, using the existing tool permissions.`,
    });
  }
  // 强制退出保留开始记录,恢复时才补未知结果;退出保存期间晚到的真实结果不会重复投影。
  if (reason === "exit") return;
  // 用户命令同样不能因恢复而重跑;开始记录与最终结果在同一数组内配对。
  for (const [id, event] of pendingUserShells(log.events)) {
    const output = event.payload.output as { file?: string } | undefined;
    const path =
      output?.file && log.recording ? `${log.recording.directory}/${output.file}` : undefined;
    log.append({
      type: "user/shell",
      at: now(),
      id,
      command: String(event.payload.command),
      cwd: String(event.payload.cwd),
      excludeFromContext: event.payload.excludeFromContext === true,
      content: `No result was recorded for this user command before the session was restored. Its execution outcome is unknown; it may have produced side effects or may still be running. No automatic retry was performed.${path ? `\nCaptured partial output: ${path}` : ""}`,
      isError: true,
      status: "Result unknown",
      outcome: "unknown",
    });
  }
}
