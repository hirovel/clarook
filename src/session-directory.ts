import { type AgentEvent, now } from "./events.js";
import type { EventLog } from "./log.js";

/** 同一查询供当前运行与历史请求使用,不为旧日志推断目录。 */
export function directoryAt(
  events: readonly AgentEvent[],
  upTo = events.length,
): Extract<AgentEvent, { type: "session/directory" }> | undefined {
  for (let i = Math.min(upTo, events.length) - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "session/directory") return event;
  }
  return undefined;
}

/** 调用方已验证绝对目录且准备成功后,只记录首次绑定与实际变化。 */
export function recordSessionDirectory(log: EventLog, cwd: string): void {
  if (directoryAt(log.events)?.cwd === cwd) return;
  log.append({
    type: "session/directory",
    at: now(),
    cwd,
    environment: `Current session directory: ${cwd}\nRelative tool paths and project resources use this directory. Each bash call starts here; cd affects only this call. Earlier directory descriptions are historical. Saved instructions are unchanged.`,
  });
}
