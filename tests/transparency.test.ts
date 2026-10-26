import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyBrowser } from "../cli/body-browser.js";
import { resultLines } from "../cli/cards.js";
import { inputBlocks, receivedBlocks } from "../cli/inspector-bodies.js";
import { collectRequests, eventLines, toolLines, wireLines } from "../cli/inspector-requests.js";
import { readRequestRecording } from "../cli/session-records.js";
import { ReplyMarkdown } from "../cli/tui-render.js";
import { clearToolResults, keepRecentTokens, llmSummarize } from "../src/compaction.js";
import { DEFAULT_COMPACTION_SETTINGS, summaryPrompt } from "../src/compaction-presets.js";
import type { AgentEvent } from "../src/events.js";
import { exchangeRecorder } from "../src/exchange.js";
import { EventLog } from "../src/log.js";
import { describeRequestBody, maxSteps, recordingProvider, runTurn } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { anthropic } from "../src/providers/anthropic.js";
import { ProviderError } from "../src/providers/errors.js";
import { recordedFetch } from "../src/providers/http.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { openaiResponses } from "../src/providers/openai-responses.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function scripted(
  turns: AssistantTurn[],
  hook?: (opts: Parameters<Provider["complete"]>[2]) => void,
): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete(_m, _t, opts) {
      hook?.(opts);
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

function fresh(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  log.append({ type: "user/message", at: "t", text: "hi" });
  return log;
}

const types = (log: EventLog) => log.events.map((e) => e.type);

describe("请求层记录", () => {
  it("每次请求先落 request 事件:规模、工具、估算、阈值;响应带耗时", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
    });
    expect(types(log)).toEqual([
      "session/start",
      "user/message",
      "request",
      "assistant/message",
      "tool/result",
      "request",
      "assistant/message",
    ]);
    const req = log.events[2];
    if (req?.type !== "request") throw new Error("应为 request");
    expect(req.model).toBe("fake");
    expect(req.messages).toBe(2);
    expect(req.tools).toEqual(["echo"]);
    expect(req.estimatedTokens).toBeGreaterThan(0);
    expect(req.threshold).toBe(80000);
    expect(req.reason).toBe("turn");
    const second = log.events[5];
    if (second?.type !== "request") throw new Error("应为 request");
    expect(second.messages).toBe(4);
    const resp = log.events[3];
    if (resp?.type !== "assistant/message") throw new Error("应为 assistant/message");
    expect(typeof resp.latencyMs).toBe("number");
  });

  it("工具结果按请求显示,拒绝与校验失败没有原文附件也不能遗漏", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "a" } },
            { id: "c2", name: "nope", args: {} },
            { id: "c3", name: "echo", args: { text: "denied" } },
            { id: "c4", name: "echo", args: {} },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo],
      slots: {
        approve: async (call) =>
          call.id === "c3" ? { allowed: false, reason: "Run tests first" } : true,
      },
    });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results[0] && "durationMs" in results[0] && typeof results[0].durationMs).toBe("number");
    expect(results[1] && "durationMs" in results[1]).toBe(false);
    expect(results).toHaveLength(4);
    expect(results[2]?.content).toBe("The user denied this call: Run tests first");
    expect(results[3]?.isError).toBe(true);
    const records = collectRequests(log.events);
    const first = records[0];
    if (!first) throw new Error("missing request");
    const displayed = receivedBlocks(first).filter((block) => block.id.startsWith("model-"));
    expect(displayed.map((block) => block.lines().join("\n"))).toEqual(
      results.map((result) => result.content),
    );
    expect(displayed.map((block) => block.meta)).toEqual([
      expect.stringContaining("c1 · success"),
      expect.stringContaining("c2 · error"),
      expect.stringContaining("c3 · error"),
      expect.stringContaining("c4 · error"),
    ]);
    expect(records[1]?.results).toEqual([]);
    const captured = receivedBlocks(first, {
      bodies: [],
      outputs: [
        {
          callId: "c1",
          name: "echo",
          original: "full output",
          state: "result recorded",
          source: "original output",
        },
      ],
      error: "Original attachment unavailable",
    });
    expect(captured.filter((block) => block.id.startsWith("model-"))).toHaveLength(4);
    expect(captured.filter((block) => block.id.startsWith("original-"))).toHaveLength(1);
    expect(captured.findIndex((block) => block.id === "original-c1") + 1).toBe(
      captured.findIndex((block) => block.id === "model-c1"),
    );
    expect(
      captured.filter((block) => /^(call|original|model)-/.test(block.id)).map((block) => block.id),
    ).toEqual([
      "call-c1",
      "original-c1",
      "model-c1",
      "call-c2",
      "model-c2",
      "call-c3",
      "model-c3",
      "call-c4",
      "model-c4",
    ]);
    expect(captured[0]?.title).toBe("Recording unavailable or damaged");
    // 分组只用于显示。同一文件的两次调用不能合并,折叠也不能删改完整参数。
    if (!first.response) throw new Error("Expected a recorded response");
    const path = "/project/alpha/settings.json";
    const grouped = receivedBlocks({
      ...first,
      response: {
        ...first.response,
        toolCalls: ["c1", "c2"].map((id) => ({ id, name: "read", args: { path } })),
      },
      results: first.results.slice(0, 2),
    });
    const argumentsBlocks = grouped.filter((block) => block.id.startsWith("call-"));
    expect(argumentsBlocks.map((block) => block.group?.id)).toEqual(["c1", "c2"]);
    expect(argumentsBlocks.map((block) => block.lines().join("\n"))).toEqual([
      JSON.stringify({ path }, null, 2),
      JSON.stringify({ path }, null, 2),
    ]);
    expect(argumentsBlocks.every((block) => !block.preview.includes(path))).toBe(true);
    const groupedBrowser = new BodyBrowser();
    groupedBrowser.set("grouped", grouped);
    const folded = groupedBrowser.render(60);
    expect(folded.context).toContain("alpha/settings.json");
    expect(
      folded.lines.map(stripAnsi).filter((line) => line.trim() === "read · alpha/settings.json"),
    ).toHaveLength(2);
    groupedBrowser.handleInput("\r");
    expect(groupedBrowser.render(60).lines.map(stripAnsi).join("\n")).toContain(path);
    groupedBrowser.handleInput("\x1b[B");
    expect(groupedBrowser.render(60).context).toContain("alpha/settings.json");
    expect(deriveMessages(log.events).filter((message) => message.role === "tool")).toHaveLength(4);
    const partial = receivedBlocks({ ...first, results: first.results.slice(1) });
    expect(partial.find((block) => block.id === "call-c1")?.meta).toContain("result not recorded");
    // 长调用ID不能挤掉当前最重要的缺失说明;不把缺失推断为仍在运行。
    if (!first.response) throw new Error("Expected a recorded response");
    const missing = receivedBlocks({
      ...first,
      response: {
        ...first.response,
        toolCalls: [{ id: `call_${"long".repeat(12)}`, name: "echo", args: { text: "a" } }],
      },
      results: [],
    });
    const browser = new BodyBrowser();
    browser.set("missing", missing);
    const narrow = browser.render(32).lines.map(stripAnsi).join("\n");
    expect(narrow).toContain("result not recorded");
    expect(narrow).not.toContain("running");
    expect(partial.some((block) => block.id === "model-c1")).toBe(false);
    // 未匹配结果不能丢失,且未知状态优先于成功标记。
    const unknown = receivedBlocks({
      ...first,
      results: [
        ...first.results,
        {
          type: "tool/result",
          at: "t",
          callId: "unmatched",
          name: "echo",
          content: "Check external state",
          isError: false,
          outcome: "unknown",
        },
      ],
    });
    const unknownBlock = unknown.find((block) => block.id === "model-unmatched");
    expect(unknownBlock?.title).toContain("outcome unknown");
    expect(unknownBlock?.lines()).toEqual(["Check external state"]);
    // 文件预览来自请求参数,失败与未知不能冒充已修改;展开不改原文或模型输入。
    const calls = [
      {
        id: "edit-ok",
        name: "edit",
        args: {
          path,
          oldText: Array.from({ length: 70 }, (_, i) => `old-${i}`).join("\n"),
          newText: Array.from({ length: 70 }, (_, i) => `new-${i}`).join("\n"),
          replaceAll: true,
        },
      },
      { id: "write-failed", name: "write", args: { path, content: "" } },
      { id: "edit-unknown", name: "edit", args: { path, oldText: "a", newText: "b" } },
      { id: "edit-missing", name: "edit", args: { path, oldText: "x", newText: "y" } },
    ];
    const fileRecord = {
      ...first,
      response: { ...first.response, toolCalls: calls },
      results: calls.slice(0, 3).map((call, i) => ({
        type: "tool/result" as const,
        at: "t",
        callId: call.id,
        name: call.name,
        content: i === 1 ? "Permission denied" : "Recorded result",
        isError: i === 1,
        ...(i === 2 && { outcome: "unknown" as const }),
      })),
    };
    const before = JSON.stringify(fileRecord);
    const messagesBefore = JSON.stringify(deriveMessages(log.events));
    const fileBlocks = receivedBlocks(fileRecord);
    const previews = fileBlocks.filter((block) => block.id.startsWith("change-"));
    expect(previews.map((block) => block.title)).toEqual([
      "Requested replacement · success",
      "Submitted file content · error",
      "Requested replacement · outcome unknown",
      "Requested replacement · result not recorded",
    ]);
    expect(previews[0]?.meta).toContain("all occurrences requested");
    expect(previews[1]?.meta).toContain("Previous file content not recorded");
    expect(previews[0]?.lines().map(stripAnsi).join("\n")).toContain("+ new-69");
    expect(previews[1]?.lines().map(stripAnsi)).toEqual(["+ "]);
    const fileBrowser = new BodyBrowser();
    fileBrowser.set("files", fileBlocks);
    fileBrowser.handleInput("\x1b[B");
    fileBrowser.handleInput("\r");
    expect(fileBrowser.render(60).lines.map(stripAnsi).join("\n")).toContain("+ new-69");
    expect(
      fileBlocks
        .find((block) => block.id === "call-edit-ok")
        ?.lines()
        .join("\n"),
    ).toBe(JSON.stringify(calls[0]?.args, null, 2));
    expect(JSON.stringify(fileRecord)).toBe(before);
    expect(JSON.stringify(deriveMessages(log.events))).toBe(messagesBefore);
  });

  it("未配置压缩时 request 不带阈值", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      tools: [],
    });
    const req = log.events.find((e) => e.type === "request");
    expect(req && "threshold" in req).toBe(false);
  });

  it("provider 的每次重试都记 retry 事件,带状态码", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }], (opts) => {
        opts?.onRetry?.({
          attempt: 1,
          delayMs: 120,
          error: new ProviderError("provider 429: slow down", { status: 429 }),
        });
      }),
      tools: [],
    });
    expect(types(log)).toEqual([
      "session/start",
      "user/message",
      "request",
      "retry",
      "assistant/message",
    ]);
    const retry = log.events[3];
    if (retry?.type !== "retry") throw new Error("应为 retry");
    expect(retry.attempt).toBe(1);
    expect(retry.delayMs).toBe(120);
    expect(retry.status).toBe(429);
    expect(retry.error).toContain("slow down");
  });

  it("请求最终失败记 request/error 后再抛出", async () => {
    const failure = new ProviderError("provider 500: boom", { status: 500 });
    let calls = 0;
    const provider: Provider = {
      model: "fake",
      async complete() {
        calls++;
        throw failure;
      },
    };
    for (const reason of ["turn", "compaction"] as const) {
      const log = fresh();
      const result =
        reason === "turn"
          ? runTurn({ log, provider, tools: [] })
          : recordingProvider(log, provider).complete(deriveMessages(log.events), []);
      await expect(result).rejects.toBe(failure);
      expect(types(log)).toEqual(["session/start", "user/message", "request", "request/error"]);
      expect(log.events[2]).toMatchObject({ type: "request", reason });
      const err = log.events[3];
      if (err?.type !== "request/error") throw new Error("应为 request/error");
      expect(err.status).toBe(500);
    }
    expect(calls).toBe(2);
  });

  it("插话注入先落 steering 决策,再落留言;终止叫停落 termination 决策", async () => {
    const log = fresh();
    let drained = false;
    await runTurn({
      log,
      provider: scripted([
        { text: "a", toolCalls: [], stopReason: "end" },
        { text: "b", toolCalls: [], stopReason: "end" },
      ]),
      tools: [],
      drainQueue: () => {
        if (drained) return [];
        drained = true;
        return ["插话"];
      },
    });
    const i = log.events.findIndex((e) => e.type === "decision");
    const d = log.events[i];
    if (d?.type !== "decision" || d.slot !== "steering") throw new Error("应为 steering 决策");
    expect(d.boundary).toBe("step");
    expect(d.injected).toBe(1);
    expect(log.events[i + 1]).toMatchObject({ type: "user/message", text: "插话" });

    const log2 = fresh();
    const out = await runTurn({
      log: log2,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }],
          stopReason: "tool",
        },
      ]),
      tools: [echo],
      slots: { termination: maxSteps(1) },
    });
    expect(out).toEqual({ stopped: "step limit 1 reached" });
    const last = log2.events.at(-1);
    expect(last).toMatchObject({ type: "decision", slot: "termination", steps: 1 });
  });

  it("这些事件全部只给人看:投影不受影响", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }], (opts) => {
        opts?.onRetry?.({ attempt: 1, delayMs: 1, error: new Error("x") });
      }),
      tools: [],
      slots: { termination: maxSteps(5) },
    });
    const messages = deriveMessages(log.events);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("collectRequests 按请求切段:重试归入请求,压缩归入下一请求的 before,失败与溢出重发分开", () => {
    const at = "t";
    const events: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "s" },
      { type: "user/message", at, text: "u" },
      {
        type: "request",
        at,
        model: "m",
        messages: 2,
        tools: [],
        estimatedTokens: 10,
        reason: "turn",
      },
      { type: "retry", at, attempt: 1, delayMs: 5, error: "429" },
      { type: "assistant/message", at, text: "a", toolCalls: [], stopReason: "end", latencyMs: 3 },
      { type: "user/message", at, text: "u2" },
      {
        type: "request",
        at,
        model: "m",
        messages: 4,
        tools: [],
        estimatedTokens: 99999,
        reason: "turn",
      },
      { type: "request/error", at, error: "context length exceeded", status: 400 },
      { type: "compaction", at, summary: "S", coversFrom: 1, coversUpTo: 5 },
      {
        type: "request",
        at,
        model: "m",
        messages: 3,
        tools: [],
        estimatedTokens: 50,
        reason: "overflow-retry",
      },
      { type: "assistant/message", at, text: "b", toolCalls: [], stopReason: "end" },
    ];
    const recs = collectRequests(events);
    expect(recs.map((r) => r.n)).toEqual([1, 2, 3]);
    const [a, b, c] = recs;
    if (!a || !b || !c) throw new Error("应有三条");
    expect(a.retries).toHaveLength(1);
    expect(a.response?.text).toBe("a");
    expect(b.error?.status).toBe(400);
    expect(b.response).toBeUndefined();
    expect(c.request.reason).toBe("overflow-retry");
    expect(c.before.map((e) => e.type)).toEqual(["compaction"]);
    expect(c.response?.text).toBe("b");
  });
});

