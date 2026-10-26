import { Value } from "@sinclair/typebox/value";
import type { ApproveDecision } from "./approval.js";
import {
  type CompactionStrategy,
  contextTokens,
  estimateAfter,
  type PreservationPolicy,
} from "./compaction.js";
import { type CompactionAcceptance, DEFAULT_COMPACTION_SETTINGS } from "./compaction-presets.js";
import { type AgentEvent, now, type ToolCall } from "./events.js";
import { completeRecorded, recordEvent, toolOutput } from "./exchange.js";
import { annotateResult, DEFAULT_FACTS, dateNote, type FactsConfig } from "./facts.js";
import type { EventLog } from "./log.js";
import { deriveMessages, type Message } from "./messages.js";
import { DEFAULT_PLAN_REMINDER, planOpen, planState, planText, stepsSincePlan } from "./plan.js";
import type { AssistantTurn, EffortLevel, Provider, ToolDef } from "./provider.js";
import { errorMessage, isContextOverflow } from "./providers/errors.js";
import { RECORDING_FULL } from "./recording.js";
import { type Tool, ToolOutcomeUnknownError, validateArgs } from "./tools.js";

// ---------- 策略槽(全部是开放接口,内置实现无特权,自定义实现从外部注入) ----------

/** 终止策略:每个 step 结束后询问。返回 null 继续,返回字符串 = 停下的理由。 */
export type TerminationPolicy = (state: { steps: number }) => string | null;

/** 缺省不设步数上限,循环到模型不再调工具为止。 */
export const untilIdle: TerminationPolicy = () => null;

/** 显式步数上限。 */
export function maxSteps(limit: number): TerminationPolicy {
  return ({ steps }) => (steps >= limit ? `step limit ${limit} reached` : null);
}

/** 插话策略:在给定边界要不要排空留言队列。 */
export type SteeringPolicy = (boundary: "step" | "turn") => boolean;

/** 缺省在步边界注入。 */
export const steer: SteeringPolicy = () => true;

/** 只在 turn 结束时投递。 */
export const queueToTurnEnd: SteeringPolicy = (boundary) => boundary === "turn";

/** 谁在问:子 agent 的调用带上自己的名字,审批提示据此标明来源。主会话不带。 */
export type ApproveOrigin = { agent: string };

/** 审批策略:执行前询问;拒绝以错误结果回喂。异步交互使用当前轮信号取消等待。 */
export type ApprovePolicy = (
  call: ToolCall,
  origin?: ApproveOrigin,
  signal?: AbortSignal,
) => ApproveDecision | Promise<ApproveDecision>;

/** 缺省不弹确认;隔离由运行环境负责。 */
export const allowAll: ApprovePolicy = () => true;

/**
 * 执行策略:sequential = 一批调用逐个跑(默认,行为最可预测);
 * parallel = 声明了并行安全的相邻调用同时跑(只读工具批量读取时省时间),其余仍逐个。
 * 结果按调用顺序落盘,两种策略下模型看到的序列一致。
 */
export type ExecutionPolicy = "sequential" | "parallel";

// ---------- runTurn(会话编排;换循环形态 = 用同一批原语另写一个函数) ----------

export type TurnOutcome = "idle" | "aborted" | { stopped: string };

export type TurnDeps = {
  log: EventLog;
  provider: Provider;
  tools: Tool[] | (() => readonly Tool[]);
  slots?: {
    termination?: TerminationPolicy;
    steering?: SteeringPolicy;
    approve?: ApprovePolicy;
    execution?: ExecutionPolicy;
    /**
     * 组装槽:事件数组 → 发给模型的消息。缺省就是 deriveMessages;给了就用它的结果发请求,
     * 差异部分记进 request.body(前缀投影 + 尾部),检视器仍能逐字节重建。扩展可在末尾追加一条提醒之类。
     */
    assemble?: (events: readonly AgentEvent[]) => Message[];
  };
  /** 排空留言队列,返回待注入的用户消息。注入时点由 steering 决定;边界告诉队列该放哪些。 */
  drainQueue?: (
    boundary: "step" | "turn",
  ) => (string | { text: string; inputId: string; images?: import("./images.js").ImageInput[] })[];
  signal?: AbortSignal;
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  /** 非空 SSE 行的实时观察回调;完整响应独立保存到会话附件。 */
  onRaw?: (line: string) => void;
  onRequest?: (body: string) => void;
  /** 强度级别。给函数则每次请求前取值,会话中切换下一请求即生效。缺省不传。 */
  effort?: EffortLevel | (() => EffortLevel | undefined);
  /** 压缩配置:给了就启用自动触发与溢出恢复。 */
  compaction?: CompactionConfig;
  /** 只执行一次手动压缩;若期间有新输入排队,压缩后沿同一 turn 继续处理。 */
  manualCompaction?: string;
  /** 运行这个 turn 的 agent 名(子 agent 用);审批提示据此标明是谁在问。主会话不填。 */
  agent?: string;
  /** 事实附注的开关(重复失败、慢调用、日期变化);缺省全开。 */
  facts?: FactsConfig;
  /** 计划复述:连续这么多步没碰计划且还有未完成项就复述一次;0 = 关闭超时复述(缺省)。 */
  planReminder?: number;
};

