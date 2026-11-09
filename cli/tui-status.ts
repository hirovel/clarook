// 运行界面的固定状态与输入提示。只投影已有事件与状态,不改变 Agent 的执行策略。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { contextSize } from "../src/compaction.js";
import { fmtCostApprox } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { DEFAULT_STATUS_WIDGETS, type StatusStyle, type StatusWidget } from "../src/status-bar.js";
import { shortcutLines } from "./cards.js";
import { fmtTok } from "./inspector-format.js";
import { renderStatusLayout } from "./status-layout.js";
import { c, G } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { shellDraft, shellInput } from "./tui-shell.js";

/** 按优先级取完整片段;次要信息放不下就留在检视器,不截出半个操作。 */
function fitParts(parts: string[], width: number): string {
  let out = "";
  for (const part of parts.filter((part) => visibleWidth(part) > 0)) {
    const next = out ? `${out} · ${part}` : part;
    if (visibleWidth(next) <= width) out = next;
    else if (!out) out = truncateToWidth(part, width, "…");
  }
  return out;
}

/** 八格只画已取得 usage 基准的容量比例;半格以下用细块表示,不把 5% 画成空。 */
function capacityMeter(used: number, window: number): string {
  const units = Math.round(Math.min(1, Math.max(0, used / window)) * 64);
  const full = Math.floor(units / 8);
  const partial = units % 8;
  const ink = "█".repeat(full) + (partial ? ("▏▎▍▌▋▊▉"[partial - 1] ?? "") : "");
  return c.jin(ink) + c.faint("░".repeat(8 - full - Number(partial > 0)));
}

export class RuntimeStatus implements Component {
  private phase = "Ready";
  private work: string | undefined;
  private outcome: "failed" | "local-failed" | "interrupted" | undefined;
  private pending = new Map<string, string>();
  private unknown = 0;
  constructor(private readonly context: () => TuiContext) {}

  begin(message: string): void {
    this.work = message;
    this.phase = message === "thinking" ? "Waiting for model" : message;
    this.outcome = undefined;
    this.pending.clear();
    this.unknown = 0;
  }
  end(): void {
    this.work = undefined;
  }

  observe(e: AgentEvent): void {
    switch (e.type) {
      case "user/message":
        this.outcome = undefined;
        break;
      case "request":
        this.unknown = 0;
        this.phase = e.reason === "compaction" ? "Compacting context" : "Waiting for model";
        this.pending.clear();
        this.outcome = undefined;
        break;
      case "assistant/message":
        this.pending = new Map(e.toolCalls.map((t) => [t.id, t.name]));
        if (e.stopReason === "aborted") this.outcome = "interrupted";
        break;
      case "tool/result":
        this.pending.delete(e.callId);
        if (e.outcome === "unknown") this.unknown++;
        break;
      case "user/shell":
        if (e.outcome === "unknown") this.unknown++;
        else if (e.isError && this.outcome !== "interrupted") this.outcome = "local-failed";
        break;
      case "retry":
        this.phase = `Retry ${e.attempt} · waiting ${Math.ceil(e.delayMs / 1000)}s`;
        break;
      case "request/error":
        this.outcome = "failed";
        break;
      case "session/interrupt":
        this.outcome = "interrupted";
        break;
      case "tool/unresolved":
        this.unknown++;
        break;
    }
  }

