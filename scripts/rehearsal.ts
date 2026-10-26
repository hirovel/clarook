// 真实供应商测试计划(docs 6.9 之后的 6.10 节)的离线彩排:把不带 key 也能跑的几轮对着本机假模型
// 真跑一遍 —— 真实 HTTP、真实 SSE、真实工具、真实落盘、真实渲染 —— 每轮跑完立刻用 checkup 的判据验一遍,
// 再把画面渲染成 HTML 逐张核对。
//
// 它证明的是"链路与判据本身没问题":工具往返、缓存字段归一、自动压缩、重试恢复、四个新画面。
// 它证不了供应商特有的部分:真实缓存策略、思考回传、真实限流、Responses 协议 —— 那几轮要带 key 跑。
// 用法:pnpm rehearsal [输出目录=.preview/rehearsal]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRequestRecording } from "../cli/session-records.js";
import { analyze, reportLines } from "../cli/checkup.js";
import { buildTools, RESERVE } from "../cli/bootstrap.js";
import { llmSummarize } from "../src/compaction.js";
import { createProvider, loadConfig, resolveApiKey, resolveModel } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { usageTotals } from "../src/cost.js";
import { createTuiApp } from "../cli/tui-app.js";
import { ansiToHtmlDocument } from "../tests/helpers/ansi-html.js";
import { VirtualTerminal } from "../tests/helpers/virtual-terminal.js";

const outDir = process.argv[2] ?? join(".preview", "rehearsal");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 4113;
const W = 110;
const tick = () => new Promise((r) => setTimeout(r, 20));
const divider = (t: string) => ["", `\x1b[38;2;201;165;78m━━ ${t} ━━\x1b[39m`, ""];

mkdirSync(outDir, { recursive: true });
const server = spawn(process.execPath, [join(root, "scripts", "fake-model.mjs"), String(port)], {
  stdio: ["ignore", "ignore", "inherit"],
});
await new Promise((r) => setTimeout(r, 400));

const { config } = loadConfig(join(root, "examples", "config.demo.json"));
const resolved = resolveModel(config, "fake-agent");
resolved.provider.baseUrl = `http://127.0.0.1:${port}`;

/** 一轮:自己的会话文件、自己的界面,窗口按需给小。 */
function boot(name: string, window: number) {
  const sessionFile = join(outDir, `${name}.jsonl`);
  rmSync(sessionFile, { force: true });
  rmSync(sessionFile.replace(/\.jsonl$/, ".records"), { recursive: true, force: true });
  rmSync(sessionFile.replace(/\.jsonl$/, ".trace.jsonl"), { force: true });
  const provider = createProvider(resolved, resolveApiKey(resolved.providerName, resolved.provider));
  const log = new EventLog(sessionFile);
  const compaction = { strategy: llmSummarize(), window, reserveTokens: Math.min(RESERVE, window / 4) };
  const choice = {
    provider,
    model: resolved.model,
    providerName: resolved.providerName,
    contextWindow: window,
    ...(resolved.price && { price: resolved.price }),
  };
  const app = createTuiApp({
    terminal: new VirtualTerminal(W, 44),
    log,
    provider,
    tools: buildTools(),
    compaction,
    reserveTokens: compaction.reserveTokens,
    info: { model: resolved.model, providerName: resolved.providerName, sessionFile, contextWindow: window },
    systemPrompt: "You are a coding assistant working in the user's repository.",

    settings: {
      listModels: () => ["local-fake/fake-agent"],
      switchModel: () => choice,
      setKey: () => {},
      setDefault: () => {},
      settingLayers: () => ({ defaults: { foldSteps: 3, foldLines: 5 } }),
      saveSetting: () => {},
    },
    ...(resolved.price && { price: resolved.price }),
    onExit: () => {},

  });
  return { app, log, sessionFile };
}

const shots: string[] = [];
const verdicts: string[] = [];

/** 跑完一轮:判据打印到终端,画面进 HTML。 */
function judge(round: string, log: EventLog, file: string) {
  const requests = log.events.flatMap((e, i) => e.type === "request" ? [i] : []);
  const saved = requests.map((i) => readRequestRecording(file, log.events, i));
  const c = analyze(log.events, { lines: saved.reduce((n, r) => n + (r?.attempts?.reduce((count, a) => count + a.response.split(/\r?\n/).length, 0) ?? 0), 0), requests: requests.filter((_, i) => saved[i]?.attempts?.length && !saved[i]?.error) });
  const report = reportLines(file, log.events.length, c, usageTotals(log.events));
  verdicts.push(`\n${"=".repeat(96)}\n${round}\n${report.join("\n")}`);
  return c.checks.filter((k) => k.status === "fail");
}

