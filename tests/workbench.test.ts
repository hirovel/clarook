// 上下文工作台(Ctrl+E):一列就是下一次请求的正文,系统提示词与工具定义在前,被覆盖与被丢弃的留在原位,
// 缓存线画在上次发到的那条之下,改动后上移变金;system 行 Enter 翻段,落成对 #0 的编辑。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { systemPromptFor } from "../cli/bootstrap.js";
import { RequestInspector } from "../cli/inspector.js";
import { coveredLines, workbench, workbenchLine } from "../cli/inspector-workbench.js";
import { createTuiApp } from "../cli/tui-app.js";
import { changeContext } from "../src/context-edit.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages, requestMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { systemAt, systemParts, systemText } from "../src/system-prompt.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const at = "2026-09-07T10:00:00.000Z";
const tick = () => new Promise((r) => setTimeout(r, 5));
let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function sample(): AgentEvent[] {
  return [
    { type: "session/start", at, model: "m", system: "sys" },
    { type: "user/message", at, text: "q1" },
    {
      type: "request",
      at,
      model: "m",
      messages: 2,
      tools: [],
      estimatedTokens: 10,
      reason: "turn",
    },
    {
      type: "assistant/message",
      at,
      text: "reading",
      toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }],
      stopReason: "tool",
    },
    {
      type: "tool/result",
      at,
      callId: "c1",
      name: "read",
      content: "file body\nline 2",
      isError: false,
    },
    {
      type: "request",
      at,
      model: "m",
      messages: 4,
      tools: [],
      estimatedTokens: 20,
      reason: "turn",
    },
    { type: "assistant/message", at, text: "done", toolCalls: [], stopReason: "end" },
    { type: "user/message", at, text: "q2" },
  ];
}

