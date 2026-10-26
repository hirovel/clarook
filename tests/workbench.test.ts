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
import { workbench, workbenchLine } from "../cli/inspector-workbench.js";
import { replaceSystemSection, sectionStates, systemWithSections } from "../cli/prompt-sections.js";
import { createTuiApp } from "../cli/tui-app.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
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
    log.append({ type: "session/start", at, model: "m", system: p.text, sections: p.sections });
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
    expect(s).toContain("Context · Next request");
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

  it("system 行 Enter 列段并翻:落成对 #0 的编辑,行标 ✎,缓存线说明从头重算;切不回段的日志只读", async () => {
    const { app, log, ins } = boot();
    await app.submit("hi");
    app.inspector.openComposition(0);
    let s = ins();
    expect(s).toMatch(/› ·\s+#0\s+system/);
    app.inspector.key("\r");
    s = ins();
    expect(s).toContain("System prompt");
    expect(s).toContain("Changes this session's next input");
    expect(s).toMatch(/1\s+Role and rules\s+on/);
    expect(s).toMatch(/2\s+Environment\s+on/);
    app.inspector.key("2");
    app.inspector.key("\r");
    await tick();
    const edit = log.events.at(-1);
    expect(edit).toMatchObject({
      type: "context/edit",
      target: 0,
      field: "system",
      note: "sections: Role and rules",
    });
    s = ins();
    expect(s).toMatch(/2\s+Environment\s+off/);
    app.inspector.key("\x1b");
    s = ins();
    expect(s).toMatch(/✎\s+#0\s+system/);
    expect(s).toContain("same prefix through nothing");
    const states = sectionStates(log.events);
    expect(states?.map((x) => x.on)).toEqual([true, false]);
    expect(systemWithSections(states ?? [], "Environment")).toBe(
      log.events[0]?.type === "session/start" ? log.events[0].system : "",
    );
    const skillsEdit = replaceSystemSection(log.events, "Skills", {
      name: "Skills",
      text: "# Skills\n- review",
    });
    if (!skillsEdit) throw new Error("missing catalog edit");
    log.append(skillsEdit);
    const after = sectionStates(log.events);
    expect(after?.find((s) => s.name === "Environment")?.on).toBe(false);
    expect(systemWithSections(after ?? [], "Environment")).toContain(
      states?.find((s) => s.name === "Environment")?.text,
    );
    // 旧日志:段长度对不上全文 → 只读
    const old = new EventLog();
    old.append({
      type: "session/start",
      at,
      model: "m",
      system: "a b c",
      sections: [{ name: "x", chars: 99 }],
    });
    expect(sectionStates(old.events)).toBeUndefined();
    // 自定义段很多时,选中的最后一段必须可见且操作目标不随滚动改变。
    const sections = Array.from({ length: 18 }, (_, i) => ({
      name: `Section ${i + 1}`,
      text: `Body ${i + 1}`,
    }));
    const long = new EventLog();
    long.append({
      type: "session/start",
      at,
      model: "m",
      system: sections.map((s) => s.text).join("\n\n"),
      sections: sections.map((s) => ({ name: s.name, chars: s.text.length })),
    });
    const toggles: string[] = [];
    const picker = new RequestInspector({
      events: () => long.events,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 12,
      onSection: (name) => toggles.push(name),
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
    expect(toggles).toEqual(["Section 18"]);
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