const failures: string[] = [];

// ---------- 轮 1 与 2:冒烟、工具往返 ----------
{
  const { app, log, sessionFile } = boot("1-tools", 64000);
  await app.submit("Look at this directory and read the README.");
  shots.push(...divider("round 1–2 · one task: tool calls, results, streamed reply"), ...app.lines(W));
  const bad = judge("round 1–2  smoke and tool round-trip", log, sessionFile);
  if (bad.length > 0) failures.push(`round 1–2: ${bad.map((b) => b.id).join(", ")}`);
  app.stop();
}

// ---------- 轮 3:缓存,前缀长起来之后连着问 ----------
{
  const { app, log, sessionFile } = boot("3-cache", 64000);
  // 第一轮故意要一段长回答,把前缀撑过 1k;不到 1k 各家都不缓存,判据 D 会跳过。
  for (const q of [
    "Read the README and answer at length (长).",
    "Again please.",
    "And once more.",
    "Last one.",
  ]) {
    await app.submit(q);
  }
  shots.push(...divider("round 3 · four turns, the prefix grows"), ...app.lines(W).slice(-24));
  const bad = judge("round 3  prompt cache against the prediction", log, sessionFile);
  if (bad.length > 0) failures.push(`round 3: ${bad.map((b) => b.id).join(", ")}`);
  // 工作台:这一屏就是下一次请求的正文
  app.inspector.openComposition();
  shots.push(...divider("round 3 · Ctrl+E workbench: system, tools, every message, the cache line"), ...app.inspector.lines(W));
  app.inspector.close();
  app.stop();
}

// ---------- 轮 4:自动压缩 ----------
{
  const { app, log, sessionFile } = boot("4-compaction", 4000);
  await app.submit("Read the README and answer at length (长).");
  await app.submit("Now what did you keep?");
  await tick();
  shots.push(...divider("round 4 · the context crossed the threshold and compacted"), ...app.lines(W).slice(-20));
  const bad = judge("round 4  automatic compaction", log, sessionFile);
  if (bad.length > 0) failures.push(`round 4: ${bad.map((b) => b.id).join(", ")}`);
  app.inspector.openComposition();
  shots.push(...divider("round 4 · Ctrl+E: the summary in place, the covered messages folded under it"), ...app.inspector.lines(W));
  app.inspector.close();
  app.inspector.openEvents();
  shots.push(...divider("round 4 · Ctrl+R Tab: events, one readable line each"), ...app.inspector.lines(W));
  app.inspector.key("4");
  shots.push(...divider("round 4 · events filtered to 4 changes"), ...app.inspector.lines(W));
  app.inspector.close();
  app.stop();
}

// ---------- 轮 6:限流重试与恢复 ----------
{
  const { app, log, sessionFile } = boot("6-errors", 64000);
  await app.submit("This one hits a rate limit (错).");
  shots.push(...divider("round 6 · 429 then recovery: the retry row"), ...app.lines(W).slice(-18));
  const bad = judge("round 6  retry and recovery", log, sessionFile);
  if (bad.length > 0) failures.push(`round 6: ${bad.map((b) => b.id).join(", ")}`);
  app.stop();
}

// ---------- 设置屏 ----------
{
  const { app } = boot("7-settings", 64000);
  await app.command("/settings");
  shots.push(...divider("/settings · every switch with its value, meaning and source"), ...app.dialogLines());
  app.dialogInput("\x1b[B");
  app.dialogInput("\x1b[B");
  app.dialogInput("\x1b[B");
  app.dialogInput("\r");
  shots.push(...divider("/settings · foldSteps: common values, then type a value"), ...app.dialogLines());
  app.dialogInput("\x1b");
  app.dialogInput("\x1b");
  app.stop();
}

server.kill();

const html = join(outDir, "index.html");
writeFileSync(html, ansiToHtmlDocument(shots, "clarook rehearsal: the plan without a key"), "utf8");
for (const v of verdicts) console.log(v);
console.log(`\n${"=".repeat(96)}`);
console.log(`screens: ${html}`);
if (failures.length > 0) {
  console.log(`\nFAILED: ${failures.join(" · ")}`);
  process.exit(1);
}
console.log("\nevery check that can run without a key passed");