export type CompactionTrigger = "threshold" | "manual" | "remind";
export const COMPACTION_TRIGGERS: CompactionTrigger[] = ["threshold", "manual", "remind"];

export type CompactionConfig = {
  strategy: CompactionStrategy;
  window: number;
  /**
   * 阈值 = window − reserveTokens(绝对余量制)。
   * 余量的用途:装下一次模型输出 + 摘要调用的开销,不随窗口变大而变大。
   */
  reserveTokens?: number;
  /** 额外的窗口比例触发线;0 或未设置表示关闭,与余量线取较早者。 */
  ratio?: number;
  preservation?: PreservationPolicy;
  /** complete 接受完整摘要;其它模式还要求组合后的上下文变小。 */
  acceptance?: CompactionAcceptance;
  /**
   * 什么时候压:threshold(缺省)= 每次请求前占用超阈值就压;manual = 只在 /compact 时压;
   * remind = 不自动压,界面到阈值提示一行。三档下溢出恢复都会强制压缩一次。
   */
  trigger?: CompactionTrigger;
  /** 识别 provider 的上下文溢出错误。默认按常见错误文案匹配。 */
  isOverflow?: (err: Error) => boolean;
};

const DEFAULT_RESERVE = DEFAULT_COMPACTION_SETTINGS.compactionReserve;

/**
 * 自动压缩阈值 = window − reserve,但余量不许吃掉超过一半窗口:小窗口(或演示用的假窗口)下
 * 阈值否则会变成负数,每一步都触发压缩。显式比例线可更早触发,两者取较早者。
 */
export function compactionThreshold(
  window: number,
  reserveTokens = DEFAULT_RESERVE,
  ratio = 0,
): number {
  const reserveThreshold = Math.max(Math.floor(window / 2), window - reserveTokens);
  return ratio > 0 ? Math.min(reserveThreshold, Math.floor(window * ratio)) : reserveThreshold;
}

const defaultIsOverflow = (err: Error): boolean => isContextOverflow(err);

/**
 * 给策略用的 provider 包装:策略每发一次模型请求,日志里就多一条 reason 为 compaction 的 request
 * (以及其间的 retry / request/error)。摘要请求把整段上下文发给了模型,和正常步一样必须可见。
 * 响应不是 assistant/message —— 它不进投影;随后的 compaction 事件就是它的结果。
 */
export function recordingProvider(
  log: EventLog,
  provider: Provider,
  opts: {
    threshold?: number;
    onRaw?: (line: string) => void;
    onRequest?: (body: string) => void;
  } = {},
): Provider {
  return {
    model: provider.model,
    ...(provider.wire && { wire: provider.wire.bind(provider) }),
    async complete(messages, tools, callOpts = {}) {
      log.append({
        type: "request",
        at: now(),
        model: provider.model,
        messages: messages.length,
        tools: tools.map((t) => t.name),
        estimatedTokens: contextTokens(log.events),
        ...(opts.threshold !== undefined && { threshold: opts.threshold }),
        reason: "compaction",
        ...(callOpts.maxTokens !== undefined && { maxTokens: callOpts.maxTokens }),
        body: describeRequestBody(log.events, messages),
      });
      return completeRecorded(log, provider, messages, tools, {
        ...callOpts,
        ...(opts.onRaw && { onRaw: opts.onRaw }),
        ...(opts.onRequest && { onRequest: opts.onRequest }),
      });
    },
  };
}

