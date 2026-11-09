// 编辑上下文:投影层的编辑与丢弃、回传物丢弃、Anthropic 前缀绑定、界面命令与拒绝条件。
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { type ContextOperation, changeContext, contextView } from "../src/context-edit.js";
import { EventLog } from "../src/log.js";
import { composeContext, deriveMessages, type Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { anthropic, toAnthropicWire } from "../src/providers/anthropic.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { type SystemSection, systemAt } from "../src/system-prompt.js";
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
    const before = contextView(log.events, 2);
    expect(before.actions).toEqual(
      expect.arrayContaining(["edit", "edit-reasoning", "drop", "rewind", "retry"]),
    );
    expect(before.actions).not.toContain("compare");
    expect(
      changeContext(log, { type: "edit", target: 2, field: "reasoning", value: "改过的想法" })
        .opaqueDiscarded,
    ).toBe(true);
    const effect = changeContext(log, {
      type: "edit",
      target: 2,
      field: "reasoning",
      value: "再改一次",
    });
    expect(effect).toMatchObject({
      target: 2,
      fields: ["reasoning"],
      opaqueDiscarded: false,
      prefixFrom: 2,
    });
    changeContext(log, { type: "edit", target: 3, value: "R1 改" });
    changeContext(log, { type: "edit", target: 0, section: "custom", value: "S 改" });
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
    expect(contextView(log.events, 2).fields[1]).toMatchObject({
      original: "想法一",
      current: "再改一次",
      edited: true,
    });
    expect(contextView(log.events, 3).actions).toEqual(
      expect.arrayContaining(["compare", "restore"]),
    );
    expect(changeContext(log, { type: "restore", target: 2 }).fields).toEqual(["reasoning"]);
    expect(contextView(log.events, 2).fields[1]?.current).toBe("想法一");
    expect(deriveMessages(log.events)[2]).not.toHaveProperty("opaque");
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
      const preview = contextView(dropped.events, target).effects.drop;
      expect(changeContext(dropped, { type: "drop", target })).toEqual(preview);
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
    changeContext(log, { type: "edit", target: 3, value: "R1 改" });
    const wire = toAnthropicWire(deriveMessages(log.events), { model: "m" });
    const assistants = wire.messages.filter((m) => m.role === "assistant");
    // 第一条助手在编辑点之前,思考块仍在;第二条在编辑点之后,思考块没了。
    expect(assistants[0]?.content.some((b) => b.type === "thinking")).toBe(true);
    expect(assistants[1]?.content.some((b) => b.type === "thinking")).toBe(false);
  });

  it("按段身份编辑、开关与刷新Skills互不覆盖,整体恢复保留原始正文和启用状态", () => {
    const log = new EventLog();
    const original: [SystemSection, SystemSection] = [
      { id: "instructions", name: "Instructions", text: "My instructions", enabled: true },
      { id: "skills", name: "Skills", text: "Old catalog", enabled: false, source: "skills" },
    ];
    log.append({ type: "session/start", at: "", model: "m", system: original });
    const before = contextView(log.events);
    expect(contextView(log.events, 0).comparisons).toEqual([]);
    const events = log.events.length;
    for (const operation of [
      {
        type: "replace-section",
        target: 0,
        id: "skills",
        section: { ...original[1], enabled: true },
      },
      { type: "set-system", target: 0, value: structuredClone(original) },
    ] satisfies ContextOperation[]) {
      expect(changeContext(log, operation)).toEqual({
        target: 0,
        fields: [],
        dropped: [],
        removed: [],
        opaqueDiscarded: false,
      });
      expect(log.events).toHaveLength(events);
      expect(contextView(log.events).composition).toEqual(before.composition);
    }
    expect(() =>
      changeContext(log, { type: "edit", target: 0, value: "unowned full text" }),
    ).toThrow(/Choose a system section/);
    expect(log.events).toHaveLength(events);
    changeContext(log, {
      type: "edit",
      target: 0,
      section: "instructions",
      value: "My instructions with Old catalog quoted",
    });
    changeContext(log, {
      type: "replace-section",
      target: 0,
      id: "skills",
      section: {
        id: "skills",
        name: "Skills",
        text: "New catalog",
        enabled: true,
        source: "new-source",
      },
    });
    expect(contextView(log.events, 0).fields).toEqual([
      expect.objectContaining({
        section: "instructions",
        original: "My instructions",
        current: "My instructions with Old catalog quoted",
        enabled: true,
      }),
      expect.objectContaining({
        section: "skills",
        current: "New catalog",
        enabled: false,
        source: "new-source",
      }),
    ]);
    expect(deriveMessages(log.events)[0]?.content).toBe("My instructions with Old catalog quoted");
    expect(contextView(log.events, 0).actions).toContain("toggle-section");
    changeContext(log, { type: "toggle-section", target: 0, section: "skills" });
    expect(contextView(log.events, 0).comparisons).toEqual([
      {
        field: "system",
        original,
        current: [
          { ...original[0], text: "My instructions with Old catalog quoted" },
          { ...original[1], text: "New catalog", enabled: true, source: "new-source" },
        ],
      },
    ]);
    expect(deriveMessages(log.events)[0]?.content).toBe(
      "My instructions with Old catalog quoted\n\nNew catalog",
    );
    expect(composeContext(log.events, 1)).toEqual(before.composition);
    const count = log.events.length;
    expect(changeContext(log, { type: "restore", target: 0 }).fields).toEqual(["system"]);
    expect(log.events).toHaveLength(count + 1);
    expect(systemAt(log.events)).toEqual(original);
    expect(deriveMessages(log.events)[0]?.content).toBe("My instructions");
    for (const value of [[{ ...original[0], id: "" }], [original[0], original[0]]])
      expect(() => changeContext(log, { type: "set-system", target: 0, value })).toThrow(
        /section id/,
      );
    expect(log.events).toHaveLength(count + 1);
    changeContext(log, { type: "set-system", target: 0, value: "Native custom text" });
    changeContext(log, { type: "replace-section", target: 0, id: "skills", section: original[1] });
    expect(contextView(log.events, 0).fields.map((field) => field.section)).toEqual([
      "custom",
      "skills",
    ]);
    expect(contextView(log.events, 0).fields[0]?.current).toBe("Native custom text");
    changeContext(log, { type: "replace-section", target: 0, id: "custom" });
    expect(contextView(log.events, 0).comparisons).toEqual([
      { field: "system", original, current: [original[1]] },
    ]);
    expect(contextView(log.events, 0).fields.map((field) => field.section)).toEqual(["skills"]);
    changeContext(log, { type: "replace-section", target: 0, id: "skills" });
    expect(contextView(log.events, 0).fields).toEqual([]);
    expect(contextView(log.events, 0).comparisons).toEqual([
      { field: "system", original, current: [] },
    ]);
    expect(contextView(log.events, 0).actions).toEqual(
      expect.arrayContaining(["compare", "restore"]),
    );
    expect(deriveMessages(log.events)[0]?.content).toBe("");
    changeContext(log, { type: "restore", target: 0 });
    expect(systemAt(log.events)).toEqual(original);
  });
  it("保存重验覆盖、清除、排除与只读限制;预览只给出当前输入真正能执行的操作", () => {
    const log = sample();
    expect(contextView(log.events, 4).actions).not.toContain("edit-reasoning");
    expect(() =>
      changeContext(log, { type: "edit", target: 4, field: "reasoning", value: "x" }),
    ).toThrow(/thinking is a summary/);
    expect(contextView(log.events, 5).actions).not.toContain("rewind");
    expect(() =>
      changeContext(log, { type: "edit", target: 1, field: "reasoning", value: "x" }),
    ).toThrow(/has no field reasoning/);
    expect(() => changeContext(log, { type: "edit", target: 99, value: "x" })).toThrow(
      /no event #99/,
    );
    changeContext(log, { type: "edit", target: 2, value: "edited a1" });
    const before = log.events.length;
    for (const access of [{ running: true }, { readOnlyReason: "Read-only session" }]) {
      const view = contextView(log.events, 2, access);
      expect(view.actions).toEqual(["compare"]);
      for (const operation of [
        { type: "edit", target: 2, value: "x" },
        { type: "drop", target: 2 },
        { type: "restore", target: 2 },
        { type: "rewind", target: 2 },
        { type: "retry" },
      ] satisfies ContextOperation[])
        expect(() => changeContext(log, operation, access)).toThrow();
    }
    expect(log.events).toHaveLength(before);
    expect(contextView(log.events, 3).actions).toContain("edit");
    log.append({ type: "compaction", at: "", cleared: [3] });
    const cleared = contextView(log.events, 3);
    expect(cleared.actions).not.toContain("edit");
    expect(() => changeContext(log, { type: "edit", target: 3, value: "replacement" })).toThrow(
      /cleared from current input/,
    );
    const drop = changeContext(log, { type: "drop", target: 2 });
    expect(drop.removed.map((item) => item.event)).toEqual([2, 3]);
    expect(contextView(log.events, 2).actions).toEqual(
      expect.arrayContaining(["compare", "rewind", "retry"]),
    );
    expect(() => changeContext(log, { type: "restore", target: 2 })).toThrow(
      /excluded from current input/,
    );
    expect(() => changeContext(log, { type: "drop", target: 2 })).toThrow(
      /excluded from current input/,
    );
    log.append({
      type: "compaction",
      at: "",
      summary: "Earlier work including a2",
      coversFrom: 2,
      coversUpTo: 5,
    });
    const comp = contextView(log.events).composition;
    const summary = comp.provenance.findIndex((item) =>
      item.stages.some((stage) => stage.startsWith("summary")),
    );
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(contextView(log.events, { message: summary }).actions).not.toContain("rewind");
    const events = log.events.length;
    const current = deriveMessages(log.events);
    for (const operation of [
      { type: "edit", target: 2, value: "new answer" },
      { type: "drop", target: 2 },
      { type: "restore", target: 2 },
      { type: "rewind", target: 2 },
      { type: "rewind", target: { message: summary } },
      { type: "retry" },
    ] satisfies ContextOperation[])
      expect(() => changeContext(log, operation)).toThrow();
    expect(contextView(log.events).actions).not.toContain("retry");
    expect(log.events).toHaveLength(events);
    expect(deriveMessages(log.events)).toEqual(current);
    changeContext(log, { type: "edit", target: 5, value: "updated tail" });
    expect(deriveMessages(log.events).at(-1)?.content).toBe("updated tail");
  });

  it("回退只排除当前消息与关联结果,保留目录事实并支持数字事件截止点", () => {
    const log = sample();
    log.append({
      type: "session/directory",
      at: "",
      cwd: "/project",
      environment: "Current directory",
    });
    changeContext(log, { type: "drop", target: 4 });
    const preview = contextView(log.events, { message: 1 }).effects.rewind;
    const effect = changeContext(log, { type: "rewind", target: 1 });
    expect(effect).toEqual(preview);
    expect(effect.dropped).toEqual([2, 5]);
    expect(effect.removed.map((item) => item.event)).toEqual([2, 3, 5]);
    expect(deriveMessages(log.events).map((item) => item.content)).toEqual([
      "S",
      "u1",
      "Current directory",
    ]);
    expect(contextView(log.events, 1).actions).not.toContain("rewind");
    const count = log.events.length;
    expect(() => changeContext(log, { type: "drop", target: 6 })).toThrow(/only user or assistant/);
    expect(() => changeContext(log, { type: "edit", target: 6, value: "wrong root" })).toThrow(
      /execution fact/,
    );
    expect(log.events).toHaveLength(count);
    const summaryLog = sample();
    summaryLog.append({
      type: "compaction",
      at: "",
      summary: "Earlier work",
      coversFrom: 2,
      coversUpTo: 5,
    });
    summaryLog.append({ type: "user/message", at: "", text: "after compaction" });
    changeContext(summaryLog, { type: "rewind", target: 6 });
    expect(deriveMessages(summaryLog.events).at(-1)?.content).toBe("u2");
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
