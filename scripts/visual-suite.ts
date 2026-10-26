// 视觉专项:脚本化 provider 驱动界面,每个场景一份 HTML,浏览器里逐张核对。
// 用法:FORCE_COLOR=1 pnpm exec tsx scripts/visual-suite.ts [输出目录,缺省 .preview/visual]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { noProviderChoice, systemPromptFor } from "../cli/bootstrap.js";
import type { Bootstrap } from "../cli/bootstrap.js";
import { applyPreset, parseCommonArgs } from "../cli/args.js";
import { startTuiSession } from "../cli/tui-session.js";
import type { KernelConfig } from "../src/config.js";
import { setSetting } from "../src/settings.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { llmSummarize } from "../src/compaction.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, CompleteOptions, Provider } from "../src/provider.js";
import type { Message } from "../src/messages.js";
import { ProviderError } from "../src/providers/errors.js";
import { createTaskTool } from "../src/subagent.js";
import { defineTool, type Tool } from "../src/tools.js";
import { createBashTool } from "../cli/tools/bash.js";
import { readTool } from "../cli/tools/fs.js";
import { ansiToHtmlDocument } from "../tests/helpers/ansi-html.js";
import { stripAnsi, VirtualTerminal } from "../tests/helpers/virtual-terminal.js";
import { createLogic } from "../tests/helpers/mcp-server.mjs";

const outDir = process.argv[2] ?? join(".preview", "visual");
mkdirSync(outDir, { recursive: true });
// 看门狗:某个场景卡住就报出名字退出,不让脚本挂死。
let scene = "start";
const watchdog = setInterval(() => {
  console.error(`watchdog: stuck in scene ${scene}`);
  process.exit(2);
}, 60_000);
watchdog.unref();
const W = 110;
const tick = () => new Promise((r) => setTimeout(r, 5));
const divider = (t: string) => ["", `\x1b[38;2;201;165;78m━━ ${t} ━━\x1b[39m`, ""];

/** 一个脚本化 provider:按顺序吐回合;摘要请求另答;可插入重试与错误。 */
type Step = AssistantTurn | { error: ProviderError } | { retryThen: AssistantTurn };
function scripted(steps: Step[], model = "fake-agent"): Provider {
  let i = 0;
  return {
    model,
    wire: (messages, tools) => ({
      model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: t })),
      stream: true,
    }),
    wireMap: (messages) => messages.map((_, i) => i),
    async complete(messages, _tools, opts: CompleteOptions = {}) {
      const last = messages.at(-1);
      if (last?.role === "user" && /Compress the conversation above/.test(last.content)) {
        return {
          text: "## Task and intent\nInspect the repository and report.\n## Files and code state\nsrc/loop.ts read.\n## Next steps\nContinue with the third task.",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 5200, outputTokens: 60 },
        };
      }
      const s = steps[i++];
      if (!s) throw new Error(`script exhausted at step ${i}`);
      if ("error" in s) throw s.error;
      if ("retryThen" in s) {
        opts.onRetry?.({
          attempt: 1,
          delayMs: 800,
          error: new ProviderError("provider 429: rate limited", { status: 429 }),
        });
        return emit(s.retryThen, opts);
      }
      return emit(s, opts);
    },
  };
}
function emit(t: AssistantTurn, opts: CompleteOptions): AssistantTurn {
  if (t.reasoning && opts.onReasoning) opts.onReasoning(t.reasoning);
  if (t.text && opts.onDelta) opts.onDelta(t.text);
  return t;
}

// 真实的描述与参数,假的执行:描述档的对照才有意义。
const bash: Tool = {
  ...createBashTool(),
  async execute() {
    return " ✓ tests/loop.test.ts (10 tests) 9ms\n ✗ tests/agent.test.ts (3 tests | 1 failed) 12ms\n Test Files  1 failed | 9 passed (10)";
  },
};
const read: Tool = {
  ...readTool,
  async execute() {
    return "60\texport async function runTurn(deps: TurnDeps) {\n61\t  const termination = deps.slots?.termination ?? untilIdle;";
  },
};
/** 大结果:让压缩有东西可覆盖。 */
const bigRead: Tool = {
  ...readTool,
  async execute() {
    return Array.from({ length: 300 }, (_, i) => `${i + 1}\t// line ${i + 1} of a long README about the clarook kernel and its event log`).join("\n");
  },
};
/** 等打断的工具:子在它里面被 Esc 打断,得到 partial。 */
let slowStarted = false;
const slow = defineTool({
  name: "slow",
  description: "Waits until interrupted",
  parameters: Type.Object({}),
  async execute(_args, ctx) {
    slowStarted = true;
    await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
    throw new Error("interrupted");
  },
});
const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function boot(provider: Provider, extra: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term = new VirtualTerminal(W, 44);
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [bash, read, echo],
    compaction: { strategy: async () => null, window: 131072, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-agent", providerName: "local-fake", sessionFile: "sessions/demo.jsonl" },
    systemPrompt: "You are a coding assistant working in the user's repository.",
    price: { input: 1, output: 5, cacheRead: 0.1 },
    onExit: () => {},
    ...extra,
  });
  return { app, log };
}

async function waitPrompt(app: TuiApp) {
  for (let i = 0; i < 100 && app.approvalLines().length === 0; i++) await tick();
}

const files: { name: string; title: string; lines: string[] }[] = [];
function save(name: string, title: string, lines: string[]) {
  files.push({ name, title, lines });
  writeFileSync(join(outDir, `${name}.html`), ansiToHtmlDocument(lines, title), "utf8");
  console.log(`wrote ${name}.html (${lines.length} lines)`);
}

