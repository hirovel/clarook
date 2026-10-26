// 端到端:真实 HTTP + SSE + 重试 + 溢出恢复 + 落盘 + 检视器,只把远端模型换成本机假服务器。
// 覆盖 cli/tui.ts 之外的整条链路:config.createProvider → openaiCompat → runTurn → EventLog 文件 → TUI 渲染 → replay。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRequestRecording } from "../cli/session-records.js";
import { createTuiApp } from "../cli/tui-app.js";
import { keepRecentTokens, llmSummarize } from "../src/compaction.js";
import { createProvider } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

type Recorded = { body: Record<string, unknown>; headers: http.IncomingHttpHeaders; url: string };
type Handler = (res: http.ServerResponse) => void;

/** 按脚本逐次应答的假服务器。每个请求消耗一个 handler;脚本用尽返回 500。 */
async function fakeServer(
  script: Handler[],
): Promise<{ url: string; calls: Recorded[]; close(): Promise<void> }> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      calls.push({ body: JSON.parse(raw), headers: req.headers, url: req.url ?? "" });
      const h = script.shift();
      if (!h) {
        res.writeHead(500);
        res.end("脚本用尽");
        return;
      }
      h(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const sse =
  (events: unknown[]): Handler =>
  (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.end("data: [DONE]\n\n");
  };
const status =
  (code: number, body: string, headers: Record<string, string> = {}): Handler =>
  (res) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(body);
  };
const text = (t: string) => ({ choices: [{ delta: { content: t }, finish_reason: null }] });
const toolCall = (id: string, name: string, args: unknown) => ({
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    },
  ],
});
const finish = (reason: string, usage: Record<string, number>) => ({
  choices: [{ delta: {}, finish_reason: reason }],
  usage,
});

