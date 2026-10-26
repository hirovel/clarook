// 零 key 的"运行效果与内部"预览:起本机假模型,在虚拟终端里真跑一遍界面(真实 HTTP、真实工具、真实落盘),
// 把主屏与检视器的各个画面转成一份 HTML。
// 用法:pnpm exec tsx scripts/demo-preview.ts <输出.html>
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTuiApp } from "../cli/tui-app.js";
import { createProvider, loadConfig, resolveApiKey, resolveModel } from "../src/config.js";
import { llmSummarize } from "../src/compaction.js";
import { EventLog } from "../src/log.js";
import { ansiToHtmlDocument } from "../tests/helpers/ansi-html.js";
import { VirtualTerminal } from "../tests/helpers/virtual-terminal.js";
import { buildTools, RESERVE } from "../cli/bootstrap.js";

const out = process.argv[2] ?? ".preview/demo.html";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 4112;

const server = spawn(process.execPath, [join(root, "scripts", "fake-model.mjs"), String(port)], {
  stdio: ["ignore", "ignore", "inherit"],
});
await new Promise((r) => setTimeout(r, 400));

try {
  const { config } = loadConfig(join(root, "examples", "config.demo.json"));
  const r = resolveModel(config, "fake-agent");
  r.provider.baseUrl = `http://127.0.0.1:${port}`;
  const provider = createProvider(r, resolveApiKey(r.providerName, r.provider));

  mkdirSync(join(root, ".preview"), { recursive: true });
  const sessionFile = join(root, ".preview", "demo-session.jsonl");
  // 日志只追加;每次演示从空文件开始。
  rmSync(sessionFile, { force: true });
  rmSync(sessionFile.replace(/\.jsonl$/, ".records"), { recursive: true, force: true });
  rmSync(sessionFile.replace(/\.jsonl$/, ".trace.jsonl"), { force: true });
  const log = new EventLog(sessionFile);
  const term = new VirtualTerminal(110, 40);
  // 窗口故意给小(8000),让第二个任务("长")触发自动压缩,压缩对照才有东西看。
  const compaction = { strategy: llmSummarize(), window: 8000, reserveTokens: RESERVE };
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: buildTools(),
    compaction,
    reserveTokens: RESERVE,
    info: { model: r.model, providerName: r.providerName, sessionFile },
    systemPrompt: "你是一个在用户机器上工作的编程助手。工作目录即当前目录。",

    ...(r.price && { price: r.price }),
    onExit: () => {},
  });

  await app.submit("看看这个目录里有什么,读一下 README");
  await app.command("/context");
  await app.submit("再来一次,这次要长一点(长)");
  await app.submit("第三次,看压缩之后模型还看到什么");
  await app.command("/context");

  const divider = (t: string) => ["", `\x1b[38;2;201;165;78m━━ ${t} ━━\x1b[39m`, ""];
  const shots: string[] = [];
  const shot = (title: string) => shots.push(...divider(title), ...app.inspector.lines(110));
  app.inspector.open();
  shot("Ctrl+R Requests:一行一请求");
  app.inspector.key("\x1b[H");
  app.inspector.key("\r");
  shot("Request #1 · 1 summary");
  app.inspector.key("2");
  shot("Request #1 · 2 decisions");
  app.inspector.key("3");
  shot("Request #1 · 3 sent(模型看到的全部内容)");
  app.inspector.key("5");
  shot("Request #1 · 5 wire JSON(与实际发送逐字节一致)");
  app.inspector.key("6");
  shot("Request #1 · 6 received(含原始流)");
  app.inspector.key("7");
  shot("Request #1 · 7 written(这次请求之后进日志的事件)");
  app.inspector.key("\x1b");
  app.inspector.key("\t");
  shot("Tab · Events:内核维护的全部数组");
  app.inspector.key("\t");
  shot("Tab · Compactions");
  app.inspector.key("\r");
  shot("Compaction #1 · 1 compare");
  app.inspector.key("2");
  shot("Compaction #1 · 2 original(被摘要取代的那一大段)");
  app.inspector.key("3");
  shot("Compaction #1 · 3 summary");
  app.inspector.close();
  app.stop();

  writeFileSync(out, ansiToHtmlDocument([...app.lines(110), ...shots], "clarook 零 key 演示"), "utf8");
  console.log(`已写入 ${out};会话文件 ${sessionFile}(${log.events.length} 条事件)`);
} finally {
  server.kill();
}