describe("工作台的行", () => {
  it("系统提示词与工具定义在前;缓存线画在上次发到的那条之下;没发过就没有线", () => {
    const events = sample();
    const lastSent = deriveMessages(events.slice(0, 5)); // 第二次请求发出的
    const wb = workbench({
      events,
      tools: [{ name: "read", description: "Read.", parameters: {} }],
      lastSent,
    });
    expect(wb.rows.filter((r) => r.kind !== "records").map((r) => r.kind)).toEqual([
      "system",
      "tools",
      "message",
      "message",
      "message",
      "prefix",
      "message",
      "message",
    ]);
    expect(wb.rows.filter((r) => r.kind === "records")).toEqual([
      { kind: "records", from: 2, upTo: 3, tok: 0 },
      { kind: "records", from: 5, upTo: 6, tok: 0 },
    ]);
    const cache = wb.rows.find((r) => r.kind === "prefix");
    expect(cache).toMatchObject({ kind: "prefix", through: 4, broken: false });
    expect(wb.prefixTokens).toBeGreaterThan(0);
    expect(wb.total).toBeGreaterThan(wb.prefixTokens ?? 0);
    expect(wb.lastRequest).toBe(5);
    const none = workbench({ events, tools: [] });
    expect(none.rows.some((r) => r.kind === "prefix")).toBe(false);
    expect(none.prefixTokens).toBeUndefined();
  });

  it("宽字符不把右边的列顶歪:中文预览的行与英文行,token 与占比尺同一列", () => {
    const wide: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "sys" },
      { type: "user/message", at, text: "English question here" },
      {
        type: "request",
        at,
        model: "m",
        messages: 2,
        tools: [],
        estimatedTokens: 10,
        reason: "turn",
      },
      {
        type: "assistant/message",
        at,
        text: "先看一下目录,再读文件",
        toolCalls: [],
        stopReason: "end",
      },
    ];
    const wb = workbench({
      events: wide,
      tools: [{ name: "read", description: "Read.", parameters: {} }],
    });
    const lines = wb.rows
      .filter((r) => r.kind !== "records")
      .map((r) => stripAnsi(workbenchLine(wide, r, { selected: false, width: 100, maxTok: 10 })));
    // 尺之前的部分显示宽度处处相同:补齐按显示宽度算,不是按码元。按码元补的话中文行会把尺顶右。
    const heads = lines.map((l) => visibleWidth(l.split("▮")[0] as string));
    expect(new Set(heads).size).toBe(1);
    expect(lines.some((l) => l.includes("先看一下目录"))).toBe(true);
  });

  it("编辑之后线上移变金并说明在哪;丢弃的淡显在原位;清掉的结果说原来多大;摘要后折一行被覆盖的", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "context/edit", at, target: 3, field: "text", value: "reading carefully" },
      { type: "context/drop", at, target: 7 },
    ];
    const lastSent = deriveMessages(sample().slice(0, 7));
    const wb = workbench({ events, tools: [], lastSent });
    const cache = wb.rows.find((r) => r.kind === "prefix");
    expect(cache).toMatchObject({
      kind: "prefix",
      through: 1,
      broken: true,
      reason: "the edit at #3",
    });
    expect(wb.broken).toBe(true);
    const recorded = (value: ReturnType<typeof workbench>) =>
      value.rows
        .flatMap((r) =>
          r.kind === "records" ? Array.from({ length: r.upTo - r.from }, (_, i) => r.from + i) : [],
        )
        .sort((a, b) => a - b);
    expect(recorded(wb)).toEqual([2, 5, 8, 9]);
    const dropped = wb.rows.find((r) => r.kind === "dropped");
    expect(dropped).toMatchObject({ kind: "dropped", event: 7, by: 9, role: "user" });
    const compacted: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at, summary: "SUM", coversFrom: 1, coversUpTo: 5, cleared: [4] },
    ];
    const wb2 = workbench({ events: compacted, tools: [] });
    const kinds = wb2.rows.map((r) => r.kind);
    expect(kinds).toContain("covered");
    const covered = wb2.rows.find((r) => r.kind === "covered");
    expect(covered).toMatchObject({ kind: "covered", from: 1, upTo: 5, summary: 8 });
    expect(recorded(wb2)).toEqual([2, 5]); // 被摘要覆盖的原消息仍归原文折叠页,请求记录不消失。
    const edited = [
      ...events,
      { type: "compaction", at, summary: "SUM", coversFrom: 1, coversUpTo: 8 } satisfies AgentEvent,
    ];
    const editedCovered = workbench({ events: edited, tools: [] }).rows.find(
      (r) => r.kind === "covered",
    );
    if (editedCovered?.kind !== "covered") throw new Error("应有有效输入折叠行");
    expect(editedCovered.count).toBe(4); // q1、调用、结果、回复;已排除的 q2 不计入。
    const original = coveredLines(edited, editedCovered).map(stripAnsi).join("\n");
    expect(original).toContain("reading carefully");
    expect(original).not.toContain("q2");
    edited.push({ type: "context/edit", at, target: 3, field: "text", value: "LATER_CHANGE" });
    expect(coveredLines(edited, editedCovered).map(stripAnsi).join("\n")).toBe(original);
    const directoryHistory: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "sys" },
      { type: "session/directory", at, cwd: "/A", environment: "CURRENT_DIR_A" },
      { type: "user/message", at, text: "task" },
      { type: "assistant/message", at, text: "answer", toolCalls: [], stopReason: "end" },
      { type: "compaction", at, summary: "FIRST_SUMMARY", coversFrom: 1, coversUpTo: 4 },
    ];
    const directoryCovered = workbench({ events: directoryHistory, tools: [] }).rows.find(
      (r) => r.kind === "covered",
    );
    if (directoryCovered?.kind !== "covered") throw new Error("应有真实替换的对话");
    expect(directoryCovered.count).toBe(2);
    expect(directoryCovered.tok).toBe(3);
    const firstComparison = coveredLines(directoryHistory, directoryCovered)
      .map(stripAnsi)
      .join("\n");
    expect(firstComparison).toContain("task");
    expect(firstComparison).toContain("answer");
    expect(firstComparison).not.toContain("CURRENT_DIR_A");
    directoryHistory.push(
      { type: "session/directory", at, cwd: "/D", environment: "CURRENT_DIR_D" },
      { type: "user/message", at, text: "next task" },
      { type: "assistant/message", at, text: "next answer", toolCalls: [], stopReason: "end" },
      { type: "compaction", at, summary: "NEXT_SUMMARY", coversFrom: 1, coversUpTo: 8 },
    );
    expect(coveredLines(directoryHistory, directoryCovered).map(stripAnsi).join("\n")).toBe(
      firstComparison,
    );
    const nextCovered = workbench({ events: directoryHistory, tools: [] }).rows.find(
      (r) => r.kind === "covered",
    );
    if (nextCovered?.kind !== "covered") throw new Error("应有下一次真实替换的内容");
    expect(nextCovered.count).toBe(4);
    const nextComparison = coveredLines(directoryHistory, nextCovered).map(stripAnsi).join("\n");
    expect(nextComparison).toContain("FIRST_SUMMARY");
    expect(nextComparison).toContain("CURRENT_DIR_A");
    expect(nextComparison).not.toContain("CURRENT_DIR_D");
    const changedFrom: AgentEvent[] = [
      ...compacted,
      { type: "compaction", at, summary: "SHIFTED_SUMMARY", coversFrom: 2, coversUpTo: 8 },
    ];
    const shiftedCovered = workbench({ events: changedFrom, tools: [] }).rows.find(
      (r) => r.kind === "covered",
    );
    if (shiftedCovered?.kind !== "covered") throw new Error("应有保留策略改变后的替换内容");
    expect(shiftedCovered.count).toBe(3); // 旧摘要、done、q2;旧摘要的合成位置在新范围之外。
    expect(coveredLines(changedFrom, shiftedCovered).map(stripAnsi).join("\n")).toContain("SUM");
    const live = sample();
    const inspector = new RequestInspector({
      events: () => live,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 12,
      onClose() {},
      requestRender() {},
    });
    inspector.showComposition(1);
    inspector.handleInput("\x1b[B");
    inspector.handleInput("\r");
    inspector.handleInput("\r");
    live.push({ type: "compaction", at, summary: "SUM", coversFrom: 1, coversUpTo: 5 });
    expect(inspector.render(60).map(stripAnsi).join("\n")).toContain("Event #2");
    inspector.handleInput("\x1b");
    inspector.handleInput("\x1b");
    expect(inspector.render(60).map(stripAnsi).join("\n")).toMatch(/›\s+⋯ #2/);
  });
});

