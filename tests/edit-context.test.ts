// 编辑上下文:投影层的编辑与丢弃、回传物丢弃、Anthropic 前缀绑定、界面命令与拒绝条件。
import { describe, expect, it } from "vitest";
import { actionsFor, compositionRows } from "../cli/inspector-composition.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import { composeContext, deriveMessages, editState, type Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { anthropic, toAnthropicWire } from "../src/providers/anthropic.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const thinking = (model: string) => ({
  kind: "anthropic-thinking",
  model,
  blocks: [
    { type: "thinking", thinking: "t", signature: "sig" },
    { type: "redacted_thinking", data: "redacted" },
  ],
});

function sample(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "", model: "m", system: "S" });
  log.append({ type: "user/message", at: "", text: "u1" });
  log.append({
    type: "assistant/message",
    at: "",
    text: "a1",
    toolCalls: [{ id: "c1", name: "r", args: {} }],
    stopReason: "tool",
    reasoning: "想法一",
    reasoningKind: "full",
    opaque: thinking("m"),
  });
  log.append({
    type: "tool/result",
    at: "",
    callId: "c1",
    name: "r",
    content: "R1",
    isError: false,
  });
  log.append({
    type: "assistant/message",
    at: "",
    text: "a2",
    toolCalls: [],
    stopReason: "end",
    reasoning: "想法二",
    reasoningKind: "summary",
    opaque: thinking("m"),
  });
  log.append({ type: "user/message", at: "", text: "u2" });
  return log;
}

