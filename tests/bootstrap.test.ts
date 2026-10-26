import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPreset,
  beginSession,
  buildCompaction,
  latestSession,
  loadCompactionStrategy,
  openSession,
  parseCommonArgs,
  parsePreservation,
  systemPromptFor,
} from "../cli/bootstrap.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function scripted(model: string, turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model,
    wire: (messages, tools) => ({ model, messages, tools }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

describe("入口参数与会话文件", () => {
  it("parseCommonArgs:选项、-p、位置参数、非法值报错", () => {
    const a = parseCommonArgs([
      "--model",
      "x/y",
      "--effort",
      "minimal",
      "--compaction",
      "clear",
      "--max-steps",
      "3",
      "--json",
      "任务",
      "文本",
    ]);
    expect(a).toMatchObject({
      model: "x/y",
      effort: "low",
      compaction: "clear",
      maxSteps: 3,
      json: true,

      rest: ["任务", "文本"],
    });
    expect(parseCommonArgs(["-p", "hi", "--continue"]).rest).toEqual(["hi"]);
    expect(() => parseCommonArgs(["--effort", "ultra"])).toThrow("unknown effort level");
    expect(parseCommonArgs(["--compaction", "./x.mjs"]).compaction).toBe("./x.mjs");
    expect(() => parseCommonArgs(["--bogus"])).toThrow("unknown option");
    expect(() => parseCommonArgs(["--model"])).toThrow("requires a value");
  });

  it("latestSession 取最新且跳过 trace 文件;openSession 恢复时挂回同一文件", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-boot-"));
    expect(latestSession(tmp)).toBeUndefined();
    writeFileSync(join(tmp, "2026-09-01T01.jsonl"), "");
    writeFileSync(join(tmp, "2026-09-02T02.jsonl"), "");
    writeFileSync(join(tmp, "2026-09-03T03.trace.jsonl"), "");
    expect(latestSession(tmp)?.endsWith("2026-09-02T02.jsonl")).toBe(true);

    const file = join(tmp, "s.jsonl");
    const first = new EventLog(file);
    first.append({ type: "session/start", at: "t", model: "m", system: "sys" });
    expect(() => openSession({ resume: file, continue: false })).toThrow("File is in use");
    first.recording?.flush();
    first.recording?.dispose();
    const opened = openSession({ resume: file, continue: false });
    expect(opened.resumed).toBe(true);
    expect(opened.log.events).toHaveLength(1);
    opened.log.append({ type: "user/message", at: "t", text: "继续" });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => openSession({ resume: join(tmp ?? "", "nope.jsonl"), continue: false })).toThrow(
      "session file not found",
    );
  });
});