scene = "1";
// ---------- 1 对话流与工具描述档 ----------
{
  const provider = scripted([
    {
      text: "Let me run the tests first.",
      reasoning: "The user asks why a test fails; run the suite, then read the code around the failure.",
      reasoningKind: "full",
      toolCalls: [{ id: "c1", name: "bash", args: { command: "pnpm test 2>&1 | tail -3" } }],
      stopReason: "tool",
      usage: { inputTokens: 2310, outputTokens: 42, cacheReadTokens: 1800 },
    },
    {
      text: "",
      toolCalls: [{ id: "c2", name: "read", args: { path: "src/loop.ts", limit: 2 } }],
      stopReason: "tool",
      usage: { inputTokens: 2890, outputTokens: 31, cacheReadTokens: 2300 },
    },
    {
      text: "## Conclusion\n\nThe queue-mode test fails because `steering(\"turn\")` is not drained after `end`.\n\n- Fix: move the drain into the `end` branch\n- Blast radius: queue mode only",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 4120, outputTokens: 188, cacheReadTokens: 2800 },
    },
    { text: "Descriptions changed; the next request carries the new definitions.", toolCalls: [], stopReason: "end", usage: { inputTokens: 4300, outputTokens: 20 } },
  ]);
  const { app } = boot(provider, { toolPrompts: { style: "explain" } });
  await app.submit("Why does the queue-mode test fail?");
  const shots = [...app.lines(W)];
  await app.command("/set toolprompts");
  shots.push(...divider("/toolprompts: three levels with token totals"), ...app.lines(W).slice(-14));
  await app.command("/set toolprompts brief");
  await app.command("/inspect tools");
  await app.submit("Say one line.");
  shots.push(...divider("after /toolprompts brief: /tools with the new token totals"), ...app.lines(W).slice(-26));
  app.stop();
  save("1-cards", "1 Cards, thinking, tool results, description levels", shots);
}

