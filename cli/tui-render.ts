// 呈现:UI 是事件流的订阅者。每条事件到屏幕的映射都在 render 里;历史回放与新事件走同一个函数。
// 对话流直印:用户、回复、调用、结果;记账不进正文,只在上下文发生了别的工具看不见的事时多一行说明。
// 这里还有子 agent 视图、流式回复与思考的增量绘制、折叠/展开两个显示开关。
import { type Component, Container, Markdown, Spacer } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import { imageSummary } from "../src/images.js";
import { composeContext, requestMessages } from "../src/messages.js";
import { classifyError, type ErrorKind, hintFor } from "../src/providers/errors.js";
import type { ChildInfo } from "../src/subagent.js";
import { systemText } from "../src/system-prompt.js";
import { sameReplayShape } from "../src/tool-replay.js";
import {
  cacheNote,
  callLine,
  changeNote,
  compactionDecisionText,
  errorCardLines,
  predictedCache,
  resultLines,
  resultView,
  thinkingReplayCounts,
  userLine,
} from "./cards.js";
import { renderExtEvent } from "./ext-events.js";
import { compareInputs, requestSnapshot, unchangedTextPrefix } from "./input-comparison.js";
import { fmtMs, fmtTok } from "./inspector-format.js";
import { PROMPT_MARK } from "./terminal-extras.js";
import { c, G, markdownTheme } from "./theme.js";
import { Block } from "./tui-block.js";
import {
  CHILD_TAIL,
  type ChildMode,
  GUIDE,
  PULSE_STEPS,
  type ResultRecord,
  type TuiContext,
} from "./tui-context.js";
import { formatArgs, plainDisplayText, toolCallDetail } from "./tui-format.js";
import { shellScope } from "./tui-shell.js";
import { autoFold, beginStep, refreshStep } from "./tui-steps.js";

/** 散文的最大行宽(列):再宽的屏幕上一行也不超过它,读起来不累;代码与工具输出不受它管。 */
export const PROSE_WIDTH = 96;
/** 正文列:标记列两格。 */
const CONTENT = "  ";

/** 工具结果的屏幕文本。折叠只是显示状态,内容原封不动留在节点里。 */
export function resultText(ctx: TuiContext, r: ResultRecord): string {
  return resultLines(r, {
    folded: ctx.view.foldResults,
    head: ctx.view.foldLines,
    view: resultView(ctx.view.results, r.name),
  }).join("\n");
}

/** 回复的 Markdown:从正文列起,行宽封顶 PROSE_WIDTH。流式回复与回放都用它;setText 换正文。 */
export class ReplyMarkdown implements Component {
  private readonly md: Markdown;

  constructor(text = "") {
    this.md = new Markdown(plainDisplayText(text), 0, 0, markdownTheme, { color: c.ink });
  }

  setText(text: string): void {
    this.md.setText(plainDisplayText(text));
  }

  invalidate(): void {
    this.md.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(10, Math.min(PROSE_WIDTH, width - 4));
    return this.md.render(inner).map((l) => ` ${CONTENT}${l}`);
  }
}

/** Ctrl+O:父的工具结果折叠/展开;子 agent 块在 尾窗 → 全部 → 仅进度 间轮换。 */
export function toggleFold(ctx: TuiContext): void {
  const v = ctx.view;
  v.foldResults = !v.foldResults;
  for (const r of v.resultNodes) r.node.setText(resultText(ctx, r));
  const order: ChildMode[] = ["tail", "all", "progress"];
  v.childMode = order[(order.indexOf(v.childMode) + 1) % order.length] as ChildMode;
  for (const view of ctx.children.views) view.refresh();
  const kids =
    ctx.children.views.length > 0
      ? `; sub-agents: ${v.childMode === "tail" ? "tail" : v.childMode === "all" ? "all" : "progress only"}`
      : "";
  ctx.note(
    c.faint(`· tool results ${v.foldResults ? "folded (Ctrl+O to unfold)" : "unfolded"}${kids}`),
  );
}