type CompactionOutcome = { applied: boolean; reduced: boolean };

/** 应用摘要和腾出空间是两件事;溢出恢复只能依赖后者。 */
async function compactIfNeeded(
  deps: TurnDeps,
  cfg: CompactionConfig,
  force: boolean,
  instructions?: string,
): Promise<CompactionOutcome> {
  const threshold = compactionThreshold(cfg.window, cfg.reserveTokens, cfg.ratio);
  // 触发用实测优先的口径;进展门两边都用估算,口径一致才可比。
  if (!force && contextTokens(deps.log.events) <= threshold)
    return { applied: false, reduced: false };
  const before = estimateAfter(deps.log.events);
  const noProgress = (reason: "no-result" | "no-gain") => {
    deps.log.append({
      type: "decision",
      at: now(),
      slot: "compaction",
      reason,
      images: deriveMessages(deps.log.events).some((m) => m.role === "user" && !!m.images?.length),
    });
    return { applied: false, reduced: false };
  };
  let payload: Awaited<ReturnType<CompactionStrategy>>;
  try {
    payload = await cfg.strategy({
      events: deps.log.events,
      window: cfg.window,
      targetTokens: threshold,
      provider: recordingProvider(deps.log, deps.provider, {
        threshold,
        ...(deps.onRaw && { onRaw: deps.onRaw }),
        ...(deps.onRequest && { onRequest: deps.onRequest }),
      }),
      ...(cfg.preservation && { preservation: cfg.preservation }),
      ...(instructions && { instructions }),
      ...(deps.signal && { signal: deps.signal }),
    });
  } catch (err) {
    if (deps.signal?.aborted) return { applied: false, reduced: false };
    throw err;
  }
  if (deps.signal?.aborted) return { applied: false, reduced: false };
  if (!payload) return noProgress("no-result");
  const reduced = estimateAfter(deps.log.events, payload) < before;
  if (!reduced && (!payload.summary?.trim() || (cfg.acceptance ?? "complete") !== "complete"))
    return noProgress("no-gain");
  deps.log.append({ type: "compaction", at: now(), ...payload });
  await deps.log.checkpoint(deps.signal);
  return { applied: true, reduced };
}

const LENGTH_NOTICE =
  "Not executed: the response was cut off by the output token limit, so the arguments may be incomplete. Issue this tool call again.";
const INTERRUPTED_NOTICE = "Interrupted by the user; not executed.";
const STORAGE_NOTICE = "Not executed: recording buffer filled while saving was unavailable.";
const interruptedNotice = (signal: AbortSignal) =>
  signal.reason === RECORDING_FULL ? STORAGE_NOTICE : INTERRUPTED_NOTICE;

/**
 * 跑一个 turn:从当前日志出发,循环 step 直到无事可欠(模型不调工具且队列为空)、
 * 被打断、或终止策略叫停。所有状态变化都以事件落盘,函数本身不持有状态。
 */