describe("投影应用编辑", () => {
  it("edit 换字段、标 edited、丢该消息的回传物;最后一次编辑生效;原事件不变", () => {
    const log = sample();
    log.append({
      type: "context/edit",
      at: "",
      target: 2,
      field: "reasoning",
      value: "改过的想法",
    });
    log.append({ type: "context/edit", at: "", target: 2, field: "reasoning", value: "再改一次" });
    log.append({ type: "context/edit", at: "", target: 3, field: "content", value: "R1 改" });
    log.append({ type: "context/edit", at: "", target: 0, field: "system", value: "S 改" });
    const msgs = deriveMessages(log.events);
    expect(msgs[0]).toEqual({ role: "system", content: "S 改", edited: true });
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      content: "a1",
      reasoning: "再改一次",
      edited: true,
    });
    expect(msgs[2]).not.toHaveProperty("opaque");
    expect(msgs[3]).toMatchObject({ role: "tool", content: "R1 改", edited: true });
    // 没被改的助手消息仍带回传物。
    expect(msgs[4]).toHaveProperty("opaque");
    const e2 = log.events[2];
    expect(e2?.type === "assistant/message" && e2.reasoning).toBe("想法一");
    expect(editState(log.events).edits.get(2)).toEqual({ reasoning: "再改一次" });
  });

  it("drop 只移除目标与所属工具结果,Anthropic 仅丢后继思考块,Chat reasoning 与旧请求保持", () => {
    const log = new EventLog();
    const events = sample().events;
    for (const e of events.slice(0, 2)) log.append(e);
    log.append({
      type: "assistant/message",
      at: "",
      text: "before",
      toolCalls: [],
      stopReason: "end",
      reasoning: "before reasoning",
      reasoningKind: "full",
      opaque: thinking("m"),
    });
    log.append({ type: "user/message", at: "", text: "middle user" });
    for (const e of events.slice(2)) log.append(e);
    const provider = anthropic({ apiKey: "", model: "m", promptCache: false });
    const wire = (messages: Message[]) =>
      provider.wire?.(messages, []) as { messages: ReturnType<typeof toAnthropicWire>["messages"] };
    const assistantBlocks = (messages: Message[]) =>
      wire(messages)
        .messages.filter((m) => m.role === "assistant")
        .map((m) => m.content.map((b) => b.type));
    const chat = openaiCompat({
      apiKey: "",
      baseUrl: "http://unused",
      model: "m",
      reasoningField: "reasoning_content",
    });
    for (const { target, contents, blocks, reasoning } of [
      {
        target: 3,
        contents: ["S", "u1", "before", "a1", "R1", "a2", "u2"],
        blocks: [["thinking", "redacted_thinking", "text"], ["text", "tool_use"], ["text"]],
        reasoning: ["before reasoning", "想法一", "想法二"],
      },
      {
        target: 4,
        contents: ["S", "u1", "before", "middle user", "a2", "u2"],
        blocks: [["thinking", "redacted_thinking", "text"], ["text"]],
        reasoning: ["before reasoning", "想法二"],
      },
      {
        target: 7,
        contents: ["S", "u1", "before", "middle user", "a1", "R1", "a2"],
        blocks: [
          ["thinking", "redacted_thinking", "text"],
          ["thinking", "redacted_thinking", "text", "tool_use"],
          ["thinking", "redacted_thinking", "text"],
        ],
        reasoning: ["before reasoning", "想法一", "想法二"],
      },
    ]) {
      const dropped = new EventLog();
      for (const e of log.events) dropped.append(e);
      const upTo = dropped.events.length;
      const original = structuredClone(composeContext(dropped.events));
      const originalWire = wire(original.messages);
      dropped.append({ type: "context/drop", at: "", target });
      const current = composeContext(dropped.events);
      expect(current.messages.map((m) => m.content)).toEqual(contents);
      expect(assistantBlocks(current.messages)).toEqual(blocks);
      expect(current.messages.some((m) => m.edited)).toBe(false);
      const chatWire = chat.wire?.(current.messages, []) as {
        messages: { role: string; reasoning_content?: string }[];
      };
      expect(
        chatWire.messages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content),
      ).toEqual(reasoning);
      expect(composeContext(dropped.events, upTo)).toEqual(original);
      expect(wire(composeContext(dropped.events, upTo).messages)).toEqual(originalWire);
    }
  });

  it("Anthropic:前缀里有编辑过的消息,之后所有思考块都不再回传;编辑点之前的照常", () => {
    const log = sample();
    log.append({ type: "context/edit", at: "", target: 3, field: "content", value: "R1 改" });
    const wire = toAnthropicWire(deriveMessages(log.events), { model: "m" });
    const assistants = wire.messages.filter((m) => m.role === "assistant");
    // 第一条助手在编辑点之前,思考块仍在;第二条在编辑点之后,思考块没了。
    expect(assistants[0]?.content.some((b) => b.type === "thinking")).toBe(true);
    expect(assistants[1]?.content.some((b) => b.type === "thinking")).toBe(false);
  });
});

