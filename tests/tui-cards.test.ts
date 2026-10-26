// 界面:直印的对话流。完整 turn、结果可见度与折叠、思考、diff 预览、错误行、打断、
// 少见事件与流式思考、变化说明与缓存说明、文本小工具。
import { rmSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { cacheNote, changeNote, firstRunLines, messageMarks, thinkingLines } from "../cli/cards.js";
import type { ModelSettings } from "../cli/model-settings.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { brief, formatArgs, toolCallDetail } from "../cli/tui-format.js";
import { now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake-model",
    async complete(_m, _t, opts) {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      if (t.text && opts?.onDelta) opts.onDelta(t.text); // 模拟流式:整段作为一次增量
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

function boot(
  provider: Provider,
  settings?: ModelSettings,
): { app: TuiApp; term: VirtualTerminal; log: EventLog } {
  const term = new VirtualTerminal(100, 40);
  const log = new EventLog();
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-model", providerName: "fake", sessionFile: "sessions/t.jsonl" },
    ...(settings && { settings }),
    systemPrompt: "sys",
    onExit: () => {},
  });
  return { app, term, log };
}

const text = (app: TuiApp) => app.lines(100).map(stripAnsi).join("\n");

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");

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

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
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

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content, toolCalls: [] });

describe("屏幕:完整 turn、卡片、折叠、diff、错误、打断", () => {
  it("金额默认隐藏;主动开启后缺少任一轮用量也不显示不完整金额", async () => {
    const { app } = bootB(
      scriptedB([
        {
          text: "one",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1000, outputTokens: 10 },
        },
        { text: "two", toolCalls: [], stopReason: "end" },
      ]),
      { price: { input: 1, output: 1 } },
    );
    await app.submit("first");
    expect(doc(app)).not.toContain("cost est.");
    await app.command("/settings showCostEstimate on");
    expect(doc(app)).toContain("cost est. ≈$");
    await app.submit("second");
    expect(doc(app)).toContain("cost est. unavailable (missing usage)");
    app.stop();
  });

  it("一个完整 turn:用户消息、工具调用与结果、流式回复、状态栏全部呈现且不重复", async () => {
    const { app, term } = boot(
      scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
          stopReason: "tool",
        },
        {
          text: "**完成**:内容是 hi",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1200, outputTokens: 40 },
        },
      ]),
    );
    await app.submit("读一下");
    const doc = text(app);

    expect(doc).toContain("clarook");
    expect(doc).toContain("fake-model");
    expect(doc).toContain("› 读一下");
    expect(doc).toContain("» echo");
    expect(doc).toContain("✓ echo");
    expect(doc).toContain("echo:hi");
    expect(doc).toContain("完成");
    expect(doc.match(/内容是 hi/g)?.length).toBe(1); // 流式组件被定稿替换,不重复
    expect(doc).toContain("Context ~1.2k/100k");
    expect(doc).toContain("auto-compact ~");

    // 整条渲染管线:经差分渲染写入模拟终端后,屏幕上确实有内容
    app.tui.renderNow(true);
    const screen = (await term.screen()).join("\n");
    expect(screen).toContain("clarook");
    expect(screen).toContain("读一下");
    app.stop();
  });

  it("直印:请求用轻量编号分隔,没有响应卡;结果按可见度折叠,Ctrl+O 展开;思考一行,Ctrl+T 展开", async () => {
    const long = defineTool({
      name: "long",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join("\n");
      },
    });
    const term = new VirtualTerminal(100, 40);
    const log = new EventLog();
    const app = createTuiApp({
      terminal: term,
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "long", args: {} }],
          stopReason: "tool",
          reasoning: "先拿到输出\n再看结果",
          usage: { inputTokens: 1200, outputTokens: 20 },
        },
        {
          text: "好了",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1500, outputTokens: 5, cacheReadTokens: 1200 },
        },
      ]),
      tools: [long],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("跑");
    let doc = text(app);
    // 直印:正文里只有请求编号,没有响应卡、用量与费用;正常追加不印变化说明。
    expect(doc).toContain("› 跑");
    expect(doc).toContain("Request #1");
    expect(doc).toContain("Request #2");
    expect(doc).not.toContain("Response #");
    expect(doc).not.toContain("estimated");
    expect(doc).not.toContain("recomputed");
    expect(doc).toContain("» long");
    // 未知工具按 head:头行(└ ✓ 名字 行数)加前 5 行,尾行说明还有多少与怎么展开。
    expect(doc).toContain("└ ✓ long  10 lines");
    expect(doc).toContain("行1");
    expect(doc).toContain("行5");
    expect(doc).not.toContain("行10");
    expect(doc).toContain("… +5 lines · Ctrl+O");
    // 思考缺省折成一行:· 起头的淡斜体首句加行数;第二行不显示。
    expect(doc).toContain("· 先拿到输出");
    expect(doc).toContain("(2 lines · Ctrl+T)");
    expect(doc).not.toContain("再看结果");

    term.feed("\x0f"); // Ctrl+O
    doc = text(app);
    expect(doc).toContain("行10");
    expect(doc).not.toContain("+5 lines");
    expect(doc).toContain("· tool results unfolded");
    term.feed("\x0f");
    doc = text(app);
    expect(doc).not.toContain("行10");
    expect(doc).toContain("· tool results folded (Ctrl+O to unfold)");

    term.feed("\x14"); // Ctrl+T:展开全文
    doc = text(app);
    expect(doc).toContain("先拿到输出");
    expect(doc).toContain("再看结果");
    expect(doc).toContain("· thinking expanded");
    term.feed("\x14"); // 再按:收回一行
    doc = text(app);
    expect(doc).toContain("先拿到输出");
    expect(doc).not.toContain("再看结果");
    expect(doc).toContain("· thinking collapsed to one line (Ctrl+T)");
    expect(
      app
        .lines(60)
        .map(stripAnsi)
        .find((line) => line.includes("last cache")),
    ).toContain("last cache 80%");
    app.agent.setProvider(
      scripted([
        { text: "usage unavailable", toolCalls: [], stopReason: "end" },
        {
          text: "no cache hit",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
        },
      ]),
    );
    await app.submit("one");
    expect(text(app)).toContain("last cache n/a");
    await app.submit("two");
    expect(text(app)).toContain("last cache 0%");

    const control = "\x1b]52;c;dGVzdA==\x07\x1b[2J\x1b[H";
    const unknown = Array.from({ length: 25 }, (_, i) => `Unknown detail ${i + 1}`)
      .join("\n")
      .replace("Unknown detail 1\n", `Unknown detail 1${control}\n`);
    log.append({
      type: "tool/result",
      at: now(),
      callId: "unknown-call",
      name: "remote-change",
      content: unknown,
      isError: true,
      outcome: "unknown",
      durationMs: 1500,
    });
    expect(text(app)).toContain("result unknown");
    expect(text(app)).toContain("Unknown detail 20");
    expect(app.lines(100).join("\n")).not.toContain(control);
    expect(text(app)).not.toContain("Unknown detail 25");
    expect(text(app)).toContain("… +5 lines · Ctrl+O");
    term.feed("\x0f");
    expect(text(app)).toContain("Unknown detail 25");
    expect(app.lines(100).join("\n")).not.toContain(control);
    expect(text(app)).toContain("result unknown");
    expect(text(app)).toContain("/session recovery");
    term.feed("\x0f");
    expect(text(app)).not.toContain("Unknown detail 25");
    expect(log.events.at(-1)).toMatchObject({ content: unknown, outcome: "unknown" });

    app.stop();
  });

  it("edit 调用显示行级 diff,write 显示前几行与总行数", async () => {
    const control = "\x1b]52;c;dGVzdA==\x07\x1b[2J\x1b[H";
    const writeContent = Array.from({ length: 20 }, (_, i) => `L${i}`)
      .join("\n")
      .replace("L0\n", `L0${control}\n`);
    const { app, log } = boot(
      scripted([
        {
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "edit",
              args: { path: "a.ts", oldText: "x = 1\ny = 2", newText: "x = 1\ny = 3" },
            },
            {
              id: "c2",
              name: "write",
              args: {
                path: "b.txt",
                content: writeContent,
              },
            },
            { id: "c3", name: "bash", args: { command: `echo before${control}after` } },
          ],
          stopReason: "tool",
        },
        {
          text: `Reply before${control}after\r\nProgress 10%\rProgress 100%`,
          toolCalls: [],
          stopReason: "end",
        },
      ]),
    );
    await app.submit("改");
    const doc = text(app);
    expect(doc).toContain("- y = 2");
    expect(doc).toContain("+ y = 3");
    expect(doc).toContain("+ L0");
    expect(doc).toContain("… 20 lines total");
    expect(doc).not.toContain("+ L19");
    expect(doc).toContain("Reply beforeafter");
    expect(doc).toContain("Progress 10%");
    expect(doc).toContain("Progress 100%");
    expect(doc).not.toContain("Progress 10%Progress 100%");
    expect(app.lines(100).join("\n")).not.toContain(control);
    const assistant = log.events.find((event) => event.type === "assistant/message");
    if (assistant?.type !== "assistant/message") throw new Error("Missing assistant message");
    expect(assistant.toolCalls.find((call) => call.id === "c2")?.args).toEqual({
      path: "b.txt",
      content: writeContent,
    });
    expect(assistant.toolCalls.find((call) => call.id === "c3")?.args).toEqual({
      command: `echo before${control}after`,
    });
    expect(log.events.filter((event) => event.type === "assistant/message").at(-1)?.text).toContain(
      control,
    );
    app.stop();
  });

  it("请求失败保留错误和恢复入口,执行结束后仍可继续输入", async () => {
    let attempt = 0;
    const provider: Provider = {
      model: "fake-model",
      async complete(_messages, _tools, opts) {
        if (attempt++ === 0) {
          opts?.onReasoning?.("FAILED_THINKING\n");
          opts?.onReasoning?.("FAILED_TAIL");
          opts?.onDelta?.("FAILED_REPLY ");
          opts?.onDelta?.("LAST_FRAGMENT");
          throw new Error("网络断了");
        }
        opts?.onReasoning?.("NEW_THINKING");
        opts?.onDelta?.("NEW_REPLY");
        return { text: "NEW_REPLY", reasoning: "NEW_THINKING", toolCalls: [], stopReason: "end" };
      },
    };
    const { app, term, log } = boot(provider);
    try {
      await app.submit("x");
      let shown = text(app);
      expect(shown).toContain("✗ request #1 failed");
      expect(shown).toContain("网络断了");
      expect(shown).toContain("Request failed");
      expect(shown).toContain("/inspect raw");
      expect(shown).toContain("FAILED_REPLY LAST_FRAGMENT");
      expect(shown).toContain("Partial response");
      expect(app.agent.running).toBe(false);
      term.feed("\x14");
      expect(text(app)).toContain("FAILED_TAIL");
      await app.submit("continue after failure");
      shown = text(app);
      expect(shown.indexOf("FAILED_REPLY LAST_FRAGMENT")).toBeGreaterThan(-1);
      expect(shown.indexOf("FAILED_REPLY LAST_FRAGMENT")).toBeLessThan(
        shown.indexOf("continue after failure"),
      );
      expect(shown).toContain("FAILED_TAIL");
      expect(shown).toContain("NEW_REPLY");
      expect(shown).toContain("NEW_THINKING");
      expect(log.events.filter((event) => event.type === "assistant/message")).toMatchObject([
        { text: "NEW_REPLY", reasoning: "NEW_THINKING" },
      ]);
    } finally {
      app.stop();
    }
  });

  it("Esc 通过终端输入通道打断运行中的 turn", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete(_m, _t, opts) {
        await new Promise<void>((r) =>
          opts?.signal?.addEventListener("abort", () => r(), { once: true }),
        );
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const { app, term } = boot(provider);
    const running = app.submit("长任务");
    await new Promise((r) => setImmediate(r));
    expect(text(app)).toContain("Waiting for model");
    term.feed("\x1b[5;2~");
    expect(text(app)).toContain("Esc return live");
    term.feed("\x1b");
    expect(app.agent.running).toBe(true);
    expect(text(app)).not.toContain("step 1/1");
    term.feed("\x1b");
    await running;
    const doc = text(app);
    expect(doc).toContain("— interrupted —");
    expect(doc).toContain("Interrupted");
    expect(app.agent.running).toBe(false);
    app.stop();
  });
});

