// 上下文组装:composeContext 的来历与省略、三家 wireMap、组装槽记 body、检视器组装视图。
import { describe, expect, it } from "vitest";
import { RequestInspector } from "../cli/inspector.js";
import { compositionLines, compositionRows } from "../cli/inspector-composition.js";
import { eventSummary, eventViewLines, modelSees } from "../cli/inspector-events.js";
import { legalizeCut } from "../src/compaction.js";
import { estimateTokens, eventTokens } from "../src/context.js";
import { changeContext, contextView } from "../src/context-edit.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { describeRequestBody, runTurn } from "../src/loop.js";
import { composeContext, deriveMessages, requestMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { anthropic } from "../src/providers/anthropic.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { openaiResponses } from "../src/providers/openai-responses.js";
import { recordUnresolvedCalls } from "../src/recovery.js";
import { directoryAt, recordSessionDirectory } from "../src/session-directory.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

function sample(): AgentEvent[] {
  return [
    { type: "session/start", at: "", model: "m", system: "S" },
    { type: "user/message", at: "", text: "u1" },
    {
      type: "assistant/message",
      at: "",
      text: "",
      toolCalls: [
        { id: "a", name: "r", args: {} },
        { id: "b", name: "r", args: {} },
      ],
      stopReason: "tool",
      opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
    },
    { type: "tool/result", at: "", callId: "a", name: "r", content: "RA", isError: false },
    { type: "tool/result", at: "", callId: "b", name: "r", content: "RB", isError: false },
    { type: "assistant/message", at: "", text: "a1", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "", text: "u2" },
    { type: "assistant/message", at: "", text: "a2", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "", text: "u3" },
  ];
}

describe("composeContext", () => {
  it("目录追加保留历史前缀与请求边界,当前执行根不被摘要、编辑或排除隐藏", () => {
    const log = new EventLog();
    for (const event of sample().slice(0, 6)) log.append(event);
    const original = deriveMessages(log.events);
    const oldRequest = log.events.length;
    log.append({
      type: "request",
      at: "",
      model: "m",
      messages: original.length,
      tools: [],
      estimatedTokens: 1,
      reason: "turn",
    });
    expect(directoryAt(log.events)).toBeUndefined();
    recordSessionDirectory(log, "/project/A");
    const firstIndex = log.events.length - 1;
    const first = directoryAt(log.events);
    recordSessionDirectory(log, "/project/A");
    expect(log.events).toHaveLength(firstIndex + 1);
    expect(directoryAt(log.events, oldRequest)).toBeUndefined();
    log.append({ type: "user/message", at: "", text: "Continue after moving the project." });
    recordSessionDirectory(log, "/project/D");
    const currentIndex = log.events.length - 1;
    const current = directoryAt(log.events);
    if (!first || !current) throw new Error("Expected recorded directories");
    expect(directoryAt(log.events, firstIndex + 1)).toBe(first);
    const moved = composeContext(log.events);
    expect(moved.messages.slice(0, original.length)).toEqual(original);
    expect(moved.messages[2]).toBe(original[2]);
    expect(moved.messages[2]).toHaveProperty("opaque");
    expect(moved.messages.slice(original.length).map((message) => message.content)).toEqual([
      first.environment,
      "Continue after moving the project.",
      current.environment,
    ]);
    expect(moved.messages.every((message) => !message.edited && !message.prefixChanged)).toBe(true);
    expect(requestMessages(log.events, oldRequest)).toEqual(original);

    for (const target of [firstIndex, currentIndex]) {
      log.append({ type: "context/drop", at: "", target });
      log.append({ type: "context/edit", at: "", target, field: "content", value: "wrong root" });
    }
    expect(composeContext(log.events)).toEqual(moved);
    expect(contextView(log.events, currentIndex).fields[0]).toMatchObject({
      current: current.environment,
      readOnlyReason: expect.stringContaining("/session directory"),
    });
    log.append({
      type: "compaction",
      at: "",
      summary: "Earlier work in the previous project location.",
      coversFrom: 1,
      coversUpTo: log.events.length,
    });
    const compacted = composeContext(log.events);
    expect(compacted.messages.map((message) => message.content)).toEqual([
      "S",
      expect.stringContaining("Earlier work in the previous project location."),
      current.environment,
    ]);
    expect(compacted.omitted).toContainEqual({ event: firstIndex, reason: "covered" });
    expect(compacted.omitted).not.toContainEqual({ event: currentIndex, reason: "covered" });
    expect(requestMessages(log.events, oldRequest)).toEqual(original);
    expect(modelSees(log.events, firstIndex).text).toBe("covered");
    expect(modelSees(log.events, currentIndex).text).toBe("not sent yet");
    expect(eventTokens(current)).toBe(estimateTokens(current.environment));
    expect(eventSummary(log.events, currentIndex).text).toContain("/project/D");
    expect(eventViewLines(log.events, currentIndex).map(plain).join("\n")).toContain("/project/D");
    const { rows } = compositionRows(log.events);
    const directoryRow = rows.find((row) => row.event === currentIndex);
    if (!directoryRow) throw new Error("Expected current directory in composition");
    expect(compositionLines(log.events, directoryRow).map(plain).join("\n")).toContain(
      "session/directory",
    );
    expect(
      contextView(log.events, { message: directoryRow.i - 1 }).actions.filter((action) =>
        ["edit", "drop", "restore"].includes(action),
      ),
    ).toEqual([]);
    const compactedRequest = log.events.length;
    log.append({
      type: "request",
      at: "",
      model: "m",
      messages: compacted.messages.length,
      tools: [],
      estimatedTokens: 1,
      reason: "turn",
    });
    log.append({
      type: "assistant/message",
      at: "",
      text: "Continued in the current project directory.",
      toolCalls: [],
      stopReason: "end",
      opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
    });
    const beforeRebind = deriveMessages(log.events);
    const retainedAssistant = beforeRebind.at(-1);
    recordSessionDirectory(log, "/project/E");
    const rebound = deriveMessages(log.events);
    expect(rebound.slice(0, beforeRebind.length)).toEqual(beforeRebind);
    expect(rebound[beforeRebind.length - 1]).toBe(retainedAssistant);
    expect(rebound[beforeRebind.length - 1]).toHaveProperty("opaque");
    expect(rebound.at(-1)?.content).toBe(directoryAt(log.events)?.environment);
    expect(modelSees(log.events, currentIndex).text).toBe("sent");
    expect(requestMessages(log.events, compactedRequest)).toEqual(compacted.messages);
    log.append({
      type: "compaction",
      at: "",
      summary: "Continued work after another directory change.",
      coversFrom: 1,
      coversUpTo: log.events.length,
    });
    expect(
      deriveMessages(log.events).some((message) => message.content === current.environment),
    ).toBe(false);
    expect(modelSees(log.events, currentIndex).text).toBe("covered");
    expect(requestMessages(log.events, compactedRequest)).toEqual(compacted.messages);
  });
  it("恢复缺失工具结果:记录未知且不重跑,投影保留合法调用配对与来源,旧请求不被改写", () => {
    const log = new EventLog();
    for (const e of sample().slice(0, 4)) log.append(e); // a 有结果,b 没有。
    const before = composeContext(log.events);
    recordUnresolvedCalls(log);
    recordUnresolvedCalls(log);
    expect(log.events.filter((e) => e.type === "tool/unresolved")).toHaveLength(1);
    const shell = new EventLog();
    for (const excluded of [false, true])
      shell.append({
        type: "ext/event",
        at: "",
        source: "shell",
        kind: "start",
        payload: {
          id: String(excluded),
          command: `echo ${excluded}`,
          cwd: "/project",
          excludeFromContext: excluded,
        },
      });
    recordUnresolvedCalls(shell, "exit");
    expect(shell.events.filter((e) => e.type === "user/shell")).toHaveLength(0);
    recordUnresolvedCalls(shell);
    recordUnresolvedCalls(shell);
    expect(shell.events.filter((e) => e.type === "user/shell")).toHaveLength(2);
    expect(deriveMessages(shell.events)).toHaveLength(1);
    expect(deriveMessages(shell.events)[0]?.content).toContain("execution outcome is unknown");
    expect(legalizeCut(shell.events, 2)).toBe(2);
    expect(composeContext(log.events, 4)).toEqual(before);
    log.append({ type: "user/message", at: "", text: "Check the actual state and continue." });
    const recovered = composeContext(log.events);
    expect(recovered.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(recovered.messages[4]).toMatchObject({ role: "tool", callId: "b", isError: true });
    expect(recovered.messages[4]?.content).toContain("execution outcome is unknown");
    expect(recovered.provenance[4]).toEqual({ event: 4, stages: ["unknown-result"] });
    changeContext(log, {
      type: "edit",
      target: 4,
      value: "Verified separately by the user.",
    });
    expect(composeContext(log.events).messages[4]?.content).toBe(
      "Verified separately by the user.",
    );
    const effect = changeContext(log, { type: "drop", target: 2 });
    expect(effect.removed.filter((item) => item.message.role === "tool")).toHaveLength(2);
    expect(composeContext(log.events).messages.some((m) => m.role === "tool")).toBe(false);
    const late = new EventLog();
    for (const e of sample().slice(0, 4)) late.append(e);
    recordUnresolvedCalls(late);
    late.append({
      type: "tool/result",
      at: "",
      callId: "b",
      name: "r",
      content: "actual late result",
      isError: false,
    });
    expect(
      composeContext(late.events).messages.filter((m) => m.role === "tool" && m.callId === "b"),
    ).toEqual([
      { role: "tool", callId: "b", name: "r", content: "actual late result", isError: false },
    ]);
    const remote = new EventLog();
    for (const e of sample().slice(0, 4)) remote.append(e);
    remote.append({
      type: "tool/result",
      at: "",
      callId: "b",
      name: "r",
      content: "Remote outcome unknown.",
      isError: true,
      outcome: "unknown",
    });
    const remoteBefore = composeContext(remote.events);
    recordUnresolvedCalls(remote);
    expect(remote.events).toHaveLength(5);
    expect(composeContext(remote.events)).toEqual(remoteBefore);
    expect(remoteBefore.messages.filter((m) => m.role === "tool" && m.callId === "b")).toHaveLength(
      1,
    );
    expect(remoteBefore.provenance.at(-1)).toEqual({ event: 4, stages: ["unknown-result"] });
  });
  it("丢弃旧调用时保留后续轮次复用同一 ID 的工具结果", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "S" },
      { type: "user/message", at: "", text: "first" },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: "reused", name: "r", args: {} }],
        stopReason: "tool",
      },
      { type: "tool/result", at: "", callId: "reused", name: "r", content: "old", isError: false },
      { type: "user/message", at: "", text: "second" },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: "reused", name: "r", args: {} }],
        stopReason: "tool",
      },
      { type: "tool/result", at: "", callId: "reused", name: "r", content: "new", isError: false },
    ];
    const log = new EventLog();
    for (const event of events) log.append(event);
    const preview = contextView(log.events, 2).effects.drop;
    const effect = changeContext(log, { type: "drop", target: 2 });
    expect(effect).toEqual(preview);
    expect(effect.removed.map((item) => item.event)).toEqual([2, 3]);
    const comp = composeContext(log.events);
    expect(comp.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["new"]);
    expect(comp.omitted).toContainEqual({ event: 3, reason: "dropped" });
    expect(comp.omitted).not.toContainEqual({ event: 6, reason: "dropped" });
  });
  it("每条消息带来源事件与阶段;摘要、清除、编辑、丢弃各有名字;省略列出原因;deriveMessages 只是它的一列", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", summary: "SUM", coversFrom: 2, coversUpTo: 6, cleared: [] },
      { type: "context/edit", at: "", target: 6, field: "content", value: "u2 edited" },
      { type: "context/drop", at: "", target: 7 },
    ];
    const comp = composeContext(events);
    expect(comp.messages).toEqual(deriveMessages(events));
    const tags = comp.provenance.map((p) => `${p.event}:${p.stages.join("+")}`);
    // system, u1, summary(compaction event #9), u2(edited), u3;a2 被丢弃,#2-#5 被摘要覆盖
    expect(tags).toEqual(["0:", "1:", "9:summary(covers #2–#5)", "6:edited:content", "8:"]);
    expect(comp.omitted).toEqual([
      { event: 2, reason: "covered" },
      { event: 3, reason: "covered" },
      { event: 4, reason: "covered" },
      { event: 5, reason: "covered" },
      { event: 7, reason: "dropped" },
    ]);
  });

  it("清除与改过的助手消息标 cleared / opaque-dropped", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", cleared: [3] },
      { type: "context/edit", at: "", target: 2, field: "text", value: "x" },
    ];
    const comp = composeContext(events);
    const byEvent = new Map(comp.provenance.map((p) => [p.event, p.stages]));
    expect(byEvent.get(3)).toEqual(["cleared"]);
    expect(byEvent.get(2)).toEqual(["edited:text", "opaque-dropped"]);
  });
});

