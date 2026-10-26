// 界面:上下文面板(Ctrl+E)。动作按消息类型增减与后果预告;Enter 出菜单再执行;
// compare / restore / rewind / edit-reasoning / drop / fork / retry 落到事件;编辑在终端内完成。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ClipboardInput } from "../cli/clipboard-input.js";
import { actionsFor, compositionRows, consequenceOf } from "../cli/inspector-composition.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { type AgentEvent, now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages, type Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { recordUnresolvedCalls } from "../src/recovery.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");
const panel = (app: TuiApp) => plain(app.inspector.lines(120).join("\n"));
const tick = () => new Promise((r) => setTimeout(r, 5));

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** 从当前行往上找,直到菜单里出现某个标签;返回是否找到(菜单保持打开)。 */
function findRowWith(app: TuiApp, label: string): boolean {
  for (let i = 0; i < 12; i++) {
    app.inspector.key("\r");
    if (panel(app).includes(label)) return true;
    app.inspector.key("\x1b");
    app.inspector.key("\x1b[A");
  }
  return false;
}

/** 菜单已打开:按标签顺序数到目标项,回车执行。 */
function pick(app: TuiApp, label: string): void {
  const lines = panel(app).split("\n");
  const labels = [
    "View full message",
    "Edit content",
    "Edit thinking",
    "Compare with original",
    "Restore original text",
    "Exclude from input",
    "Keep input through here",
    "Retry latest reply",
    "Fork new session here",
  ];
  const present = labels.filter((l) => lines.some((x) => x.includes(l)));
  const idx = present.indexOf(label);
  if (idx < 0) throw new Error(`menu has no ${label}: ${present.join(", ")}`);
  for (let i = 0; i < idx; i++) app.inspector.key("\x1b[B");
  app.inspector.key("\r");
}

function scriptedB(turns: AssistantTurn[], extra: Partial<Provider> = {}): Provider {
  let i = 0;
  return {
    model: "m",
    async complete(_m, _t, opts) {
      const t = turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
      if (t.reasoning && opts?.onReasoning) opts.onReasoning(t.reasoning.slice(0, 2));
      return t;
    },
    ...extra,
  };
}

const echoB = defineTool({
  name: "echo",
  description: "Echo.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function bootB(provider: Provider, over: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term = new VirtualTerminal(120, 40);
  const exits: number[] = [];
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echoB],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    onExit: () => exits.push(1),
    ...over,
  });
  return { app, term, log, exits };
}

describe("上下文面板的动作与后果", () => {
  it("动作按消息类型与编辑状态增减;后果算出重算条数、缓存失效点、Anthropic 丢的思考块", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: now(), model: "m", system: "sys" },
      { type: "user/message", at: now(), text: "q" },
      {
        type: "assistant/message",
        at: now(),
        text: "a",
        toolCalls: [{ id: "c1", name: "read", args: {} }],
        stopReason: "tool",
        reasoning: "why",
        reasoningKind: "full",
        opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
      },
      {
        type: "tool/result",
        at: now(),
        callId: "c1",
        name: "read",
        content: "file",
        isError: false,
      },
      { type: "assistant/message", at: now(), text: "done", toolCalls: [], stopReason: "end" },
      { type: "context/edit", at: now(), target: 3, field: "content", value: "file (edited)" },
    ];
    const { rows } = compositionRows(events);
    const asst = rows.find((r) => r.event === 2) as (typeof rows)[number];
    const tool = rows.find((r) => r.event === 3) as (typeof rows)[number];
    const last = rows[rows.length - 1] as (typeof rows)[number];
    expect(actionsFor(events, asst, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "edit-reasoning",
      "drop",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, tool, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "compare",
      "restore",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, last, rows.length).map((a) => a.action)).not.toContain("rewind");
    const anthropic = {
      model: "m",
      fields: { protocol: "anthropic", sends: [], reads: [], ignores: [] },
      complete: async () => ({}) as AssistantTurn,
    } as unknown as Provider;
    const edit = consequenceOf("edit", asst, rows, events, anthropic);
    expect(edit).toContain("Later input: 2 messages");
    expect(edit).toContain("input changes from #2; hit impact unknown");
    expect(edit).toContain("Anthropic drops 1 thinking block");
    expect(consequenceOf("drop", asst, rows, events)).toContain("with its 1 tool result");
    expect(consequenceOf("rewind", tool, rows, events)).toContain("Input: keep through #3");
    expect(consequenceOf("view", tool, rows, events)).toBe("read-only · nothing changes");
    const initial = events.slice(0, 2);
    const initialRows = compositionRows(initial).rows;
    const initialUser = initialRows[1];
    if (!initialUser) throw new Error("missing initial user message");
    expect(actionsFor(initial, initialUser, initialRows.length).map((a) => a.action)).not.toContain(
      "retry",
    );
  });

  it("打字形态:/edit compare、restore、rewind 落到事件;首屏随第一条消息撤掉", async () => {
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        return { text: "reply", toolCalls: [], stopReason: "end" };
      },
    };
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(a) {
        return a.text;
      },
    });
    const log = new EventLog();
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 40),
      log,
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      onExit: () => {},
    });
    let doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("Ask anything");
    expect(doc).toContain("/help");
    await app.submit("first");
    await app.submit("second");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).not.toContain("Ask anything");
    expect(doc).toContain("› second");
    // 正常追加显示请求边界,不误报上下文重算。
    expect(doc).toContain("Request #2");
    expect(doc).not.toContain("recomputed");

    // 命令:编辑 #1 的 content,再 compare 与 restore;rewind 到 #1 丢掉之后的三条。
    await app.command("/edit 1 content first (edited)");
    await app.command("/edit compare 1");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("#1.content  original 5 chars → current 14 chars");
    expect(doc).toContain("- first");
    expect(doc).toContain("+ first (edited)");
    await app.command("/edit restore 1");
    const restore = log.events.at(-1);
    expect(restore?.type).toBe("context/edit");
    expect((restore as { value: string }).value).toBe("first");
    await app.command("/edit rewind 1");
    const drops = log.events.filter((e) => e.type === "context/drop");
    expect(drops.map((e) => (e as { target: number }).target)).toEqual([3, 4, 6]);
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("rewound to event #1: dropped 3 messages");
    app.stop();
  });
});