const big = defineTool({
  name: "big",
  description: "返回一大段文本",
  parameters: Type.Object({ n: Type.Number() }),
  async execute(args) {
    return Array.from({ length: args.n }, (_, i) => `第 ${i + 1} 行:${"内容".repeat(20)}`).join(
      "\n",
    );
  },
});

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("端到端(假服务器)", () => {
  it("OpenAI 协议:429 重试 → 工具 → 溢出压缩(摘要请求也被记录)→ 重发完成;落盘、trace、检视器、回放一致", async () => {
    const server = await fakeServer([
      status(429, '{"error":{"message":"rate limited"}}', { "retry-after": "0" }),
      sse([
        toolCall("call_1", "big", { n: 80 }),
        finish("tool_calls", { prompt_tokens: 300, completion_tokens: 20 }),
      ]),
      status(
        400,
        '{"error":{"message":"This model\'s maximum context length is 131072 tokens. However, you requested 140000 tokens."}}',
      ),
      sse([
        text("摘要:用户要看大文件,工具已返回 80 行内容。"),
        finish("stop", { prompt_tokens: 2000, completion_tokens: 30 }),
      ]),
      sse([
        text("完成:文件已看过。"),
        finish("stop", { prompt_tokens: 900, completion_tokens: 12, prompt_cache_hit_tokens: 600 }),
      ]),
    ]);
    tmp = mkdtempSync(join(tmpdir(), "ak-e2e-"));
    const sessionFile = join(tmp, "s.jsonl");
    const traceFile = join(tmp, "s.trace.jsonl");
    const log = new EventLog(sessionFile);
    const provider = createProvider(
      {
        providerName: "fake",
        provider: {
          protocol: "openai",
          baseUrl: server.url,
          models: ["m"],
          reasoningField: "reasoning_content",
        },
        model: "m",
        contextWindow: 100000,
      },
      "test-key",
    );
    const term = new VirtualTerminal(110, 40);
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [big],
      readClipboard: async () => ({ image: testImage }),
      // 这条测的是内核链路,每一步都要在屏幕上看得到:关掉账簿折叠。
      foldSteps: 0,
      // 保留策略只留最近 50 tok,溢出恢复才有东西可摘要(缺省保留 20000,小会话下无事可做)。
      compaction: {
        strategy: llmSummarize(),
        window: 100000,
        reserveTokens: 20000,
        preservation: keepRecentTokens(50),
      },
      reserveTokens: 20000,
      info: { model: "m", providerName: "fake", sessionFile },
      systemPrompt: "你是助手。",
      onExit: () => {},
    });

    app.setDraft("看一下大文件");
    term.feed("\x1bv");
    await vi.waitFor(() =>
      expect(app.lines(110).map(stripAnsi).join("\n")).toContain("1 image(s) attached"),
    );
    expect(server.calls).toHaveLength(0);
    term.feed("\r");
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(0));
    await app.agent.waitForIdle();
    const doc = app.lines(110).map(stripAnsi).join("\n");

    // 服务器视角:5 次调用,带 Bearer,第一条消息是系统提示词,摘要请求也走了同一条线
    expect(server.calls).toHaveLength(5);
    expect(server.calls[0]?.headers.authorization).toBe("Bearer test-key");
    const firstSent = (server.calls[1]?.body.messages ?? []) as { role: string }[];
    expect(firstSent[0]?.role).toBe("system");
    expect(server.calls[1]?.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            { type: "text", text: "看一下大文件" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${testImage.data}` } },
          ],
        }),
      ]),
    );
    expect(doc).toContain("Image 1: pixel.png");
    expect(doc).toContain("visual tokens unknown before response");
    expect(doc).not.toContain(testImage.data);
    expect(server.calls[4]?.body.messages).toBeDefined();

    // 日志视角:四次请求,原因依次为 正常步 / 正常步(失败)/ 压缩 / 溢出重发
    const requests = log.events.filter((e) => e.type === "request");
    expect(requests.map((r) => r.type === "request" && r.reason)).toEqual([
      "turn",
      "turn",
      "compaction",
      "overflow-retry",
    ]);
    expect(log.events.find((e) => e.type === "retry")).toMatchObject({ status: 429, attempt: 1 });
    expect(log.events.find((e) => e.type === "request/error")).toMatchObject({ status: 400 });
    const compaction = log.events.find((e) => e.type === "compaction");
    expect(compaction).toMatchObject({ usage: { inputTokens: 2000, outputTokens: 30 } });
    expect(compaction && "latencyMs" in compaction && typeof compaction.latencyMs).toBe("number");

    // 屏幕视角
    expect(doc).toContain("· retry 1: 429");
    expect(doc).toContain("✓ big");
    expect(doc).toContain("≈ compacted (llmSummarize(pi, replay)): summary covers events");
    expect(doc).toContain("完成:文件已看过");
    // 直印:失败的请求一行 ✗,溢出重发一行 ≈;用量不进正文(命中 67% 不低,不出声)
    expect(doc).toContain("✗ request #2 failed  overflow · HTTP 400");
    expect(doc).toContain("≈ overflow retry");
    expect(doc).not.toContain("Response #");
    expect(doc).not.toContain("unchanged text ≈");
    expect(app.agent.running).toBe(false);

    // 检视器视角:四条记录,压缩请求有自己的一行,接收分区有原始流
    app.inspector.open();
    let insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("4 requests");
    expect(insp).toContain("compaction");
    expect(insp).toContain("summary");
    expect(insp).toContain("overflow retry");
    app.inspector.key("\r");
    app.inspector.key("6");
    app.inspector.key("\x1b[B"); // 选 HTTP 原文,仅展开当前块。
    app.inspector.key("\r");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("data: [DONE]");
    app.inspector.key("[");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("摘要:用户要看大文件");
    app.inspector.close();

    const saved = log.events.flatMap((e, i) =>
      e.type === "request" ? [readRequestRecording(sessionFile, log.events, i)] : [],
    );
    expect(saved).toHaveLength(4);
    expect(saved.every((r) => r?.bodies.length && r.attempts?.length && !r.error)).toBe(true);
    expect(existsSync(traceFile)).toBe(false);

    // 回放视角:磁盘日志与内存一致,摘要已进入投影
    const loaded = EventLog.load(sessionFile);
    expect(loaded.events).toEqual(log.events);
    expect(loaded.events.find((e) => e.type === "user/message")).toMatchObject({
      images: [testImage],
    });
    const messages = deriveMessages(loaded.events);
    expect(
      messages.some(
        (m) => m.role === "user" && m.content.includes("Earlier conversation was compacted"),
      ),
    ).toBe(true);
    expect(readFileSync(sessionFile, "utf8").trim().split("\n")).toHaveLength(log.events.length);

    app.stop();
    await server.close();
  });

  it("Anthropic 协议:x-api-key、system 顶层、tool_use → tool_result 合并进 user 消息", async () => {
    const ev = (o: unknown) => o;
    const server = await fakeServer([
      (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of [
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } },
          }),
          ev({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "big" },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"n":2}' },
          }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 9 },
          }),
          ev({ type: "message_stop" }),
        ])
          res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.end();
      },
      (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of [
          ev({ type: "message_start", message: { usage: { input_tokens: 160 } } }),
          ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "两行看完。" },
          }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          }),
        ])
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end();
      },
    ]);
    const provider = createProvider(
      {
        providerName: "anth",
        provider: { protocol: "anthropic", baseUrl: server.url, models: ["c"], maxTokens: 512 },
        model: "c",
        contextWindow: 200000,
      },
      "sk-ant-test",
    );
    const log = new EventLog();
    log.append({ type: "session/start", at: "t", model: "c", system: "sys" });
    log.append({ type: "user/message", at: "t", text: "看两行" });
    const out = await runTurn({ log, provider, tools: [big] });
    expect(out).toBe("idle");
    expect(server.calls[0]?.url).toBe("/v1/messages");
    expect(server.calls[0]?.headers["x-api-key"]).toBe("sk-ant-test");
    // 系统提示词是块数组,缺省挂缓存断点(前缀不变即命中,每步只为新增部分付全价)。
    expect(server.calls[0]?.body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(server.calls[0]?.body.max_tokens).toBe(512);
    const second = server.calls[1]?.body.messages as {
      role: string;
      content: { type: string }[];
    }[];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2]?.content[0]?.type).toBe("tool_result");
    const first = log.events.find((e) => e.type === "assistant/message");
    expect(first).toMatchObject({
      usage: { inputTokens: 140, cacheReadTokens: 40, outputTokens: 9 },
    });
    expect(log.events.at(-1)).toMatchObject({ type: "assistant/message", text: "两行看完。" });
    await server.close();
  });
});