export function toggleReasoning(ctx: TuiContext): void {
  const v = ctx.view;
  v.showReasoning = !v.showReasoning;
  for (const r of v.reasoningNodes) r.node.setText(ctx.renderReasoning(r.text, r.kind));
  if (v.reasoningView) v.reasoningView.setText(ctx.renderReasoning(v.reasoningBuffer));
  ctx.note(
    c.faint(v.showReasoning ? "· thinking expanded" : "· thinking collapsed to one line (Ctrl+T)"),
  );
}

/** 回复与思考共用合帧间隔(毫秒):约 30 帧,不在每个增量到达时处理累计全文。 */
const STREAM_FRAME_MS = 33;

/** 把攒着的增量落到屏幕上。 */
function flushStream(ctx: TuiContext): void {
  const v = ctx.view;
  if (v.streamTimer) clearTimeout(v.streamTimer);
  v.streamTimer = undefined;
  if (v.streaming) v.streaming.setText(v.streamBuffer);
  if (v.reasoningView) v.reasoningView.setText(ctx.renderReasoning(v.reasoningBuffer));
  ctx.tui.requestRender();
}

/** 流式回复正文:直接印,Markdown 照常渲染。增量按帧合并。 */
export function streamDelta(ctx: TuiContext, d: string): void {
  const v = ctx.view;
  if (!v.streaming) {
    v.streaming = new ReplyMarkdown();
    ctx.transcript.addChild(v.streaming);
    v.streamBuffer = d;
    flushStream(ctx);
    return;
  }
  v.streamBuffer += d;
  if (!v.streamTimer) v.streamTimer = setTimeout(() => flushStream(ctx), STREAM_FRAME_MS);
}

/** 推理内容不隐藏:thinking 模型的思考过程以淡字实时呈现。 */
export function streamReasoning(ctx: TuiContext, d: string): void {
  const v = ctx.view;
  if (!v.reasoningView) {
    v.reasoningView = new Block("");
    ctx.transcript.addChild(v.reasoningView);
    v.reasoningBuffer = d;
    flushStream(ctx);
    return;
  }
  v.reasoningBuffer += d;
  if (!v.streamTimer) v.streamTimer = setTimeout(() => flushStream(ctx), STREAM_FRAME_MS);
}

// ---------- 子 agent 视图 ----------

