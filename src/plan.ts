// 计划:模型自己维护的任务状态。它用 plan 工具写整张清单(最新一次覆盖之前的),harness 不替它总结;
// harness 只在两个时机把清单复述到上下文末尾:压缩之后(摘要可能丢了它),以及连续多步没碰它而还有未完成项。
// 复述是追加一条用户消息,旧的留着;前缀不动,缓存不伤。状态本身就是事件日志的一个投影。
import { Type } from "@sinclair/typebox";
import type { AgentEvent } from "./events.js";
import { defineTool, described } from "./tools.js";

export const PLAN_STATUSES = ["pending", "in_progress", "done", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanItem = { id: string; text: string; status: PlanStatus };

/** 复述正文的可读标记;计数通过 decision 事件识别,不猜测用户文本。 */
export const PLAN_MARK = "[plan]";
/** 连续这么多步没碰计划且还有未完成项就复述一次;配置 planReminder,0 = 从不。 */
export const DEFAULT_PLAN_REMINDER = 0;

const MARKS: Record<PlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  done: "[x]",
  cancelled: "[-]",
};

export const planTool = defineTool({
  name: "plan",
  ...described({
    core:
      "Write or rewrite your plan for the current task: a list of steps, each with a status (pending, in_progress, done, cancelled). " +
      "Send the whole list every time; the newest call replaces the previous plan. Keep each step to one line.",
    guidance:
      "Use it for tasks with three or more steps. Mark a step in_progress before starting it and done right after. " +
      "Cancel steps that turned out unnecessary and add the replacement instead of editing history. Skip it for one-step tasks.",
    rules: "ALWAYS keep at most one step in_progress. NEVER leave a finished step marked pending.",
  }),
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({
        id: Type.Optional(Type.String({ description: "stable id; defaults to the position" })),
        text: Type.String(),
        status: Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s))),
      }),
    ),
  }),
  async execute(args) {
    const items = normalize(args.items);
    return `plan: ${summary(items)}`;
  },
});

function normalize(items: { id?: string; text: string; status: PlanStatus }[]): PlanItem[] {
  return items.map((it, i) => ({ id: it.id ?? String(i + 1), text: it.text, status: it.status }));
}

export function summary(items: PlanItem[]): string {
  const count = (s: PlanStatus) => items.filter((i) => i.status === s).length;
  return [
    `${items.length} step${items.length === 1 ? "" : "s"}`,
    `${count("done")} done`,
    `${count("in_progress")} in progress`,
    `${count("pending")} pending`,
    ...(count("cancelled") > 0 ? [`${count("cancelled")} cancelled`] : []),
  ].join(" · ");
}

/** 当前生效的计划:最后一次执行成功的 plan 调用的参数。没有就是 undefined。 */
export function planState(events: readonly AgentEvent[]): PlanItem[] | undefined {
  const calls = new Map<string, { id?: string; text: string; status: PlanStatus }[]>();
  let plan: PlanItem[] | undefined;
  for (const e of events) {
    if (e.type === "assistant/message") {
      for (const tc of e.toolCalls) {
        if (tc.name !== "plan") continue;
        const items = (tc.args as { items?: unknown } | undefined)?.items;
        if (Array.isArray(items)) calls.set(tc.id, items as { text: string; status: PlanStatus }[]);
      }
    } else if (e.type === "tool/result" && e.name === "plan" && !e.isError) {
      const items = calls.get(e.callId);
      if (items) plan = normalize(items);
    }
  }
  return plan;
}

export function planOpen(items: PlanItem[]): boolean {
  return items.some((i) => i.status === "pending" || i.status === "in_progress");
}

/** 复述文本:一行一步,状态用方括号记号。 */
export function planText(items: PlanItem[]): string {
  return [
    `${PLAN_MARK} ${summary(items)}`,
    ...items.map((i) => `${MARKS[i.status]} ${i.id}. ${i.text}`),
  ].join("\n");
}

/** 自上次 plan 调用或上次复述以来过了几步(助手消息数)。 */
export function stepsSincePlan(events: readonly AgentEvent[]): number {
  let steps = 0;
  for (const e of events) {
    if (e.type === "assistant/message") {
      steps += 1;
      if (e.toolCalls.some((tc) => tc.name === "plan")) steps = 0;
    } else if (e.type === "decision" && e.slot === "plan") steps = 0;
  }
  return steps;
}
