// 事件视图:每种事件一句人读的话;右列是模型眼里的状态;筛选页签;详情三页。
import { describe, expect, it } from "vitest";
import { RequestInspector } from "../cli/inspector.js";
import {
  eventPasses,
  eventSummary,
  eventViewLines,
  filteredIndices,
  modelSees,
  projectionLines,
} from "../cli/inspector-events.js";
import type { AgentEvent } from "../src/events.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const at = "2026-09-07T10:00:00.000Z";

function events(): AgentEvent[] {
  return [
    {
      type: "session/start",
      at,
      model: "m",
      system: [{ id: "role", name: "Role", text: "sys", enabled: true }],
    },
    { type: "user/message", at, text: "hello there" },
    {
      type: "request",
      at,
      model: "m",
      messages: 2,
      tools: ["read"],
      estimatedTokens: 1200,
      reason: "turn",
      effort: "high",
    },
    { type: "retry", at, attempt: 1, delayMs: 800, error: "rate limited", status: 429 },
    {
      type: "assistant/message",
      at,
      text: "Reading.",
      toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }],
      stopReason: "tool",
      reasoning: "think",
      reasoningKind: "full",
      usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 },
      latencyMs: 1200,
    },
    {
      type: "tool/result",
      at,
      callId: "c1",
      name: "read",
      content: "l1\nl2\nl3",
      isError: false,
      durationMs: 4,
    },
    { type: "decision", at, slot: "plan", reason: "stale", steps: 8 },
    { type: "session/slot", at, slot: "execution", value: "parallel" },
    {
      type: "compaction",
      at,
      strategy: "llm",
      summary: "SUM",
      coversFrom: 1,
      coversUpTo: 5,
      tokensBefore: 3000,
      cleared: [5],
    },
    { type: "context/edit", at, target: 1, field: "content", value: "hello there, friend" },
    { type: "context/drop", at, target: 4, note: "retry" },
    { type: "ext/event", at, source: "mcp", kind: "rpc", payload: {} },
  ];
}

