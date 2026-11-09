// 账簿:每次请求是一步,一步一个容器。最新几步全开,更早的自动折成一行账目(停止原因、调用、用量、缓存命中率、回复首行);
// Shift+PgUp / Shift+PgDn 在请求间选择并把目标滚到视野顶,Enter 展开或折起,Esc 放开光标。
// 正文节点始终保留在容器里;折叠只切换渲染结果,后到的内容不会被旧快照覆盖。
// 请求号与事件号分开标注;这里只使用供应商报告的用量。
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentEvent, StopReason } from "../src/events.js";
import { firstLine } from "./cards.js";
import { fmtTok } from "./inspector-format.js";
import { c, G, selectedText } from "./theme.js";
import { Block } from "./tui-block.js";
import type { StepView, TuiContext } from "./tui-context.js";
import { formatArgs } from "./tui-format.js";

/** 缺省保持展开的最新步数;配置 foldSteps,0 = 从不自动折。 */
export const FOLD_STEPS = 3;

/** 折叠只决定显示什么,不搬走或复制子节点。 */
class StepBlock extends Container {
  constructor(private readonly collapsed: () => Block | undefined) {
    super();
  }

  override render(width: number): string[] {
    const summary = this.collapsed();
    return summary ? summary.render(width) : super.render(width);
  }
}

/** 开一步:新容器挂到根上,之后的节点都进它。 */
export function beginStep(ctx: TuiContext, n: number, requestIndex: number): StepView {
  const block = new StepBlock(() => (step.folded ? step.summary : undefined));
  const step: StepView = {
    n,
    requestIndex,
    block,
    summary: new Block(openHeading(ctx, n, requestIndex, false)),
    folded: false,
    pinned: false,
  };
  ctx.steps.push(step);
  ctx.root.addChild(block);
  ctx.transcript = block;
  return step;
}

/** 一步的账目:从它的 request 事件读到下一次 request 之前。 */
export function stepSummary(ctx: TuiContext, step: StepView): string {
  const events = ctx.log.events;
  const req = events[step.requestIndex];
  let stop: StopReason | undefined;
  let calls = 0;
  let firstCall = "";
  let input = 0;
  let output = 0;
  let cacheRead: number | undefined;
  let reply = "";
  let failed: string | undefined;
  let compacted = false;
  for (let i = step.requestIndex + 1; i < events.length; i++) {
    const e = events[i] as AgentEvent;
    if (e.type === "request") break;
    if (e.type === "assistant/message") {
      stop = e.stopReason;
      calls += e.toolCalls.length;
      const tc = e.toolCalls[0];
      if (tc && !firstCall)
        firstCall = `${G.call} ${tc.name} ${firstLine(formatArgs(tc.args), 40)}`;
      if (e.usage) {
        input += e.usage.inputTokens;
        output += e.usage.outputTokens;
        if (e.usage.cacheReadTokens !== undefined)
          cacheRead = (cacheRead ?? 0) + e.usage.cacheReadTokens;
      }
      if (e.text && !reply) reply = firstLine(e.text, 50);
    } else if (e.type === "request/error") failed = e.kind ?? "error";
    else if (e.type === "compaction") compacted = true;
  }
  const kind =
    req?.type === "request" && req.reason === "compaction"
      ? "summary"
      : stop
        ? {
            end: "replied",
            tool: "tools requested",
            aborted: "interrupted",
            length: "output limit",
          }[stop]
        : "waiting";
  const parts = [
    failed ? c.zhu(`✗ ${failed}`) : kind,
    ...(calls > 0 ? [`${calls} call${calls === 1 ? "" : "s"}`] : []),
    ...(input > 0 ? [`in ${fmtTok(input)} · out ${fmtTok(output)} tok`] : []),
    ...(cacheRead !== undefined && input > 0
      ? [`cache ${Math.round((cacheRead / input) * 100)}%`]
      : []),
    ...(compacted ? ["≈ compacted"] : []),
    ...(reply ? [reply] : firstCall ? [firstCall] : []),
  ];
  return parts.join(" · ");
}

function openHeading(ctx: TuiContext, n: number, index: number, selected: boolean): string {
  const request = ctx.log.events[index];
  const detail =
    request?.type === "request"
      ? ` · ${request.model}${request.reason === "compaction" ? " · compaction" : ""}`
      : "";
  const head = `Request #${n}`;
  return selected
    ? `${selectedText(`${G.cursor} ${head}`)}${c.faint(detail)}`
    : c.faint(`── ${head}${detail}`);
}