export class ChildView {
  readonly block = new Container();
  private readonly progress = new Block("");
  private readonly body = new Block("");
  private readonly lines: string[] = [];
  private steps = 0;
  private toolsUsed = 0;
  private tokens = 0;
  private readonly startedAt = Date.now();
  private finishedAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly ctx: TuiContext,
    readonly info: ChildInfo,
  ) {
    this.block.addChild(this.progress);
    this.block.addChild(this.body);
    // 起始事件(继承的父上下文、任务简报)不重画:父屏幕上已经有它们;只画子自己产生的。
    // 结束即退订:续聊在同一日志上再跑,新事件归新的视图,旧视图定格。
    let directory: string | undefined;
    for (const e of info.log.events) if (e.type === "session/directory") directory = e.cwd;
    this.unsubscribe = info.log.subscribe((e) => {
      if (e.type === "session/directory") directory = e.cwd;
      this.absorb(e, directory);
      this.refresh();
    });
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  get running(): boolean {
    return this.finishedAt === undefined;
  }

  private absorb(e: AgentEvent, cwd: string | undefined): void {
    if (e.type === "assistant/message") {
      this.steps += 1;
      if (e.usage) this.tokens = e.usage.inputTokens;
    }
    if (e.type === "tool/result") this.toolsUsed += 1;
    this.lines.push(...childEventLines(e, cwd).map((l) => GUIDE + l));
  }

  finish(): void {
    this.finishedAt = Date.now();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): void {
    const mode = this.ctx.view.childMode;
    const elapsed = fmtMs((this.finishedAt ?? Date.now()) - this.startedAt);
    const stats = `${this.steps} steps · ${this.toolsUsed} tool calls · ${elapsed}${this.tokens ? ` · last input ${fmtTok(this.tokens)}` : ""}`;
    const who = plainDisplayText(
      `${this.info.id}${this.info.type !== "default" ? ` ${this.info.type}` : ""}${this.info.resumed ? " resumed" : ""}`,
    );
    const status = this.info.state.status;
    const head = this.running
      ? `${c.zhu("●")} ${c.soft(`${who} · running · ${stats}`)}`
      : status === "completed"
        ? `${c.soft(G.ok)} ${c.soft(`${who} · done · ${stats}`)}`
        : status === "stopped"
          ? `${c.soft(G.note)} ${c.soft(`${who} · stopped (${plainDisplayText(this.info.state.reason ?? "termination policy")}) · resumable · ${stats}`)}`
          : `${c.zhu("✗")} ${c.soft(`${who} · partial · ${stats}`)}`;
    this.progress.setText(GUIDE + head);
    let body: string;
    if (mode === "progress" || (!this.running && mode !== "all")) {
      body = GUIDE + c.faint(`sub-session ${this.lines.length} lines · Ctrl+O to expand`);
    } else if (mode === "all") {
      body = this.lines.length > 0 ? this.lines.join("\n") : GUIDE + c.faint("(no output yet)");
      if (this.info.log.path)
        body += `\n${GUIDE}${c.faint(`Log: ${plainDisplayText(this.info.log.path)}`)}`;
    } else {
      const tail = this.lines.slice(-CHILD_TAIL);
      const more =
        this.lines.length > CHILD_TAIL
          ? [GUIDE + c.faint(`… ${this.lines.length} lines in the sub-session · Ctrl+O for all`)]
          : [];
      body = [...tail, ...more].join("\n") || GUIDE + c.faint("(no output yet)");
    }
    this.body.setText(body);
    this.ctx.tui.requestRender();
  }
}

/** 子 agent 开跑时由 task 工具通知:挂到对应调用行下面的槽,没有槽就接在末尾。 */
export function attachChild(ctx: TuiContext, child: ChildInfo): void {
  const view = new ChildView(ctx, child);
  ctx.children.views.push(view);
  const slot = child.callId ? ctx.children.slots.get(child.callId) : undefined;
  if (slot) slot.addChild(view.block);
  else ctx.transcript.addChild(view.block);
  ctx.updateStatus();
}

/** 子 agent 事件的屏幕行(不含引导线),与主屏同一套记号:› » ✓ ✗ ·。 */
export function childEventLines(e: AgentEvent, cwd?: string): string[] {
  switch (e.type) {
    case "session/directory":
      return [c.soft(`· Session directory: ${plainDisplayText(e.cwd)}`)];
    case "user/message":
      return [
        `${c.zhu(G.you)} ${c.ink(plainDisplayText([e.text, imageSummary(e.images)].filter(Boolean).join("\n")))}`,
      ];
    case "assistant/message": {
      const lines: string[] = [];
      if (e.reasoning)
        lines.push(
          ...plainDisplayText(e.reasoning)
            .trim()
            .split("\n")
            .map((l) => c.faint(c.italic(l))),
        );
      if (e.text)
        lines.push(
          ...plainDisplayText(e.text)
            .trim()
            .split("\n")
            .map((l) => c.ink(l)),
        );
      for (const tc of e.toolCalls) {
        lines.push(callLine(tc.name, formatArgs(tc.args, { cwd })));
      }
      if (e.stopReason === "aborted") lines.push(c.faint("— interrupted —"));
      return lines;
    }
    case "tool/result": {
      const mark = e.outcome === "unknown" ? c.jin("?") : e.isError ? c.zhu(G.err) : c.soft(G.ok);
      const body = plainDisplayText(e.content).trim().split("\n");
      const meta = [
        ...(body.length > 1 ? [`${body.length} lines`] : []),
        ...(e.durationMs !== undefined ? [fmtMs(e.durationMs)] : []),
      ];
      return [
        `${mark} ${c.soft(plainDisplayText(e.name))}${meta.length ? c.faint(`  ${meta.join(" · ")}`) : ""}`,
        ...body.map((l) => (e.isError ? c.soft(`  ${l}`) : c.faint(`  ${l}`))),
      ];
    }
    case "user/shell":
      return [
        c.soft(`User shell · ${shellScope(e.excludeFromContext)} · ${e.status}`),
        c.soft(plainDisplayText(e.command)),
        ...plainDisplayText(e.content)
          .trim()
          .split("\n")
          .map((line) => c.faint(`  ${line}`)),
      ];
    case "retry":
      return [
        c.faint(
          `· retry ${e.attempt}: ${e.status ?? ""} ${plainDisplayText(e.error).split("\n")[0]}`,
        ),
      ];
    case "request/error":
      return [c.zhu(`✗ request failed: ${plainDisplayText(e.error).split("\n")[0]}`)];
    case "compaction":
      return [c.jin(`≈ compacted${e.strategy ? ` (${plainDisplayText(e.strategy)})` : ""}`)];
    default:
      return [];
  }
}