export async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {
  const { log, provider, signal, onDelta, onReasoning } = deps;
  const termination = deps.slots?.termination ?? untilIdle;
  const steering = deps.slots?.steering ?? steer;
  const approve = deps.slots?.approve ?? allowAll;
  const execution = deps.slots?.execution ?? "sequential";
  const drainQueue = deps.drainQueue ?? (() => []);
  const facts = { ...DEFAULT_FACTS, ...deps.facts };
  const planReminder = deps.planReminder ?? DEFAULT_PLAN_REMINDER;
  let steps = 0;
  let skipAutoCompaction = false;

  if (deps.manualCompaction !== undefined) {
    if (!deps.compaction) throw new Error("Compaction is not configured");
    if (signal?.aborted) return "aborted";
    const compacted = await compactIfNeeded(deps, deps.compaction, true, deps.manualCompaction);
    if (signal?.aborted) return "aborted";
    if (compacted.applied) restatePlan(log, "compacted", steps);
    const queued = drainQueue("turn");
    if (queued.length === 0) return "idle";
    inject(log, "turn", queued);
    skipAutoCompaction = true;
  }

  let overflowRecovered = false;
  let requestReason: "turn" | "overflow-retry" = "turn";
  while (true) {
    if (signal?.aborted) return "aborted";
    // 自动压缩检查:每次模型请求前,占用超阈值即压;manual 与 remind 不在这里动手,溢出时另有兜底。
    if (
      !skipAutoCompaction &&
      deps.compaction &&
      (deps.compaction.trigger ?? "threshold") === "threshold"
    ) {
      const compacted = await compactIfNeeded(deps, deps.compaction, false);
      if (signal?.aborted) return "aborted";
      if (compacted.applied) restatePlan(log, "compacted", steps);
    }
    skipAutoCompaction = false;
    // 日期变了就说一句;和其它注入一样只追加到末尾。
    if (facts.date) {
      const note = dateNote(log.events);
      if (note) {
        log.append({ type: "decision", at: now(), slot: "facts", note: "date" });
        log.append({ type: "user/message", at: now(), text: note });
      }
    }

    // 请求事件:正文不落盘,它就是此刻的投影;记下规模与口径,检视器按需原样重建。
    // 组装槽换了投影时,差异部分记进 body,重建仍然逐字节。
    // 定义与执行器取同一版快照,服务端在请求中途更新清单不会替换已发出调用的实现。
    const tools = (typeof deps.tools === "function" ? deps.tools() : deps.tools).map((tool) => ({
      ...tool,
      parameters: Value.Clone(tool.parameters),
    }));
    const defs: ToolDef[] = tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    const assemble = deps.slots?.assemble;
    const messages = assemble ? assemble(log.events) : deriveMessages(log.events);
    const body = assemble ? describeRequestBody(log.events, messages) : undefined;
    const cfg = deps.compaction;
    const effort = typeof deps.effort === "function" ? deps.effort() : deps.effort;
    log.append({
      type: "request",
      at: now(),
      model: provider.model,
      messages: messages.length,
      tools: defs.map((d) => d.name),
      estimatedTokens: contextTokens(log.events),
      ...(cfg && { threshold: compactionThreshold(cfg.window, cfg.reserveTokens, cfg.ratio) }),
      reason: requestReason,
      ...(effort && { effort }),
      ...(body && (body.tail.length > 0 || body.prefixEvents !== log.events.length) && { body }),
    });
    requestReason = "turn";
    const startedAt = Date.now();

    let turn: AssistantTurn;
    try {
      turn = await completeRecorded(log, provider, messages, defs, {
        ...(onDelta && { onDelta }),
        ...(onReasoning && { onReasoning }),
        ...(signal && { signal }),
        ...(deps.onRaw && { onRaw: deps.onRaw }),
        ...(deps.onRequest && { onRequest: deps.onRequest }),
        ...(effort && { effort }),
      });
    } catch (err) {
      if (signal?.aborted) return "aborted";
      // 溢出恢复:压缩取得进展才许重试,且只重试一次。
      const overflow = cfg && (cfg.isOverflow ?? defaultIsOverflow)(err as Error);
      if (!overflow || overflowRecovered) throw err;
      overflowRecovered = true;
      const progressed = await compactIfNeeded(deps, cfg, true);
      if (signal?.aborted) return "aborted";
      if (!progressed.reduced) throw err;
      restatePlan(log, "compacted", steps);
      requestReason = "overflow-retry";
      continue;
    }
    log.append({
      type: "assistant/message",
      at: now(),
      ...turn,
      latencyMs: Date.now() - startedAt,
    });
    await log.checkpoint(signal?.aborted ? undefined : signal);
    steps += 1;

    if (turn.stopReason === "aborted" || (signal?.aborted && turn.stopReason === "end"))
      return "aborted";

    if (turn.stopReason === "length") {
      //:截断响应的调用一个都不执行,逐个补错误应答(协议要求每个 call 有应答)。
      for (const call of turn.toolCalls) appendResult(log, call, LENGTH_NOTICE, true);
    } else if (turn.stopReason === "tool") {
      await executeCalls(turn.toolCalls, {
        log,
        tools,
        approve,
        execution,
        facts,
        ...(signal && { signal }),
        ...(deps.agent && { origin: { agent: deps.agent } }),
      });
      if (signal?.aborted) return "aborted";
    }

    // step 边界。审批等待发生在上面的执行阶段,此处才排队列 —— 留言永不落进确认窗口(硬规矩)。
    // 计划久未更新且还有未完成项:复述一次,算作这一步边界的注入。
    let injected = steering("step") ? inject(log, "step", drainQueue("step")) : 0;
    if (
      turn.stopReason === "tool" &&
      planReminder > 0 &&
      stepsSincePlan(log.events) >= planReminder &&
      restatePlan(log, "stale", steps)
    )
      injected += 1;

    if (turn.stopReason === "end") {
      if (injected === 0 && steering("turn")) injected = inject(log, "turn", drainQueue("turn"));
      if (injected === 0) return "idle"; // 无事可欠,turn 结束
    }

    const reason = termination({ steps });
    if (reason !== null) {
      log.append({ type: "decision", at: now(), slot: "termination", steps, reason });
      return { stopped: reason };
    }
  }
}

