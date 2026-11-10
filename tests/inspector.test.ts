import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { RequestInspector } from "../cli/inspector.js";
import { cacheUsageLines, fmtMs, fmtTok } from "../cli/inspector-format.js";
import type { RequestRecording } from "../cli/session-records.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { deriveMessages, requestMessages } from "../src/messages.js";
import type { AssistantTurn, Provider, ToolDef } from "../src/provider.js";
import { anthropic } from "../src/providers/anthropic.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const echo = defineTool({
  name: "echo",
  description: "回显文本",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});
const defs: ToolDef[] = [
  { name: echo.name, description: echo.description, parameters: echo.parameters },
];

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    wire: (messages, tools) => ({ model: "fake", messages, tools, stream: true }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

async function session(): Promise<{ log: EventLog; provider: Provider }> {
  const log = new EventLog();
  log.append({
    type: "session/start",
    at: "2026-09-01T09:00:00.000Z",
    model: "fake",
    system: [{ id: "role", name: "角色与规则", text: "你是助手", enabled: true }],
  });
  log.append({ type: "user/message", at: "2026-09-01T09:00:01.000Z", text: "读一下" });
  const provider = scripted([
    {
      text: "先看看",
      toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
      stopReason: "tool",
      usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 800 },
      reasoning: "用户想读内容",
    },
    {
      text: "完成",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1500, outputTokens: 10 },
    },
  ]);
  await runTurn({
    log,
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
  });
  return { log, provider };
}

function build(log: EventLog, provider: Provider, rows = 30, currentDefs = defs) {
  let closed = 0;
  const insp = new RequestInspector({
    events: () => log.events,
    providerFor: () => provider,
    tools: () => currentDefs,
    rows: () => rows,
    sessions: () => [
      {
        name: "main",
        events: log.events,
        recordingFor: (i) =>
          i === log.events.findIndex((event) => event.type === "request")
            ? {
                bodies: [],
                attempts: [
                  { n: 1, status: 200, state: "complete", response: "data: {}\ndata: [DONE]" },
                ],
              }
            : undefined,
      },
    ],
    onClose: () => {
      closed += 1;
    },
    requestRender: () => {},
  });
  insp.reset();
  const text = (width = 100) => insp.render(width).map(stripAnsi).join("\n");
  return { insp, text, closed: () => closed };
}