describe("界面命令", () => {
  function app(log: EventLog, sent: Message[][] = []) {
    const provider: Provider = {
      model: "m",
      fields: { protocol: "anthropic(messages)", sends: [], reads: [], ignores: [] },
      async complete(messages): Promise<AssistantTurn> {
        sent.push(structuredClone(messages));
        return { text: "", toolCalls: [], stopReason: "end" };
      },
    };
    return createTuiApp({
      terminal: new VirtualTerminal(100, 30),
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      onExit: () => {},
    });
  }
  // 用码点拼出 ESC,避免正则字面量里出现控制字符。
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const text = (a: ReturnType<typeof app>) =>
    a
      .lines(100)
      .map((l) => l.replace(ansi, ""))
      .join("\n");

  it("摘要覆盖区不接受无效修改或跨区回退,可见区修改仍进入下一请求", async () => {
    const log = sample();
    log.append({ type: "context/edit", at: "", target: 2, field: "text", value: "edited a1" });
    log.append({
      type: "compaction",
      at: "",
      summary: "Earlier work including a2",
      coversFrom: 2,
      coversUpTo: 5,
    });
    log.append({ type: "user/message", at: "", text: "message after compaction" });
    const sent: Message[][] = [];
    const a = app(log, sent);
    try {
      const before = deriveMessages(log.events);
      const events = log.events.length;
      const rows = compositionRows(log.events).rows;
      const summary = rows.find((row) => row.stages.some((stage) => stage.startsWith("summary")));
      if (!summary) throw new Error("Missing summary row");
      expect(actionsFor(log.events, summary, rows.length).map((item) => item.action)).not.toContain(
        "rewind",
      );
      for (const operation of ["2 text new answer", "drop 2", "restore 2", "rewind 2"]) {
        await a.command(`/edit ${operation}`);
        expect(log.events).toHaveLength(events);
        expect(deriveMessages(log.events)).toEqual(before);
      }
      expect(text(a)).toContain("compacted");
      await a.command("/edit 5 content updated tail");
      await a.submit("Confirm current input");
      expect(sent[0]).toContainEqual(expect.objectContaining({ content: "updated tail" }));
      expect(sent[0]).toContainEqual(
        expect.objectContaining({ content: expect.stringContaining("Earlier work including a2") }),
      );
      await a.command(`/edit rewind ${summary.event}`);
      const rewound = deriveMessages(log.events);
      expect(rewound).toContainEqual(expect.objectContaining({ content: "updated tail" }));
      expect(rewound).not.toContainEqual(
        expect.objectContaining({ content: "message after compaction" }),
      );
    } finally {
      a.stop();
    }
  });

  it("已清除的工具结果拒绝无效编辑,保留模型实际看到的占位内容", async () => {
    const log = sample();
    log.append({ type: "compaction", at: "", cleared: [3] });
    const a = app(log);
    try {
      const before = deriveMessages(log.events);
      const events = log.events.length;
      await a.command("/edit 3 content replacement result");
      expect(log.events).toHaveLength(events);
      expect(deriveMessages(log.events)).toEqual(before);
      expect(text(a)).toContain("cleared from current input");
    } finally {
      a.stop();
    }
  });

  it("/edit 内联文本追加 context/edit 并打印后果;摘要思考拒绝编辑;/drop;/edits", async () => {
    const log = sample();
    const a = app(log);
    await a.command("/edit 2 reasoning 换个思路,先读文件");
    const edit = log.events.at(-1);
    expect(edit).toMatchObject({
      type: "context/edit",
      target: 2,
      field: "reasoning",
      value: "换个思路,先读文件",
    });
    let doc = text(a);
    expect(doc).toContain("· edited event #2.reasoning");
    expect(doc).toContain("thinking blocks after this point are no longer");

    await a.command("/edit 4 reasoning 试图改摘要");
    expect(log.events.at(-1)?.type).toBe("context/edit"); // 没有新增
    doc = text(a);
    expect(doc).toContain("event #4 thinking is a summary");

    // #6 是刚追加的 context/edit 事件本身,不进入模型上下文。
    await a.command("/edit 6 text x");
    expect(text(a)).toContain("event #6 is context/edit; it never reaches the model");
    await a.command("/edit 1 reasoning x");
    expect(text(a)).toContain("event #1 has no field reasoning");

    await a.command("/edit drop 2 走错方向");
    expect(log.events.at(-1)).toMatchObject({ type: "context/drop", target: 2, note: "走错方向" });
    expect(text(a)).toContain("· dropped event #2 with its 1 tool results");

    await a.command("/edit list");
    doc = text(a);
    expect(doc).toContain("edit #2.reasoning");
    expect(doc).toContain("drop #2");
    a.stop();

    const replay = app(log);
    const restored = text(replay);
    expect(restored).toContain("· edited event #2.reasoning");
    expect(restored).toContain("· dropped event #2 with its 1 tool results");
    expect(restored).toContain("original kept · Ctrl+E current context");
    expect(doc.match(/· edited event #2.reasoning/g)).toHaveLength(1);
    expect(doc.match(/· dropped event #2 with its 1 tool results/g)).toHaveLength(1);
    replay.stop();
  });
});
