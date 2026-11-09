// 子 agent 视图与压缩对照。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { RequestInspector } from "../cli/inspector.js";
import {
  collectCompactions,
  compactionChanges,
  compactionLines,
  compactionRow,
} from "../cli/inspector-compactions.js";
import { childEventLines, createTuiApp } from "../cli/tui-app.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { CLEARED_PLACEHOLDER } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { type ChildInfo, createTaskTool } from "../src/subagent.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

/** 父与子共用一个脚本 provider:父先派任务,子跑两步,父收尾。 */
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    wire: (messages, tools) => ({ model: "fake", messages, tools }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

describe("子 agent 视图", () => {
  it("task 工具把子日志与 callId 交给界面;子块挂在调用行下,尾窗、进度、完成态、会话切换", async () => {
    const provider = scripted([
      // 父:派任务
      {
        text: "交给子",
        toolCalls: [{ id: "t1", name: "task", args: { task: "统计 echo 两次\n第二行说明" } }],
        stopReason: "tool",
      },
      // 子:两步
      {
        text: "子先回显",
        toolCalls: [{ id: "c1", name: "echo", args: { text: "one" } }],
        stopReason: "tool",
        usage: { inputTokens: 300, outputTokens: 9 },
      },
      {
        text: "子完成:one",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 420, outputTokens: 5 },
      },
      // 父:收尾
      { text: "父收到", toolCalls: [], stopReason: "end" },
    ]);
    const log = new EventLog();
    const children: ChildInfo[] = [];
    let app: ReturnType<typeof createTuiApp> | undefined;
    const task = createTaskTool({
      parent: log,
      provider,
      tools: [echo],
      onChild: (child) => {
        children.push(child);
        app?.attachChild(child);
      },
    });
    app = createTuiApp({
      terminal: new VirtualTerminal(110, 50),
      log,
      provider,
      tools: [echo, task],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "fake", providerName: "p", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("开始");
    const doc = app.lines(110).map(stripAnsi).join("\n");

    expect(children).toHaveLength(1);
    expect(children[0]?.callId).toBe("t1");
    expect(children[0]?.scope).toBe("taskOnly");
    expect(children[0]?.index).toBe(1);
    expect(app.children()).toHaveLength(1);

    // 调用行、引导线、完成态进度、尾窗提示
    expect(doc).toContain("» task  统计 echo 两次");
    expect(doc).toContain("┆ ✓ sub-1 · done · 2 steps · 1 tool calls");
    expect(doc).toContain("last input 420");
    expect(doc).toContain("┆ sub-session"); // 完成后收起为一行
    expect(doc).toContain("✓ task"); // 父的工具结果
    expect(doc).toContain("子完成:one");
    expect(doc).toContain("父收到");

    // Ctrl+O 循环到"全部":子的每一行都带引导线
    app.toggleFold();
    const all = app.lines(110).map(stripAnsi).join("\n");
    expect(all).toContain('┆ » echo  {"text":"one"}');
    expect(all).toContain("┆ ✓ echo");
    expect(all).toContain("┆ 子先回显");

    // 检视器:s 切到子会话,请求列表与事件视图作用在子的数组上
    app.inspector.open();
    let insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("› main");
    expect(insp).toContain("sub #1 统计 echo 两次");
    expect(insp).toContain("2 requests");
    app.inspector.key("\x1b[C");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("› sub #1");
    expect(insp).toContain("2 requests");
    app.inspector.key("\r");
    app.inspector.key("5");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain('"model": "fake"'); // 子会话的线路正文用当前 provider 重建
    app.inspector.key("\x1b");
    app.inspector.key("\t");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("Events");
    expect(insp).toContain("› sub #1");
    const parentCount = log.events.length;
    const child = children[0]?.log;
    if (!child) throw new Error("missing child");
    const childCount = child.events.length;
    app.inspector.key("\t"); // 事件 → 压缩 → 上下文,仍查看子会话。
    app.inspector.key("\t");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("Read-only");
    expect(insp).not.toMatch(/tools\s+\d+ definitions?/);
    app.inspector.key("\r");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("View full message");
    expect(insp).not.toContain("Edit content");
    expect(insp).not.toContain("Retry latest reply");
    expect(insp).not.toContain("Fork new session here");
    app.inspector.key("\r");
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("子完成:one");
    expect(app.dialogLines()).toEqual([]);
    // 子system只能查看全文,不能打开父提示词的开关或工具选单。
    app.inspector.key("\x1b");
    app.inspector.key("\x1b[H");
    app.inspector.key("\r");
    app.inspector.key("2");
    app.inspector.key("\r");
    expect(log.events).toHaveLength(parentCount);
    expect(child.events).toHaveLength(childCount);
    expect(app.dialogLines()).toEqual([]);
    app.inspector.close();
    app.inspector.openComposition();
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("› main");
    app.inspector.key("\r");
    expect(app.inspector.lines(110).map(stripAnsi).join("\n")).toContain("Edit content");
    app.stop();
  });

  it("childEventLines:与主屏同一套记号,思考淡字,结果带行数与耗时", () => {
    const control = "\x1b]52;c;dGVzdA==\x07\x1b[2J\x1b[H";
    const event: AgentEvent = {
      type: "assistant/message",
      at: "t",
      text: `第一行${control}\n第二行`,
      reasoning: `想一下${control}`,
      toolCalls: [{ id: "x", name: "bash", args: { command: `ls${control}` } }],
      stopReason: "tool",
    };
    const original = JSON.stringify(event);
    const rendered = childEventLines(event);
    expect(rendered.join("\n")).not.toContain("\x1b]52;");
    expect(rendered.join("\n")).not.toContain("\x1b[2J");
    expect(JSON.stringify(event)).toBe(original);
    const lines = rendered.map(stripAnsi);
    expect(lines).toEqual(["想一下", "第一行", "第二行", "» bash  ls"]);
    const result = childEventLines({
      type: "tool/result",
      at: "t",
      callId: "x",
      name: "bash",
      content: `a${control}\nb`,
      isError: false,
      durationMs: 12,
    });
    expect(result.join("\n")).not.toContain("\x1b]52;");
    expect(result.join("\n")).not.toContain("\x1b[2J");
    expect(result.map(stripAnsi)).toEqual(["✓ bash  2 lines · 12ms", "  a", "  b"]);
    expect(
      childEventLines({
        type: "request",
        at: "t",
        model: "m",
        messages: 1,
        tools: [],
        estimatedTokens: 1,
        reason: "turn",
      }),
    ).toEqual([]);
  });
});

describe("压缩对照", () => {
  const events: AgentEvent[] = [
    { type: "session/start", at: "t", model: "m", system: "S" },
    { type: "user/message", at: "t", text: "开始" },
    {
      type: "request",
      at: "t",
      model: "m",
      messages: 2,
      tools: [],
      estimatedTokens: 5,
      reason: "turn",
    },
    {
      type: "assistant/message",
      at: "t",
      text: "",
      toolCalls: [{ id: "c1", name: "bash", args: { command: "cat big" } }],
      stopReason: "tool",
    },
    {
      type: "tool/result",
      at: "t",
      callId: "c1",
      name: "bash",
      content: "x".repeat(4000),
      isError: false,
    },
    { type: "assistant/message", at: "t", text: "看完了", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "t", text: "继续" },
    {
      type: "compaction",
      at: "t",
      summary: "摘要:看过 big 文件。",
      coversFrom: 2,
      coversUpTo: 6,
      tokensBefore: 1200,
      usage: { inputTokens: 1100, outputTokens: 20 },
      latencyMs: 900,
      strategy: "llmSummarize(structuredFull, replay)",
    },
    {
      type: "tool/result",
      at: "t",
      callId: "c9",
      name: "read",
      content: "y".repeat(800),
      isError: false,
    },
    {
      type: "compaction",
      at: "t",
      cleared: [8],
      strategy: "clearToolResults(keepRecent=0, clearAtLeast=1)",
    },
  ];

  it("collectCompactions:覆盖的模型可见事件、token、摘要 token、清除条目", () => {
    const recs = collectCompactions(events).map((rec) => ({
      ...rec,
      ...compactionChanges(events, rec.index),
    }));
    expect(recs).toHaveLength(2);
    const [a, b] = recs;
    if (!a || !b) throw new Error("应有两条");
    expect(a.covered.map((source) => source.event)).toEqual([3, 4, 5]); // request(2) 只给人看,不算
    expect(a.coveredTokens).toBeGreaterThan(1000);
    expect(a.summaryTokens).toBeGreaterThan(0);
    expect(a.cleared).toEqual([]);
    expect(b.covered).toEqual([]);
    expect(b.cleared.map((source) => source.event)).toEqual([8]);
    expect(b.clearedTokens).toBe(200);

    // 同次 clear→summary 的左侧是整次操作前值,不冒充中间摘要请求的占位输入。
    const combined: AgentEvent[] = [...events.slice(0, 7), { ...a.event, cleared: [4] }];
    expect(
      compactionChanges(combined, 7).covered.find((source) => source.event === 4)?.message.content,
    ).toBe("x".repeat(4000));

    const modified: AgentEvent[] = [
      ...events.slice(0, 7),
      { type: "context/edit", at: "t", target: 4, field: "content", value: "EDITED_INPUT" },
      { type: "context/drop", at: "t", target: 5 },
      { ...a.event, summary: "FIRST_SUMMARY" },
      {
        type: "user/shell",
        at: "t",
        id: "s1",
        command: "echo shell",
        cwd: "/tmp",
        content: "SHELL_OUTPUT",
        excludeFromContext: false,
        isError: false,
        status: "completed",
      },
      {
        type: "assistant/message",
        at: "t",
        text: "",
        toolCalls: [{ id: "missing", name: "read", args: { path: "pending" } }],
        stopReason: "tool",
      },
      {
        type: "tool/unresolved",
        at: "t",
        callEvent: 11,
        callId: "missing",
        name: "read",
        content: "UNKNOWN_RESULT",
      },
      { type: "user/message", at: "t", text: "DROPPED_NOTE" },
      { type: "context/drop", at: "t", target: 13 },
      {
        type: "assistant/message",
        at: "t",
        text: "",
        toolCalls: [{ id: "c3", name: "read", args: { path: "c" } }],
        stopReason: "tool",
      },
      {
        type: "tool/result",
        at: "t",
        callId: "c3",
        name: "read",
        content: "RAW_RESULT",
        isError: false,
      },
      { type: "context/edit", at: "t", target: 16, field: "content", value: "EDITED_BEFORE_CLEAR" },
      { type: "compaction", at: "t", cleared: [16] },
      { type: "user/message", at: "t", text: "KEEP_TAIL" },
      { type: "compaction", at: "t", summary: "SECOND_SUMMARY", coversFrom: 2, coversUpTo: 19 },
    ];
    const readHistory = () =>
      collectCompactions(modified).map((rec) => ({
        ...rec,
        ...compactionChanges(modified, rec.index),
      }));
    const history = readHistory();
    const [first, clear, second] = history;
    if (!first || !clear || !second) throw new Error("应有编辑后摘要、清除与滚动摘要");
    expect(first.covered.map((source) => source.event)).toEqual([3, 4]);
    const before = compactionLines(modified, first, 2).map(stripAnsi).join("\n");
    expect(before).toContain("EDITED_INPUT");
    expect(before).not.toContain("x".repeat(100));
    expect(before).not.toContain("看完了");
    expect(compactionLines(modified, clear, 4).map(stripAnsi).join("\n")).toContain(
      "EDITED_BEFORE_CLEAR",
    );
    const repeated = compactionLines(modified, second, 2).map(stripAnsi).join("\n");
    for (const content of ["FIRST_SUMMARY", "SHELL_OUTPUT", "UNKNOWN_RESULT", CLEARED_PLACEHOLDER])
      expect(repeated).toContain(content);
    for (const absent of ["EDITED_INPUT", "DROPPED_NOTE", "RAW_RESULT", "EDITED_BEFORE_CLEAR"])
      expect(repeated).not.toContain(absent);
    modified.push({
      type: "context/edit",
      at: "t",
      target: 4,
      field: "content",
      value: "LATER_EDIT",
    });
    expect(readHistory()).toEqual(history);
  });

  it("列表行与四个分区:对照数字、原文全文、摘要、被清除的工具结果", () => {
    const [a, b] = collectCompactions(events);
    if (!a || !b) throw new Error("应有两条");
    const row = stripAnsi(compactionRow(events, a, true));
    expect(row).toContain("#1");
    expect(row).toContain("llmSummarize(structuredFull, replay)");
    expect(row).toContain("input (3 messages");
    expect(row).toContain("→ summary");
    const overview = compactionLines(events, a, 1).map(stripAnsi).join("\n");
    expect(overview).toContain("ratio");
    expect(overview).toContain("summary request");
    expect(overview).toContain("Raw originals remain in Events");
    const original = compactionLines(events, a, 2).map(stripAnsi).join("\n");
    expect(original).toContain("#4 tool:bash");
    expect(original).toContain("x".repeat(100));
    expect(original).toContain("看完了");
    expect(compactionLines(events, a, 3).map(stripAnsi).join("\n")).toContain(
      "摘要:看过 big 文件。",
    );
    expect(compactionLines(events, a, 4).map(stripAnsi).join("\n")).toContain(
      "cleared no tool results",
    );
    expect(compactionLines(events, b, 4).map(stripAnsi).join("\n")).toContain("#8 tool:read");
    expect(compactionLines(events, b, 2).map(stripAnsi).join("\n")).toContain(
      "has no summary (clear only)",
    );
    const control = "\u001b]52;c;dGVzdA==\u0007";
    const external: AgentEvent[] = [
      ...events.slice(0, 7),
      { type: "context/edit", at: "t", target: 4, field: "content", value: control },
      { ...a.event, summary: control },
    ];
    const record = collectCompactions(external)[0];
    if (!record) throw new Error("应有带原始控制字符的摘要");
    for (const section of [2, 3] as const) {
      const shown = compactionLines(external, record, section).join("\n");
      expect(shown).not.toContain(control);
      expect(shown).toContain("\\u001b]52;c;dGVzdA==\\u0007");
    }
    expect(external.at(-1)).toMatchObject({ summary: control });
  });

  it("检视器:Tab 两次进压缩对照,Enter 看详情,分区切换,Esc 返回", () => {
    const log = new EventLog();
    for (const e of events) log.append(e);
    const insp = new RequestInspector({
      events: () => log.events,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.reset();
    insp.handleInput("\t");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("compactions");
    let doc = insp.render(120).map(stripAnsi).join("\n");
    expect(doc).toContain("Compactions");
    expect(doc).toContain("2 compactions");
    expect(doc).toContain("› #2");
    insp.handleInput("\x1b[H");
    insp.handleInput("\r");
    doc = insp.render(120).map(stripAnsi).join("\n");
    expect(insp.currentMode).toBe("compaction");
    expect(doc).toContain("Compaction #1");
    expect(doc).toContain("[1 compare]");
    insp.handleInput("2");
    expect(insp.render(120).map(stripAnsi).join("\n")).toContain(
      "Context before this compaction: 3 effective messages replaced",
    );
    insp.handleInput("\x1b[C");
    expect(insp.render(120).map(stripAnsi).join("\n")).toContain("[3 summary]");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("compactions");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition"); // 第四视图:组装
    insp.handleInput("	");
    expect(insp.currentMode).toBe("list");
  });
});
