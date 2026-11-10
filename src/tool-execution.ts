// 工具执行的准备、审批、调度和原始输出归同一个 module,循环只交付调用及其固定身份。
import { type AgentEvent, now, type ToolCall } from "./events.js";
import { recordEvent, toolOutput } from "./exchange.js";
import { annotateResult, type FactsConfig } from "./facts.js";
import type { EventLog } from "./log.js";
import type { ApproveOrigin, ApprovePolicy, ExecutionPolicy } from "./loop.js";
import { errorMessage } from "./providers/errors.js";
import { RECORDING_FULL } from "./recording.js";
import { prepareArgs, type Tool, ToolOutcomeUnknownError } from "./tools.js";

/** 前置函数只通过返回值改参;观察输入不可变,原模型调用独立保留。 */
export type BeforeToolCall = (
  context: { call: Readonly<ToolCall>; args: unknown; origin?: ApproveOrigin },
  signal: AbortSignal,
  // biome-ignore lint/suspicious/noConfusingVoidType: 异步观察函数也可不返回替换值。
) => void | { args: unknown } | Promise<void | { args: unknown }>;

const INTERRUPTED_NOTICE = "Interrupted by the user; not executed.";
const STORAGE_NOTICE = "Not executed: recording buffer filled while saving was unavailable.";
const interruptedNotice = (signal: AbortSignal) =>
  signal.reason === RECORDING_FULL ? STORAGE_NOTICE : INTERRUPTED_NOTICE;

export function appendResult(
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
  | { call: ToolCall; tool: Tool; args: unknown; argumentsEvent: number };

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
    recordEvent(log, "tool/start", {
      callId: p.call.id,
      name: p.call.name,
      argumentsEvent: p.argumentsEvent,
    });
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
    const content = await p.tool.execute(structuredClone(p.args) as never, {
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

export async function executeCalls(
  calls: readonly ToolCall[],
  ctx: {
    log: EventLog;
    callEvent: number;
    tools: Tool[];
    beforeToolCall?: BeforeToolCall;
    approve: ApprovePolicy;
    execution: ExecutionPolicy;
    facts: FactsConfig;
    signal?: AbortSignal;
    origin?: ApproveOrigin;
  },
): Promise<void> {
  const signal = ctx.signal ?? new AbortController().signal;

  // 准备阶段永远按顺序:找工具、校验、审批。审批与执行共用有效参数,不能并发弹出。
  const prepare = async (call: ToolCall): Promise<Prepared> => {
    const tool = ctx.tools.find((t) => t.name === call.name);
    if (!tool) return { call, immediate: `Unknown tool "${call.name}".` };
    let checked: ReturnType<typeof prepareArgs>;
    try {
      checked = prepareArgs(tool.parameters, call.args);
      if (!checked.ok) return { call, immediate: checked.error };
      if (ctx.beforeToolCall) {
        const replacement = await ctx.beforeToolCall(
          { call, args: checked.value, ...(ctx.origin && { origin: ctx.origin }) },
          signal,
        );
        if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
        if (replacement !== undefined) {
          checked = prepareArgs(tool.parameters, replacement.args);
          if (!checked.ok) return { call, immediate: checked.error };
        }
      }
    } catch (error) {
      if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
      return { call, immediate: `Tool argument preparation failed: ${errorMessage(error)}` };
    }
    if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
    const argumentsEvent = ctx.log.append({
      type: "tool/arguments",
      at: now(),
      callEvent: ctx.callEvent,
      callId: call.id,
      name: call.name,
      args: checked.value,
    });
    const prepared = ctx.log.events[argumentsEvent] as Extract<
      AgentEvent,
      { type: "tool/arguments" }
    >;
    // 准备事实观察者可同步取消;审批只读该固定事实,不共享 hook 的返回对象。
    if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
    const decision = await ctx.approve(
      Object.freeze({ ...call, args: prepared.args }),
      ctx.origin,
      signal,
    );
    if (signal.aborted) return { call, immediate: interruptedNotice(signal) };
    const allowed = typeof decision === "boolean" ? decision : decision.allowed;
    if (!allowed) {
      const reason = typeof decision === "object" ? decision.reason : undefined;
      return {
        call,
        immediate: reason ? `The user denied this call: ${reason}` : "The user denied this call.",
      };
    }
    return { call, tool, args: prepared.args, argumentsEvent };
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