describe("面板动作菜单", () => {
  it("compare / restore / rewind 落到事件;内部编辑保留草稿,应用前不改上下文", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-panel-"));
    let lastInput: Message[] = [];
    const provider: Provider = {
      model: "m",
      async complete(messages) {
        lastInput = messages;
        return {
          text: "answer",
          toolCalls: [],
          stopReason: "end",
          reasoning: "deep thought",
          reasoningKind: "full",
        };
      },
    };
    const log = new EventLog();
    const terminal = new VirtualTerminal(60, 24);
    let clipboard: () => Promise<ClipboardInput> = async () => ({});
    let clipboardReads = 0;
    const app = createTuiApp({
      terminal,
      readClipboard: () => {
        clipboardReads++;
        return clipboard();
      },
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      sessionsDir: tmp,
      onExit: () => {},
    });
    await app.submit("first");
    await app.submit("second");
    await app.command("/edit 1 content first (edited)");

    // 找到编辑过的那一行(菜单里有 Compare),依次 compare、restore
    app.inspector.openComposition();
    expect(findRowWith(app, "Compare with original")).toBe(true);
    pick(app, "Compare with original");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(doc(app)).toContain("#1.content  original 5 chars → current 14 chars");

    app.inspector.openComposition();
    expect(findRowWith(app, "Restore original text")).toBe(true);
    pick(app, "Restore original text");
    await tick();
    expect(doc(app)).toContain("restored event #1");

    // 全文思考的助手行:Enter 只换行,动作需要切换焦点,草稿不被覆盖或发送。
    terminal.feed("unsent draft");
    app.inspector.openComposition();
    expect(findRowWith(app, "Edit thinking")).toBe(true);
    pick(app, "Edit thinking");
    await tick();
    const before = log.events.length;
    terminal.feed("\r");
    const addition = Array.from({ length: 35 }, (_, i) => `中文 ${i} EDITED`).join("\n");
    terminal.feed(`\x1b[200~\x1b[31m${addition}\x1b[0m\x00\x1b[201~`);
    expect(log.events).toHaveLength(before);
    expect(app.draft()).toBe("unsent draft");
    app.tui.renderNow(true);
    const screen = (await terminal.screen()).join("\n");
    expect(screen).toContain("中文 34 EDITED");
    expect(screen).toContain("Apply");
    // 同一编辑器缩窗后仍看见光标内容和操作,放大后全文不变。
    for (const rows of [12, 8]) {
      terminal.resize(36, rows);
      app.tui.renderNow(true);
      const small = (await terminal.screen()).join("\n");
      expect(small).toContain("中文 34 EDITED");
      expect(small).toContain("Apply");
      expect(small).toContain("Esc cancel");
      expect(app.dialogLines().length).toBeLessThanOrEqual(rows);
      terminal.feed("\x1b[A");
      app.tui.renderNow(true);
      expect((await terminal.screen()).join("\n")).toContain("中文 33 EDITED");
      terminal.feed("\x1b[B");
    }
    terminal.resize(60, 24);
    app.tui.renderNow(true);
    terminal.feed("\x03");
    terminal.feed("\x03");
    expect(plain(app.dialogLines().join("\n"))).toContain("Quit Clarook");
    expect(log.events).toHaveLength(before);
    terminal.feed("\x1b");
    expect(plain(app.dialogLines().join("\n"))).toContain("中文 34 EDITED");
    expect(app.draft()).toBe("unsent draft");
    terminal.feed("\t");
    terminal.feed("\r");
    const edit = [...log.events].reverse().find((e) => e.type === "context/edit");
    expect(edit).toMatchObject({ field: "reasoning", value: `deep thought\n${addition}` });
    expect(log.events).toHaveLength(before + 1);
    expect(app.draft()).toBe("unsent draft");
    expect(doc(app)).toContain(".reasoning (");

    // 取消、不改动应用都不写事件;清空是有效编辑,不能当取消。
    await app.command("/edit 1 content");
    terminal.feed("discard me");
    terminal.feed("\x1b");
    expect(log.events).toHaveLength(before + 1);
    await app.command("/edit 1 content");
    terminal.feed("\t");
    terminal.feed("\r");
    expect(log.events).toHaveLength(before + 1);
    await app.command("/edit 1 content");
    terminal.feed("\x15");
    terminal.feed("\t");
    terminal.feed("\r");
    expect(log.events.at(-1)).toMatchObject({ type: "context/edit", target: 1, value: "" });
    expect(log.events[1]).toMatchObject({ type: "user/message", text: "first" });
    expect(app.draft()).toBe("unsent draft");

    // Ctrl+K 归文字编辑;异步粘贴可继续打字,应用等待读取,重复按键不重复读取。
    let finishPaste: (value: ClipboardInput) => void = () => {};
    clipboard = () =>
      new Promise((resolve) => {
        finishPaste = resolve;
      });
    await app.command("/edit 1 content");
    terminal.feed("keep remove");
    terminal.feed("\x01");
    for (let i = 0; i < 5; i++) terminal.feed("\x1b[C");
    terminal.feed("\x0b");
    expect(app.dialogLines().length).toBeGreaterThan(0);
    terminal.feed("\x16");
    terminal.feed("\x1bv");
    expect(clipboardReads).toBe(1);
    terminal.feed("typed ");
    const beforePaste = log.events.length;
    terminal.feed("\t");
    terminal.feed("\r");
    expect(log.events).toHaveLength(beforePaste);
    expect(app.dialogLines().length).toBeGreaterThan(0);
    finishPaste({ text: "\x1b[31mfile.png\x1b[0m" });
    await tick();
    terminal.feed("\r");
    expect(log.events.at(-1)).toMatchObject({ value: "keep typed file.png" });
    expect(app.draft()).toBe("unsent draft");

    // 失败和纯图片不修改文本;更换面板后晚到结果不能进入新面板或草稿。
    await app.command("/edit 1 content");
    clipboard = async () => {
      throw "fixture unavailable";
    };
    terminal.feed("\x1bv");
    await tick();
    expect(plain(app.dialogLines().join("\n"))).toContain("fixture unavailable");
    terminal.resize(36, 8);
    app.tui.renderNow(true);
    const failedPaste = (await terminal.screen()).join("\n");
    expect(failedPaste).toContain("Paste failed: fixture unavailable");
    expect(failedPaste).toContain("Esc cancel");
    expect(app.dialogLines().length).toBeLessThanOrEqual(8);
    terminal.resize(60, 24);
    clipboard = async () => ({ image: { mimeType: "image/png", data: "", name: "fixture" } });
    terminal.feed("\x16");
    await tick();
    expect(plain(app.dialogLines().join("\n"))).toContain("Text only here");
    clipboard = () =>
      new Promise((resolve) => {
        finishPaste = resolve;
      });
    terminal.feed("\x16");
    terminal.feed("\x1b");
    await app.command("/edit 1 content");
    finishPaste({ text: "late clipboard" });
    await tick();
    expect(plain(app.dialogLines().join("\n"))).not.toContain("late clipboard");
    terminal.feed("\t");
    terminal.feed("\r");
    expect(log.events).toHaveLength(beforePaste + 1);
    expect(app.draft()).toBe("unsent draft");
    terminal.feed("\x0b");
    expect(app.dialogLines().length).toBeGreaterThan(0); // 离开面板后恢复命令菜单。
    terminal.feed("\x1b");

    // 通过真正的循环入口发送,核对编辑后的正文和思考都进入下一次请求。
    await app.submit("continue with edited context");
    expect(lastInput.find((m) => m.role === "user")?.content).toBe("keep typed file.png");
    expect(lastInput.filter((m) => m.role === "assistant").at(-1)).toMatchObject({
      reasoning: `deep thought\n${addition}`,
    });

    // Rewind 到第一条:之后的消息全部丢弃
    app.inspector.openComposition();
    expect(findRowWith(app, "Keep input through here")).toBe(true);
    pick(app, "Keep input through here");
    await tick();
    expect(doc(app)).toContain("rewound to event #");
    expect(log.events.filter((e) => e.type === "context/drop").length).toBeGreaterThan(0);
    app.stop();
  });
});