// ---------- 主屏:一条事件一段屏幕 ----------

function renderUser(ctx: TuiContext, text: string): void {
  // 用户消息不属于任何一步:挂在根上,折叠永远不碰它。
  ctx.transcript = ctx.root;
  if (ctx.view.firstRun) {
    ctx.root.removeChild(ctx.view.firstRun);
    ctx.view.firstRun = undefined;
  }
  // 提示标记(OSC 133;A)贴在用户消息上:备用屏里 Ctrl+↑ / Ctrl+↓ 在提问之间跳。
  ctx.transcript.addChild(new Spacer(1));
  ctx.transcript.addChild(new Block(PROMPT_MARK + userLine(text)));
  ctx.view.afterUser = true;
}

/** 成功与失败都结束同一段流式显示;失败只保留收到的文字,不合成会话事实。 */
function finishStream(
  ctx: TuiContext,
  e: Pick<
    Extract<AgentEvent, { type: "assistant/message" }>,
    "text" | "reasoning" | "reasoningKind"
  >,
): void {
  const { view: v, transcript } = ctx;
  if (v.streamTimer) clearTimeout(v.streamTimer);
  v.streamTimer = undefined;
  if (v.reasoningView) {
    if (e.reasoning) {
      v.reasoningView.setText(ctx.renderReasoning(e.reasoning, e.reasoningKind));
      v.reasoningNodes.push({
        node: v.reasoningView,
        text: e.reasoning,
        ...(e.reasoningKind && { kind: e.reasoningKind }),
      });
    } else transcript.removeChild(v.reasoningView);
    v.reasoningView = undefined;
    v.reasoningBuffer = "";
  } else if (e.reasoning) {
    const node = new Block(ctx.renderReasoning(e.reasoning, e.reasoningKind));
    v.reasoningNodes.push({
      node,
      text: e.reasoning,
      ...(e.reasoningKind && { kind: e.reasoningKind }),
    });
    transcript.addChild(node);
  }
  if (v.streaming) {
    if (e.text) v.streaming.setText(e.text);
    else transcript.removeChild(v.streaming);
    v.streaming = undefined;
    v.streamBuffer = "";
  } else if (e.text) {
    transcript.addChild(new ReplyMarkdown(e.text));
  }
}