describe("会话恢复", () => {
  it("历史渲染到屏幕、不重发 session/start、换模型记 session/model、检视器可重建同模型的线路正文", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-resume-"));
    const file = join(tmp, "s.jsonl");
    const term1 = new VirtualTerminal(100, 40);
    const firstLog = new EventLog(file);
    const app1 = createTuiApp({
      terminal: term1,
      log: firstLog,
      provider: scripted("m1", [
        {
          text: "第一轮回复",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 100, outputTokens: 5 },
        },
      ]),
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "m1", providerName: "p", sessionFile: file },
      systemPrompt: "原始系统提示词",
      onExit: () => {},
    });
    await app1.submit("第一轮");
    app1.stop();
    firstLog.recording?.dispose();
    const before = readFileSync(file, "utf8").trim().split("\n").length;

    const log = EventLog.load(file, { attach: true });
    const term2 = new VirtualTerminal(100, 40);
    const app2 = createTuiApp({
      terminal: term2,
      log,
      provider: scripted("m1", [{ text: "第二轮回复", toolCalls: [], stopReason: "end" }]),
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "m1", providerName: "p", sessionFile: file, resumed: true },
      systemPrompt: "这份不该被用",
      onExit: () => {},
    });
    let doc = app2.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("› 第一轮");
    expect(doc).toContain("第一轮回复");
    expect(doc).toContain(`· resumed: ${before} events, appending to`);
    expect(log.events.filter((e) => e.type === "session/start")).toHaveLength(1);
    expect(log.events.filter((e) => e.type === "session/model")).toHaveLength(0);

    await app2.submit("第二轮");
    doc = app2.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("第二轮回复");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(before);
    expect(JSON.parse(lines[0] as string).system).toBe("原始系统提示词");

    // 旧请求的线路正文:模型相同,用当前 provider 重建
    app2.inspector.open();
    app2.inspector.key("\x1b[H");
    app2.inspector.key("\r");
    app2.inspector.key("5");
    const insp = app2.inspector.lines(100).map(stripAnsi).join("\n");
    expect(insp).toContain('"model": "m1"');
    app2.inspector.close();
    app2.stop();
    log.recording?.flush();
    log.recording?.dispose();

    // 换模型恢复:入口层(beginSession)记一条 session/model,界面层不再碰
    const s3 = beginSession({ resume: file, continue: false }, { model: "m2" });
    expect(s3.resumed).toBe(true);
    expect(s3.log.events.at(-1)).toMatchObject({ type: "session/model", model: "m2" });
    s3.log.recording?.flush();
    s3.log.recording?.dispose();
    // 同模型恢复不多记
    const s4 = beginSession({ resume: file, continue: false }, { model: "m2" });
    expect(s4.log.events.filter((e) => e.type === "session/model")).toHaveLength(1);
    s4.log.recording?.dispose();
  });

  it("压缩策略:内置名、外部模块路径(扩展点)、未知名报错", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-strategy-"));
    const file = join(tmp, "my-strategy.mjs");
    writeFileSync(
      file,
      "export default async (input) => ({ cleared: [], strategy: `mine(${input.events.length})` });\n",
    );
    const custom = await loadCompactionStrategy(file);
    const out = await custom({ events: [], window: 1, targetTokens: 1 });
    expect(out?.strategy).toBe("mine(0)");
    const cfg = await buildCompaction(
      {
        compaction: "clear",
        compactionReserve: 100,
        compactionTrigger: "remind",
        compactionRatio: 0.8,
      },
      1000,
    );
    expect(cfg).toMatchObject({ window: 1000, reserveTokens: 100, trigger: "remind", ratio: 0.8 });
    await expect(loadCompactionStrategy("zip")).rejects.toThrow("unknown compaction strategy");
    writeFileSync(join(tmp, "bad.mjs"), "export const nothing = 1;\n");
    await expect(loadCompactionStrategy(join(tmp, "bad.mjs"))).rejects.toThrow(
      "must default-export a function",
    );
    // 文件模板、输出上限和保留策略必须真的送进摘要调用，不只是设置展示。
    const template = join(tmp, "summary.md");
    const instructions = "Keep exact paths.\n\n## Next action\nWrite the next step.";
    writeFileSync(template, instructions);
    const configured = await buildCompaction(
      { compactionPrompt: template, compactionMaxTokens: 73, preservation: "tokens 1" },
      100000,
    );
    const log = new EventLog();
    log.append({ type: "session/start", at: "t", model: "m", system: "Work on code." });
    log.append({ type: "user/message", at: "t", text: "Keep the goal." });
    log.append({ type: "user/message", at: "t", text: "Older findings. ".repeat(80) });
    log.append({ type: "user/message", at: "t", text: "More findings. ".repeat(80) });
    log.append({ type: "user/message", at: "t", text: "Continue." });
    const provider: Provider = {
      model: "m",
      wire: (messages) => ({ messages }),
      async complete(messages, tools, opts) {
        expect(messages.at(-1)).toEqual({ role: "user", content: instructions });
        expect(tools).toEqual([]);
        expect(opts?.maxTokens).toBe(73);
        return { text: "Next: verify the code.", toolCalls: [], stopReason: "end" };
      },
    };
    expect(
      await configured.strategy({
        events: log.events,
        window: configured.window,
        targetTokens: 50000,
        ...(configured.preservation && { preservation: configured.preservation }),
        provider,
      }),
    ).toMatchObject({ summary: "Next: verify the code." });
    writeFileSync(template, " ");
    await expect(buildCompaction({ compactionPrompt: template }, 100000)).rejects.toThrow("empty");
    await expect(buildCompaction({ compactionPrompt: "typo" }, 100000)).rejects.toThrow(
      "Unknown summary template",
    );
    await expect(
      buildCompaction({ compaction: "clear", compactionPrompt: "missing.md" }, 100000),
    ).resolves.toHaveProperty("strategy");
  });

  it("新会话的系统提示词带分段构成(名称、来源、字符数)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-prompt-"));
    const p = systemPromptFor({}, tmp);
    expect(p.sections.map((s) => s.name)).toEqual(["Role and rules", "Environment"]);
    expect(p.sections.every((s) => s.chars > 0)).toBe(true);
    expect(p.text).toContain("working directory: ");
  });
});

describe("配置里的可选项:命令行 > 预设 > defaults > 内置缺省", () => {
  it("defaults 给全局缺省,预设覆盖它,显式命令行再覆盖预设;prompt 段与 skills 同序", () => {
    const config = {
      default: "p/m",
      providers: {},
      defaults: {
        compaction: "clear",
        approve: "policy" as const,
        execution: "parallel" as const,
        steering: "turn" as const,
        preservation: "ratio 0.3",
        toolPrompts: "brief" as const,

        fold: true,
        subagent: true,
        prompt: {
          memory: true,
          instructionsAs: "user" as const,
          skills: { mode: "manual" as const },
        },
      },
      presets: {
        fast: {
          compaction: "llm",
          approve: "all" as const,
          toolPrompts: "rules" as const,
          prompt: { memory: false },
        },
      },
    };
    const byDefaults = applyPreset(parseCommonArgs([]), config);
    expect(byDefaults).toMatchObject({
      compaction: "clear",
      approve: "policy",
      execution: "parallel",
      steering: "turn",
      preservation: "ratio 0.3",
      toolPrompts: "brief",

      fold: true,
      subagent: true,
      memory: true,
      instructionsAs: "user",
      skillsMode: "manual",
    });
    const byPreset = applyPreset(parseCommonArgs(["--preset", "fast"]), config);
    expect(byPreset).toMatchObject({
      compaction: "llm",
      approve: "all",
      toolPrompts: "rules",
      memory: false,
      execution: "parallel",
    });
    const byFlags = applyPreset(
      parseCommonArgs(["--preset", "fast", "--compaction", "pipeline", "--steering", "step"]),
      config,
    );
    expect(byFlags).toMatchObject({
      compaction: "pipeline",

      steering: "step",
      approve: "all",
    });
    expect(() =>
      applyPreset(parseCommonArgs([]), { ...config, defaults: { preservation: "lots" } }),
    ).toThrow("preservation must be");
    expect(() => parseCommonArgs(["--steering", "sideways"])).toThrow("--steering accepts");
    expect(parsePreservation("tokens 5000").label).toBe("keepRecentTokens(5000)");
    expect(parsePreservation("ratio 0.25").label).toBe("keepRatio(0.25)");
    expect(() => parsePreservation("ratio 3")).toThrow("between 0 and 1");
    for (const spec of ["ratio .", "ratio 0.0.1", `tokens ${"9".repeat(310)}`])
      expect(() => parseCommonArgs(["--preservation", spec])).toThrow("finite number");
  });
});
