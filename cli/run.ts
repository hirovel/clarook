// 一次性模式:跑一个 turn 就退出。策略 A/B 的执行器。
// 用法:pnpm once -- "任务" [--json] [--model X] [--effort L] [--compaction llm|clear|pipeline]
//                 [--max-steps N] [--resume 文件 | --continue] [--system-prompt 文件] [--append-system-prompt 文件]
// stdout:最终回复文本;--json 时输出结构化结果。非零退出码 = 请求失败。
import { Agent } from "../src/agent.js";
import { policyApprove } from "../src/approval.js";
import { usageTotals } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { errorMessage } from "../src/providers/errors.js";
import { getSetting, SETTINGS } from "../src/settings.js";
import { setupSnapshot } from "../src/setup.js";
import { expandFileRefs } from "./attachments.js";
import {
  beginSession,
  bootstrap,
  parseCommonArgs,
  resolveApproval,
  sessionsDir,
  settingsFromArgs,
  USAGE,
} from "./bootstrap.js";
import { prepareSessionRuntime } from "./session-runtime.js";
import { recordSessionSetup } from "./session-setup.js";

let args: ReturnType<typeof parseCommonArgs>;
try {
  args = parseCommonArgs(process.argv.slice(2));
} catch (err) {
  console.error(errorMessage(err));
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const prompt = args.rest.join(" ").trim();
if (!prompt) {
  console.error(USAGE);
  process.exit(2);
}

const boot = bootstrap();
try {
  args = boot.resolve(args);
} catch (err) {
  console.error(errorMessage(err));
  process.exit(2);
}
let choice: ReturnType<typeof boot.choose>;
try {
  choice = boot.choose(args.model);
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

const { log, sessionFile } = beginSession(args, choice, process.cwd(), sessionsDir(boot.config));
// 事件流输出(--events):每条事件一行 JSON,与会话文件逐字节相同;给外部程序订阅内核的全部状态变化。
if (args.events) log.subscribe((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
log.subscribe((e) => {
  if (e.type === "ext/event" && e.source === "skills" && e.kind === "load-error")
    console.error(String(e.payload.message));
});
let runtime: Awaited<ReturnType<typeof prepareSessionRuntime>>;
let agent: Agent;
const recordings = new Set<typeof log>();
const recordingOffs: (() => void)[] = [];
const watchSaving = (source: typeof log) => {
  if (recordings.has(source)) return;
  recordings.add(source);
  let shownError: string | undefined;
  let shownFull = false;
  const off = source.recording?.subscribe(() => {
    const recording = source.recording;
    if (!recording?.error) {
      shownError = undefined;
      shownFull = false;
    } else if (recording.full && !shownFull) {
      console.error(
        `Recording buffer full (${source.path}); stopping current work. Fix saving before starting new work.`,
      );
      shownFull = true;
    } else if (!recording.full && recording.error !== shownError)
      console.error(
        `Saving failed (${source.path}): ${recording.error}. Work continues; retrying storage every second. Unsaved data may be lost on exit.`,
      );
    shownError = recording?.error;
  });
  if (off) recordingOffs.push(off);
};
watchSaving(log);
try {
  const prepared = await prepareSessionRuntime({
    boot,
    args,
    log,
    sessionFile,
    slots: () => agent.slots,
    current: () => ({
      provider: agent.provider,
      modelLocator: `${choice.providerName}/${choice.model}`,
      tools: agent.tools,
    }),
    onChild: (child) => watchSaving(child.log),
  });
  if (!prepared) throw new Error("Session preparation cancelled.");
  runtime = prepared;
  runtime.activate();
} catch (error) {
  console.error(errorMessage(error));
  await log.checkpoint();
  if (log.recording?.error) console.error(`Saving failed: ${log.recording.error}`);
  log.recording?.dispose();
  process.exit(2);
}
const approvalCfg = resolveApproval(args, boot.config);
const resolvedSettings = settingsFromArgs(args);
const values = setupSnapshot(SETTINGS, (def) => getSetting(resolvedSettings, def.key));
values.model = `${runtime.choice.providerName}/${runtime.choice.model}`;
values.extensions = [...args.extensions];
if (typeof approvalCfg === "object") values.approval = structuredClone(approvalCfg);
if (args.systemPromptFile) values.systemPromptFile = args.systemPromptFile;
if (args.appendSystemPromptFile) values.appendSystemPromptFile = args.appendSystemPromptFile;
recordSessionSetup(log, {
  values,
  tools: runtime.tools.map((tool) => tool.name),
  descriptions: structuredClone(runtime.toolPrompts.descriptions ?? {}),
});
agent = new Agent({
  log,
  provider: runtime.choice.provider,
  tools: () => runtime.tools.filter((tool) => !args.disabledTools?.includes(tool.name)),
  compaction: runtime.compaction,
  ...(args.facts && { facts: args.facts }),
  ...(args.planReminder !== undefined && { planReminder: args.planReminder }),
  slots: {
    ...runtime.slots,
    ...(args.approve === "ask" && {
      approve: () => ({
        allowed: false,
        reason: "one-shot mode with --approve ask; no one to ask",
      }),
    }),
    ...(typeof approvalCfg === "object" && {
      approve: policyApprove(approvalCfg, undefined, runtime.cwd),
    }),
  },
  ...(args.effort && { effort: args.effort }),
  ...(!args.json && !args.events && { onDelta: (d: string) => process.stdout.write(d) }),
});

const startIndex = log.events.length;
try {
  const outcome = await agent.prompt(expandFileRefs(prompt, runtime.cwd).text);
  const fresh = log.events.slice(startIndex);
  const last = [...fresh].reverse().find((e) => e.type === "assistant/message");
  const text = last?.type === "assistant/message" ? last.text : "";
  if (args.json) {
    const summary = summarize(fresh, text, outcome, sessionFile, choice.model);
    // 事件流模式下摘要也是一行,type 字段区分;否则缩进打印。
    console.log(
      args.events
        ? JSON.stringify({ type: "summary", ...summary })
        : JSON.stringify(summary, null, 2),
    );
  } else if (args.events) {
    console.error(`[session: ${sessionFile}]`);
  } else {
    if (!text.endsWith("\n")) process.stdout.write("\n");
    if (typeof outcome === "object") console.error(`[loop stopped: ${outcome.stopped}]`);
    console.error(`[session: ${sessionFile}]`);
  }
} catch (err) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: errorMessage(err), sessionFile }, null, 2));
  } else console.error(`request failed: ${errorMessage(err)}`);
  process.exitCode = 1;
} finally {
  try {
    await runtime.dispose();
  } finally {
    for (const source of recordings) {
      await source.checkpoint();
      source.recording?.dispose();
    }
    for (const off of recordingOffs) off();
  }
}

function summarize(
  events: AgentEvent[],
  text: string,
  outcome: Awaited<ReturnType<Agent["prompt"]>>,
  file: string,
  model: string,
) {
  let steps = 0;
  let requests = 0;
  let toolCalls = 0;
  for (const e of events) {
    if (e.type === "request") requests++;
    if (e.type === "assistant/message") {
      steps++;
      toolCalls += e.toolCalls.length;
    }
  }
  const totals = usageTotals(events, () => choice.price);
  return {
    ok: true,
    model,
    outcome: typeof outcome === "string" ? outcome : `stopped:${outcome.stopped}`,
    steps,
    requests,
    toolCalls,
    retries: events.filter((e) => e.type === "retry").length,
    compactions: events.filter((e) => e.type === "compaction").length,
    usage: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
    },
    ...(args.showCostEstimate &&
      totals.cost !== undefined && {
        estimatedCostUsd: Number(totals.cost.toFixed(6)),
      }),
    ...(args.showCostEstimate && { estimatedCostStatus: totals.costStatus }),
    text,
    sessionFile: file,
  };
}