function renderAssistant(
  ctx: TuiContext,
  e: Extract<AgentEvent, { type: "assistant/message" }>,
  cwd: string | undefined,
): void {
  finishStream(ctx, e);
  const { view: v, transcript, req } = ctx;
  v.lastUsage = e.usage;
  if (e.usage) {
    // 缓存命中明显低于预计才说一句;正常命中不出声。
    const note = cacheNote(e.usage, req.predictedAt.get(req.lastTurnIndex));
    if (note) transcript.addChild(new Block(note));
  }
  for (const tc of e.toolCalls) {
    transcript.addChild(new Block(callLine(tc.name, formatArgs(tc.args, { cwd }))));
    // edit/write 的改动内容直接可见:diff 从参数算出,不进日志。代码不折行,超宽截断。
    const detail = toolCallDetail(tc.name, tc.args);
    if (detail) {
      transcript.addChild(
        new Block(
          detail
            .split("\n")
            .map((l) => CONTENT + l)
            .join("\n"),
          { truncate: true },
        ),
      );
    }
    // task 调用行下面留一个槽,子 agent 开跑时把它的块挂进来。
    if (tc.name === "task") {
      const slot = new Container();
      ctx.children.slots.set(tc.id, slot);
      transcript.addChild(slot);
    }
  }
  if (e.stopReason === "aborted") ctx.note(c.faint("— interrupted —"));
  if (e.stopReason === "length")
    ctx.note(
      c.zhu(
        e.toolCalls.length > 0
          ? "· output truncated; tool calls were not executed; the model receives an error for each call"
          : "· response incomplete; output or context limit reached; stopped without automatic continuation",
      ),
    );
}

function renderToolResult(ctx: TuiContext, e: Extract<AgentEvent, { type: "tool/result" }>): void {
  // 可见度按工具定(配置 results);Ctrl+O 切换折叠,内容仍在节点里。工具输出不折行,超宽截断。
  const rec: ResultRecord = {
    name: e.name,
    content: e.content,
    isError: e.isError,
    ...(e.outcome && { outcome: e.outcome }),
    ...(e.durationMs !== undefined && { durationMs: e.durationMs }),
  };
  addResult(ctx, rec);
  const child = ctx.children.views.find((v) => v.info.callId === e.callId && v.running);
  if (child) child.finish();
}

function addResult(ctx: TuiContext, rec: ResultRecord): void {
  const node = new Block(resultText(ctx, rec), { truncate: true });
  ctx.view.resultNodes.push({ node, ...rec });
  ctx.transcript.addChild(node);
}

/**
 * 请求:开一步,投影出这次实际发出的消息(正常步 = 之前事件的投影;摘要请求 = 记录的 body),
 * 与上一次正常步比;有别的工具看不见的变化才印一行说明。全文永远在检视器。
 */
function renderRequest(
  ctx: TuiContext,
  e: Extract<AgentEvent, { type: "request" }>,
  index: number,
): void {
  const { log, agent, req } = ctx;
  req.count += 1;
  req.lastIndex = index;
  req.providersAt.set(req.lastIndex, agent.provider);
  // 账簿:这次请求是新的一步;更早的步按 foldSteps 折起。脉搏记下这次的占用比。
  const step = beginStep(ctx, req.count, req.lastIndex);
  autoFold(ctx);
  const threshold = e.threshold ?? ctx.threshold();
  ctx.view.pulse.push(threshold > 0 ? e.estimatedTokens / threshold : 0);
  if (ctx.view.pulse.length > PULSE_STEPS) ctx.view.pulse.shift();
  const transcript = ctx.transcript;
  // 步与步之间一个空行;用户消息前面已经有了。
  if (!ctx.view.afterUser) transcript.addChild(new Spacer(1));
  ctx.view.afterUser = false;
  transcript.addChild(step.summary);
  const messages = requestMessages(log.events, req.lastIndex);
  const comp = composeContext(log.events, req.lastIndex);
  // 仅去签名 opaque 的实际输入仍与标准投影逐条同形,可沿用来源。
  const aligned = !e.body || sameReplayShape(messages, comp.messages);
  const provenance = aligned ? comp.provenance : undefined;
  const originalOpaque = provenance?.map(({ event }) => {
    const source = log.events[event];
    return source?.type === "assistant/message" ? source.opaque : undefined;
  });
  const note = changeNote({
    n: req.count,
    request: e,
    messages,
    ...(req.lastSent && { previous: req.lastSent }),
    ...(req.lastSent && {
      comparison: compareInputs(
        { ...requestSnapshot(log.events, req.lastTurnIndex), messages: req.lastSent },
        { ...requestSnapshot(log.events, index), messages },
      ),
    }),
    ...(provenance && { provenance }),
    ...(agent.provider.fields?.protocol.startsWith("anthropic") && {
      droppedThinking: thinkingReplayCounts(messages, e.model, originalOpaque).dropped,
    }),
    ...(ctx.model.info.capabilitySource && { limitSource: ctx.model.info.capabilitySource }),
    contextWindow: ctx.model.contextWindow,
  });
  if (note) transcript.addChild(new Block(note));
  req.predictedAt.set(
    req.lastIndex,
    predictedCache(req.lastSent, messages, unchangedTextPrefix(req.lastSent, messages)),
  );
  if (e.reason === "compaction") req.lastCompactionIndex = req.lastIndex;
  else {
    req.lastTurnIndex = req.lastIndex;
    req.lastSent = messages;
  }
}