/** 把模型自己写的计划复述到末尾(有计划且有未完成项才复述)。决定先于内容落盘。返回是否复述了。 */
function restatePlan(log: EventLog, reason: "compacted" | "stale", steps: number): boolean {
  const plan = planState(log.events);
  if (!plan || !planOpen(plan)) return false;
  log.append({ type: "decision", at: now(), slot: "plan", reason, steps });
  log.append({ type: "user/message", at: now(), text: planText(plan) });
  return true;
}

/** 注入留言。决定先于内容落盘:检视器读到 decision 就知道随后几条 user/message 是插话而非新 turn。 */
function inject(
  log: EventLog,
  boundary: "step" | "turn",
  texts: (
    | string
    | { text: string; inputId: string; images?: import("./images.js").ImageInput[] }
  )[],
): number {
  if (texts.length === 0) return 0;
  log.append({ type: "decision", at: now(), slot: "steering", boundary, injected: texts.length });
  for (const text of texts)
    log.append({
      type: "user/message",
      at: now(),
      ...(typeof text === "string" ? { text } : text),
    });
  return texts.length;
}

/**
 * 把一次请求的消息表示成"前缀投影 + 尾部":找最长的事件前缀,其投影是 messages 的前缀,
 * 剩下的消息原样记为 tail。正常步的 tail 为空;压缩摘要请求的 tail 是那条摘要指示。
 * 紧凑描述用于投影比较;实际适配器输入另存附件,不依赖未来投影实现重建。
 */
export function describeRequestBody(
  events: readonly AgentEvent[],
  messages: Message[],
): { prefixEvents: number; tail: Message[] } {
  const same = (a: Message, b: Message) => JSON.stringify(a) === JSON.stringify(b);
  for (let k = events.length; k >= 0; k--) {
    const derived = deriveMessages(events.slice(0, k));
    if (derived.length > messages.length) continue;
    if (derived.every((m, i) => same(m, messages[i] as Message))) {
      return { prefixEvents: k, tail: messages.slice(derived.length) };
    }
  }
  return { prefixEvents: 0, tail: messages };
}

function appendResult(
  log: EventLog,
  call: ToolCall,
  content: string,
  isError: boolean,
  durationMs?: number,
  outcome?: "unknown",
): void {
  log.append({
    type: "tool/result",
    at: now(),
    callId: call.id,
    name: call.name,
    content,
    isError,
    ...(durationMs !== undefined && { durationMs }),
    ...(outcome && { outcome }),
  });
}

type Prepared =
  | { call: ToolCall; immediate: string }
  | { call: ToolCall; tool: Tool; args: unknown };

type Executed = { content: string; isError: boolean; durationMs?: number; outcome?: "unknown" };