  invalidate(): void {}
  render(width: number, preview?: { style?: StatusStyle; widgets?: string[] }): string[] {
    const ctx = this.context();
    const { agent, view } = ctx;
    const inner = Math.max(1, width - 2);
    const logs = [ctx.log, ...ctx.children.views.map((v) => v.info.log)];
    const unsaved =
      logs.find((log) => log.recording?.full) ?? logs.find((log) => log.recording?.error);
    const busy = agent.running || this.work !== undefined;
    let label = "Ready";
    if (!busy && this.unknown)
      label = `${this.outcome === "interrupted" ? "Interrupted · " : ""}${this.unknown} ${this.unknown === 1 ? "result" : "results"} unknown`;
    else if (this.outcome === "failed") label = "Request failed";
    else if (this.outcome === "local-failed") label = "Shell failed";
    else if (this.outcome === "interrupted") label = agent.running ? "Interrupting" : "Interrupted";
    else if (ctx.approval.prompt) label = "Waiting for approval";
    else if (busy) {
      const names = [...new Set(this.pending.values())];
      label = names.length
        ? `Tools · ${names.join(", ")} (${this.pending.size} pending)`
        : view.streaming
          ? "Receiving reply"
          : view.reasoningView
            ? "Receiving thinking"
            : this.phase;
    }
    const urgent = Boolean(
      this.outcome === "failed" || this.outcome === "local-failed" || ctx.approval.prompt,
    );
    const mark = busy ? G.running : G.idle;
    const state = (urgent ? c.zhu : busy ? c.ink : c.soft)(`${mark} ${label}`);
    const elapsed =
      busy && view.turnStartedAt !== undefined
        ? `${Math.round((Date.now() - view.turnStartedAt) / 1000)}s`
        : "";
    const children = ctx.children.views.filter((v) => v.running).length;
    const selected =
      view.selectedStep !== undefined
        ? `request ${view.selectedStep + 1}/${ctx.steps.length}`
        : ctx.scroll && !ctx.scroll.isFollowingEnd
          ? "Reading history"
          : "";
    const first = wrapTextWithAnsi(
      [
        state,
        !busy && this.unknown ? c.jin("/session recovery") : "",
        ctx.deps.inputs?.error ? c.zhu("Inputs not saved · /session inputs") : "",
        this.outcome === "failed" ? c.soft("/inspect raw") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      inner,
    );
    const total = ctx.usage.totals();
    const size = contextSize(ctx.log.events, ctx.agent.tools);
    const used = size.tokens;
    const threshold = Math.max(1, ctx.threshold());
    const trigger = ctx.compaction.trigger ?? "threshold";
    // 带用量基准仍是估算;窗口与压缩触发点是两件事,不把手动模式写成自动倒计时。
    const context =
      size.basis === "usage"
        ? `Context ~${fmtTok(used)}/${fmtTok(ctx.model.contextWindow)}`
        : `Text + tools ~${fmtTok(used)} · total unmeasured`;
    let contextMeter = "";
    if (size.basis === "usage" && inner >= 90 && ctx.model.contextWindow > 0) {
      contextMeter = capacityMeter(used, ctx.model.contextWindow);
    }
    let compaction =
      trigger === "threshold"
        ? `auto-compact ~${fmtTok(threshold)}`
        : trigger === "manual"
          ? "compact manual"
          : `remind ~${fmtTok(threshold)}`;
    if (used >= threshold && trigger !== "threshold") compaction = "/compact suggested";
    const pulse =
      view.pulse.length > 1
        ? view.pulse
            .map((ratio) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.max(0, Math.round(ratio * 7)))])
            .join("")
        : "";
    const usage = view.lastUsage;
    const cache = usage
      ? usage.cacheReadTokens !== undefined && usage.inputTokens > 0
        ? `last cache ${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}%`
        : "last cache n/a"
      : ctx.req.count > 0
        ? "last cache n/a"
        : "";
    const style = preview?.style ?? ctx.deps.statusStyle ?? "rail";
    const widgets = preview?.widgets ?? ctx.deps.statusWidgets ?? DEFAULT_STATUS_WIDGETS;
    const values: Partial<Record<StatusWidget, string>> = {
      context: `${context}${style === "classic" && contextMeter ? ` · ${contextMeter}` : ""}`,
      model: `model ${ctx.model.info.model}`,
      effort: `effort ${agent.effort ?? "Auto (omitted)"}`,
      ...(cache && { cache }),
      ...(compaction && { compaction }),
      ...(total.requests && {
        tokens: `session ↑${fmtTok(total.inputTokens)} ↓${fmtTok(total.outputTokens)}`,
      }),
      ...(pulse && { trend: pulse }),
      ...(agent.queued && {
        queue: `${agent.pending.filter((p) => p.paused).length} paused · ${agent.pending.filter((p) => !p.paused).length} queued`,
      }),
      ...(elapsed && { elapsed }),
      ...(children && { children: `${children} sub-agents` }),
      ...(selected && { position: selected }),
    };
    const gaps = logs.reduce(
      (n, log) =>
        n +
        log.events.filter(
          (e) => e.type === "ext/event" && e.source === "recording" && e.kind === "body/gap",
        ).length,
      0,
    );
    const saving = unsaved
      ? unsaved.recording?.full
        ? `${agent.running ? "Stopping" : "Work paused"} · recording buffer full · Ctrl+S retry`
        : "Not saved · Ctrl+S retry · auto retry active"
      : gaps
        ? `${gaps} recording gap(s) · Ctrl+R details`
        : undefined;
    const important = [
      ...first.map((line) => ` ${line}`),
      ...(saving ? wrapTextWithAnsi(c.zhu(saving), inner).map((line) => ` ${line}`) : []),
    ];
    const cost = ctx.deps.showCostEstimate
      ? wrapTextWithAnsi(
          c.faint(
            total.cost !== undefined
              ? `main cost est. ${fmtCostApprox(total.cost)}`
              : `main cost est. unavailable (${total.costStatus})`,
          ),
          inner,
        ).map((line) => ` ${line}`)
      : [];
    // 备用屏给标题两行、正文至少两行,其余留给当前编辑器和操作提示。
    // 主屏回滚文档和设置预览不受此预算影响;不修改用户的小组件选择。
    const budget =
      ctx.scroll && !preview
        ? Math.max(
            1,
            ctx.deps.terminal.rows -
              ctx.editor.render(width).length -
              inputHintLines(ctx, width).length -
              4,
          )
        : Number.POSITIVE_INFINITY;
    // 严重故障优先保留恢复入口,不让普通 Ready 行挤掉保存失败。
    const required =
      saving && important.length > budget
        ? [
            ` ${c.zhu(
              truncateToWidth(
                unsaved
                  ? `${unsaved.recording?.full ? "Buffer full" : "Not saved"} · Ctrl+S retry`
                  : "Recording gaps · Ctrl+R details",
                inner,
              ),
            )}`,
            ...first.map((line) => ` ${line}`),
          ].slice(0, budget)
        : important.slice(0, budget);
    const remaining = Math.max(0, budget - required.length);
    if (!remaining && !saving && widgets.some((id) => values[id as StatusWidget])) {
      const last = required.length - 1;
      required[last] = truncateToWidth(`${required[last]}${c.faint(" · status shortened")}`, width);
    }
    const extra =
      cost.length <= remaining
        ? cost
        : remaining > 0
          ? [` ${c.faint(truncateToWidth("Cost not shown: short window", inner))}`]
          : [];
    return [
      ...required,
      ...renderStatusLayout(style, widgets, values, width, remaining - extra.length),
      ...extra,
    ];
  }
}