describe("事件一句话", () => {
  it("每种事件的摘要与记号", () => {
    const e = events();
    const s = (i: number) => stripAnsi(eventSummary(e, i).text);
    expect(s(0)).toContain("system prompt · m · 1 sections");
    expect(s(1)).toBe("hello there");
    expect(s(2)).toBe("m · 2 msgs · ≈1.2k tok · cache 80% · 1.2s · effort high");
    expect(s(3)).toContain("429 rate limited · waited 800ms · attempt 1");
    expect(s(4)).toContain("Reading. · » read · thinking 2");
    expect(s(5)).toContain("✓ read · 3 lines · 4ms");
    expect(s(6)).toContain("plan restated · 8 steps without an update");
    expect(s(7)).toBe("execution → parallel");
    expect(s(8)).toContain("llm · #1–#4 (2 messages, 3.0k tok) → summary 1 tok");
    expect(s(8)).toContain("cleared 1 result");
    expect(s(9)).toContain("#1.content · 3 → 5 tok");
    expect(s(10)).toBe("dropped #4 assistant · retry");
    expect(s(11)).toContain("mcp");
    // 只有调用没有正文时,记号列已经是 »,正文里不再重复一个
    const bare: AgentEvent[] = [
      {
        type: "assistant/message",
        at,
        text: "",
        toolCalls: [{ id: "c", name: "read", args: {} }],
        stopReason: "tool",
      },
    ];
    expect(eventSummary(bare, 0).sign).toBe("»");
    expect(stripAnsi(eventSummary(bare, 0).text)).toBe("read");
    e.push({
      type: "tool/arguments",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      args: { path: "b" },
    });
    expect(s(12)).toContain("read · prepared arguments · call from #4 · execution not implied");
    expect(modelSees(e, 12).text).toBe("kernel");
    e.push({
      type: "tool/executed",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      content: "External state requires verification",
      isError: true,
      durationMs: 5,
      outcome: "unknown",
    });
    expect(s(13)).toContain("execution outcome unknown · call from #4 · 5ms");
    expect(eventSummary(e, 13).tok).toBeUndefined();
    expect(modelSees(e, 13).text).toBe("kernel");
  });

  it("模型眼里的状态:sent · kernel · covered · cleared · dropped · edited · not sent yet", () => {
    const e = events();
    expect(modelSees(e, 2).text).toBe("kernel");
    expect(modelSees(e, 1)).toEqual({ text: "covered", changed: true });
    // #4 被丢弃,它的结果 #5 随它一起走;去掉那条 drop 才看得到 cleared
    expect(modelSees(e, 4)).toEqual({ text: "dropped", changed: true });
    expect(modelSees(e, 5)).toEqual({ text: "dropped", changed: true });
    expect(modelSees(e.slice(0, 10), 5)).toEqual({ text: "cleared", changed: true });
    const plain: AgentEvent[] = [
      e[0] as AgentEvent,
      e[1] as AgentEvent,
      e[2] as AgentEvent,
      e[4] as AgentEvent,
      { type: "user/message", at, text: "next" },
      { type: "context/edit", at, target: 3, field: "text", value: "x" },
    ];
    expect(modelSees(plain, 1).text).toBe("sent");
    expect(modelSees(plain, 3)).toEqual({ text: "edited text", changed: true });
    expect(modelSees(plain, 4).text).toBe("not sent yet");
  });

  it("筛选:conversation · kernel · changes · extensions", () => {
    const e = events();
    e.push({
      type: "tool/arguments",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      args: { path: "b" },
    });
    e.push({
      type: "tool/executed",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      content: "original return",
      isError: false,
      durationMs: 4,
    });
    expect(filteredIndices(e, 2)).toEqual([0, 1, 4, 5]);
    expect(filteredIndices(e, 3)).toEqual([2, 3, 6, 7, 12, 13]);
    expect(filteredIndices(e, 4)).toEqual([8, 9, 10]);
    expect(filteredIndices(e, 5)).toEqual([11]);
    expect(eventPasses(e[2] as AgentEvent, 1)).toBe(true);
  });

  it("详情:view 按字段;projection 写它后来怎么了", () => {
    const e = events();
    const view = eventViewLines(e, 4).map(stripAnsi).join("\n");
    expect(view).toContain("stop         tool");
    expect(view).toContain("usage        in 1000 (cache 800) · out 20");
    expect(view).toContain("thinking (full)");
    expect(view).toContain("» read");
    e.push({
      type: "tool/arguments",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      args: { path: "b" },
    });
    const prepared = eventViewLines(e, 12).map(stripAnsi).join("\n");
    expect(prepared).toContain("prepared for approval; execution not implied");
    expect(prepared).toContain('"path": "b"');
    e.push({
      type: "tool/executed",
      at,
      callEvent: 4,
      callId: "c1",
      name: "read",
      content: "original return",
      isError: false,
      durationMs: 4,
      output: { file: "a.body", bytes: 20, missingFrom: 4 },
    });
    const executed = eventViewLines(e, 13).map(stripAnsi).join("\n");
    expect(executed).toContain("call event #4");
    expect(executed).toContain("success · 4ms");
    expect(executed).toContain("pending; no final result recorded");
    expect(executed).toContain("20 attempted bytes · captured prefix 4 bytes");
    expect(executed).toContain("original return");
    e.push({
      type: "tool/result",
      at,
      callId: "c1",
      name: "read",
      content: "normalized error",
      isError: true,
      executionEvent: 13,
    });
    expect(eventViewLines(e, 13).map(stripAnsi).join("\n")).toContain("event #14");
    const final = eventViewLines(e, 14).map(stripAnsi).join("\n");
    expect(final).toContain("event #13");
    expect(final).toContain("normalized error");
    const dropped = projectionLines(e, 4).map(stripAnsi).join("\n");
    expect(dropped).toContain("now          dropped");
    expect(dropped).toContain("since        event #10 · retry");
    const comp = projectionLines(e, 8).map(stripAnsi).join("\n");
    expect(comp).toContain("never reaches the model");
    expect(comp).toContain("replaces events #1 to #4");
    const edit = projectionLines(e, 9).map(stripAnsi).join("\n");
    expect(edit).toContain("replaces the content of event #1");
  });

  it("界面:request 前空一行,右列状态,数字切筛选,Ctrl+↑↓ 在请求间跳,Enter 三页", () => {
    const e = events();
    const insp = new RequestInspector({
      events: () => e,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 40,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.showEvents();
    let s = insp.render(130).map(stripAnsi).join("\n");
    expect(s).toContain("[1 all]");
    expect(s).toMatch(/\n\s*\n\s*#2\s+\d\d:\d\d:\d\d\s+request/); // request 前空一行
    // request 是章节靠空行分,不靠缩进:类型列与右边的状态列都不许错开
    const line = (n: number) => s.split("\n").find((l) => l.includes(`#${n} `)) as string;
    expect(line(2).indexOf("request")).toBe(line(1).indexOf("user/message"));
    expect(line(2).indexOf("kernel")).toBe(line(1).indexOf("covered"));
    expect(s).toMatch(/#1 .*covered/);
    expect(s).toMatch(/#11 .*kernel/);
    insp.handleInput("4");
    s = insp.render(130).map(stripAnsi).join("\n");
    expect(s).toContain("[4 changes]");
    expect(s).not.toContain("user/message");
    expect(s).toContain("context/edit");
    insp.handleInput("1");
    insp.handleInput("\x1b[H");
    insp.handleInput("\x1b[1;5B"); // Ctrl+↓ → 下一个 request
    insp.handleInput("\r");
    s = insp.render(130).map(stripAnsi).join("\n");
    expect(s).toContain("Event #2");
    expect(s).toContain("[1 view]");
    expect(s).toContain("reason       turn");
    insp.handleInput("3");
    expect(insp.render(130).map(stripAnsi).join("\n")).toContain("Its body is the projection");
  });
});