describe("请求检视器", () => {
  it("格式化:token 与耗时", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1200)).toBe("1.2k");
    expect(fmtTok(48200)).toBe("48k");
    expect(fmtTok(undefined)).toBe("—");
    expect(fmtMs(80)).toBe("80ms");
    expect(fmtMs(2340)).toBe("2.3s");
    expect(
      cacheUsageLines({ inputTokens: 1200, outputTokens: 5000, cacheReadTokens: 800 })[0],
    ).toContain("66.7%");
    expect(
      cacheUsageLines({ inputTokens: 1200, outputTokens: 0, cacheReadTokens: 0 })[0],
    ).toContain("0.0%");
    expect(cacheUsageLines({ inputTokens: 1200, outputTokens: 0 })).toEqual([
      "Cache hit: not reported",
    ]);
    expect(
      cacheUsageLines({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 101 })[0],
    ).toContain("unavailable");
  });

  it("列表:一行一请求,含规模、实测、缓存、停止原因;行数恰为终端高度", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 30);
    const doc = text();
    expect(insp.render(100)).toHaveLength(30);
    expect(doc).toContain("Requests");
    expect(doc).toContain("2 requests");
    expect(doc).toContain("#1");
    expect(doc).toContain("2 msgs");
    expect(doc).toContain("→ 1.2k (cache 800)  +30");
    expect(doc).toContain("tool");
    expect(doc).toContain("#2");
    expect(doc).toContain("4 msgs");
    expect(doc).toContain("end");
    expect(doc).toContain("› #2"); // 打开时选中最新一条
    const narrow = text(60);
    expect(insp.render(60)).toHaveLength(30);
    expect(narrow).toContain("cache 800");
    expect(narrow).toContain("+30");
    expect(narrow).toContain("tool");
    insp.handleInput("\x1b[H");
    text(60); // 窄屏每个请求占两行,分页使用实际可见的条目数。
    insp.handleInput("\x1b[6~");
    expect(text(60)).toContain("› #2");
    insp.handleInput("\x1b[5~");
    expect(text(60)).toContain("› #1");
    for (const summary of ["first summary", "second summary"])
      log.append({ type: "compaction", at: "t", summary, coversFrom: 1, coversUpTo: 2 });
    insp.showCompactions();
    insp.handleInput("\x1b[H");
    text(60);
    insp.handleInput("\x1b[6~");
    expect(text(60)).toMatch(/› #2\s/);
    insp.handleInput("\x1b[5~");
    expect(text(60)).toMatch(/› #1\s/);
  });

  it("详情六分区:概要 / 决策 / 发送(折叠可切) / 工具定义 / 线路 JSON / 接收", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 40, [
      { name: "echo", description: "replacement description", parameters: { replacement: true } },
    ]);
    insp.handleInput("\x1b[H"); // 选到 #1
    insp.handleInput("\r");
    let doc = text();
    expect(insp.isDetail).toBe(true);
    expect(doc).toContain("Request #1");
    expect(doc).toContain("[1 summary]");
    expect(doc).toContain("HTTP body: 1 attempt(s) recorded before dispatch");
    expect(doc).not.toContain("HTTP body: not captured");
    expect(doc).toContain("2 messages · 1 tools");
    expect(doc).toContain("threshold 80000");
    expect(doc).toContain("measured in");
    expect(doc).toContain("cache hit 800 tok");
    expect(doc).toContain("stop reason");

    insp.handleInput("2");
    doc = text();
    expect(doc).toContain("[2 decisions]");
    expect(doc).toContain("recorded threshold");
    expect(doc).toContain("below threshold");

    insp.handleInput("3");
    doc = text();
    expect(doc).toContain("[3 sent]");
    expect(doc).toContain("Cache hit: 66.7%");
    expect(doc).toContain("exact text spans not reported");
    expect(doc).toContain("1. system");
    expect(doc).toContain("2. user");
    expect(doc).toContain("reconstructed from events");
    expect(doc).not.toContain("├ 角色与规则");
    insp.handleInput("\r");
    expect(text()).toContain("├ 角色与规则");
    expect(text()).toContain("[−] 1. system");
    expect(text()).toContain("[+] 2. user");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("[−] 2. user");
    expect(text()).toContain("[−] 1. system");
    const unchanged = text();
    for (const key of ["f", "j", "k", "g", "G", "q", "s", "h", "l"]) insp.handleInput(key);
    expect(text()).toBe(unchanged);
    expect(text()).toContain("[−] 2. user");

    insp.handleInput("4");
    doc = text();
    expect(doc).toContain("[4 tool defs]");
    expect(doc).toContain("echo");
    expect(doc).toContain("回显文本");
    expect(doc).toContain('"type": "object"');
    expect(doc).toContain('"text": {');
    expect(doc).not.toContain("replacement");

    insp.handleInput("5");
    doc = text();
    expect(doc).toContain("[5 wire JSON]");
    expect(doc).toContain("Reconstructed preview");
    expect(doc).toContain('"model": "fake"');
    expect(doc).toContain('"stream": true');

    insp.handleInput("6");
    doc = text();
    expect(doc).toContain("[6 received]");
    expect(doc).toContain("先看看");
    expect(doc).toContain("Model arguments");
    expect(doc).toContain("Prepared arguments");
    expect(doc).toContain("HTTP attempt 1");
    expect(doc).not.toContain("data: [DONE]");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain('"text": "hi"');
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("prepared for approval");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("Result for model");
    expect(text()).toContain("echo:hi");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("data: [DONE]");
    insp.handleInput("\x1b[B");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("用户想读内容");

    // 短窗口必须给选中目标和实际操作留位置,不能由固定统计挤出屏幕。
    for (const [width, height] of [
      [60, 12],
      [20, 8],
    ]) {
      const small = build(log, provider, height);
      small.insp.showRequest(1, 3);
      small.insp.handleInput("\r");
      const lines = small.insp.render(width as number);
      const screen = lines.map(stripAnsi).join("\n").replace(/\s+/g, " ");
      expect(lines.length).toBeLessThanOrEqual(height as number);
      expect(screen).toContain("Request #1");
      expect(screen).toContain("Selected");
      expect(screen).toContain("Enter collapse");
      expect(screen).toContain("Esc back");
      expect(screen).toContain("[−] 1. system");
    }

    // 重载不附带 Recording;旧请求不能借后来同名工具的描述与 schema。
    log.append({ type: "user/message", at: "t", text: "next task" });
    await runTurn({
      log,
      provider: scripted([{ text: "new result", toolCalls: [], stopReason: "end" }]),
      tools: [
        defineTool({
          name: "echo",
          description: "replacement description",
          parameters: Type.Object({ replacement: Type.Boolean() }),
          async execute() {
            return "unused";
          },
        }),
      ],
    });
    const directory = mkdtempSync(join(tmpdir(), "clarook-inspector-history-"));
    try {
      const file = join(directory, "session.jsonl");
      writeFileSync(file, `${log.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const loaded = EventLog.load(file);
      const restored = build(loaded, provider, 40, []);
      restored.insp.showRequest(1, 4);
      expect(restored.text()).toContain("回显文本");
      expect(restored.text()).toContain('"text": {');
      expect(restored.text()).not.toContain("replacement");
      restored.insp.showRequest(1, 6);
      expect(restored.text()).toContain("Model arguments");
      expect(restored.text()).toContain("Prepared arguments");
      expect(restored.text()).toContain("execution not implied");
      restored.insp.showRequest(3, 4);
      expect(restored.text()).toContain("replacement description");
      expect(restored.text()).toContain('"replacement": {');

      // 无附件重载必须复现实际清理输入,不能把 B 的新块或旧请求一起重写。
      const thinkingLog = new EventLog();
      thinkingLog.append({ type: "session/start", at: "t", model: "m", system: "S" });
      const adapter = anthropic({ apiKey: "", model: "m", promptCache: false });
      const inputs: Parameters<Provider["complete"]>[0][] = [];
      const thinkingProvider: Provider = {
        model: "m",
        async complete(messages) {
          inputs.push(structuredClone(messages));
          const signature = `sig-${inputs.length}`;
          return {
            text: `answer-${inputs.length}`,
            toolCalls: [],
            stopReason: "end",
            opaque: {
              kind: "anthropic-thinking",
              model: "m",
              blocks: [
                { type: "thinking", thinking: "saved reasoning", signature },
                { type: "redacted_thinking", data: `redacted-${inputs.length}` },
              ],
            },
          };
        },
      };
      const changedEcho = { ...echo, description: "changed description" };
      for (const [i, tools] of [[echo], [echo], [changedEcho], [changedEcho]].entries()) {
        thinkingLog.append({ type: "user/message", at: "t", text: `prompt-${i + 1}` });
        await runTurn({ log: thinkingLog, provider: thinkingProvider, tools });
      }
      const thinkingFile = join(directory, "thinking.jsonl");
      writeFileSync(
        thinkingFile,
        `${thinkingLog.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      const thinkingEvents = EventLog.load(thinkingFile).events;
      const thinkingInspector = new RequestInspector({
        events: () => thinkingEvents,
        providerFor: () => adapter,
        tools: () => [],
        rows: () => 40,
        onClose() {},
        requestRender() {},
      });
      for (const record of thinkingInspector.records()) {
        expect(requestMessages(thinkingEvents, record.index)).toEqual(inputs[record.n - 1]);
        const sent = stripAnsi(thinkingInspector.sectionLines(record, 3).join("\n"));
        const wire = stripAnsi(thinkingInspector.sectionLines(record, 5).join("\n"));
        expect(sent).toContain("reconstructed from recorded events");
        expect(wire).toContain("Reconstructed preview");
        if (record.n === 2) {
          expect(sent).toContain("sig-1");
          expect(wire).toContain("sig-1");
        } else {
          expect(sent).not.toContain("sig-1");
          expect(wire).not.toContain("sig-1");
        }
        if (record.n >= 3) {
          expect(sent).not.toContain("sig-2");
          expect(wire).not.toContain("sig-2");
        }
        if (record.n === 4) {
          expect(sent).toContain("sig-3");
          expect(wire).toContain("sig-3");
          expect(wire).toContain("redacted-3");
        }
      }
      // 捕获输入与 HTTP 是旧行为证据,其优先级高于当前重建规则。
      const records = thinkingInspector.records();
      const dirty =
        inputs[3]?.map((message) =>
          message.role === "assistant" && message.content === "answer-1"
            ? {
                ...message,
                opaque: {
                  kind: "anthropic-thinking",
                  model: "m",
                  blocks: [{ type: "thinking", thinking: "old", signature: "captured-dirty" }],
                },
              }
            : message,
        ) ?? [];
      const captured = new RequestInspector({
        events: () => thinkingEvents,
        sessions: () => [
          {
            name: "main",
            events: thinkingEvents,
            recordingFor: () => ({
              input: { messages: dirty, tools: [] },
              bodies: ['{"historical":"captured-dirty"}'],
              attempts: [],
            }),
          },
        ],
        providerFor: () => adapter,
        tools: () => [],
        rows: () => 40,
        onClose() {},
        requestRender() {},
      });
      const latest = records[3];
      if (!latest) throw new Error("Expected stable tool request");
      expect(stripAnsi(captured.sectionLines(latest, 3).join("\n"))).toContain("captured-dirty");
      expect(stripAnsi(captured.sectionLines(latest, 5).join("\n"))).toContain("captured-dirty");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("按键:方向切分区、[ ] 切请求、滚动有位置提示、Esc 逐级返回并关闭", async () => {
    const { log, provider } = await session();
    const { insp, text, closed } = build(log, provider, 12);
    insp.handleInput("\x1b[H");
    insp.handleInput("\r");
    insp.handleInput("\x1b[C"); // →
    expect(text()).toContain("[2 decisions]");
    insp.handleInput("]");
    expect(text()).toContain("Request #2");
    insp.handleInput("5");
    // 位置提示在页脚提示语之后;100 列下会被截断,用宽终端看它
    const before = text(160);
    expect(before).toMatch(/lines 1-\d+ of \d+/);
    insp.handleInput("\x1b[B"); // ↓
    expect(text(160)).toMatch(/lines 2-\d+ of \d+/);
    insp.handleInput("\x1b[F");
    expect(text(160)).not.toMatch(/lines 2-/);
    insp.handleInput("\x1b");
    expect(insp.isDetail).toBe(false);
    insp.handleInput("\x1b");
    expect(closed()).toBe(1);
  });

  it("第 7 分区 写入:本次请求之后追加的事件原样 JSON", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 60);
    insp.handleInput("\x1b[H");
    insp.handleInput("\r");
    insp.handleInput("7");
    const doc = text();
    expect(doc).toContain("[7 written]");
    expect(doc).toContain("assistant/message");
    expect(doc).toContain("tool/result");
    expect(doc).toContain('"callId": "c1"');
    expect(doc).toContain("model-visible");
    expect(doc).not.toContain('"text": "完成"'); // 那是下一次请求的写入
  });

  it("事件视图(Tab):内核维护的全部事件,逐条大小与可见性;Enter 看原样 JSON", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 30);
    insp.handleInput("\t");
    let doc = text();
    expect(insp.currentMode).toBe("events");
    expect(doc).toContain("Events");
    expect(doc).toContain(`${log.events.length} events`);
    expect(doc).toContain("#0   ");
    expect(doc).toContain("session/start");
    expect(doc).toContain("request");
    // 右列:模型眼里的状态;request 行前空一行,一句人读的话
    expect(doc).toContain("kernel");
    expect(doc).toContain("sent");
    expect(doc).toMatch(/→ .+ · \d+ msgs · ≈/);
    expect(doc).toContain("[1 all]");
    // 筛选:3 kernel 只留 request 之类
    insp.handleInput("3");
    doc = text();
    expect(doc).not.toContain("session/start");
    expect(doc).toContain("request");
    insp.handleInput("1");
    insp.handleInput("\x1b[H");
    insp.handleInput("\r");
    doc = text();
    expect(insp.currentMode).toBe("event");
    expect(doc).toContain("Event #0");
    expect(doc).toContain("[1 view]");
    expect(doc).toContain("system prompt");
    insp.handleInput("2");
    doc = text();
    expect(doc).toContain('"type": "session/start"');
    expect(doc).toContain('"text": "你是助手"');
    insp.handleInput("3");
    expect(text()).toContain("position");
    insp.handleInput("1");
    insp.handleInput("]");
    expect(text()).toContain("Event #1");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("events");
    insp.handleInput("\t"); // 事件视图 → 压缩对照 → 请求视图
    expect(insp.currentMode).toBe("compactions");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition"); // 第四视图:组装
    insp.handleInput("	");
    expect(insp.currentMode).toBe("list");
  });

  it("压缩请求的发送分区显示真实发出的消息(前缀 + 摘要指示),线路 JSON 同源", () => {
    const events: AgentEvent[] = [
      {
        type: "session/start",
        at: "t",
        model: "fake",
        system: [{ id: "original", name: "Original", text: "S", enabled: true }],
      },
      { type: "user/message", at: "t", text: "U1" },
      { type: "assistant/message", at: "t", text: "A1", toolCalls: [], stopReason: "end" },
      { type: "user/message", at: "t", text: "U2" },
      {
        type: "context/edit",
        at: "t",
        target: 0,
        field: "system",
        value: [{ id: "later", name: "Later", text: "S", enabled: true }],
      },
      { type: "tools/snapshot", at: "t", tools: defs },
      {
        type: "request",
        at: "t",
        model: "fake",
        messages: 4,
        tools: [],
        estimatedTokens: 10,
        reason: "compaction",
        body: { prefixEvents: 3, tail: [{ role: "user", content: "请压缩以上对话" }] },
      },
      {
        type: "compaction",
        at: "t",
        summary: "摘要",
        coversFrom: 2,
        coversUpTo: 3,
        strategy: "llmSummarize(structuredFull, replay)",
      },
    ];
    const log = new EventLog();
    for (const e of events) log.append(e);
    const { insp, text } = build(log, scripted([]));
    const first = insp.records()[0];
    if (!first) throw new Error("missing request");
    const historical = insp.sectionLines(first, 3).map(stripAnsi).join("\n");
    expect(historical).toContain("Original [original]");
    expect(historical).not.toContain("Later [later]");
    insp.handleInput("\r");
    insp.handleInput("3");
    const doc = text();
    expect(doc).toContain("请压缩以上对话");
    expect(doc).toContain("A1");
    expect(doc).not.toContain("U2"); // 前缀只到第 3 条事件
    insp.handleInput("5");
    expect(text()).toContain("请压缩以上对话");
    insp.handleInput("4");
    expect(text()).toContain("No tools were sent");
    expect(text()).not.toContain("回显文本");
    insp.handleInput("1");
    expect(text()).toContain("strategy");
    expect(text()).toContain("llmSummarize(structuredFull, replay)");
    log.append({
      type: "request",
      at: "t",
      model: "fake",
      messages: 2,
      tools: ["echo"],
      estimatedTokens: 10,
      reason: "compaction",
    });
    insp.showRequest(2, 4);
    expect(text()).toContain("Historical tool definitions are unavailable");
    expect(text()).not.toContain("回显文本");
    insp.handleInput("5");
    expect(text()).toContain("Cannot reconstruct");
  });

  it("没有请求时给出提示而不崩", () => {
    const log = new EventLog();
    const { text } = build(log, scripted([]));
    expect(text()).toContain("No requests yet. Send a message first.");
  });

  it("provider 未实现 wire 时线路分区如实说明", async () => {
    const { log } = await session();
    const bare: Provider = {
      model: "fake",
      async complete() {
        throw new Error("x");
      },
    };
    const { insp, text } = build(log, bare);
    insp.handleInput("\r");
    insp.handleInput("5");
    expect(text()).toContain("This provider has no wire()");
    // 旧日志没有完整声明,即使当前仍有同名工具也不能冒充历史。
    const legacy = new EventLog();
    for (const event of log.events) if (event.type !== "tools/snapshot") legacy.append(event);
    const missing = build(legacy, scripted([]), 30);
    missing.insp.handleInput("\r");
    missing.insp.handleInput("4");
    expect(missing.text()).toContain("Historical tool definitions are unavailable");
    expect(missing.text()).toContain("Recorded tool names: echo");
    expect(missing.text()).not.toContain("回显文本");
    expect(missing.text()).not.toContain("No tools were sent");
    missing.insp.handleInput("5");
    expect(missing.text()).not.toContain('"stream": true');
    expect(missing.text()).toContain("Cannot reconstruct");

    // 请求尚未返回时,旁路记录会变化而事件数不变;不能让缓存一直显示未捕获。
    const events = legacy.events.slice(0, 3);
    const trace: RequestRecording = { bodies: [], attempts: [] };
    const live = new RequestInspector({
      events: () => events,
      sessions: () => [{ name: "main", events, recordingFor: () => trace }],
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    live.showRequest(1, 5);
    const render = () => live.render(100).map(stripAnsi).join("\n");
    expect(render()).toContain("Cannot reconstruct");
    trace.bodies.push('{"model":"historical","tools":[{"name":"echo"}]}');
    expect(render()).toContain('"model": "historical"');
    expect(render()).not.toContain("Cannot reconstruct");
    live.handleInput("6");
    expect(render()).toContain("No HTTP response captured");
    trace.attempts?.push({ n: 1, state: "unfinished", response: "data: live-chunk" });
    expect(render()).toContain("data: live-chunk");
    // 翻页后正文块的标题已经滚出视口,固定头仍需说明 Enter 操作谁。
    const attempt = trace.attempts?.[0];
    if (!attempt) throw new Error("missing attempt");
    attempt.response = Array.from({ length: 100 }, (_, i) => `data: chunk-${i}`).join("\n");
    live.handleInput("\r");
    render();
    live.handleInput("\x1b[6~");
    const page = live.render(60).map(stripAnsi).join("\n");
    expect(page).toContain("Selected · HTTP attempt 1");
    expect(page).not.toContain("data: chunk-0\n");
    // 调用、结果与原文在当前 HTTP 块之前加入,选择仍指向正在阅读的块。
    events.push({
      type: "assistant/message",
      at: "t",
      text: "checking",
      stopReason: "tool",
      toolCalls: [{ id: "waiting", name: "echo", args: { text: "waiting" } }],
    });
    trace.outputs = [
      {
        callId: "waiting",
        name: "echo",
        original: "partial output",
        state: "unfinished",
        source: "original output",
      },
    ];
    expect(render()).toContain("Selected · HTTP attempt 1");
    expect(render()).toContain("Enter collapse");
    events.push({
      type: "tool/result",
      at: "t",
      callId: "waiting",
      name: "echo",
      content: "External outcome unknown",
      isError: true,
      outcome: "unknown",
    });
    const expectedEvents = JSON.stringify(events);
    const expectedMessages = JSON.stringify(deriveMessages(events));
    expect(render()).toContain("Selected · HTTP attempt 1");
    expect(render()).toContain("Enter collapse");
    live.handleInput("\x1b[5~");
    render();
    live.handleInput("\x1b[6~");
    render();
    live.handleInput("\r"); // 仍折叠 HTTP 正文,不误折叠新加入的结果。
    expect(render()).not.toContain("data: chunk-99");
    expect(JSON.stringify(events)).toBe(expectedEvents);
    expect(JSON.stringify(deriveMessages(events))).toBe(expectedMessages);
    // 发送页不能把读取失败隐藏在重建标签背后。
    trace.error = "Missing or unreadable recording: fixture input";
    live.handleInput("3");
    const damaged = live.render(60).map(stripAnsi).join("\n");
    expect(damaged).toContain("Recording unavailable or damaged");
    expect(damaged).toContain("Missing or unreadable recording");
    expect(damaged).toContain("reconstructed from events");

    // 历史工具同名也可能改了定义;只比较实录,不借当前工具集猜测。
    const records = build(log, bare).insp.records();
    let capturePrevious = false;
    const recorded = new RequestInspector({
      events: () => log.events,
      providerFor: () => undefined,
      sessions: () => [
        {
          name: "main",
          events: log.events,
          recordingFor: (i, section) => {
            const rec = records.find((r) => r.index === i);
            return rec
              ? {
                  bodies:
                    section === "wire" && rec.n === 2
                      ? ['{"tools":[{"name":"echo","description":"captured HTTP definition"}]}']
                      : section === "wire" && capturePrevious
                        ? ['{"tools":[{"description":"captured HTTP definition","name":"echo"}]}']
                        : [],
                  input: {
                    messages: requestMessages(log.events, rec.index),
                    tools: [
                      { name: "echo", parameters: {}, description: rec.n === 1 ? "old" : "new" },
                    ],
                  },
                }
              : undefined;
          },
        },
      ],
      tools: () => [],
      rows: () => 40,
      onClose() {},
      requestRender() {},
    });
    recorded.showRequest(2, 3);
    const compared = recorded.render(100).map(stripAnsi).join("\n");
    expect(compared).toContain("Tool definitions: changed");
    expect(compared).toContain("Same message text prefix");
    expect(compared).toContain("Added since previous input");
    expect(compared).toContain("Cache hit: not reported");
    expect(compared).toContain("HTTP bytes: unknown");
    capturePrevious = true;
    const byteComparison = recorded.render(100).map(stripAnsi).join("\n");
    expect(byteComparison).toContain("HTTP bytes: changed · JSON structure: unchanged");
    capturePrevious = false;
    recorded.showRequest(1, 4);
    const savedDefinitions = recorded.render(100).map(stripAnsi).join("\n");
    expect(savedDefinitions).toContain("Definitions saved with this request's adapter input");
    expect(savedDefinitions).toContain("old");
    expect(savedDefinitions).not.toContain("回显文本");
    recorded.showRequest(2, 4);
    const capturedDefinitions = recorded.render(100).map(stripAnsi).join("\n");
    expect(capturedDefinitions).toContain("captured HTTP definition");
    expect(capturedDefinitions).not.toContain("adapter input");
    recorded.showRequest(2, 5);
    const capturedBody = recorded.render(100).map(stripAnsi).join("\n");
    expect(capturedBody).toContain("captured HTTP definition");
    expect(capturedBody).not.toContain("Reconstructed preview");
    log.append({
      type: "context/edit",
      at: "t",
      target: 1,
      field: "content",
      value: "changed question",
    });
    log.append({
      type: "request",
      at: "t",
      model: "fake",
      messages: 5,
      tools: [],
      estimatedTokens: 50,
      reason: "turn",
    });
    recorded.showRequest(3, 3);
    const edited = recorded.render(100).map(stripAnsi).join("\n");
    expect(edited).toContain("Changed tail from here");
    expect(edited).not.toContain("Added since previous input");
    expect(edited).toContain("context/edit");
  });
});