describe("策略请求的真实正文与策略名", () => {
  it("describeRequestBody:正常步 tail 为空;摘要请求 = 前缀投影 + 指示消息", () => {
    const log = fresh();
    log.append({ type: "assistant/message", at: "t", text: "a", toolCalls: [], stopReason: "end" });
    const plain = deriveMessages(log.events);
    expect(describeRequestBody(log.events, plain)).toEqual({ prefixEvents: 3, tail: [] });

    const withInstruction = [
      ...deriveMessages(log.events.slice(0, 2)),
      { role: "user" as const, content: "请压缩" },
    ];
    expect(describeRequestBody(log.events, withInstruction)).toEqual({
      prefixEvents: 2,
      tail: [{ role: "user", content: "请压缩" }],
    });

    const standalone = [
      { role: "system" as const, content: "You are a conversation compaction assistant." },
      { role: "user" as const, content: "全文…" },
    ];
    expect(describeRequestBody(log.events, standalone)).toEqual({
      prefixEvents: 0,
      tail: standalone,
    });
  });

  it("recordingProvider 把摘要请求的真实正文记进 request.body;压缩事件带策略名", async () => {
    const log = fresh();
    log.append({
      type: "assistant/message",
      at: "t",
      text: "",
      toolCalls: [{ id: "c1", name: "big", args: {} }],
      stopReason: "tool",
    });
    log.append({
      type: "tool/result",
      at: "t",
      callId: "c1",
      name: "big",
      content: "x".repeat(4000),
      isError: false,
    });
    log.append({
      type: "assistant/message",
      at: "t",
      text: "ok",
      toolCalls: [],
      stopReason: "end",
    });
    const captured: string[] = [];
    const summarizer: Provider = {
      model: "fake",
      async complete(messages, _tools, opts) {
        opts?.onRequest?.(JSON.stringify(messages));
        return {
          text: "摘要正文",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 900, outputTokens: 10 },
        };
      },
    };
    const strategy = llmSummarize();
    const payload = await strategy({
      events: log.events,
      window: 100000,
      targetTokens: 50,
      provider: recordingProvider(log, summarizer, { onRequest: (body) => captured.push(body) }),
      preservation: keepRecentTokens(10),
    });
    expect(payload?.strategy).toBe("llmSummarize(pi, replay)");
    const req = log.events.find((e) => e.type === "request");
    if (req?.type !== "request") throw new Error("应记 request");
    expect(req.reason).toBe("compaction");
    expect(req.maxTokens).toBe(DEFAULT_COMPACTION_SETTINGS.compactionMaxTokens);
    const body = req.body;
    if (!body) throw new Error("应记 body");
    expect(body.tail).toHaveLength(1);
    expect(body.tail[0]?.role).toBe("user");
    expect((body.tail[0] as { content: string }).content).toBe(summaryPrompt("pi"));
    expect(body.prefixEvents).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0] ?? "[]").at(-1)).toEqual(body.tail[0]);

    const cleared = await clearToolResults({ keepRecent: 0, clearAtLeast: 1 })({
      events: log.events,
      window: 1,
      targetTokens: 1,
    });
    expect(cleared?.strategy).toBe("clearToolResults(keepRecent=0, clearAtLeast=1)");
  });
});