describe("少见事件与流式思考的渲染", () => {
  it("恢复日志与新事件正常呈现,停止界面后不再消费日志或迟到增量", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "s" });
    log.append({ type: "session/recovered", at: "", droppedBytes: 12, preview: "{" });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "server",
      payload: {
        server: "s1",
        phase: "ready",
        transport: "stdio",
        era: "modern",
        protocolVersion: "2026-07-28",
        toolCount: 2,
        listed: 3,
        ms: 7,
      },
    });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "rpc",
      payload: { server: "s1", direction: "send", bytes: 1, body: "{}" },
    });
    log.append({ type: "ext/event", at: "", source: "other", kind: "thing", payload: {} });
    log.append({ type: "session/slot", at: "", slot: "execution", value: "parallel" });
    log.append({
      type: "decision",
      at: "",
      slot: "termination",
      steps: 4,
      reason: "step limit 4 reached",
    });
    log.append({ type: "user/message", at: "", text: "inspect", images: [testImage] });
    log.append({
      type: "decision",
      at: "",
      slot: "compaction",
      reason: "no-gain",
      images: true,
    });
    const fresh = new EventLog();
    for (const e of log.events.filter((e) => e.type === "session/start" || e.type === "ext/event"))
      fresh.append(e);
    const starting = bootB(scriptedB([]), {}, fresh);
    expect(doc(starting.app)).not.toContain("resumed:");
    starting.app.stop();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, term } = bootB(
      {
        model: "m",
        async complete(_messages, _tools, opts) {
          started();
          await wait;
          opts?.onReasoning?.("late thinking after stop");
          opts?.onDelta?.("late reply after stop");
          return { text: "late reply after stop", toolCalls: [], stopReason: "end" };
        },
      },
      {
        info: { model: "m", providerName: "p", sessionFile: "s", resumed: true },
      },
      log,
    );
    const d = doc(app);
    expect(d).toContain("recovered: dropped 12 bytes");
    expect(d).toContain("mcp s1: ready · stdio · modern 2026-07-28 · 2 tools of 3 listed · 7ms");
    expect(d).toContain("· other/thing");
    expect(d).not.toContain("rpc");
    expect(d).toContain("stopped · step limit 4 reached · send to continue");
    expect(d).toContain("compact unchanged: candidate did not reduce text");
    expect(d).toContain("images kept, visual tokens unknown");
    expect(d).toContain("resumed: 9 events");
    log.append({ type: "user/message", at: "", text: "live before stop" });
    expect(doc(app)).toContain("live before stop");
    const pending = app.submit("run before stop");
    await ready;
    app.stop();
    const writes = term.raw.length;
    const titles = term.titles.length;
    log.append({ type: "user/message", at: "", text: "late after stop" });
    expect(doc(app)).not.toContain("late after stop");
    release();
    await pending;
    expect(doc(app)).not.toContain("late after stop");
    expect(doc(app)).not.toContain("late thinking after stop");
    expect(doc(app)).not.toContain("late reply after stop");
    expect(term.titles).toHaveLength(titles);
    expect(term.raw).toHaveLength(writes);
    expect(log.events.at(-1)).toMatchObject({
      type: "assistant/message",
      text: "late reply after stop",
    });
  });

  it("网络请求的重试按发生顺序显示在最终错误之前", () => {
    const control = "\x1b]52;c;dGVzdA==\x07\x1b[2J\x1b[H";
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "s" });
    log.append({ type: "user/message", at: "", text: "hi" });
    log.append({
      type: "request",
      at: "",
      model: "m",
      messages: 2,
      tools: [],
      estimatedTokens: 10,
      reason: "turn",
    });
    log.append({
      type: "retry",
      at: "",
      attempt: 1,
      delayMs: 500,
      error: `fetch failed${control}`,
    });
    log.append({ type: "request/error", at: "", error: `fetch failed${control}`, kind: "network" });
    log.append({
      type: "ext/event",
      at: "",
      source: "skills",
      kind: "load-error",
      payload: { message: `Skill load failed${control}` },
    });
    const { app } = bootB(scriptedB([]), {}, log);
    const failed = doc(app);
    expect(failed.indexOf("retry 1:")).toBeLessThan(failed.indexOf("request #1 failed"));
    expect(failed).toContain("Skill load failed");
    expect(app.lines(120).join("\n")).not.toContain("\x1b]52;");
    expect(app.lines(120).join("\n")).not.toContain("\x1b[2J");
    app.stop();
  });

  it("流式思考:定稿带思考时保留节点并可 Ctrl+T 展开;定稿无思考时撤掉节点;task 调用留槽", async () => {
    let step = 0;
    let continueStep!: () => void;
    let firstStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      continueStep = resolve;
    });
    const { app, term, log } = bootB({
      model: "m",
      async complete(_messages, _tools, opts) {
        if (step++ > 0) {
          opts?.onReasoning?.("discarded thinking\n");
          opts?.onReasoning?.("discarded tail");
          return { text: "final", toolCalls: [], stopReason: "end", reasoning: "" };
        }
        opts?.onReasoning?.("thinking\n");
        opts?.onReasoning?.("hard about it");
        opts?.onDelta?.("reply ");
        opts?.onDelta?.("in progress");
        firstStarted();
        await paused;
        opts?.onReasoning?.("\nFINAL_REASONING");
        opts?.onDelta?.("LATE_DRAFT");
        return {
          text: "first reply",
          toolCalls: [{ id: "t1", name: "task", args: { task: "sub job" } }],
          stopReason: "tool",
          reasoning: "thinking\nhard about it\nFINAL_REASONING",
          reasoningKind: "full",
        };
      },
    });
    const running = app.submit("go");
    await ready;
    expect(doc(app)).toContain("thinking");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(doc(app)).toContain("reply in progress");
    term.feed("\x14");
    expect(doc(app)).toContain("hard about it");
    continueStep();
    await running;
    let d = doc(app);
    expect(d).toContain("thinking");
    expect(d).toContain("» task");
    term.feed("\x14");
    term.feed("\x14");
    d = doc(app);
    expect(d).toContain("hard about it");
    expect(d).toContain("FINAL_REASONING");
    expect(d).toContain("first reply");
    expect(d).toContain("final");
    expect(d).not.toContain("LATE_DRAFT");
    expect(d).not.toContain("discarded thinking");
    expect(log.events.find((event) => event.type === "assistant/message")).toMatchObject({
      reasoning: "thinking\nhard about it\nFINAL_REASONING",
      text: "first reply",
    });
    app.stop();
  });
});