/** 每次渲染读编辑器状态,提示与 Enter 的真实行为保持一致。 */
export class InputHints implements Component {
  constructor(private readonly context: () => TuiContext) {}
  invalidate(): void {}
  render(width: number): string[] {
    return inputHintLines(this.context(), width);
  }
}

/** 状态栏与提示使用同一份实际行数,不另存高度。 */
function inputHintLines(ctx: TuiContext, width: number): string[] {
  const text = ctx.editor.getExpandedText();
  const shell = shellDraft(ctx, text);
  const history = ctx.view.selectedStep !== undefined || (ctx.scroll && !ctx.scroll.isFollowingEnd);
  const step = ctx.steps[ctx.view.selectedStep ?? -1];
  const boundary = ctx.slots.state.steering === "turn" ? "after turn" : "next step";
  const send = ctx.agent.localRunning
    ? "Wait or Esc first · draft kept"
    : text.startsWith("/")
      ? "Enter command"
      : ctx.agent.running
        ? `Enter ${boundary}`
        : "Enter send";
  let parts: string[];
  if (shell) {
    const selected = (label: string, excluded: boolean) =>
      shell.excludeFromContext === excluded ? c.jin(c.bold(`[${label}]`)) : c.soft(label);
    // 按完整操作换行,窄屏不能把按键和作用拆开。
    const actions = ctx.agent.running
      ? ["Wait / Esc interrupt", "draft kept"]
      : ["Enter run", "Shift+Tab scope", "Esc chat"];
    const actionLines: string[] = [];
    for (const action of actions) {
      const previous = actionLines.at(-1);
      const next = previous ? `${previous} · ${action}` : action;
      if (previous && visibleWidth(next) <= Math.max(1, width - 2))
        actionLines[actionLines.length - 1] = next;
      else actionLines.push(action);
    }
    const lines = [
      `${c.jin(c.bold("SHELL"))} ${c.faint("· No API request")}`,
      `${selected("Include context", false)}  ${selected("Exclude context", true)}`,
      ...actionLines,
    ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)).map((row) => ` ${row}`));
    if (ctx.draftImages.length)
      lines.push(
        ` ${c.faint(truncateToWidth(`${ctx.draftImages.length} image(s) kept for chat · not sent to shell`, Math.max(1, width - 2)))}`,
      );
    return lines;
  } else if (ctx.editor.isShowingAutocomplete())
    parts = ["↑↓ choose", "Tab complete", "Esc dismiss"];
  else if (ctx.agent.localRunning) parts = ["Esc interrupt shell", send];
  else if (history)
    parts = [
      text || ctx.draftImages.length
        ? send
        : step
          ? `Enter ${step.folded ? "expand" : "collapse"}`
          : "",
      "Esc return live",
      "PgUp/PgDn page",
      ...(step ? ["Ctrl+R received"] : []),
      ...(ctx.steps.length ? ["Shift+PgUp/PgDn request"] : []),
    ];
  else if (ctx.view.shellAsText && shellInput(text)) parts = ["Chat text", send, "/shell to run"];
  else if (text.startsWith("/")) parts = [send, "Ctrl+K palette"];
  else if (ctx.agent.running) {
    parts = ["Esc interrupt", send, "Alt+Enter follow-up"];
  } else
    parts = [
      send,
      ctx.agent.queued || ctx.deps.inputs?.error ? "/session inputs" : "Ctrl+K palette",
      "Ctrl+R requests",
      "/help",
    ];
  const attachments = ctx.inputReading
    ? "Preparing paste…"
    : ctx.draftImages.length
      ? `${ctx.draftImages.length} image(s) ${shell ? "kept for chat · not sent to shell" : "attached · Alt+I inspect/remove · Enter sends"}`
      : "";
  return [
    ...(attachments ? [` ${c.jin(truncateToWidth(attachments, Math.max(1, width - 2)))}`] : []),
    ` ${c.faint(fitParts(parts, Math.max(1, width - 2)))}`,
  ];
}

/** 帮助占用独立焦点,不把反复查看的说明追加到工作记录。 */
export function openShortcutHelp(ctx: TuiContext): void {
  let offset = 0;
  let page = 1;
  let length = 0;
  const help: Component = {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const lines = shortcutLines()
        .slice(1)
        .flatMap((line) => wrapTextWithAnsi(line, inner));
      page = Math.max(1, ctx.deps.terminal.rows - 5);
      length = lines.length;
      offset = Math.min(offset, Math.max(0, length - page));
      return [
        c.bold(c.ink(" Shortcuts")),
        "",
        ...lines.slice(offset, offset + page).map((line) => ` ${line}`),
        "",
        c.faint(` ↑↓ scroll · Esc close · ${Math.min(length, offset + page)}/${length}`),
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) ctx.dialog.close();
      else {
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        if (matchesKey(data, "down")) offset = Math.min(Math.max(0, length - page), offset + 1);
        if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - page);
        if (matchesKey(data, "pageDown"))
          offset = Math.min(Math.max(0, length - page), offset + page);
        ctx.tui.requestRender();
      }
    },
  };
  ctx.dialog.open(help);
}