function renderRequestError(
  ctx: TuiContext,
  e: Extract<AgentEvent, { type: "request/error" }>,
): void {
  if (ctx.view.streaming || ctx.view.reasoningView) {
    finishStream(ctx, { text: ctx.view.streamBuffer, reasoning: ctx.view.reasoningBuffer });
    ctx.transcript.addChild(
      new Block(c.jin("· Partial response · not added to model context · /inspect raw")),
    );
  }
  const { req, log } = ctx;
  const info = ctx.model.info;
  const request = log.events[req.lastIndex];
  const kind = (e.kind ?? classifyError(new Error(e.error))) as ErrorKind;
  const lines = errorCardLines(e, {
    n: req.count,
    providerName: info.providerName,
    ...(request?.type === "request" && { model: request.model }),
    hint: hintFor(kind, { providerName: info.providerName, model: info.model }),
  });
  ctx.transcript.addChild(new Block(lines.join("\n")));
}

function renderCompaction(ctx: TuiContext, e: Extract<AgentEvent, { type: "compaction" }>): void {
  const parts: string[] = [];
  if (e.summary !== undefined)
    parts.push(`summary covers events ${e.coversFrom ?? 1}-${e.coversUpTo}`);
  if (e.cleared?.length) parts.push(`cleared ${e.cleared.length} tool results`);
  const cost = e.usage
    ? `  summary request · ${fmtTok(e.usage.inputTokens)}→${fmtTok(e.usage.outputTokens)} tok · ${fmtMs(e.latencyMs)}`
    : "";
  const who = e.strategy ? ` (${plainDisplayText(e.strategy)})` : "";
  ctx.note(
    `${c.jin(`≈ compacted${who}: ${parts.join(", ")}`)}${c.faint(`${cost}  /compactions to compare original and summary`)}`,
  );
}

