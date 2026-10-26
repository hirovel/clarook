// 用实际组件与按键生成组装工作台的多尺寸预览,不启动供应商、不读用户配置。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTuiApp } from "../cli/tui-app.js";
import type { Preset } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { planTool } from "../src/plan.js";
import type { Provider } from "../src/provider.js";
import { defaultPreset, setSetting } from "../src/settings.js";
import { mergeSetup } from "../src/setup.js";
import { defineTool } from "../src/tools.js";
import { ansiToHtmlDocument } from "../tests/helpers/ansi-html.js";
import { VirtualTerminal } from "../tests/helpers/virtual-terminal.js";

const out = join(".preview", "setup");
mkdirSync(out, { recursive: true });
const links: { path: string; label: string }[] = [];
const tick = () => new Promise((r) => setTimeout(r, 10));
for (const [width, height] of [[120, 40], [80, 30], [60, 24]] as const) {
  let defaults: Preset = defaultPreset();
  const presets = [{ name: "focused", values: { ...defaultPreset(), subagent: true, execution: "parallel" as const, foldSteps: 1 } }];
  const provider: Provider = { model: "local-fake", async complete() { return { text: "Ready.", toolCalls: [], stopReason: "end" }; } };
  const tools = ["read", "edit", "write", "bash", "grep", "glob", "fetch"].map((name) => defineTool({ name, description: `${name} (preview fixture)`, parameters: Type.Object({}), async execute() { return "preview fixture"; } }));
  const app = createTuiApp({ terminal: new VirtualTerminal(width, height), log: new EventLog(), provider, tools: [...tools, planTool], compaction: { strategy: async () => null, window: 128000, reserveTokens: 32000 }, reserveTokens: 32000, info: { model: provider.model, providerName: "demo", sessionFile: "preview.jsonl" }, systemPrompt: "Preview fixture.", settings: {
    listModels: () => ["demo/local-fake", "demo/comparison-model"], defaultModel: () => "demo/local-fake",
    switchModel: () => ({ provider, providerName: "demo", model: provider.model, contextWindow: 128000 }), setKey: () => {}, setDefault: () => {},
    settingLayers: () => ({ defaults }), saveSetting: (key, value) => { defaults = setSetting(defaults, key, value); },
    listPresets: () => presets, savePreset: () => {}, usePreset: (name) => { defaults = mergeSetup(defaultPreset(), presets.find((p) => p.name === name)?.values ?? {}); },
  }, onExit: () => {} });
  const shot = (name: string, label: string) => {
    const path = `${width}-${name}.html`;
    writeFileSync(join(out, path), ansiToHtmlDocument(app.dialogLines(), `${label} · ${width} × ${height} · local fixtures`));
    links.push({ path, label: `${width} × ${height} · ${label}` });
  };
  await app.command("/settings"); shot("overview", "Agent setup overview");
  await app.command("/settings compaction"); shot("context", "Context choices and consequences");
  app.dialogInput("\r"); shot("choices", "Select compaction method");
  app.dialogInput("\x1b"); app.dialogInput("\x1b[C"); app.dialogInput("\r"); shot("details", "Full explanation and recommendation");
  app.dialogInput("\x1b"); app.dialogInput("\t"); shot("defaults", "Saved defaults have a separate scope");
  await app.command("/settings tools.disable"); app.dialogInput("\r"); app.dialogInput("\x1b[B"); app.dialogInput("\r"); await tick(); shot("tools", "Tool availability after an edit");
  await app.command("/settings planReminder"); app.dialogInput("\r"); app.dialogInput("\x1b[C"); app.dialogInput("\r"); app.dialogInput("\x15"); app.dialogInput("many"); app.dialogInput("\r"); await tick(); shot("error", "Inline validation preserves the value");
  await app.command("/settings"); app.dialogInput("9"); app.dialogInput("\r"); app.dialogInput("\x1b[B"); app.dialogInput("\r"); shot("preset", "Review a preset before saving defaults");
  app.stop();
}
writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clarook · Agent setup review</title><style>body{font:16px/1.6 system-ui;background:#1b1916;color:#e2ddd5;margin:40px;max-width:1000px}h1{font-size:28px}p{color:#b3ada4}a{color:#c7ad82;text-underline-offset:4px}ul{columns:3;column-gap:32px;padding-left:20px}li{margin-bottom:12px;break-inside:avoid}a:focus-visible{outline:2px solid #c7ad82;outline-offset:4px}@media(max-width:800px){ul{columns:1}}</style><h1>Agent setup</h1><p>Actual terminal output at three sizes. Choose a screen to inspect the layout, information and available actions. These fixtures use no provider connection.</p><ul>${links.map((l) => `<li><a href="${l.path}">${l.label}</a></li>`).join("")}</ul></html>`);
console.log(`Wrote ${links.length} screens to ${out}`);