scene = "2";
// ---------- 2 审批:主会话与子 agent 的弹窗 ----------
{
  const provider = scripted([
    { text: "I will echo first.", toolCalls: [{ id: "c1", name: "echo", args: { text: "hello" } }], stopReason: "tool", usage: { inputTokens: 900, outputTokens: 12 } },
    { text: "Now delegating.", toolCalls: [{ id: "t1", name: "task", args: { task: "Echo the word world and report it." } }], stopReason: "tool", usage: { inputTokens: 1100, outputTokens: 20 } },
    // child
    { text: "", toolCalls: [{ id: "k1", name: "echo", args: { text: "world" } }], stopReason: "tool", usage: { inputTokens: 400, outputTokens: 8 } },
    { text: "Done: world", toolCalls: [], stopReason: "end", usage: { inputTokens: 520, outputTokens: 6 } },
    // parent
    { text: "The sub-agent reported: world.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1400, outputTokens: 10 } },
    { text: "Trying bash.", toolCalls: [{ id: "c3", name: "bash", args: { command: "rm -rf build" } }], stopReason: "tool", usage: { inputTokens: 1500, outputTokens: 10 } },
    { text: "Understood, bash is denied by policy.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1600, outputTokens: 12 } },
  ]);
  const log = new EventLog();
  let app: TuiApp | undefined;
  const task = createTaskTool({
    parent: log,
    provider,
    tools: [echo],
    slots: () => app?.slots(),
    onChild: (child) => app?.attachChild(child),
  });
  const term = new VirtualTerminal(W, 44);
  app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [bash, read, echo, task],
    compaction: { strategy: async () => null, window: 131072, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-agent", providerName: "local-fake", sessionFile: "sessions/demo.jsonl" },
    systemPrompt: "sys",
    approve: "ask",
    onExit: () => {},
  });
  const shots: string[] = [];
  let run = app.submit("Echo hello, then delegate.");
  await waitPrompt(app);
  shots.push(...divider("main session asks (approve = ask)"), ...app.approvalLines());
  app.approvalInput("1"); app.approvalInput("\r");
  await waitPrompt(app); // the task call itself asks too
  shots.push(...divider("the task call asks"), ...app.approvalLines());
  app.approvalInput("1"); app.approvalInput("\r");
  await waitPrompt(app);
  shots.push(...divider("the sub-agent's call asks through the parent, labelled sub-1"), ...app.approvalLines());
  app.approvalInput("1"); app.approvalInput("\r");
  await run;
  shots.push(...divider("main screen after both approvals"), ...app.lines(W));
  await app.command("/set approve policy");
  await app.command("/set approve deny bash");
  run = app.submit("Now try a bash command.");
  await run;
  shots.push(...divider("policy mode: deny rule for bash, reason fed back to the model"), ...app.lines(W).slice(-16));
  app.stop();
  save("2-approval", "2 Approval prompts: main session, sub-agent label, policy deny", shots);
}

scene = "3";
// ---------- 3 子 agent 四态与续聊 ----------
{
  const provider = scripted([
    { text: "Delegating an endless task.", toolCalls: [{ id: "t1", name: "task", args: { task: "Keep echoing until told to stop.", type: "research" } }], stopReason: "tool", usage: { inputTokens: 1000, outputTokens: 12 } },
    // child: two steps, stopped by maxSteps 2
    { text: "step one", toolCalls: [{ id: "k1", name: "echo", args: { text: "1" } }], stopReason: "tool", usage: { inputTokens: 300, outputTokens: 5 } },
    { text: "step two", toolCalls: [{ id: "k2", name: "echo", args: { text: "2" } }], stopReason: "tool", usage: { inputTokens: 420, outputTokens: 5 } },
    // parent resumes
    { text: "Resuming the same sub-agent.", toolCalls: [{ id: "t2", name: "task", args: { task: "Finish now and summarise.", resume: "sub-1" } }], stopReason: "tool", usage: { inputTokens: 1300, outputTokens: 12 } },
    // child resumed: finishes
    { text: "Finished: echoed 1 and 2.", toolCalls: [], stopReason: "end", usage: { inputTokens: 700, outputTokens: 8 } },
    // parent: turn ends here; the next user message starts the interrupted delegation
    { text: "The sub-agent finished after the resume.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1400, outputTokens: 10 } },
    // parent: one more delegation that gets interrupted while the child is inside a tool
    { text: "Delegating once more.", toolCalls: [{ id: "t3", name: "task", args: { task: "A long task." } }], stopReason: "tool", usage: { inputTokens: 1500, outputTokens: 10 } },
    { text: "Working on it.", toolCalls: [{ id: "k9", name: "slow", args: {} }], stopReason: "tool", usage: { inputTokens: 500, outputTokens: 6 } },
  ]);
  const log = new EventLog();
  let app: TuiApp | undefined;
  const task = createTaskTool({
    parent: log,
    provider,
    tools: [echo, slow],
    slots: () => app?.slots(),
    maxSteps: 2,
    types: { research: { description: "read-only investigation", tools: ["echo"] } },
    onChild: (child) => app?.attachChild(child),
  });
  app = createTuiApp({
    terminal: new VirtualTerminal(W, 60),
    log,
    provider,
    tools: [echo, slow, task],
    compaction: { strategy: async () => null, window: 131072, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-agent", providerName: "local-fake", sessionFile: "sessions/demo.jsonl" },
    systemPrompt: "sys",
    onExit: () => {},
  });
  const shots: string[] = [];
  await app.submit("Run an endless sub-agent, then resume it.");
  shots.push(...divider("stopped by the step limit, then resumed"), ...app.lines(W));
  const run = app.submit("Delegate a long task.");
  for (let i = 0; i < 400 && !slowStarted; i++) await tick();
  await tick();
  shots.push(...divider("third sub-agent running"), ...app.lines(W).slice(-10));
  app.agent.interrupt();
  await run;
  shots.push(...divider("after Esc: partial"), ...app.lines(W).slice(-12));
  app.toggleFold();
  shots.push(...divider("Ctrl+O: every sub-agent line"), ...app.lines(W).slice(-40));
  app.stop();
  save("3-subagent", "3 Sub-agent states: stopped, resumed, running, partial", shots);
}

scene = "4";
// ---------- 4 压缩:remind 提示、手动压缩、对照 ----------
{
  const provider = scripted([
    { text: "First answer, long context.", toolCalls: [{ id: "c1", name: "read", args: { path: "README.md" } }], stopReason: "tool", usage: { inputTokens: 6900, outputTokens: 30 } },
    { text: "Read done.", toolCalls: [], stopReason: "end", usage: { inputTokens: 7400, outputTokens: 30 } },
    { text: "Second answer after compaction.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1800, outputTokens: 20 } },
  ]);
  const { app } = boot(provider, {
    tools: [bash, bigRead, echo],
    compaction: { strategy: llmSummarize(), window: 8000, reserveTokens: 1000, trigger: "remind" },
    reserveTokens: 1000,
    compactionName: "llm",
  });
  const shots: string[] = [];
  await app.submit("Read the README and tell me what this is.");
  shots.push(...divider("trigger = remind: past the threshold, the status bar asks for /compact"), ...app.lines(W));
  await app.command("/set compaction manual");
  await app.command("/compact keep the file names");
  shots.push(...divider("/compaction manual then /compact with an instruction"), ...app.lines(W).slice(-14));
  await app.submit("What did you keep?");
  await app.command("/inspect usage");
  shots.push(...divider("next request after compaction and /context"), ...app.lines(W).slice(-30));
  app.inspector.openCompactions();
  shots.push(...divider("Ctrl+R Tab Tab: compactions"), ...app.inspector.lines(W));
  app.inspector.key("\r");
  shots.push(...divider("compaction detail: original vs summary"), ...app.inspector.lines(W));
  app.inspector.close();
  app.stop();
  save("4-compaction", "4 Compaction: remind hint, manual compact, comparison", shots);
}

scene = "5";
// ---------- 5 错误卡与重试 ----------
{
  const provider = scripted([
    { retryThen: { text: "Recovered after a 429.", toolCalls: [], stopReason: "end", usage: { inputTokens: 900, outputTokens: 10 } } },
    { error: new ProviderError("provider 500: upstream exploded", { status: 500, body: '{"error":{"message":"upstream exploded","type":"server_error"}}' }) },
    { error: new ProviderError("provider 401: invalid api key", { status: 401, body: '{"error":{"message":"Authentication Fails, Your api key: ****x is invalid"}}' }) },
  ]);
  const { app } = boot(provider);
  const shots: string[] = [];
  await app.submit("First request hits a rate limit.");
  await app.submit("Second request fails hard.");
  await app.submit("Third request has a bad key.");
  shots.push(...divider("retry row, then two error cards with class and next step"), ...app.lines(W));
  app.stop();
  save("5-errors", "5 Retry row and error cards", shots);
}

scene = "6";
// ---------- 6 检视器四视图与上下文面板动作菜单 ----------
{
  const provider = scripted([
    { text: "Reading.", reasoning: "Need the file first.", reasoningKind: "full", toolCalls: [{ id: "c1", name: "read", args: { path: "src/loop.ts", limit: 2 } }], stopReason: "tool", usage: { inputTokens: 2000, outputTokens: 20 } },
    { text: "Here is the answer.", toolCalls: [], stopReason: "end", usage: { inputTokens: 2400, outputTokens: 40 } },
  ]);
  const { app } = boot(provider, {});
  await app.submit("Explain runTurn.");
  const shots: string[] = [];
  app.inspector.open();
  shots.push(...divider("Ctrl+R requests"), ...app.inspector.lines(W));
  app.inspector.key("\x1b[H");
  app.inspector.key("\r");
  app.inspector.key("3");
  shots.push(...divider("request 1 · sent"), ...app.inspector.lines(W));
  app.inspector.key("\x1b");
  app.inspector.close();
  app.inspector.openEvents();
  shots.push(...divider("events view"), ...app.inspector.lines(W));
  app.inspector.close();
  app.inspector.openComposition();
  shots.push(...divider("Ctrl+E context"), ...app.inspector.lines(W));
  app.inspector.key("\r");
  shots.push(...divider("Enter: action menu with consequences"), ...app.inspector.lines(W));
  app.inspector.key("\x1b");
  app.inspector.close();
  app.stop();
  save("6-inspector", "6 Inspector views and the context action menu", shots);
}

scene = "7";
// ---------- 7 没有 key 的启动:登录对话框 ----------
{
  const real = scripted([
    { text: "Hello from the model you just set up.", toolCalls: [], stopReason: "end", usage: { inputTokens: 300, outputTokens: 8 } },
  ]);
  const none = noProviderChoice();
  const app = createTuiApp({
    terminal: new VirtualTerminal(W, 30),
    log: new EventLog(),
    provider: none.provider,
    tools: [],
    compaction: { strategy: async () => null, window: 131072, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: none.model, providerName: none.providerName, sessionFile: "sessions/demo.jsonl" },
    systemPrompt: "sys",
    settings: {
      listModels: () => ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "anthropic/claude-sonnet-5"],
      switchModel: () => ({ provider: real, model: "deepseek-v4-pro", providerName: "deepseek", contextWindow: 128000 }),
      setKey: () => {},
      setDefault: () => {},
      providers: () => [
        { name: "deepseek", protocol: "openai", env: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
        { name: "anthropic", protocol: "anthropic", env: "ANTHROPIC_API_KEY", keySource: "env", models: ["claude-sonnet-5"] },
        { name: "openai", protocol: "openai-responses", env: "OPENAI_API_KEY", models: ["gpt-5.5", "gpt-5.6"] },
      ],
      verifyKey: async () => ["deepseek-v4-pro", "deepseek-v4-lite"],
    },
    unavailable: "no API key for provider deepseek. Run /login in the TUI, set env var DEEPSEEK_API_KEY, or add it to ~/.clarook/credentials.json",
    onExit: () => {},
  });
  const shots: string[] = [];
  const dialog = () => app.dialogLines();
  shots.push(...divider("start without a key: the header says no model, the dialog opens by itself"), ...app.lines(W), ...divider("dialog · providers"), ...dialog());
  app.dialogInput("\r");
  app.dialogInput("sk-0123456789abcdef");
  shots.push(...divider("dialog · key entry, masked"), ...dialog());
  app.dialogInput("\r");
  for (let i = 0; i < 40 && !app.dialogLines().join("").includes("key saved"); i++) await tick();
  shots.push(...divider("dialog · key checked with GET /models, pick a model (d also makes it the default)"), ...dialog());
  app.dialogInput("\r");
  await app.submit("Say hello.");
  shots.push(...divider("after the dialog: model switched, first message answered"), ...app.lines(W).slice(-16));
  await app.command("/model");
  shots.push(...divider("/model: list picker"), ...dialog());
  app.dialogInput("\x1b");
  app.stop();
  save("7-login", "7 Start without a key: login dialog and model picker", shots);
}

scene = "8";
// ---------- 8 账簿:自动折叠、光标、脉搏、命令面板 ----------
{
  let n = 0;
  const provider: Provider = {
    model: "fake-agent",
    async complete() {
      n += 1;
      return {
        text: n % 2 ? `Step ${n}: read the file and found the bug in the drain logic.` : `Step ${n}: patched it.`,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 900 + n * 700, outputTokens: 20 + n * 5 },
      };
    },
  };
  const term = new VirtualTerminal(W, 44);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [],
    compaction: { strategy: async () => null, window: 12000, reserveTokens: 2000 },
    reserveTokens: 2000,
    info: { model: "fake-agent", providerName: "local-fake", sessionFile: "sessions/demo.jsonl" },
    systemPrompt: "sys",
    settings: {
      listModels: () => ["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5"],
      switchModel: () => { throw new Error("n/a"); },
      setKey: () => {},
      setDefault: () => {},
      providers: () => [{ name: "deepseek", protocol: "openai", keySource: "credentials", models: ["deepseek-v4-pro"] }],
      verifyKey: async () => [],
    },
    price: { input: 0.28, output: 0.42 },
    onExit: () => {},
  });
  const shots: string[] = [];
  const questions = ["Why does the queue-mode test fail?", "Fix it.", "Run the tests again.", "Now update the docs.", "Commit."];
  for (const q of questions) await app.submit(q);
  shots.push(...divider("five steps: the two oldest folded into ledger lines, the newest three open; the pulse shows context growing"), ...app.lines(W));
  term.feed("\x1b[5~");
  term.feed("\x1b[5~");
  term.feed("\x1b[5~");
  term.feed("\x1b[5~");
  term.feed("\x1b[5~");
  shots.push(...divider("PgUp to step 1: the ledger line takes the cursor, the status line says where you are"), ...app.lines(W).slice(0, 12), ...app.lines(W).slice(-3));
  term.feed("\r");
  shots.push(...divider("Enter unfolds it (and pins it: it will not fold again on its own)"), ...app.lines(W).slice(0, 16));
  term.feed("\x1b");
  term.feed("\x0b");
  for (const ch of "mod") app.dialogInput(ch);
  shots.push(...divider("Ctrl+K command palette, filtered by \"mod\""), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.stop();
  save("8-ledger", "8 Ledger: auto-folded steps, step cursor, context pulse, command palette", shots);
}

scene = "9";
// ---------- 9 命令选单:次级选项都是选出来的 ----------
{
  const { app } = boot(scripted([{ text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 900, outputTokens: 12 } }]), {
    settings: {
      listModels: () => ["local-fake/fake-agent", "deepseek/deepseek-v4-pro"],
      switchModel: () => { throw new Error("n/a"); },
      setKey: () => {},
      setDefault: () => {},
    },
  });
  await app.submit("Say ok.");
  const shots: string[] = [];
  await app.command("/help");
  shots.push(...divider("/help: thirteen commands in groups, then the keys"), ...app.lines(W).slice(-22));
  await app.command("/inspect");
  shots.push(...divider("/inspect: pick what to look at; each row says what it is and how many"), ...app.dialogLines());
  app.dialogInput("\x1b");
  await app.command("/set");
  shots.push(...divider("/set: pick a slot; the row shows the current value"), ...app.dialogLines());
  app.dialogInput("5");
  app.dialogInput("\r");
  await tick();
  shots.push(...divider("then pick a value; the current one is marked"), ...app.dialogLines());
  app.dialogInput("\x1b");
  await app.command("/set approve");
  shots.push(...divider("/set approve: modes, rules and the cwd boundary in one list"), ...app.dialogLines());
  app.dialogInput("\x1b");
  await app.command("/tools");
  shots.push(...divider("/tools: Enter flips a tool on or off; the token cost of each definition is on the row"), ...app.dialogLines());
  app.dialogInput("\x1b");
  await app.command("/session");
  shots.push(...divider("/session: new, fork, resume, list"), ...app.dialogLines());
  app.dialogInput("\x1b");
  await app.command("/model");
  shots.push(...divider("/model: configured models, d makes one the default, the last row asks the provider"), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.stop();
  save("9-menus", "9 Command menus: inspect, set, tools, session, model", shots);
}

scene = "10";
// ---------- 10 上下文工作台、事件视图、设置表 ----------
{
  const provider = scripted([
    { text: "Reading the loop first.", reasoning: "Need the file before answering.", reasoningKind: "full", toolCalls: [{ id: "c1", name: "read", args: { path: "src/loop.ts", limit: 2 } }], stopReason: "tool", usage: { inputTokens: 1400, outputTokens: 30, cacheReadTokens: 900 } },
    { text: "runTurn drives one turn: it projects the log, sends the request, executes the calls and appends every result.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1800, outputTokens: 60, cacheReadTokens: 1400 } },
    { text: "The step limit lives in the termination slot.", toolCalls: [], stopReason: "end", usage: { inputTokens: 2000, outputTokens: 20, cacheReadTokens: 1800 } },
  ]);
  const log = new EventLog();
  const p = systemPromptFor({}, process.cwd());
  log.append({ type: "session/start", at: new Date().toISOString(), model: "fake-agent", system: p.text, sections: p.sections });
  const { app } = boot(provider, {

    settings: {
      listModels: () => ["local-fake/fake-agent"],
      switchModel: () => { throw new Error("n/a"); },
      setKey: () => {},
      setDefault: () => {},
      settingLayers: () => ({ defaults: { foldLines: 5, foldSteps: 3 }, presetName: "long", preset: { compactionReserve: 64000 } }),
      saveSetting: () => {},
    },
  }, log);
  await app.submit("Explain runTurn.");
  await app.submit("Where is the step limit?");
  const shots: string[] = [];
  app.inspector.openComposition();
  shots.push(...divider("Ctrl+E: the next request in order, token ruler, cache line, preview of the selected row"), ...app.inspector.lines(W));
  app.inspector.close();
  await app.command("/edit 3 text Reading the loop first; the limit is in loop.ts.");
  app.inspector.openComposition(3);
  shots.push(...divider("after editing #3: ✎ on the row, the cache line moves up and turns gold"), ...app.inspector.lines(W));
  app.inspector.key("\r");
  shots.push(...divider("Enter on a message: numbered actions with the consequence line"), ...app.inspector.lines(W));
  app.inspector.key("\x1b");
  app.inspector.openComposition(0);
  app.inspector.key("\r");
  shots.push(...divider("Enter on the system row: sections with tokens; Enter flips one for this session"), ...app.inspector.lines(W));
  app.inspector.key("\x1b");
  app.inspector.close();
  app.inspector.openEvents();
  shots.push(...divider("Ctrl+R Tab: events, one readable line each, the right column is what the model sees now"), ...app.inspector.lines(W));
  app.inspector.key("4");
  shots.push(...divider("4 changes: only edits, drops and compactions"), ...app.inspector.lines(W));
  app.inspector.key("1");
  app.inspector.key("\x1b[1;5A");
  app.inspector.key("\r");
  shots.push(...divider("Enter on a request: the view page; 2 json, 3 projection"), ...app.inspector.lines(W));
  app.inspector.key("\x1b");
  app.inspector.close();
  await app.command("/settings");
  shots.push(...divider("/settings: Agent setup; This session and Saved defaults are separate scopes"), ...app.dialogLines());
  await app.command("/settings foldSteps");
  app.dialogInput("\r");
  shots.push(...divider("foldSteps: current value, recommendations, timing; E enters a custom value"), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.dialogInput("\x1b");
  await app.command("/settings statusStyle");
  app.dialogInput("\r");
  app.dialogInput("\x1b[B");
  shots.push(...divider("status style: highlighted choice previews the live bar before applying"), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.dialogInput("\x1b");
  await app.command("/settings statusWidgets");
  app.dialogInput("\r");
  shots.push(...divider("status contents: each reading has a checkbox and a live preview"), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.dialogInput("\x1b");
  app.stop();
  save("10-workbench", "10 Context workbench, events and settings", shots);
}

// 固定运行区的真实终端缓冲区:小屏和宽屏走同一段有停顿、有审批、有错误的工作流。
for (const [width, height] of [[60, 24], [120, 36]] as const) {
  scene = `runtime-${width}`;
  const term = new VirtualTerminal(width, height);
  let release: (() => void) | undefined;
  let fail = false;
  let requests = 0;
  const provider: Provider = {
    model: "local-fake",
    async complete(_messages, _tools, opts) {
      if (fail) throw new ProviderError("The local fixture is unavailable.", { status: 503 });
      if (++requests > 1) return { text: "The update is complete. The execution boundary is unchanged.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1800, outputTokens: 32 } };
      opts?.onReasoning?.("Reviewing the current execution boundary before proposing a change.");
      opts?.onDelta?.("The runtime currently mixes task state, context usage and shortcut hints.\n\nI am checking the existing components before updating their layout.");
      await new Promise<void>((resolve) => { release = resolve; });
      return { text: "The proposed status component keeps actions visible at narrow widths.", toolCalls: [{ id: "preview-write", name: "write", args: { path: "cli/runtime.ts", content: Array.from({ length: 35 }, (_, n) => `// Proposed layout line ${n + 1}`).join("\n") } }], stopReason: "tool", usage: { inputTokens: 1600, outputTokens: 60 } };
    },
  };
  const write = defineTool({ name: "write", description: "Local preview fixture; no file writes.", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute() { return "Preview change accepted."; } });
  const app = createTuiApp({ terminal: term, log: new EventLog(), provider, tools: [write], compaction: { strategy: async () => null, window: 128000, reserveTokens: 32000 }, reserveTokens: 32000, info: { model: "local-fake", providerName: "demo", sessionFile: "sessions/long-project-name/runtime-design-session.jsonl" }, systemPrompt: "Local visual fixture.", approve: "ask", onExit: () => {} });
  const capture = async (state: string) => {
    app.tui.renderNow(true);
    const visible = await term.screen();
    const candidates = [...app.lines(width), ...app.dialogLines(), ...app.approvalLines()];
    // 位置取真实缓冲区,精确匹配的行沿用组件 ANSI 色彩;不重造终端布局。
    const styled = visible.map((line) => candidates.find((candidate) => stripAnsi(candidate).trimEnd() === line) ?? line);
    save(`11-runtime-${width}-${state}`, `Runtime · ${width} × ${height} · ${state}`, styled);
  };
  await capture("ready");
  if (width === 60) {
    await app.command("/settings statusStyle");
    app.dialogInput("\r");
    app.dialogInput("\x1b[B");
    await capture("settings-style");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    await app.command("/settings statusWidgets");
    app.dialogInput("\r");
    await capture("settings-contents");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
  }
  const work = app.submit("Clarify the runtime UI and keep the execution choices visible.");
  await tick();
  await capture("streaming");
  term.feed("\x1b[5~");
  await capture("history");
  term.feed("\x1b");
  release?.();
  for (let n = 0; n < 40 && app.approvalLines().length === 0; n++) await tick();
  await capture("approval");
  term.feed("\x1b[6~");
  await capture("approval-details");
  term.feed("1"); term.feed("\r");
  await work;
  await capture("complete");
  fail = true;
  await app.submit("Continue with the next task.");
  await capture("error");
  term.feed("?");
  await capture("help");
  app.stop();
}

// 新建、历史补全与失败恢复均走真实会话控制器,不手绘未来状态。
for (const [width, height] of [[60, 24], [120, 36]] as const) {
  scene = `session lifecycle ${width}`;
  const dir = mkdtempSync(join(tmpdir(), "clarook-session-visual-"));
  const config: KernelConfig = { default: "demo/local-fake", providers: { demo: { protocol: "openai", baseUrl: "http://unused", models: ["local-fake"] } },
    sessionsDir: dir, defaults: { prompt: { sections: [] }, execution: "sequential" } };
  let hold = false;
  let remoteMode: "timeout" | "cancel" | undefined;
  let exitMode = false;
  let remoteArrived = () => {};
  const handleMcp = createLogic({ era: "modern", tools: 0 });
  const remote = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      if (message.method === "tools/call") { remoteArrived(); return; }
      const out = handleMcp(message);
      res.writeHead(message.id === undefined ? 202 : 200, { "content-type": "application/json" });
      res.end(message.id === undefined ? undefined : JSON.stringify(out[0]));
    });
  });
  const choose = () => ({ model: "local-fake", providerName: "demo", contextWindow: 128000,
    provider: { model: "local-fake", async complete(_messages: Message[], _tools: unknown, opts?: CompleteOptions) {
      if (hold) { await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true })); return { text: "", toolCalls: [], stopReason: "aborted" as const }; }
      if (exitMode) return { text: "Waiting for the local demo extension.", toolCalls: [{ id: "release-check", name: "demo_wait", args: { task: "Review release preparation" } }], stopReason: "tool" as const };
      if (remoteMode) {
        if (_messages.at(-1)?.role === "tool") return { text: "The remote outcome is unknown. I will check its actual state before deciding whether another call is needed.", toolCalls: [], stopReason: "end" as const };
        return { text: "Calling the local demo MCP server.", toolCalls: [{ id: remoteMode, name: "mcp__demo__echo", args: { text: "Check release preparation" } }], stopReason: "tool" as const };
      }
      return { text: "The current setup is ready. You can change the model, tools and strategies independently.", toolCalls: [], stopReason: "end" as const };
    } } });
  const boot: Bootstrap = { config, configCreated: false, choose, chooseOrNone: choose,
    resolve: (args) => applyPreset(args, config), settings: { listModels: () => [config.default], switchModel: choose, setKey() {}, setDefault() {},
      saveSetting(key, value) { config.defaults = setSetting(config.defaults, key, value); } } };
  let term = new VirtualTerminal(width, height);
  let host = await startTuiSession({ boot, args: boot.resolve(parseCommonArgs([])), terminal: () => { term = new VirtualTerminal(width, height); return term; }, onExit() {} });
  const capture = async (state: string) => {
    const app = host.app();
    app.tui.renderNow(true);
    const visible = await term.screen();
    const candidates = [...app.lines(width), ...app.dialogLines()];
    save(`12-session-${width}-${state}`, `Local session runtime · ${width} × ${height} · ${state}`,
      visible.map((line) => candidates.find((candidate) => stripAnsi(candidate).trimEnd() === line) ?? line));
  };
  try {
    await host.app().submit("Inspect the current agent setup.");
    await host.app().command("/session");
    await capture("menu");
    host.app().dialogInput("\x1b");
    await host.switchSession({ kind: "new" });
    await capture("new");
    const legacyFile = join(dir, "old-work.jsonl");
    const legacy = new EventLog(legacyFile);
    legacy.append({ type: "session/start", at: "", model: "demo/local-fake", system: "Continue the existing work." });
    legacy.append({ type: "user/message", at: "", text: "Review the session architecture and preserve my choices." });
    await legacy.checkpoint();
    legacy.recording?.dispose();
    const restoring = host.switchSession({ kind: "resume", file: legacyFile });
    await tick();
    await capture("restore-review");
    host.app().dialogInput("\r");
    host.app().dialogInput("\x15");
    host.app().dialogInput("\x1b[200~demo/local-fake\x1b[201~");
    await capture("restore-edit");
    host.app().dialogInput("\r");
    host.app().dialogInput("\x1b[F"); host.app().dialogInput("\r");
    await restoring;
    await capture("restored");
    config.defaults = { ...config.defaults, extensions: [join(dir, "missing-extension.mjs")] };
    host.app().setDraft("Keep this draft while I repair the setup.");
    const failing = host.switchSession({ kind: "new", source: "defaults" });
    for (let n = 0; n < 60 && !host.app().dialogLines().join("\n").includes("preparation failed"); n++) await tick();
    await capture("failure");
    host.app().dialogInput("\x1b");
    await failing;
    await capture("draft-preserved");
    config.defaults = { ...config.defaults, extensions: [] };
    hold = true;
    const running = host.app().submit("Review the input recovery changes.");
    await tick();
    void host.app().agent.prompt("Check the recovery path before changing the execution policy.");
    void host.app().agent.prompt("Then summarize the changes and verification evidence.", { deliverAs: "followUp" });
    host.app().setDraft("Keep this unsent draft.\nDo not replay external actions.");
    host.app().agent.interrupt();
    await running;
    hold = false;
    const savedFile = host.file();
    await host.switchSession({ kind: "new" });
    await host.switchSession({ kind: "resume", file: savedFile });
    await capture("inputs-recovered");
    await host.app().command("/session inputs");
    await capture("inputs-paused");
    term.feed("\r"); term.feed("\r");
    term.feed("\x15");
    term.feed("\x1b[200~Check recovery with a multiline input.\nKeep the delivery boundary visible.\x1b[201~");
    await capture("inputs-edit");
    term.feed("\r");
    term.feed("\r"); term.feed("3"); term.feed("\r");
    await host.app().agent.waitForIdle();
    await host.app().command("/session inputs");
    await capture("inputs-empty");
    host.app().dialogInput("\x1b");
    const snapshot = savedFile.replace(/\.jsonl$/, ".inputs.json");
    rmSync(snapshot, { force: true });
    mkdirSync(snapshot);
    host.app().setDraft("Keep this draft until local saving works again.");
    try { host.app().flushInputs(); } catch { /* 保存失败的本地磁盘夹具 */ }
    await host.app().command("/session inputs");
    await capture("inputs-save-error");
    rmSync(snapshot, { recursive: true });
    host.app().dialogInput("\r"); host.app().dialogInput("4"); host.app().dialogInput("\r");
    host.app().dialogInput("\x1b");
    const unknownFile = join(dir, "unknown-result.jsonl");
    const unknownLog = new EventLog(unknownFile);
    for (const event of EventLog.load(savedFile).events) unknownLog.append(event);
    unknownLog.append({ type: "assistant/message", at: "", text: "Updating the release notes.", toolCalls: [{ id: "unfinished-write", name: "write", args: { path: join(dir, "release-notes.md"), content: "Document the recovery behavior." } }], stopReason: "tool" });
    await unknownLog.checkpoint();
    unknownLog.recording?.dispose();
    await host.switchSession({ kind: "resume", file: unknownFile });
    await capture("result-unknown");
    await host.app().command("/session recovery");
    await capture("recovery-details");
    host.app().dialogInput("\x1b");
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    config.mcp = { servers: { demo: { url: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`, toolTimeoutMs: 500 } } };
    config.defaults = { ...config.defaults, approve: "all" };
    remoteMode = "timeout";
    await host.switchSession({ kind: "new", source: "defaults" });
    await host.app().submit("Check the release preparation remotely.");
    await capture("remote-timeout");
    await host.app().command("/session recovery");
    await capture("remote-details");
    host.app().dialogInput("\x1b");
    remoteMode = "cancel";
    await host.switchSession({ kind: "new", source: "defaults" });
    const arrived = new Promise<void>((resolve) => { remoteArrived = resolve; });
    const remoteRun = host.app().submit("Check the release preparation remotely.");
    await arrived;
    term.feed("\x1b");
    await remoteRun;
    await capture("remote-cancel");
    const exitExtension = join(dir, "exit-demo.mjs");
    writeFileSync(exitExtension, `
      export let started = false;
      export let cleaning = false;
      export let finishTool = () => {};
      export let finishCleanup = () => {};
      export const reset = () => { started = false; cleaning = false; };
      export default () => ({
        tools: [{ name: "demo_wait", description: "A local shutdown fixture", parameters: { type: "object" },
          execute() { started = true; return new Promise(resolve => { finishTool = () => resolve("Demo work finished."); }); } }],
        dispose() { cleaning = true; return new Promise(resolve => { finishCleanup = resolve; }); }
      });
    `);
    const exitControl = await import(pathToFileURL(exitExtension).href);
    try {
      exitMode = true;
      remoteMode = undefined;
      config.mcp = { servers: {} };
      config.defaults = { ...config.defaults, extensions: [exitExtension] };
      await host.switchSession({ kind: "new", source: "defaults" });
      const exitingWork = host.app().submit("Finish the release checks.");
      while (!exitControl.started) await tick();
      void host.app().agent.prompt("Keep the verification notes for later.");
      host.app().setDraft("Preserve my next question.");
      await host.app().command("/quit");
      await capture("exit-wait");
      const exitSnapshot = host.file().replace(/\.jsonl$/, ".inputs.json");
      rmSync(exitSnapshot);
      mkdirSync(exitSnapshot);
      host.app().setDraft("Preserve the latest question too.");
      term.feed("\x1b[F"); term.feed("\r");
      await capture("exit-save-error");
      rmSync(exitSnapshot, { recursive: true });
      exitControl.finishTool();
      await exitingWork;
      while (!exitControl.cleaning) await tick();
      await capture("exit-cleanup");
      term.feed("\x1b[F"); term.feed("\r");
      await host.close();
      exitControl.finishCleanup();
      exitControl.reset();
      host = await startTuiSession({ boot, args: boot.resolve(parseCommonArgs([])), terminal: () => { term = new VirtualTerminal(width, height); return term; }, onExit() {} });
      const fatalWork = host.app().submit("Finish the release checks.");
      while (!exitControl.started) await tick();
      void host.app().agent.prompt("Keep the verification notes for later.");
      host.app().setDraft("Preserve my question after the failure.");
      const fatalSnapshot = host.file().replace(/\.jsonl$/, ".inputs.json");
      rmSync(fatalSnapshot, { force: true });
      mkdirSync(fatalSnapshot);
      const fatalClose = host.close("unhandled promise rejection: Error: Local extension failed\n    at releaseCheck (local-fixture.mjs:18:7)");
      while (!host.app().dialogLines().join("\n").includes("Retry saving and continue shutdown")) await tick();
      await capture("fatal-save-error");
      rmSync(fatalSnapshot, { recursive: true });
      term.feed("\x1b[B"); term.feed("\r");
      await tick();
      await capture("fatal-wait");
      exitControl.finishTool();
      await fatalWork;
      while (!exitControl.cleaning) await tick();
      await capture("fatal-cleanup");
      term.feed("\x1b[F"); term.feed("\r");
      await fatalClose;
    } finally { exitControl.finishTool(); exitControl.finishCleanup(); }
  } finally {
    await host.close();
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const index = [
  "<!doctype html><meta charset=utf-8><title>clarook visual suite</title><body style='font:14px system-ui;padding:20px'><h1>clarook visual suite</h1><ol>",
  ...files.map((f) => `<li><a href='${f.name}.html'>${f.title}</a> (${f.lines.length} lines)</li>`),
  "</ol>",
].join("\n");
writeFileSync(join(outDir, "index.html"), index, "utf8");
console.log(`index at ${join(outDir, "index.html")}`);