/** 一条事件 → 屏幕。历史回放与实时订阅都走这里。 */
export function render(ctx: TuiContext, e: AgentEvent, index: number, cwd?: string): void {
  ctx.usage.add(e);
  switch (e.type) {
    case "session/directory":
      ctx.note(c.soft(`· Session directory: ${plainDisplayText(e.cwd)}`));
      break;
    case "user/message":
      renderUser(ctx, [e.text, imageSummary(e.images)].filter(Boolean).join("\n"));
      break;
    case "user/shell":
      ctx.transcript = ctx.root;
      ctx.view.afterUser = false;
      addResult(ctx, {
        name: `User shell · ${shellScope(e.excludeFromContext)}`,
        content: e.content,
        isError: e.isError,
        ...(e.outcome && { outcome: e.outcome }),
        ...(e.durationMs !== undefined && { durationMs: e.durationMs }),
      });
      break;
    case "assistant/message":
      renderAssistant(ctx, e, cwd);
      break;
    case "tool/result":
      renderToolResult(ctx, e);
      break;
    case "request":
      renderRequest(ctx, e, index);
      break;
    case "retry":
      ctx.transcript.addChild(
        new Block(
          c.faint(
            `· retry ${e.attempt}: ${e.status ?? ""} ${plainDisplayText(e.error).split("\n")[0]}, next attempt in ${fmtMs(e.delayMs)}`,
          ),
        ),
      );
      ctx.tui.requestRender();
      break;
    case "decision":
      if (e.slot === "termination")
        ctx.note(c.soft(`· stopped · ${plainDisplayText(e.reason)} · send to continue`));
      if (e.slot === "steering")
        ctx.note(c.faint(`· steering: injected ${e.injected} (${e.boundary} boundary)`));
      if (e.slot === "execution")
        ctx.note(
          c.faint(
            `· parallel: ${e.parallel} calls at once: ${plainDisplayText(e.tools.join(", "))}`,
          ),
        );
      if (e.slot === "plan")
        ctx.note(
          c.faint(
            `· plan restated ${e.reason === "compacted" ? "after compaction" : `after ${e.steps} steps without an update`}`,
          ),
        );
      if (e.slot === "facts") ctx.note(c.faint(`· ${e.note} changed; told the model`));
      if (e.slot === "compaction")
        ctx.note(c.jin(`· ${plainDisplayText(compactionDecisionText(e))}`));
      break;
    case "request/error":
      renderRequestError(ctx, e);
      break;
    case "compaction":
      renderCompaction(ctx, e);
      break;
    case "context/edit":
      ctx.note(
        c.soft(
          `· edited event #${e.target}.${e.field} (${(e.field === "system" ? systemText(e.value) : e.value).length} chars)`,
        ) + c.faint("\n  original kept · Ctrl+E current context"),
      );
      break;
    case "context/drop": {
      const target = ctx.log.events[e.target];
      const results =
        target?.type === "assistant/message" && target.toolCalls.length > 0
          ? ` with its ${target.toolCalls.length} tool results`
          : "";
      ctx.note(
        c.soft(`· dropped event #${e.target}${results}`) +
          c.faint("\n  original kept · Ctrl+E current context"),
      );
      break;
    }
    case "session/model":
      ctx.note(c.soft(`· model switched to ${e.model}`));
      break;
    case "session/slot":
      // 配置由宿主恢复,切换由命令应用;回放历史不能覆盖当前选定的组合。
      break;
    case "session/recovered":
      ctx.note(
        c.soft(
          `· recovered: dropped ${e.droppedBytes} bytes of a half-written line at the end of the log (the process died mid-write)`,
        ),
      );
      break;
    case "ext/event": {
      if (e.source === "shell" && e.kind === "start") {
        renderUser(
          ctx,
          `User shell · ${shellScope(e.payload.excludeFromContext === true)}\n${e.payload.excludeFromContext ? "!!" : "!"}${String(e.payload.command)}\nCwd: ${String(e.payload.cwd)}`,
        );
        ctx.view.afterUser = false;
        break;
      }
      const r = renderExtEvent(e);
      if (r) ctx.note(c[r.tone](plainDisplayText(r.text)));
      break;
    }
    case "session/interrupt":
    case "session/start":
      break;
    case "session/exit":
      ctx.note(
        c.jin(
          `· force exit requested while ${e.phase === "cleanup" ? "releasing resources" : "stopping work"}. External work may continue.`,
        ),
      );
      break;
    case "tool/unresolved":
      ctx.note(
        c.jin(
          `· ${plainDisplayText(e.name)}: result unknown. Nothing was restarted. /session recovery shows details.`,
        ),
      );
      break;
  }
  const step = ctx.steps.at(-1);
  if (
    step?.folded &&
    (e.type === "assistant/message" || e.type === "request/error" || e.type === "compaction")
  )
    refreshStep(ctx, step);
  ctx.updateStatus();
}