describe("变化说明与缓存说明", () => {
  it("只在有事时印:编辑、压缩、前缀重算、摘要请求、假设的窗口;第一次请求与正常追加不印", () => {
    const prev = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
    const cur = [
      ...prev,
      { ...assistant("d2"), edited: true as const },
      user("f"),
      { ...user("[summary]"), edited: true as const },
    ];
    const provenance = cur.map((_, i) => ({
      event: i + 1,
      stages: i === 5 ? ["edited:text"] : i === 7 ? ["summary(covers #1–#3)"] : [],
    }));
    expect(messageMarks(cur, prev, provenance).map((r) => r.state)).toEqual([
      "same",
      "same",
      "same",
      "same",
      "same",
      "edited",
      "new",
      "summary",
    ]);
    const request = {
      type: "request" as const,
      at: now(),
      model: "m",
      reason: "turn" as const,
      messages: cur.length,
      tools: [],
      estimatedTokens: 40,
      threshold: 1000,
    };
    const note = (input: Parameters<typeof changeNote>[0]) => plain(changeNote(input) ?? "");
    // 编辑与压缩同时在:写明编辑和摘要,相同文本估算不冒充缓存上限。
    const changed = note({ n: 2, request, messages: cur, previous: prev, provenance });
    expect(changed.startsWith("✎ ")).toBe(true);
    expect(changed).toContain("1 edited (#6)");
    expect(changed).toContain("compacted · 1 summary");
    expect(changed).toContain("→ 3 after prefix");
    expect(changed).toMatch(/unchanged ≈\S+ tok/);
    // 第一次请求、正常追加:不印。
    expect(changeNote({ n: 1, request, messages: cur })).toBeUndefined();
    expect(
      changeNote({ n: 2, request, messages: [...prev, user("f")], previous: prev }),
    ).toBeUndefined();
    // 上次发过的消息没了(丢弃、回退):前缀重算,≈ 起头。
    const broke = note({ n: 2, request, messages: prev.slice(0, 3), previous: prev });
    expect(broke.startsWith("≈ ")).toBe(true);
    expect(broke).toContain("prefix recomputed from #4");
    // 摘要请求与溢出重发各一行;第一次请求时窗口是假设值多一行 ?。
    expect(note({ n: 3, request: { ...request, reason: "compaction" }, messages: cur })).toContain(
      "summary request · 8 messages",
    );
    expect(
      note({ n: 3, request: { ...request, reason: "overflow-retry" }, messages: cur }),
    ).toContain("overflow retry");
    const assumed = note({
      n: 1,
      request,
      messages: cur,
      limitSource: "assumed",
      contextWindow: 65536,
    });
    expect(assumed.startsWith("? ")).toBe(true);
    expect(assumed).toContain("context window assumed 64k");
    expect(
      changeNote({ n: 2, request, messages: cur, limitSource: "assumed", contextWindow: 65536 }),
    ).toBeUndefined();
  });

  it("缓存说明:命中率低于一半才印;预计太少或供应商不报命中时不评判", () => {
    const low = plain(
      cacheNote({ inputTokens: 4000, outputTokens: 5, cacheReadTokens: 400 }, 3000) ?? "",
    );
    expect(low.startsWith("≈ cache hit 10%")).toBe(true);
    expect(low).toContain("unchanged text ≈3.0k tok");
    expect(
      cacheNote({ inputTokens: 4000, outputTokens: 5, cacheReadTokens: 3000 }, 3000),
    ).toBeUndefined();
    expect(
      cacheNote({ inputTokens: 4000, outputTokens: 5, cacheReadTokens: 0 }, 500),
    ).toBeUndefined();
    expect(cacheNote({ inputTokens: 4000, outputTokens: 5 }, 3000)).toBeUndefined();
  });

  it("思考缺省一行,展开后逐行;首屏五个动词", () => {
    const collapsed = plain(thinkingLines("line one\nline two", "full", false).join("\n"));
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed.startsWith("· ")).toBe(true);
    expect(collapsed).toContain("line one");
    expect(collapsed).toContain("(2 lines · Ctrl+T)");
    expect(plain(thinkingLines("one line only", "full", false).join("\n"))).not.toContain("Ctrl+T");
    const expanded = plain(thinkingLines("line one\nline two", "summary", true).join("\n"));
    expect(expanded).toContain("summary · the model reads the opaque block");
    expect(expanded).toContain("line two");
    const first = plain(firstRunLines().join("\n"));
    expect(first).toContain("Ask anything");
    expect(first).toContain("/help");
  });
});