describe("wire 层与实际发送一致", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("openaiCompat.wire() 与 fetch 收到的正文逐字节相同;onRaw 收到每一行", async () => {
    // 显示确实会清理协议,但原文和三种协议实际发出的消息不能继承显示处理。
    const controls = "中文\t\x1b[31mred\x1b[0m\r\nprogress\rnext\x1b[2J\u009b31m · literal \\u001b";
    const userInput = `user: ${controls}`;
    const assistantInput = `assistant: ${controls}`;
    const toolInput = `tool: ${controls}`;
    let sentBody = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      const sse = [
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const p = openaiCompat({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      reasoningField: "reasoning_content",
    });
    const events: AgentEvent[] = [
      { type: "session/start", at: "t", model: "m", system: "sys" },
      { type: "user/message", at: "t", text: userInput, images: [testImage] },
      {
        type: "assistant/message",
        at: "t",
        text: assistantInput,
        toolCalls: [{ id: "history-call", name: "echo", args: { text: userInput } }],
        stopReason: "tool",
      },
      {
        type: "tool/result",
        at: "t",
        name: "echo",
        callId: "history-call",
        content: toolInput,
        isError: false,
      },
    ];
    const messages = deriveMessages(events);
    const originalMessages = JSON.stringify(messages);
    const display = new ReplyMarkdown(assistantInput).render(80).join("\n");
    expect(display).not.toContain("\x1b[2J");
    resultLines(
      { name: "echo", content: toolInput, isError: false },
      { folded: false, head: 10, view: "all" },
    );
    const inspected = inputBlocks(messages)
      .flatMap((block) => block.lines())
      .join("\n");
    expect(inspected).toContain("\\u009b31m");
    expect(inspected).toContain("\\u000d");
    expect(inspected).not.toContain("\u009b");
    expect(JSON.stringify(messages)).toBe(originalMessages);
    const tools = [{ name: "echo", description: controls, parameters: { type: "object" } }];
    const body = JSON.stringify(p.wire?.(messages, tools));
    for (const lines of [
      wireLines(p, messages, tools),
      wireLines(p, messages, tools, undefined, { bodies: [body], outputs: [] }),
      toolLines(tools),
      toolLines(tools, undefined, { bodies: [body], outputs: [] }),
      eventLines(events, 2),
    ]) {
      expect(lines.join("\n")).toContain("\\u009b31m");
      expect(lines.join("\n")).not.toContain("\u009b");
    }
    const raw: string[] = [];
    const captured: string[] = [];
    const turn = await p.complete(messages, tools, {
      onRaw: (l) => raw.push(l),
      onRequest: (body) => captured.push(body),
    });
    expect(turn.text).toBe("hi");
    expect(JSON.parse(sentBody)).toEqual(p.wire?.(messages, tools));
    expect(sentBody).toBe(JSON.stringify(p.wire?.(messages, tools)));
    expect(JSON.parse(sentBody).messages[1].content[0].text).toBe(userInput);
    expect(JSON.parse(sentBody).messages[2].content).toBe(assistantInput);
    expect(JSON.parse(sentBody).messages[3].content).toBe(toolInput);
    expect(raw).toHaveLength(3);
    expect(raw[2]).toBe("data: [DONE]");
    expect(captured).toEqual([sentBody]);
    // 三个独立适配器都必须在每次重试边界记录实际序列化正文。
    for (const create of [openaiCompat, anthropic, openaiResponses]) {
      const outputKey =
        create === openaiResponses
          ? "max_output_tokens"
          : create === anthropic
            ? "max_tokens"
            : "max_completion_tokens";
      const sent: string[] = [];
      const captures: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push(String(init.body));
        if (sent.length === 1) return new Response("retry".repeat(2000), { status: 503 });
        const event = url.endsWith("/responses")
          ? { type: "response.completed", response: { status: "completed" } }
          : url.endsWith("/v1/messages")
            ? {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 0 },
              }
            : { choices: [{ delta: {}, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
      });
      const provider = create({
        apiKey: "fixture-auth-token",
        model: "m",
        baseUrl: "http://fixture",
        maxTokens: 2000,
        extraBody: { [outputKey]: 4000, ...(create === openaiCompat && { max_tokens: 6000 }) },
        retry: { maxRetries: 1, sleep: async () => {} },
      });
      const dir = mkdtempSync(join(tmpdir(), "clarook-http-record-"));
      try {
        const file = join(dir, "s.jsonl");
        const log = new EventLog(file);
        const retries: number[] = [];
        await recordingProvider(log, provider).complete(messages, tools, {
          maxTokens: 321,
          onRequest: (body) => captures.push(body),
          onRetry: (info) => retries.push(info.attempt),
        });
        const events = EventLog.load(file).events;
        const saved = readRequestRecording(file, events, 0);
        expect(events[0]).toMatchObject({ type: "request", reason: "compaction", maxTokens: 321 });
        expect(events.filter((e) => e.type === "retry")).toEqual([
          expect.objectContaining({ attempt: 1, status: 503 }),
        ]);
        expect(retries).toEqual([1]);
        expect(
          events.some((e) => e.type === "assistant/message" || e.type === "request/error"),
        ).toBe(false);
        expect(saved?.input).toEqual({ messages, tools });
        expect(saved?.bodies).toEqual(sent);
        const wire = JSON.parse(sent[1] ?? "{}");
        expect(wire[outputKey]).toBe(321);
        if (create === openaiCompat) expect(wire.max_tokens).toBeUndefined();
        const reconstructed = stripAnsi(
          wireLines(provider, messages, tools, undefined, undefined, [], 321).join("\n"),
        );
        expect(reconstructed).toContain(`"${outputKey}": 321`);
        // 协议结构可以不同,每一条正文的字符必须保持原样,不能用 UI 文本替换。
        for (const text of [userInput, assistantInput, toolInput])
          expect(JSON.stringify(wire)).toContain(JSON.stringify(text));
        expect(JSON.stringify(messages)).toBe(originalMessages);
        if (create === anthropic)
          expect(wire.messages[0].content).toContainEqual(
            expect.objectContaining({
              type: "image",
              source: { type: "base64", media_type: "image/png", data: testImage.data },
            }),
          );
        else if (create === openaiResponses)
          expect(wire.input[0].content).toContainEqual({
            type: "input_image",
            image_url: `data:image/png;base64,${testImage.data}`,
            detail: "auto",
          });
        else
          expect(wire.messages[1].content).toContainEqual({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${testImage.data}` },
          });
        expect(saved?.attempts?.map((a) => [a.status, a.state])).toEqual([
          [503, "complete"],
          [200, "complete"],
        ]);
        expect(saved?.attempts?.[0]?.response).toBe("retry".repeat(2000));
        expect(saved?.attempts?.[1]?.response.endsWith("\n\n")).toBe(true);
        expect(saved?.bodies.join("\n")).not.toContain("fixture-auth-token");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(captures).toEqual(sent);
      expect(captures).toHaveLength(2);
      expect(captures[0]).toBe(
        JSON.stringify(provider.wire?.(messages, tools, { maxTokens: 321 })),
      );
      expect(captures.join("\n")).not.toContain("fixture-auth-token");
      await provider.complete(messages, tools);
      expect(JSON.parse(sent[2] ?? "{}")[outputKey]).toBe(4000);
      expect(sent[2]).toBe(JSON.stringify(provider.wire?.(messages, tools)));
    }
  });

  it("响应中断、主动取消和协议解析失败都保存已收到的原文并关闭流", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-partial-record-"));
    try {
      for (const mode of ["network", "cancel", "malformed", "saving"] as const) {
        let pulls = 0;
        let canceled = false;
        const text =
          mode === "saving"
            ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            : "data: invalid-json 中文\n\n";
        vi.stubGlobal(
          "fetch",
          async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (!pulls++) controller.enqueue(new TextEncoder().encode(text));
                    else if (mode === "network") controller.error(new Error("connection lost"));
                    else if (mode === "saving") controller.close();
                  },
                  cancel() {
                    canceled = true;
                  },
                },
                { highWaterMark: 0 },
              ),
              { status: 200 },
            ),
        );
        const file = join(dir, `${mode}.jsonl`);
        const log = new EventLog(file);
        const record = exchangeRecorder(log, 0);
        if (!record) throw new Error("missing recorder");
        if (mode === "malformed" || mode === "saving") {
          const provider = openaiCompat({
            baseUrl: "http://fixture",
            apiKey: "fixture",
            model: "m",
            retry: { maxRetries: 0 },
            stallTimeoutMs: 10,
          });
          if (mode === "malformed")
            await expect(provider.complete([], [], { record })).rejects.toThrow("invalid JSON");
          else {
            const result = await provider.complete([], [], {
              record: async (body) => {
                const capture = await record(body);
                return {
                  ...capture,
                  async end(state, error) {
                    await new Promise((r) => setTimeout(r, 50));
                    await capture.end(state, error);
                  },
                };
              },
            });
            expect(result.stopReason).toBe("end");
          }
        } else {
          const captured = await recordedFetch(
            "http://fixture",
            { method: "POST", body: "{}" },
            record,
          );
          const reader = captured.response.body?.getReader();
          expect((await reader?.read())?.value).toEqual(new TextEncoder().encode(text));
          if (mode === "network") await expect(reader?.read()).rejects.toThrow("connection lost");
          else await reader?.cancel();
          await captured.saved;
        }
        const saved = readRequestRecording(file, EventLog.load(file).events, 0);
        expect(saved?.attempts).toEqual([
          {
            n: 1,
            status: 200,
            state: mode === "saving" ? "complete" : "interrupted",
            response: text,
          },
        ]);
        expect(saved?.error).toBeUndefined();
        if (mode === "cancel" || mode === "malformed") expect(canceled).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
