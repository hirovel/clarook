import { isDeepStrictEqual } from "node:util";
import { type AgentEvent, now } from "./events.js";
import type { EventLog } from "./log.js";
import type { ToolDef } from "./provider.js";

/** 执行器与本地 schema 元数据不属于模型可见声明;比较与捕获共用 JSON 语义。 */
export function modelToolDefinitions(tools: readonly ToolDef[]): ToolDef[] {
  return JSON.parse(
    JSON.stringify(
      tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ),
  );
}

/** 保存模型可见声明,交给 adapter 的对象与历史事实独立。 */
export function captureToolDefinitions(log: EventLog, tools: readonly ToolDef[]): ToolDef[] {
  const definitions = modelToolDefinitions(tools);
  const snapshot = log.events[snapshotBefore(log.events, log.events.length)];
  const previous = snapshot?.type === "tools/snapshot" ? snapshot.tools : undefined;
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
  return createToolDefinitionQuery(events)(requestIndex);
}

/** 单次只读遍历复用已查过的区间;更晚的查询自动重新定位。 */
export function createToolDefinitionQuery(events: readonly AgentEvent[]) {
  let previousIndex = events.length;
  let snapshotIndex = events.length;
  return (requestIndex: number): readonly ToolDef[] | undefined => {
    if (!Number.isInteger(requestIndex)) return undefined;
    const request = events[requestIndex];
    if (request?.type !== "request") return undefined;
    if (request.tools.length === 0) return [];
    // 摘要请求有自己的工具输入;普通目录不能证明它当时用了哪些完整声明。
    if (request.reason === "compaction") return undefined;
    if (requestIndex > previousIndex || snapshotIndex >= requestIndex)
      snapshotIndex = snapshotBefore(events, requestIndex);
    previousIndex = requestIndex;
    const snapshot = events[snapshotIndex];
    const definitions = snapshot?.type === "tools/snapshot" ? snapshot.tools : undefined;
    return definitions &&
      isDeepStrictEqual(
        request.tools,
        definitions.map((tool) => tool.name),
      )
      ? definitions
      : undefined;
  };
}

function snapshotBefore(events: readonly AgentEvent[], before: number): number {
  for (let index = before - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "tools/snapshot") return index;
  }
  return -1;
}
