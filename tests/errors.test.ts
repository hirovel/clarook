// 错误处理(P1):分类、供应商原话、下一步提示;request/error 事件带分类与响应体;界面画错误卡。
import http from "node:http";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { readRequestRecording } from "../cli/session-records.js";
import { createTuiApp } from "../cli/tui-app.js";
import { COMMANDS } from "../cli/tui-commands.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import {
  classifyError,
  errorMessage,
  hintFor,
  ProviderError,
  providerMessage,
} from "../src/providers/errors.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { StreamStall } from "../src/providers/sse.js";
import { defineTool } from "../src/tools.js";
import { testDirectory } from "./helpers/setup.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

describe("classifyError", () => {
  it("按状态码、错误名与文案分类,溢出优先于状态码", () => {
    expect(classifyError(new ProviderError("x", { status: 401 }))).toBe("auth");
    expect(classifyError(new ProviderError("x", { status: 403 }))).toBe("auth");
    expect(classifyError(new ProviderError("x", { status: 404 }))).toBe("not_found");
    expect(classifyError(new ProviderError("x", { status: 429 }))).toBe("rate_limit");
    expect(classifyError(new ProviderError("x", { status: 500 }))).toBe("server");
    expect(classifyError(new ProviderError("x", { status: 400 }))).toBe("bad_request");
    expect(
      classifyError(new ProviderError("provider 400: prompt is too long", { status: 400 })),
    ).toBe("overflow");
    expect(classifyError(new StreamStall(1000))).toBe("stream");
    expect(classifyError(new ProviderError("stream ended without finish_reason"))).toBe("stream");
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    expect(classifyError(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(
      "network",
    );
    const aborted = new Error("x");
    aborted.name = "AbortError";
    expect(classifyError(aborted)).toBe("aborted");
    expect(classifyError(new Error("something else"))).toBe("unknown");
    expect(classifyError("not an error")).toBe("unknown");
  });

  it("错误文案保留供应商正文,只补充安全且不重复的底层错误码", () => {
    expect(
      providerMessage(
        new ProviderError("provider 401: …", {
          status: 401,
          body: '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}',
        }),
      ),
    ).toBe("Incorrect API key provided (invalid_request_error)");
    expect(
      providerMessage(new ProviderError("x", { status: 502, body: "<html>bad gateway</html>" })),
    ).toBe("<html>bad gateway</html>");
    expect(providerMessage(new Error("plain"))).toBeUndefined();
    const dns = Object.assign(new Error("Private diagnostic content"), { code: "ENOTFOUND" });
    expect(errorMessage(new TypeError("fetch failed", { cause: dns }))).toBe(
      "fetch failed [ENOTFOUND]",
    );
    const aggregate = new AggregateError(
      [dns, dns, Object.assign(new Error("Hidden detail"), { code: "ECONNREFUSED" })],
      "Hidden aggregate message",
    );
    expect(errorMessage(new TypeError("fetch failed", { cause: aggregate }))).toBe(
      "fetch failed [ENOTFOUND, ECONNREFUSED]",
    );
    const cyclic = Object.assign(new Error("fetch failed"), {
      code: "UND_ERR_SOCKET",
      cause: undefined as unknown,
    });
    cyclic.cause = cyclic;
    expect(errorMessage(cyclic)).toBe("fetch failed [UND_ERR_SOCKET]");
    expect(
      errorMessage(
        new TypeError("fetch failed", {
          cause: { code: "invalid-token secret", message: "Private diagnostic content" },
        }),
      ),
    ).toBe("fetch failed");
    expect(
      errorMessage(Object.assign(new Error("ECONNRESET already shown"), { code: "ECONNRESET" })),
    ).toBe("ECONNRESET already shown");
    expect(errorMessage(new Error("plain"))).toBe("plain");
    expect(errorMessage("plain value")).toBe("plain value");
  });

  it("hintFor 每类都指向一个动作,并带上供应商与模型名", () => {
    expect(hintFor("auth", { providerName: "deepseek" })).toContain("/login");
    expect(hintFor("not_found", { model: "gpt-9" })).toContain("gpt-9");
    expect(hintFor("overflow")).toContain("/compact");
    expect(hintFor("bad_request")).toContain("wire JSON");
    expect(hintFor("stream")).toContain("stallTimeoutMs");
    expect(hintFor("unknown")).toContain("received");
    const commands = new Set(COMMANDS.map((command) => command.name));
    for (const kind of ["auth", "not_found", "overflow"] as const) {
      for (const match of hintFor(kind).matchAll(/(?:^|\s)\/([a-z]+)\b/g))
        expect(commands.has(match[1] as string)).toBe(true);
    }
  });
});

describe("request/error 事件与错误卡", () => {
  it("HTTP鉴权、异常终止与网络断连:分类、执行边界、原始尝试和回放保持一致", async () => {
    let disconnected: false | "before" | "empty" | "partial" = false;
    let networkCalls = 0;
    let finishReason: string | undefined;
    let finishCalls = 0;
    const server = http.createServer((_req, res) => {
      if (finishReason !== undefined) {
        finishCalls++;
        const unfinished = finishReason === "unfinished";
        const choice =
          finishCalls === 1
            ? {
                delta: {
                  content: "Visible partial reply.",
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "count", arguments: "{}" } },
                  ],
                },
                finish_reason: unfinished ? null : finishReason,
              }
            : { delta: { content: "Done." }, finish_reason: "stop" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ending = unfinished
          ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
          : "data: [DONE]\n\n";
        res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\n${ending}`);
        return;
      }
      if (disconnected) {
        _req.resume();
        _req.on("end", () => {
          networkCalls++;
          if (disconnected === "before") _req.socket.destroy();
          else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(
              disconnected === "empty"
                ? ": connected\n\n"
                : 'data: {"choices":[{"delta":{"content":"Partial reply only."}}]}\n\n',
            );
            setTimeout(() => res.destroy(), 20);
          }
        });
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Incorrect API key provided", type: "invalid_request_error" },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const provider = openaiCompat({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "bad",
      model: "m",
    });
    try {
      // 内核层:事件字段
      const log = new EventLog();
      log.append({ type: "session/start", at: "", model: "m", system: "s" });
      log.append({ type: "user/message", at: "", text: "hi" });
      await expect(runTurn({ log, provider, tools: [] })).rejects.toBeInstanceOf(ProviderError);
      const err = log.events.find((e) => e.type === "request/error");
      expect(err).toMatchObject({
        status: 401,
        kind: "auth",
        provider: "Incorrect API key provided (invalid_request_error)",
      });
      expect(err && "body" in err && err.body).toContain("Incorrect API key");

      const directory = testDirectory("clarook-network-error-");
      for (const reason of [
        "content_filter",
        "network_error",
        "unknown_reason",
        "unfinished",
        "tool_calls",
        "length",
      ]) {
        finishReason = reason;
        finishCalls = 0;
        let executed = 0;
        const file = join(directory, `${reason}.jsonl`);
        const finishLog = new EventLog(file);
        const count = defineTool({
          name: "count",
          description: "Count executions",
          parameters: Type.Object({}),
          async execute() {
            executed++;
            return "counted";
          },
        });
        try {
          finishLog.append({ type: "session/start", at: "", model: "m", system: "s" });
          finishLog.append({ type: "user/message", at: "", text: "count" });
          const turn = runTurn({ log: finishLog, provider, tools: [count] });
          if (reason === "tool_calls" || reason === "length") {
            await turn;
            expect(executed).toBe(reason === "tool_calls" ? 1 : 0);
            expect(finishLog.events.some((e) => e.type === "request/error")).toBe(false);
          } else {
            await expect(turn).rejects.toMatchObject({ name: "ProviderError", retryable: false });
            expect(executed).toBe(0);
            expect(finishCalls).toBe(1);
            expect(finishLog.events.find((e) => e.type === "request/error")).toMatchObject({
              kind: "stream",
              ...(reason !== "unfinished" && { body: reason }),
            });
            expect(finishLog.events.some((e) => e.type === "assistant/message")).toBe(false);
          }
          await finishLog.checkpoint();
          const request = finishLog.events.findIndex((e) => e.type === "request");
          const recording = readRequestRecording(file, finishLog.events, request);
          expect(recording?.attempts?.[0]?.response).toContain("Visible partial reply.");
          expect(recording?.attempts?.[0]?.response).toContain(
            reason === "unfinished" ? '"finish_reason":"stop"' : reason,
          );
        } finally {
          finishLog.recording?.dispose();
        }
      }
      finishReason = undefined;

      // 界面层:错误卡
      const log2 = new EventLog();
      const app = createTuiApp({
        terminal: new VirtualTerminal(110, 30),
        log: log2,
        provider,
        tools: [],
        compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
        reserveTokens: 1000,
        info: { model: "m", providerName: "deepseek", sessionFile: "s" },
        systemPrompt: "s",
        onExit: () => {},
      });
      await app.submit("hi");
      const doc = app.lines(110).map(plain).join("\n");
      expect(doc).toContain("✗ request #1 failed  auth · HTTP 401");
      expect(doc).toContain("Incorrect API key provided");
      expect(doc).toContain("/login");
      expect(doc).toContain("chars of response body saved · /inspect raw 1");
      // 不重复:submit 的 catch 不再另打一行
      expect(doc.match(/Incorrect API key provided/g)?.length).toBe(1);
      await app.command("/inspect raw 1");
      expect(app.inspector.isOpen()).toBe(true);
      app.stop();

      for (const scenario of ["before", "empty", "partial"] as const) {
        disconnected = scenario;
        networkCalls = 0;
        const attempts = scenario === "partial" ? 1 : 3;
        const message =
          scenario === "before"
            ? "fetch failed [UND_ERR_SOCKET]"
            : scenario === "empty"
              ? "terminated [UND_ERR_SOCKET]"
              : "provider stream interrupted: terminated [UND_ERR_SOCKET]";
        const file = join(directory, `${scenario}.jsonl`);
        const networkLog = new EventLog(file);
        const networkApp = createTuiApp({
          terminal: new VirtualTerminal(60, 30),
          log: networkLog,
          provider,
          tools: [],
          reserveTokens: 1000,
          compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
          info: { model: "m", providerName: "local", sessionFile: file },
          systemPrompt: "s",
          onExit: () => {},
        });
        try {
          await networkApp.submit("hi");
          await networkLog.checkpoint();
          expect(networkCalls).toBe(attempts);
          const retries = networkLog.events.filter((e) => e.type === "retry");
          expect(retries).toHaveLength(attempts - 1);
          expect(retries.every((e) => e.error.includes("UND_ERR_SOCKET"))).toBe(true);
          expect(networkLog.events.find((e) => e.type === "request/error")).toMatchObject({
            error: message,
            kind: scenario === "partial" ? "stream" : "network",
          });
          expect(networkApp.lines(60).map(plain).join("\n")).toContain(message);
          const request = networkLog.events.findIndex((e) => e.type === "request");
          const recording = readRequestRecording(file, networkLog.events, request);
          expect(recording?.attempts).toHaveLength(attempts);
          if (scenario === "partial") {
            expect(recording?.attempts?.[0]?.response).toContain("Partial reply only.");
            expect(networkLog.events.some((e) => e.type === "assistant/message")).toBe(false);
            await networkApp.command("/inspect raw 1");
            const received = networkApp.inspector.lines(60).map(plain).join("\n");
            expect(received).toContain("Request failed · stream");
            expect(received).toContain("HTTP attempt 1 · 200");
          }
          const ends = networkLog.events.filter(
            (e) => e.type === "ext/event" && e.source === "recording" && e.kind === "http/end",
          );
          expect(ends).toHaveLength(attempts);
          expect(
            ends.every(
              (e) => e.type === "ext/event" && String(e.payload.error).includes("UND_ERR_SOCKET"),
            ),
          ).toBe(true);
        } finally {
          networkApp.stop();
          networkLog.recording?.dispose();
        }
        const replay = createTuiApp({
          terminal: new VirtualTerminal(60, 30),
          log: EventLog.load(file),
          provider,
          tools: [],
          reserveTokens: 1000,
          compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
          info: { model: "m", providerName: "local", sessionFile: file },
          systemPrompt: "s",
          onExit: () => {},
        });
        try {
          expect(replay.lines(60).map(plain).join("\n")).toContain("UND_ERR_SOCKET");
          expect(networkCalls).toBe(attempts);
        } finally {
          replay.stop();
        }
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