async function runOne(
  p: Extract<Prepared, { tool: Tool }>,
  signal: AbortSignal,
  log: EventLog,
): Promise<Executed> {
  // 审批与前一批执行都可能等待;真正调用执行器前重新检查取消。
  if (signal.aborted) return { content: interruptedNotice(signal), isError: true };
  const startedAt = Date.now();
  const output = toolOutput(log, p.call.id, p.call.name);
  if (log.recording)
    recordEvent(log, "tool/start", { callId: p.call.id, name: p.call.name, args: p.args });
  try {
    await log.checkpoint(signal);
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  if (signal.aborted) return { content: interruptedNotice(signal), isError: true };
  const finish = async (result: Executed): Promise<Executed> => {
    if (output) {
      await log.checkpoint();
      // 并行工具各自完成即保存;模型结果仍按派发顺序追加,不让慢工具吞掉已完成证据。
      recordEvent(log, "tool/finished", {
        callId: p.call.id,
        bytes: output.bytes,
        ...result,
        ...(output.ref.missingFrom !== undefined && { missingFrom: output.ref.missingFrom }),
      });
      await log.checkpoint();
    }
    return result;
  };
  try {
    const content = await p.tool.execute(p.args as never, {
      signal,
      callId: p.call.id,
      ...(output && { output }),
    });
    if (output && !output.written) {
      output.write(content);
      recordEvent(log, "tool/output-source", {
        callId: p.call.id,
        source: "returned text",
        note: "No separate original output was provided by this tool",
      });
    }
    return finish({ content, isError: false, durationMs: Date.now() - startedAt });
  } catch (err) {
    const content = errorMessage(err);
    if (output && !output.written) {
      output.write(content);
      recordEvent(log, "tool/output-source", {
        callId: p.call.id,
        source: "error text",
        note: "No separate original output was provided by this tool",
      });
    }
    //:执行失败也是结果。打断导致的失败同样如实记录。
    return finish({
      content,
      isError: true,
      durationMs: Date.now() - startedAt,
      ...((err instanceof ToolOutcomeUnknownError || signal.reason === RECORDING_FULL) && {
        outcome: "unknown" as const,
      }),
    });
  }
}

async function executeCalls(
  calls: ToolCall[],
  ctx: {
    log: EventLog;
    tools: Tool[];
    approve: ApprovePolicy;
    execution: ExecutionPolicy;
    facts: FactsConfig;
    signal?: AbortSignal;
    origin?: ApproveOrigin;
  },
): Promise<void> {
  const signal = ctx.signal ?? new AbortController().signal;

  // 准备阶段永远按顺序:找工具、审批、校验。审批是人的决定,不能并发弹出。
  const prepare = async (call: ToolCall): Promise<Prepared> => {
    const tool = ctx.tools.find((t) => t.name === call.name);
    if (!tool) return { call, immediate: `Unknown tool "${call.name}".` };
    const decision = await ctx.approve(call, ctx.origin, signal);
    if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
    const allowed = typeof decision === "boolean" ? decision : decision.allowed;
    if (!allowed) {
      const reason = typeof decision === "object" ? decision.reason : undefined;
      return {
        call,
        immediate: reason ? `The user denied this call: ${reason}` : "The user denied this call.",
      };
    }
    const checked = validateArgs(tool.parameters, call.args);
    if (!checked.ok) return { call, immediate: checked.error };
    return { call, tool, args: checked.value };
  };

  // 并行批:相邻的、都声明了并行安全的调用。结果等整批完成后按顺序落盘。
  let batch: Extract<Prepared, { tool: Tool }>[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    if (items.length > 1) {
      ctx.log.append({
        type: "decision",
        at: now(),
        slot: "execution",
        parallel: items.length,
        tools: items.map((p) => p.call.name),
      });
    }
    const results = await Promise.all(items.map((p) => runOne(p, signal, ctx.log)));
    await ctx.log.checkpoint(signal?.aborted ? undefined : signal);
    items.forEach((p, i) => {
      const r = results[i] as Executed;
      // 事实附注贴在这条结果上:此前同样的失败有几次、这次比中位耗时慢多少。附注进日志,模型看到的就是它。
      const content =
        r.durationMs === undefined || r.outcome === "unknown"
          ? r.content
          : annotateResult(ctx.log.events, p.call, r, ctx.facts);
      appendResult(ctx.log, p.call, content, r.isError, r.durationMs, r.outcome);
      if (ctx.log.recording)
        recordEvent(ctx.log, "tool/end", {
          callId: p.call.id,
          isError: r.isError,
          ...(r.outcome && { outcome: r.outcome }),
        });
    });
    await ctx.log.checkpoint(signal?.aborted ? undefined : signal);
  };

  for (const call of calls) {
    // 打断后剩余调用不再执行,但必须逐个补应答。
    if (signal.aborted) {
      await flush();
      appendResult(ctx.log, call, interruptedNotice(signal), true);
      continue;
    }
    const p = await prepare(call);
    if ("immediate" in p) {
      await flush();
      appendResult(ctx.log, call, p.immediate, true);
      continue;
    }
    const parallelSafe = ctx.execution === "parallel" && p.tool.concurrency === "parallel";
    if (!parallelSafe) await flush();
    batch.push(p);
    if (!parallelSafe) await flush();
  }
  await flush();
}