describe("wireMap", () => {
  const msgs = deriveMessages(sample());
  it("chat completions 恒等;Anthropic 抽 system 并合并连续工具结果;Responses 抽 instructions", () => {
    expect(openaiCompat({ baseUrl: "http://x", apiKey: "k", model: "m" }).wireMap?.(msgs)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // system -1;u1→0;assistant→1;两条工具结果合并成 wire[2];a1→3;u2→4;a2→5;u3→6
    expect(anthropic({ apiKey: "k", model: "m" }).wireMap?.(msgs)).toEqual([
      -1, 0, 1, 2, 2, 3, 4, 5, 6,
    ]);
    // system -1;u1→0;assistant(两个 function_call)→1;RA→3;RB→4;a1→5;u2→6;a2→7;u3→8
    expect(openaiResponses({ apiKey: "k", model: "gpt-5.5" }).wireMap?.(msgs)).toEqual([
      -1, 0, 1, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe("组装槽", () => {
  it("assemble 增删投影时记录实际粗估,其 usage 不污染标准请求,恒等组装继续用新实测", async () => {
    for (const mode of ["append", "replace"] as const) {
      const log = new EventLog();
      log.append({ type: "session/start", at: "", model: "m", system: "S" });
      log.append({ type: "user/message", at: "", text: "hi" });
      const inputs = [1000, mode === "append" ? 11000 : 2, 500, 500];
      let seen: unknown[] = [];
      const provider: Provider = {
        model: "m",
        async complete(messages): Promise<AssistantTurn> {
          seen = messages;
          const inputTokens = inputs.shift();
          if (inputTokens === undefined) throw new Error("unexpected provider request");
          return {
            text: "ok",
            toolCalls: [],
            stopReason: "end",
            usage: { inputTokens, outputTokens: 4 },
          };
        },
      };
      let compactions = 0;
      const deps = {
        log,
        provider,
        tools: [],
        compaction: {
          window: 5000,
          reserveTokens: 1000,
          strategy: async () => {
            compactions++;
            return null;
          },
        },
      };
      await runTurn(deps);
      log.append({ type: "user/message", at: "", text: "next" });
      let assemblies = 0;
      await runTurn({
        ...deps,
        slots: {
          assemble: (events) => {
            assemblies++;
            return mode === "append"
              ? [...deriveMessages(events), { role: "user", content: "r".repeat(40000) }]
              : [
                  { role: "system", content: "S" },
                  { role: "user", content: "tiny" },
                ];
          },
        },
      });
      expect(seen.length).toBe(mode === "append" ? 5 : 2);
      const request = log.events.filter((event) => event.type === "request").at(-1);
      if (!request) throw new Error("Expected recorded request");
      const requestIndex = log.events.indexOf(request);
      expect(request.estimatedTokens).toBe(mode === "append" ? 10004 : 2);
      expect(requestMessages(log.events, requestIndex)).toEqual(seen);
      expect(request?.body).toEqual({
        prefixEvents: mode === "append" ? requestIndex : 1,
        tail: [{ role: "user", content: mode === "append" ? "r".repeat(40000) : "tiny" }],
      });

      log.append({ type: "user/message", at: "", text: "more" });
      await runTurn(deps);
      expect(log.events.filter((event) => event.type === "request").at(-1)).toMatchObject({
        estimatedTokens: 6,
      });
      log.append({ type: "user/message", at: "", text: "same" });
      await runTurn({
        ...deps,
        slots: {
          assemble: (events) => {
            assemblies++;
            return deriveMessages(events);
          },
        },
      });
      const identity = log.events.filter((event) => event.type === "request").at(-1);
      expect(identity?.estimatedTokens).toBe(505);
      expect(identity?.body).toBeUndefined();
      if (!identity) throw new Error("Expected identity request");
      expect(requestMessages(log.events, log.events.indexOf(identity))).toEqual(seen);
      expect(assemblies).toBe(2);
      expect(compactions).toBe(0);
    }
    // 首差异之前有后来的编辑,候选前缀必须验证后回退,不能假设投影随事件单调增长。
    const edited: AgentEvent[] = [
      ...sample(),
      { type: "context/edit", at: "", target: 0, field: "system", value: "new system" },
    ];
    const cleaned = deriveMessages(edited).map((message) => {
      if (message.role !== "assistant") return message;
      const copy = { ...message };
      delete copy.opaque;
      return copy;
    });
    const body = describeRequestBody(edited, cleaned);
    expect(body.prefixEvents).toBe(0);
    const request: AgentEvent = {
      type: "request",
      at: "",
      model: "m",
      messages: cleaned.length,
      tools: [],
      estimatedTokens: 1,
      reason: "turn",
      body,
    };
    expect(requestMessages([...edited, request], edited.length)).toEqual(cleaned);
  });
});

describe("检视器组装视图", () => {
  it("行的来源事件、wire 下标与阶段;工作台里 Enter 出动作单再看全文;Tab 从压缩对照进入", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", summary: "SUM", coversFrom: 2, coversUpTo: 6 },
    ];
    const provider = anthropic({ apiKey: "k", model: "m" });
    const { rows, omitted } = compositionRows(events, provider);
    expect(rows.map((r) => r.wire)).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(rows[2]?.stages[0]).toContain("summary");
    expect(omitted).toHaveLength(4);
    const detail = compositionLines(events, rows[2] as (typeof rows)[number])
      .map(plain)
      .join("\n");
    expect(detail).toContain("event #9 compaction");
    expect(detail).toContain("messages[1]");
    expect(detail).toContain("SUM");

    const insp = new RequestInspector({
      events: () => events,
      providerFor: () => provider,
      currentProvider: () => provider,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.showCompactions();
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition");
    const screen = insp.render(120).map(plain).join("\n");
    expect(screen).toContain("Context · Current projection");
    // 前两行是系统提示词与工具定义;摘要行带 ≈,它下面折一行被覆盖的消息
    expect(screen).toMatch(/#0\s+system/);
    expect(screen).toMatch(/tools\s+0 definitions/);
    expect(screen).toMatch(/≈ #9\s+summary\s+SUM/);
    expect(screen).toContain("#2–#5  4 messages · ");
    expect(screen).toContain("→ summary · Enter shows them");
    // 底部预览:最后一条的来历
    expect(screen).toContain("projected messages[4] · from event user/message");
    expect(screen).toContain("not sent yet");
    // Enter 先开动作菜单,第一项"View full message"再 Enter 才进全文
    insp.handleInput("\r");
    expect(insp.currentMode).toBe("actions");
    const menu = insp.render(120).map(plain).join("\n");
    expect(menu).toContain("1  View full message");
    insp.handleInput("\r");
    expect(insp.currentMode).toBe("message");
    expect(insp.render(120).map(plain).join("\n")).toContain("message 6 of 6");
    insp.handleInput("\t");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("composition");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("list");
  });
});
