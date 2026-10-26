// 生成 TUI 观感预览:用脚本化 provider 跑一段有代表性的对话,把渲染结果转成 HTML。
// 用法:pnpm exec tsx scripts/tui-preview.ts <输出.html>
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { ansiToHtmlDocument } from "../tests/helpers/ansi-html.js";
import { VirtualTerminal } from "../tests/helpers/virtual-terminal.js";

const out = process.argv[2];
if (!out) {
  console.error("用法: tsx scripts/tui-preview.ts <输出.html>");
  process.exit(1);
}

const turns: AssistantTurn[] = [
  {
    text: "先看一下测试现状。",
    toolCalls: [{ id: "c1", name: "bash", args: { command: "pnpm test 2>&1 | tail -5" } }],
    stopReason: "tool",
    usage: { inputTokens: 2310, outputTokens: 42 },
  },
  {
    text: "",
    toolCalls: [{ id: "c2", name: "read", args: { path: "src/loop.ts", offset: 60, limit: 12 } }],
    stopReason: "tool",
    usage: { inputTokens: 2890, outputTokens: 31 },
  },
  {
    text: [
      "## 结论",
      "",
      "失败集中在 `runTurn` 的终止判断:`steering(\"turn\")` 在 `end` 之后没有再次排空队列。",
      "",
      "- 修法:把排空移到 `stopReason === \"end\"` 分支内",
      "- 影响面:只有 queue 模式",
      "",
      "```ts",
      "if (injected === 0 && steering(\"turn\")) injected = inject(log, drainQueue());",
      "```",
    ].join("\n"),
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 4120, outputTokens: 188 },
  },
];

let i = 0;
const provider: Provider = {
  model: "deepseek-v4-pro",
  wire: (messages, tools) => ({
    model: "deepseek-v4-pro",
    messages,
    tools: tools.map((t) => ({ type: "function", function: t })),
    stream: true,
    stream_options: { include_usage: true },
  }),
  async complete(_m, _t, opts) {
    const t = turns[i++];
    if (!t) throw new Error("脚本越界");
    if (i === 1 && opts?.onReasoning) {
      opts.onReasoning("用户问的是测试失败原因,先跑一遍测试拿到确切的失败用例,再定位到相关代码。");
    }
    if (t.text && opts?.onDelta) opts.onDelta(t.text);
    return i === 1
      ? { ...t, reasoning: "用户问的是测试失败原因,先跑一遍测试拿到确切的失败用例,再定位到相关代码。" }
      : t;
  },
};

const bash = defineTool({
  name: "bash",
  description: "",
  parameters: Type.Object({ command: Type.String() }),
  async execute() {
    return [
      " ✓ tests/loop.test.ts (10 tests) 9ms",
      " ✗ tests/agent.test.ts (3 tests | 1 failed) 12ms",
      "   × queue 模式:插话等到 turn 末才注入",
      " Test Files  1 failed | 9 passed (10)",
      "      Tests  1 failed | 71 passed (72)",
    ].join("\n");
  },
});
const read = defineTool({
  name: "read",
  description: "",
  parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
  async execute() {
    return [
      "60\texport async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {",
      "61\t  const { log, provider, tools, signal, onDelta } = deps;",
      "62\t  const termination = deps.slots?.termination ?? untilIdle;",
      "63\t  const steering = deps.slots?.steering ?? steer;",
    ].join("\n");
  },
});

// 行数决定检视器覆盖层的高度;预览取 34 行,接近一屏终端。
const term = new VirtualTerminal(100, 34);
const log = new EventLog();
const app = createTuiApp({
  terminal: term,
  log,
  provider,
  tools: [bash, read],
  compaction: { strategy: async () => null, window: 131072, reserveTokens: 32000 },
  reserveTokens: 32000,
  info: { model: "deepseek-v4-pro", providerName: "deepseek", sessionFile: "sessions/2026-09-01T09-12-33.jsonl" },
  systemPrompt: "sys",
  onExit: () => {},
});

await app.submit("为什么 queue 模式的测试挂了?");
log.append({ type: "compaction", at: "t", cleared: [3, 5] });
await app.command("/context");

// 请求检视器(Ctrl+R)的几个画面,接在会话画面之后。
const divider = (t: string) => ["", `\x1b[38;2;201;165;78m━━ ${t} ━━\x1b[39m`, ""];
const shots: string[] = [];
app.inspector.open();
shots.push(...divider("Ctrl+R 请求检视:列表"), ...app.inspector.lines(100));
app.inspector.key("\x1b[H");
app.inspector.key("\r");
shots.push(...divider("详情 · 1 概要"), ...app.inspector.lines(100));
app.inspector.key("3");
shots.push(...divider("详情 · 3 发送(完整正文)"), ...app.inspector.lines(100));
app.inspector.key("]");
app.inspector.key("]");
app.inspector.key("6");
shots.push(...divider("详情 · 6 接收"), ...app.inspector.lines(100));
app.inspector.close();
app.stop();

writeFileSync(out, ansiToHtmlDocument([...app.lines(100), ...shots], "clarook TUI 预览"), "utf8");
console.log(`已写入 ${out}`);