describe("文本小工具", () => {
  it("formatArgs 的四种形态与截断;brief;toolCallDetail 的 write 长文与超长 diff", () => {
    expect(formatArgs({ command: "ls -la" })).toBe("ls -la");
    // 路径带 OSC 8 链接;剥掉序列后是人读的形态
    expect(stripAnsi(formatArgs({ path: "a.ts", offset: 5, limit: 3 }))).toBe(
      "a.ts  from line 5, 3 lines",
    );
    expect(stripAnsi(formatArgs({ path: "a.ts", limit: 3 }))).toBe("a.ts  from line 1, 3 lines");
    expect(formatArgs({ task: `${"x".repeat(30)}\nmore`, scope: "fork" })).toBe(
      `scope=fork  ${"x".repeat(24)}…`,
    );
    expect(formatArgs({ other: "y".repeat(200) }).endsWith("…")).toBe(true);
    expect(formatArgs(undefined)).toBe("");
    expect(brief("short")).toBe("short");
    const write = plain(
      toolCallDetail("write", {
        content: Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n"),
      }),
    );
    expect(write).toContain("+ l11");
    expect(write).not.toContain("+ l12");
    expect(write).toContain("… 15 lines total");
    const oldText = Array.from({ length: 70 }, (_, i) => `a${i}`).join("\n");
    const newText = Array.from({ length: 70 }, (_, i) => `b${i}`).join("\n");
    const big = plain(toolCallDetail("edit", { oldText, newText }));
    expect(big).toContain("more changed lines");
    expect(toolCallDetail("bash", { command: "x" })).toBe("");
  });
});