function summaryText(ctx: TuiContext, step: StepView, selected: boolean): string {
  if (!step.folded) return openHeading(ctx, step.n, step.requestIndex, selected);
  const head = `Request #${step.n}`;
  const body = stepSummary(ctx, step);
  return selected
    ? `${selectedText(`${G.cursor} ${head}`)}  ${c.ink(body)}`
    : `${c.faint(G.fold)} ${c.soft(head)}  ${c.faint(body)}`;
}

export function foldStep(ctx: TuiContext, step: StepView): void {
  if (step.folded) return;
  step.folded = true;
  refreshStep(ctx, step);
  ctx.tui.requestRender();
}

export function unfoldStep(ctx: TuiContext, step: StepView): void {
  if (!step.folded) return;
  step.folded = false;
  refreshStep(ctx, step);
  ctx.tui.requestRender();
}

/** 新的一步开始时,把最新 keep 步之外的自动折起;用户手动展开过的(pinned)不再折。 */
export function autoFold(ctx: TuiContext): void {
  const keep = ctx.view.foldSteps;
  if (keep <= 0) return;
  const older = ctx.steps.slice(0, Math.max(0, ctx.steps.length - keep));
  for (const s of older) if (!s.folded && !s.pinned) foldStep(ctx, s);
}

/** 同一标题节点在展开与折叠间复用;选择变化时两种状态都更新。 */
export function refreshSummaries(ctx: TuiContext): void {
  for (const step of ctx.steps) refreshStep(ctx, step);
}

/** 新事件只刷新当前请求的摘要;旧请求没有变化,不重新扫描历史。 */
export function refreshStep(ctx: TuiContext, step: StepView): void {
  step.summary.setText(summaryText(ctx, step, ctx.steps[ctx.view.selectedStep ?? -1] === step));
}

/** 光标移一步(delta ±1);没有光标时向前从最后一步起,向后从第一步起。 */
export function selectStep(ctx: TuiContext, delta: 1 | -1): StepView | undefined {
  const n = ctx.steps.length;
  if (n === 0) return undefined;
  const cur = ctx.view.selectedStep;
  let next: number;
  if (cur === undefined) next = delta < 0 ? n - 1 : 0;
  else next = Math.min(n - 1, Math.max(0, cur + delta));
  ctx.view.selectedStep = next;
  refreshSummaries(ctx);
  scrollToStep(ctx, ctx.steps[next] as StepView);
  ctx.updateStatus();
  return ctx.steps[next];
}

export function clearStepSelection(ctx: TuiContext): boolean {
  if (ctx.view.selectedStep === undefined) return false;
  ctx.view.selectedStep = undefined;
  refreshSummaries(ctx);
  ctx.updateStatus();
  return true;
}

/** Enter:折起的展开(记为 pinned,之后不再自动折),展开的折起。 */
export function toggleSelectedStep(ctx: TuiContext): boolean {
  const i = ctx.view.selectedStep;
  const step = i === undefined ? undefined : ctx.steps[i];
  if (!step) return false;
  if (step.folded) {
    unfoldStep(ctx, step);
    step.pinned = true;
  } else {
    foldStep(ctx, step);
    step.pinned = false;
  }
  scrollToStep(ctx, step);
  return true;
}

/** 备用屏:把这一步滚到视野顶。偏移 = 根上它之前所有节点的渲染高度之和。主屏没有滚动,只有光标。 */
export function scrollToStep(ctx: TuiContext, step: StepView): void {
  const scroll = ctx.scroll;
  if (!scroll) return;
  const width = scroll.getContentWidth(ctx.deps.terminal.columns);
  let offset = 0;
  for (const child of ctx.root.children) {
    if (child === step.block) break;
    offset += child.render(width).length;
  }
  // 请求间隔不属于跳转目标;矮窗口只有一两行正文空间时也要先看见标题。
  const leading = step.block.render(width).findIndex((line) => stripTerminalSequences(line).trim());
  if (leading > 0) offset += leading;
  scroll.scrollTo(offset, { disableFollow: true });
  ctx.tui.requestRender();
}