describe("工作台的界面", () => {
  function boot(
    tools = [
      defineTool({
        name: "echo",
        description: "Echo.",
        parameters: Type.Object({ text: Type.String() }),
        async execute(a) {
          return a.text;
        },
      }),
    ],
  ) {
    tmp = mkdtempSync(join(tmpdir(), "clarook-wb-"));
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        return { text: "reply", toolCalls: [], stopReason: "end" };
      },
    };
    const log = new EventLog();
    const p = systemPromptFor({}, tmp, { home: tmp, root: tmp });
    log.append({ type: "session/start", at, model: "m", system: p.system });
    const term = new VirtualTerminal(120, 40);
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools,
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s", contextWindow: 100000 },
      onExit: () => {},
    });
    const ins = () => app.inspector.lines(120).map(stripAnsi).join("\n");
    const doc = () => app.lines(120).map(stripAnsi).join("\n");
    return { app, log, ins, doc, term };
  }

  it("图片用量在下次请求前标未知,上次输入显示供应商实测", () => {
    const { app, log, ins } = boot();
    log.append({ type: "user/message", at, text: "first" });
    log.append({
      type: "request",
      at,
      model: "m",
      messages: 2,
      tools: [],
      estimatedTokens: 2,
      reason: "turn",
    });
    log.append({
      type: "assistant/message",
      at,
      text: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1200, outputTokens: 2 },
    });
    log.append({ type: "user/message", at, text: "look", images: [testImage] });
    app.inspector.openComposition(0);
    expect(ins()).toContain("text tok of 100k");
    expect(ins()).toContain("Image tokens unknown before next request");
    expect(ins()).toContain("Last API #1: 1.2k input tok measured by provider");
    app.stop();
  });

  it("头行有总量与缓存;预览随光标;Enter 在消息上出编号动作单;Ctrl+E 再按关闭", async () => {
    const { app, log, ins, term } = boot();
    await app.submit("first");
    await app.submit("second");
    app.setDraft("未发送的草稿\nsecond line");
    const count = log.events.length;
    term.feed("\x05");
    await tick();
    expect(app.inspector.isOpen()).toBe(true);
    let s = ins();
    expect(s).toContain("Context · Current projection");
    expect(s).toMatch(/≈\d+ tok of 100k/);
    expect(s).toMatch(/#0\s+system\s+role · env/);
    expect(s).toMatch(/tools\s+1 definition\s+echo/);
    expect(s).toContain("same prefix through #");
    // 光标在最后一条:助手回复,预览写来历
    expect(s).toMatch(/›\s+#\d+\s+assistant\s+reply/);
    expect(s).toContain("from event assistant/message");
    expect(s).toContain("position unknown"); // 这个 provider 没有 wireMap
    app.inspector.key("\x1b[A");
    s = ins();
    expect(s).toContain("Enter inspect log");
    app.inspector.key("\r");
    expect(ins()).toContain("Not extra model messages");
    app.inspector.key("\r");
    expect(ins()).toContain("Log record · not in current input");
    expect(ins()).toContain("request");
    app.inspector.key("]"); // 单条分组不能跨到模型消息。
    app.inspector.key("2");
    expect(ins()).toContain('"type": "request"');
    expect(app.draft()).toBe("未发送的草稿\nsecond line");
    expect(log.events).toHaveLength(count);
    app.inspector.key("\x1b");
    expect(ins()).toContain("Not extra model messages");
    app.inspector.key("\x1b");
    expect(ins()).toContain("Enter inspect log");
    app.inspector.key("\x1b[A");
    s = ins();
    expect(s).toMatch(/› ›\s+#\d+\s+user\s+second/);
    app.inspector.key("\r");
    s = ins();
    expect(s).toContain("1  View full message");
    expect(s).toContain("read-only · nothing changes");
    app.inspector.key("\r");
    app.inspector.key("\x1b[6~");
    expect(app.draft()).toBe("未发送的草稿\nsecond line");
    expect(log.events).toHaveLength(count);
    app.inspector.key("\x1b");
    term.feed("\x05");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(app.draft()).toBe("未发送的草稿\nsecond line");
    app.stop();
  });

  it("system 段可切换与编辑,关闭段保留正文;命令按段id修改,长列表操作保持目标", async () => {
    const { app, log, ins, term } = boot();
    const initial = systemParts(systemAt(log.events));
    const environment = initial.find((section) => section.id === "env");
    if (!environment) throw new Error("missing environment section");
    const compare = async () => {
      await app.command("/edit compare 0");
      const output = app.lines(120).map(stripAnsi).join("\n");
      return output.slice(output.lastIndexOf("System document comparison"));
    };
    await app.submit("hi");
    app.setDraft("keep this draft");
    app.inspector.openComposition(0);
    app.inspector.key("\r");
    expect(ins()).toContain("Environment [env]");
    app.inspector.key("2");
    app.inspector.key("\r");
    await tick();
    expect(systemParts(systemAt(log.events)).find((section) => section.id === "env")).toEqual({
      ...environment,
      enabled: false,
    });
    expect(log.events.at(-1)).toMatchObject({ type: "context/edit", target: 0, field: "system" });
    app.inspector.key("\x1b");
    expect(ins()).toMatch(/✎\s+#0\s+system/);
    expect(ins()).toContain("same prefix through nothing");
    const toggled = await compare();
    expect(toggled).toContain("- State: on");
    expect(toggled).toContain("+ State: off");
    expect(toggled).toContain(environment.text.split("\n").at(-1));
    expect(toggled).not.toContain("(identical)");

    // 不带段id打开列表,编辑动作使用真实文本编辑器,不覆盖关闭段或输入草稿。
    await app.command("/edit 0 system");
    app.inspector.key("1");
    app.inspector.key("e");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("\r");
    term.feed("MANUAL_REQUIREMENT_KEEP");
    term.feed("\t");
    term.feed("\r");
    expect(systemText(systemAt(log.events))).toContain("MANUAL_REQUIREMENT_KEEP");
    expect(systemParts(systemAt(log.events)).find((section) => section.id === "env")).toEqual({
      ...environment,
      enabled: false,
    });
    expect(app.draft()).toBe("keep this draft");
    await app.command("/edit 0 system env Edited environment");
    expect(systemText(systemAt(log.events))).not.toContain("Edited environment");
    expect(await compare()).toContain("+   Edited environment");
    await app.command("/edit 0 system");
    app.inspector.key("2");
    app.inspector.key("\r");
    expect(systemText(systemAt(log.events))).toContain("Edited environment");
    expect(systemText(systemAt(log.events))).toContain("MANUAL_REQUIREMENT_KEEP");
    app.inspector.close();
    const count = log.events.length;
    await app.command("/edit 0 system MANUAL_OVERWRITE");
    expect(log.events).toHaveLength(count);
    await app.submit("continue");
    const request = log.events.reduce(
      (last, event, index) => (event.type === "request" ? index : last),
      -1,
    );
    expect(requestMessages(log.events, request)[0]?.content).toContain("MANUAL_REQUIREMENT_KEEP");
    expect(requestMessages(log.events, request)[0]?.content).toContain("Edited environment");
    expect(log.events[0]).toMatchObject({ system: initial });

    // 已删除段不在编辑页中,但比较仍显示原段身份、来源与正文的删除。
    changeContext(log, { type: "replace-section", target: 0, id: "env" });
    const removed = await compare();
    expect(removed).toContain('- Section: "env"');
    expect(removed).toContain('- Name: "Environment"');
    expect(removed).toContain(
      `- Source: ${environment.source === undefined ? "(none)" : JSON.stringify(environment.source)}`,
    );
    expect(removed).toContain(`-   ${environment.text.split("\n")[0]}`);
    // 空文档仍能比较所有删除的原文,也能继续增加个人正文。
    changeContext(log, { type: "set-system", target: 0, value: [] });
    const emptied = await compare();
    expect(emptied).toContain('- Section: "role"');
    expect(emptied).toContain('- Section: "env"');
    expect(emptied).toContain("+ (empty system document)");
    expect(emptied).not.toContain("Usage:");
    await app.command("/edit 0 system");
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.close();
    await app.command("/edit 0");
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.key("a");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("Personal instructions");
    term.feed("\t");
    term.feed("\r");
    expect(systemParts(systemAt(log.events))).toEqual([
      { id: "custom", name: "Custom", text: "Personal instructions", enabled: true },
    ]);
    // 再按同一入口编辑已有Custom,不产生第二个同身份段。
    await app.command("/edit 0 system");
    app.inspector.key("a");
    term.feed(" stay here");
    term.feed("\t");
    term.feed("\r");
    expect(systemParts(systemAt(log.events))).toHaveLength(1);
    await app.submit("check personal instructions");
    const customRequest = log.events.reduce(
      (last, event, index) => (event.type === "request" ? index : last),
      -1,
    );
    expect(requestMessages(log.events, customRequest)[0]?.content).toBe(
      "Personal instructions stay here",
    );

    // 原生Custom正文中的段标签不能伪装成真正的新段,实际输入不同必须能比较。
    const custom = new EventLog();
    custom.append({
      type: "session/start",
      at,
      model: "m",
      system: 'A\n\nSection: "b"\nName: "B"\nState: on\nSource: (none)\nText:\nB',
    });
    const customApp = createTuiApp({
      terminal: new VirtualTerminal(120, 40),
      log: custom,
      provider: app.agent.provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "custom" },
      onExit() {},
    });
    try {
      customApp.inspector.openComposition(0);
      customApp.inspector.key("\r");
      expect(customApp.inspector.lines(120).map(stripAnsi).join("\n")).toContain("Custom [custom]");
      customApp.inspector.close();
      changeContext(custom, {
        type: "set-system",
        target: 0,
        value: [
          { id: "custom", name: "Custom", text: "A", enabled: true },
          { id: "b", name: "B", text: "B", enabled: true },
        ],
      });
      expect(deriveMessages(custom.events)[0]?.content).toBe("A\n\nB");
      await customApp.command("/edit compare 0");
      const output = customApp.lines(120).map(stripAnsi).join("\n");
      const compared = output.slice(output.lastIndexOf("System document comparison"));
      expect(compared).not.toContain("(identical)");
      expect(compared).toContain('-   Section: "b"');
      expect(compared).toContain('+ Section: "b"');
    } finally {
      customApp.stop();
    }

    const sections = Array.from({ length: 18 }, (_, i) => ({
      id: `section-${i + 1}`,
      name: `Section ${i + 1}`,
      text: `Body ${i + 1}`,
      enabled: true,
    }));
    const long = new EventLog();
    long.append({ type: "session/start", at, model: "m", system: sections });
    const toggles: string[] = [];
    const picker = new RequestInspector({
      events: () => long.events,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 12,
      onSection: (_target, section) => toggles.push(section),
      onClose() {},
      requestRender() {},
    });
    picker.showComposition(0);
    picker.handleInput("\r");
    picker.handleInput("\x1b[F");
    const view = picker.render(60);
    expect(view).toHaveLength(12);
    expect(view.map(stripAnsi).join("\n")).toMatch(/› 18\s+Section 18/);
    picker.handleInput("\r");
    expect(toggles).toEqual(["section-18"]);
    picker.handleInput("\x1b[H");
    picker.render(60);
    picker.handleInput("\x1b[6~");
    expect(picker.render(60).map(stripAnsi).join("\n")).not.toMatch(/› 1\s+Section 1\s/);
    picker.handleInput("\x1b[5~");
    expect(picker.render(60).map(stripAnsi).join("\n")).toMatch(/› 1\s+Section 1\s/);
    app.stop();
  });

  it("tools 行 Enter 开 /tools 选单", async () => {
    const { app, ins } = boot();
    await app.submit("hi");
    app.inspector.openComposition();
    app.inspector.key("\x1b[A"); // 请求日志折叠行
    app.inspector.key("\x1b[A"); // 越过缓存线到用户消息
    app.inspector.key("\x1b[A"); // tools 行
    expect(ins()).toMatch(/› ·\s+tools/);
    app.inspector.key("\r");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("Tools");
    app.dialogInput("\x1b");
    app.stop();
  });

  it("短终端菜单跟随选择,详情可翻页;运行或只读状态变化后不执行旧动作", () => {
    const events = sample();
    const source = events[3];
    if (source?.type !== "assistant/message") throw new Error("missing assistant");
    source.text = "long preview\n".repeat(20);
    source.reasoning = "thinking";
    source.reasoningKind = "full";
    events.push({ type: "context/edit", at, target: 3, field: "text", value: source.text });
    let running = false;
    let readOnly: string | undefined;
    const actions: string[] = [];
    const inspector = new RequestInspector({
      events: () => events,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 12,
      running: () => running,
      readOnlyReason: () => readOnly,
      onAction: (action) => actions.push(action),
      onClose() {},
      requestRender() {},
    });
    const screen = () => {
      const lines = inspector.render(60);
      expect(lines).toHaveLength(12);
      expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
      return lines.map(stripAnsi).join("\n");
    };
    inspector.showComposition(3);
    screen(); // 工作台本身也不能超出短窗口,不能只保证动作菜单适配。
    inspector.handleInput("\r");
    inspector.handleInput("9");
    expect(screen()).toContain("› 9  Fork new session here");
    inspector.handleInput("2");
    expect(screen()).toContain("› 2  Edit content");
    expect(screen()).toContain("Applies: next message you send");
    inspector.handleInput("\x1b[6~");
    inspector.handleInput("\x1b[6~");
    expect(screen()).toContain("hit impact unknown");
    // 选中编辑后任务才开始,Enter 不能继续使用原选项下标。
    running = true;
    inspector.handleInput("\r");
    expect(actions).toEqual([]);
    expect(screen()).not.toContain("Edit content");
    inspector.handleInput("1");
    inspector.handleInput("\r");
    expect(inspector.currentMode).toBe("message");
    inspector.showComposition(3);
    expect(screen()).toContain("read-only while running");
    running = false;
    inspector.showComposition(3);
    inspector.handleInput("\r");
    inspector.handleInput("3"); // 原来是Edit thinking,只读筛选后第三项会成为Fork。
    readOnly = "Fixture session is read-only.";
    inspector.handleInput("\r");
    expect(actions).toEqual([]);
    expect(screen()).not.toContain("Retry latest reply");
    inspector.handleInput("2");
    inspector.handleInput("\r");
    expect(actions).toEqual(["compare"]); // 当前主会话只读时仍允许比较。
  });
});
