import { isDeepStrictEqual } from "node:util";
import { type AgentEvent, now } from "./events.js";
import type { EventLog } from "./log.js";
import type { ToolDef } from "./provider.js";

/** 保存模型可见的 JSON 声明;执行器与本地 schema 元数据不属于声明事实。 */
export function captureToolDefinitions(log: EventLog, tools: readonly ToolDef[]): ToolDef[] {
  const definitions: ToolDef[] = JSON.parse(
    JSON.stringify(
      tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ),
  );
  const previous = definitionsBefore(log.events, log.events.length);
  // 对象键序不改变声明,目录及 schema 中的数组顺序仍是实际请求的一部分。
  if (!previous || !isDeepStrictEqual(previous, definitions))
    log.append({ type: "tools/snapshot", at: now(), tools: definitions });
  // append 自己隔离并冻结事实;交给 adapter 的对象独立且仍可修改。
  return definitions;
}

/** 只查询该请求之前的事实;缺少历史证据时不借用后来的目录。 */
export function toolDefinitionsForRequest(
  events: readonly AgentEvent[],
  requestIndex: number,
): readonly ToolDef[] | undefined {
  if (!Number.isInteger(requestIndex)) return undefined;
  const request = events[requestIndex];
  if (request?.type !== "request") return undefined;
  if (request.tools.length === 0) return [];
  // 摘要请求有自己的工具输入;普通目录不能证明它当时用了哪些完整声明。
  if (request.reason === "compaction") return undefined;
  return definitionsBefore(events, requestIndex);
}

function definitionsBefore(
  events: readonly AgentEvent[],
  before: number,
): readonly ToolDef[] | undefined {
  for (let index = before - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "tools/snapshot") return event.tools;
  }
  return undefined;
}
