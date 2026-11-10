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

type ExecutionResult = Pick<
  Extract<AgentEvent, { type: "tool/executed" }>,
  "content" | "isError" | "durationMs" | "outcome"
>;
type ResultPatch = { content?: string; isError?: boolean };

/** 后置只改给模型的正文和错误标记,原执行事实与元数据不变。 */
export type AfterToolCall = (
  context: {
    call: Readonly<ToolCall>;
    args: unknown;
    result: Readonly<ExecutionResult>;
    origin?: Readonly<ApproveOrigin>;
  },
  signal: AbortSignal,
  // biome-ignore lint/suspicious/noConfusingVoidType: 异步观察函数也可不返回替换值。
) => void | ResultPatch | Promise<void | ResultPatch>;

const AFTER_INTERRUPTED = Symbol("after interrupted");

/** 只结束本地等待;两路消费迟到结果,不强制终止扩展代码。 */
function waitForAfter(
  invoke: () => ReturnType<AfterToolCall>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<AfterToolCall>> | typeof AFTER_INTERRUPTED> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(AFTER_INTERRUPTED);
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(AFTER_INTERRUPTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => (signal.aborted ? AFTER_INTERRUPTED : invoke()))
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
  });
}

const INTERRUPTED_NOTICE = "Interrupted by the user; not executed.";
const STORAGE_NOTICE = "Not executed: recording buffer filled while saving was unavailable.";
const interruptedNotice = (signal: AbortSignal) =>
  signal.reason === RECORDING_FULL ? STORAGE_NOTICE : INTERRUPTED_NOTICE;

export function appendResult(log: EventLog, call: ToolCall, result: Executed): void {
  log.append({
    type: "tool/result",
    at: now(),
    callId: call.id,
    name: call.name,
    ...result,
  });
}

type Prepared =
  | { call: ToolCall; immediate: string }
  | { call: ToolCall; tool: Tool; args: unknown; argumentsEvent: number };

type Executed = {
  content: string;
  isError: boolean;
  durationMs?: number;
  outcome?: "unknown";
  executionEvent?: number;
};

async function runOne(
  p: Extract<Prepared, { tool: Tool }>,
  signal: AbortSignal,
  log: EventLog,
  callEvent: number,
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
  const args = structuredClone(p.args) as never;
  let result: Omit<Executed, "executionEvent"> & { durationMs: number };
  try {
    const content = await p.tool.execute(args, {
      signal,
      callId: p.call.id,
      ...(output && { output }),
    });
    result = { content, isError: false, durationMs: Date.now() - startedAt };
  } catch (err) {
    const content = errorMessage(err);
    result = {
      content,
      isError: true,
      durationMs: Date.now() - startedAt,
      ...((err instanceof ToolOutcomeUnknownError || signal.reason === RECORDING_FULL) && {
        outcome: "unknown" as const,
      }),
    };
  }
  // 捕获和保存失败不能改写执行器已经返回的结果。
  if (output && !output.written) {
    output.write(result.content);
    recordEvent(log, "tool/output-source", {
      callId: p.call.id,
      file: output.ref.file,
      source: result.isError ? "error text" : "returned text",
      note: "No separate original output was provided by this tool",
    });
  }
  const executionEvent = log.append({
    type: "tool/executed",
    at: now(),
    callEvent,
    callId: p.call.id,
    name: p.call.name,
    ...result,
    ...(output && {
      output: {
        file: output.ref.file,
        bytes: output.bytes,
        ...(output.ref.missingFrom !== undefined && { missingFrom: output.ref.missingFrom }),
      },
    }),
  });
  await log.checkpoint();
  return { ...result, executionEvent };
}

export async function executeCalls(
  calls: readonly ToolCall[],
  ctx: {
    log: EventLog;
    callEvent: number;
    tools: Tool[];
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
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
    const results = await Promise.all(items.map((p) => runOne(p, signal, ctx.log, ctx.callEvent)));
    await ctx.log.checkpoint(signal?.aborted ? undefined : signal);
    for (const [i, p] of items.entries()) {
      const r = results[i] as Executed;
      let result = r;
      let annotate = r.durationMs !== undefined && r.outcome !== "unknown";
      if (ctx.afterToolCall && r.executionEvent !== undefined && r.outcome !== "unknown") {
        const executed = ctx.log.events[r.executionEvent] as Extract<
          AgentEvent,
          { type: "tool/executed" }
        >;
        const state = executed.isError ? "an error" : "success";
        const prefix = `Tool execution already returned (reported ${state}).`;
        try {
          const after = ctx.afterToolCall;
          const patch = await waitForAfter(
            () =>
              after(
                {
                  call: p.call,
                  args: p.args,
                  result: Object.freeze({
                    content: executed.content,
                    isError: executed.isError,
                    durationMs: executed.durationMs,
                    ...(executed.outcome && { outcome: executed.outcome }),
                  }),
                  ...(ctx.origin && { origin: Object.freeze({ ...ctx.origin }) }),
                },
                signal,
              ),
            signal,
          );
          if (patch !== AFTER_INTERRUPTED && patch !== undefined) {
            if (!patch || typeof patch !== "object" || Array.isArray(patch))
              throw new TypeError("afterToolCall must return a result patch or undefined.");
            const { content, isError } = patch;
            if (content !== undefined && typeof content !== "string")
              throw new TypeError("afterToolCall content must be a string.");
            if (isError !== undefined && typeof isError !== "boolean")
              throw new TypeError("afterToolCall isError must be a boolean.");
            result = { ...r, content: content ?? r.content, isError: isError ?? r.isError };
          }
        } catch (error) {
          if (!signal.aborted)
            result = {
              ...r,
              content: `${prefix} Result post-processing failed: ${errorMessage(error)}. The original execution result is recorded; no automatic tool retry was performed.`,
              isError: true,
            };
          annotate = false;
        }
        // 回调或 patch getter 可同步取消;取消优先于其返回值或异常。
        if (signal.aborted) {
          result = {
            ...r,
            content: `${prefix} Result post-processing was interrupted. The original execution result is recorded; no automatic tool retry was performed.`,
            isError: true,
          };
          annotate = false;
        }
      }
      // 事实附注贴在这条结果上:此前同样的失败有几次、这次比中位耗时慢多少。附注进日志,模型看到的就是它。
      const content = annotate
        ? annotateResult(ctx.log.events, { ...p.call, args: p.args }, result, ctx.facts)
        : result.content;
      appendResult(ctx.log, p.call, { ...result, content });
      if (ctx.log.recording)
        recordEvent(ctx.log, "tool/end", {
          callId: p.call.id,
          isError: result.isError,
          ...(result.outcome && { outcome: result.outcome }),
        });
    }
    await ctx.log.checkpoint(signal?.aborted ? undefined : signal);
  };

  for (const call of calls) {
    // 打断后剩余调用不再执行,但必须逐个补应答。
    if (signal.aborted) {
      await flush();
      appendResult(ctx.log, call, { content: interruptedNotice(signal), isError: true });
      continue;
    }
    const p = await prepare(call);
    if ("immediate" in p) {
      await flush();
      appendResult(ctx.log, call, { content: p.immediate, isError: true });
      continue;
    }
    const parallelSafe = ctx.execution === "parallel" && p.tool.concurrency === "parallel";
    if (!parallelSafe) await flush();
    batch.push(p);
    if (!parallelSafe) await flush();
  }
  await flush();
}