describe("/retry 与面板的 drop、fork", () => {
  it("/retry:运行中拒绝;空闲时丢掉最后一步重问;上下文面板的 drop 与 fork 动作", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-tui-"));
    const { app, log, term } = bootB(
      scriptedB([
        { text: "first answer", toolCalls: [], stopReason: "end" },
        { text: "second answer", toolCalls: [], stopReason: "end" },
        { text: "third", toolCalls: [], stopReason: "end" },
      ]),
      { sessionsDir: tmp },
    );
    await app.submit("q");
    expect(doc(app)).toContain("first answer");
    await app.command("/edit retry");
    expect(doc(app)).toContain("second answer");
    expect(log.events.some((e) => e.type === "context/drop")).toBe(true);
    // 面板:最后一条(用户消息 q 之后是助手回复)→ Enter 出菜单 → ↓↓ 到 Drop → Enter
    app.inspector.openComposition();
    app.inspector.key("\r");
    let ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Exclude from input");
    app.inspector.key("\x1b[B");
    app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(doc(app)).toContain("dropped event #");
    // 再开面板,菜单最后一项是 Fork
    app.inspector.openComposition();
    app.inspector.key("\r");
    ins = plain(app.inspector.lines(120).join("\n"));
    const items = ins
      .split("\n")
      .filter((l) =>
        /Fork new session here|Retry latest reply|Exclude from input|Edit content|View full message/.test(
          l,
        ),
      );
    expect(items.length).toBeGreaterThan(2);
    for (let i = 0; i < 6; i++) app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(doc(app)).toContain("forked: first");
    // 恢复后的未知结果与普通结果共用编辑入口;编辑不执行工具,也不改执行状态。
    log.append({
      type: "assistant/message",
      at: now(),
      text: "",
      toolCalls: [{ id: "unknown", name: "echo", args: { text: "pending" } }],
      stopReason: "tool",
    });
    recordUnresolvedCalls(log);
    const target = log.events.length - 1;
    const original = log.events[target];
    if (original?.type !== "tool/unresolved") throw new Error("missing recovery event");
    const beforeEdit = log.events.length;
    const current = () =>
      deriveMessages(log.events).find((m) => m.role === "tool" && m.callId === "unknown");
    app.setDraft("keep my draft");
    app.inspector.openComposition();
    app.inspector.key("\r");
    pick(app, "Edit content");
    await tick();
    term.feed("discard this");
    term.feed("\x1b");
    expect(log.events).toHaveLength(beforeEdit);
    expect(current()?.content).toBe(original.content);
    app.inspector.openComposition();
    app.inspector.key("\r");
    pick(app, "Edit content");
    await tick();
    term.feed("\x05");
    term.feed(" User checked separately.");
    term.feed("\t");
    term.feed("\r");
    expect(current()?.content).toContain("User checked separately.");
    expect(current()).toMatchObject({ isError: true });
    const menuEdit = log.events.at(-1);
    const menuProjection = deriveMessages(log.events);
    app.inspector.openComposition();
    app.inspector.key("\r");
    pick(app, "Compare with original");
    await tick();
    expect(doc(app)).toContain(`#${target}.content`);
    app.inspector.openComposition();
    app.inspector.key("\r");
    pick(app, "Restore original text");
    await tick();
    expect(current()?.content).toBe(original.content);
    expect(log.events[target]).toBe(original);
    expect(log.events.slice(beforeEdit).map((e) => e.type)).toEqual([
      "context/edit",
      "context/edit",
    ]);
    // 相同原文经命令编辑应得到与菜单相同的事件语义及模型上下文。
    await app.command(`/edit ${target} content ${original.content} User checked separately.`);
    const commandEdit = log.events.at(-1);
    expect(commandEdit).toEqual({ ...menuEdit, at: commandEdit?.at });
    expect(deriveMessages(log.events)).toEqual(menuProjection);
    await app.command(`/edit restore ${target}`);
    expect(current()?.content).toBe(original.content);
    expect(app.draft()).toBe("keep my draft");
    app.stop();
  });
});
