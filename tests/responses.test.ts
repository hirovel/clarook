// OpenAI Responses 适配器:推理项(摘要给人看、密文回传)、input 项翻译、流式累积、假服务器全链路;
// 推理来源标记(full / summary)与字段清单表。

import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createProvider, loadConfig } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import {
  ANTHROPIC_FIELDS,
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
} from "../src/providers/anthropic.js";
import {
  feedChunk,
  finishAcc,
  newAcc,
  OPENAI_COMPAT_FIELDS,
} from "../src/providers/openai-chat.js";
import {
  feedResponsesEvent,
  finishResponsesAcc,
  newResponsesAcc,
  OPENAI_RESPONSES_FIELDS,
  openaiResponses,
  type ResponsesEvent,
  toResponsesInput,
} from "../src/providers/openai-responses.js";
import { defineTool } from "../src/tools.js";
import { testDirectory } from "./helpers/setup.js";

describe("Responses 流式累积", () => {
  it("推理项摘要 + 密文、文本与拒绝、函数调用按 output_index 归位;done 项全量覆盖增量", () => {
    const acc = newResponsesAcc();
    const message = {
      type: "message",
      id: "msg_1",
      content: [
        { type: "output_text", text: "好" },
        { type: "refusal", refusal: "I cannot help with that request." },
        { type: "output_text", text: " I can explain safer alternatives." },
      ],
    };
    feedResponsesEvent(acc, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1" },
    });
    feedResponsesEvent(acc, {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "先看目录",
    });
    feedResponsesEvent(acc, {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "先看目录,再读文件" }],
        encrypted_content: "ENC",
      },
    });
    feedResponsesEvent(acc, {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_1" },
    });
    expect(
      feedResponsesEvent(acc, { type: "response.output_text.delta", output_index: 1, delta: "好" }),
    ).toBe("好");
    expect(
      feedResponsesEvent(acc, {
        type: "response.output_text.done",
        output_index: 1,
        content_index: 0,
        text: "好",
      }),
    ).toBe("");
    expect(
      feedResponsesEvent(acc, {
        type: "response.refusal.delta",
        output_index: 1,
        content_index: 1,
        delta: "I cannot ",
      }),
    ).toBe("I cannot ");
    expect(
      feedResponsesEvent(acc, {
        type: "response.refusal.done",
        output_index: 1,
        content_index: 1,
        refusal: "I cannot help with that request.",
      }),
    ).toBe("help with that request.");
    expect(
      feedResponsesEvent(acc, {
        type: "response.output_item.done",
        output_index: 1,
        item: message,
      }),
    ).toBe(" I can explain safer alternatives.");
    feedResponsesEvent(acc, {
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
    });
    feedResponsesEvent(acc, {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      delta: '{"path":',
    });
    feedResponsesEvent(acc, {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "ls",
        arguments: '{"path":"."}',
      },
    });
    expect(
      feedResponsesEvent(acc, {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            { type: "reasoning", id: "rs_1" },
            message,
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      }),
    ).toBe("");
    const turn = finishResponsesAcc(acc, false, "gpt-5.5");
    expect(turn).toMatchObject({
      text: "好I cannot help with that request. I can explain safer alternatives.",
      toolCalls: [{ id: "call_1", name: "ls", args: { path: "." } }],
      stopReason: "tool",
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, reasoningTokens: 30 },
      reasoning: "先看目录,再读文件",
      reasoningKind: "summary",
      opaque: {
        kind: "openai-reasoning",
        model: "gpt-5.5",
        items: [
          {
            id: "rs_1",
            summary: [{ type: "summary_text", text: "先看目录,再读文件" }],
            encrypted_content: "ENC",
          },
        ],
      },
    });
  });

  it.each(["response.refusal.done", "response.output_item.done", "response.completed"])(
    "只有 %s 携带拒绝正文时补齐显示,后续完整响应不重复正文",
    (type) => {
      const acc = newResponsesAcc();
      const refusal = "I cannot help with that request.";
      const item = { type: "message", id: "msg", content: [{ type: "refusal", refusal }] };
      const completed: ResponsesEvent = {
        type: "response.completed",
        response: {
          status: "completed",
          output: [item],
          usage: { input_tokens: 12, output_tokens: 7 },
        },
      };
      const first =
        type === "response.completed"
          ? completed
          : type === "response.output_item.done"
            ? { type, output_index: 0, item }
            : { type, output_index: 0, content_index: 0, refusal };
      expect(feedResponsesEvent(acc, first)).toBe(refusal);
      expect(feedResponsesEvent(acc, completed)).toBe("");
      expect(finishResponsesAcc(acc, false)).toMatchObject({
        text: refusal,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 12, outputTokens: 7 },
      });
    },
  );

  it("max_output_tokens 截断 → length;打断 → 无工具调用、无回传物", () => {
    const acc = newResponsesAcc();
    feedResponsesEvent(acc, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs" },
    });
    feedResponsesEvent(acc, {
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    });
    expect(finishResponsesAcc(acc, false).stopReason).toBe("length");
    expect(finishResponsesAcc(acc, true)).not.toHaveProperty("opaque");
  });
});

describe("Responses input 翻译", () => {
  it("system → instructions;assistant 拆成 推理项 → 文本 → 调用;工具结果是 function_call_output;跨模型族丢推理项", () => {
    const opaque = {
      kind: "openai-reasoning",
      model: "gpt-5.5",
      items: [{ id: "rs", summary: [], encrypted_content: "E" }],
    };
    const msgs = [
      { role: "system" as const, content: "S" },
      { role: "user" as const, content: "u" },
      {
        role: "assistant" as const,
        content: "a",
        toolCalls: [{ id: "c1", name: "ls", args: { path: "." } }],
        opaque,
      },
      { role: "tool" as const, callId: "c1", name: "ls", content: "", isError: false },
    ];
    const same = toResponsesInput(msgs, { model: "gpt-5.6" });
    expect(same.instructions).toBe("S");
    expect(same.input.map((i) => i.type)).toEqual([
      "message",
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(same.input[4]).toEqual({ type: "function_call_output", call_id: "c1", output: "(空)" });
    const other = toResponsesInput(msgs, { model: "gpt-6.0" });
    expect(other.input.map((i) => i.type)).toEqual([
      "message",
      "message",
      "function_call",
      "function_call_output",
    ]);
  });

  it("wire:扁平工具定义、store: false、reasoning{effort, summary}、max_output_tokens", () => {
    const p = openaiResponses({
      apiKey: "k",
      model: "gpt-5.5",
      maxTokens: 500,
      effortLevels: ["low", "high"],
    });
    const body = p.wire?.(
      [{ role: "user", content: "hi" }],
      [{ name: "ls", description: "d", parameters: { type: "object" } }],
      {
        effort: "medium",
      },
    ) as Record<string, unknown>;
    expect(body.tools).toEqual([
      { type: "function", name: "ls", description: "d", parameters: { type: "object" } },
    ]);
    expect(body.store).toBe(false);
    // medium 不在支持集合里,向下回退到 low。
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.max_output_tokens).toBe(500);
    const none = openaiResponses({ apiKey: "k", model: "m", reasoningSummary: "none" }).wire?.(
      [],
      [],
    ) as Record<string, unknown>;
    expect(none.reasoning).toBeUndefined();
  });
});

describe("推理来源标记", () => {
  it("chat completions 的 reasoning_content 是 full;Anthropic 预算模式 full、自适应 summary", () => {
    const acc = newAcc();
    feedChunk(acc, { choices: [{ delta: { reasoning_content: "想" }, finish_reason: "stop" }] });
    expect(finishAcc(acc, false)).toMatchObject({ reasoning: "想", reasoningKind: "full" });
    const a = newAnthropicAcc();
    feedAnthropicEvent(a, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    feedAnthropicEvent(a, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "t" },
    });
    feedAnthropicEvent(a, { type: "message_delta", delta: { stop_reason: "end_turn" } });
    expect(finishAnthropicAcc(a, false, "m", { mode: "budget" }).reasoningKind).toBe("full");
    expect(finishAnthropicAcc(a, false, "m", { mode: "adaptive" }).reasoningKind).toBe("summary");
    expect(finishAnthropicAcc(a, false, "m").reasoningKind).toBe("summary");
  });

  it("reasoningKind 经投影原样回到消息", () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "s" });
    log.append({
      type: "assistant/message",
      at: "",
      text: "",
      toolCalls: [],
      stopReason: "end",
      reasoning: "r",
      reasoningKind: "summary",
    });
    expect(deriveMessages(log.events)[1]).toMatchObject({
      reasoning: "r",
      reasoningKind: "summary",
    });
  });
});

describe("字段清单表", () => {
  it("三个适配器都带 fields,三张表非空,且 provider 对象暴露它", () => {
    for (const f of [OPENAI_COMPAT_FIELDS, ANTHROPIC_FIELDS, OPENAI_RESPONSES_FIELDS]) {
      expect(f.sends.length).toBeGreaterThan(3);
      expect(f.reads.length).toBeGreaterThan(3);
      expect(f.ignores.length).toBeGreaterThan(0);
    }
    expect(openaiResponses({ apiKey: "k", model: "m" }).fields?.protocol).toBe("openai-responses");
  });
});

describe("Responses 假服务器全链路", () => {
  it("Responses 全链路:推理回传、可见拒绝与用量;失败终止不执行工具", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const refusal = "I cannot help with that request.";
    const refusalItem = { type: "message", id: "m", content: [{ type: "refusal", refusal }] };
    let failed: "failed" | "incomplete" | undefined;
    let failedRequest = 0;
    const sse = (res: http.ServerResponse, events: unknown[]) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events)
        res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        calls.push({ url: req.url ?? "", body: JSON.parse(raw) });
        if (failed && calls.length === failedRequest) {
          sse(res, [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "function_call",
                id: "unsafe",
                call_id: "unsafe",
                name: "echo",
                arguments: '{"s":"must not execute"}',
              },
            },
            {
              type: `response.${failed}`,
              response: {
                status: failed,
                ...(failed === "incomplete" && {
                  incomplete_details: { reason: "max_time_limit" },
                }),
              },
            },
          ]);
          return;
        }
        if (calls.length === 1) {
          sse(res, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: "rs_1" },
            },
            { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "看看" },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "reasoning",
                id: "rs_1",
                summary: [{ type: "summary_text", text: "看看" }],
                encrypted_content: "ENC1",
              },
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "function_call", id: "fc", call_id: "c1", name: "echo" },
            },
            { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"s":"x"}' },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: {
                type: "function_call",
                id: "fc",
                call_id: "c1",
                name: "echo",
                arguments: '{"s":"x"}',
              },
            },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: {
                  input_tokens: 50,
                  output_tokens: 10,
                  output_tokens_details: { reasoning_tokens: 5 },
                },
              },
            },
          ]);
        } else {
          sse(res, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m" },
            },
            {
              type: "response.refusal.delta",
              output_index: 0,
              content_index: 0,
              delta: "I cannot ",
            },
            {
              type: "response.refusal.delta",
              output_index: 0,
              content_index: 0,
              delta: "help with that request.",
            },
            { type: "response.refusal.done", output_index: 0, content_index: 0, refusal },
            { type: "response.output_item.done", output_index: 0, item: refusalItem },
            {
              type: "response.completed",
              response: {
                status: "completed",
                output: [refusalItem],
                usage: { input_tokens: 12, output_tokens: 7 },
              },
            },
          ]);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const dir = testDirectory("ak-resp-");
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: "gpt-5.5",
        providers: {
          openai: {
            protocol: "openai-responses",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKey: "k",
            models: ["gpt-5.5"],
          },
        },
      }),
    );
    const { config } = loadConfig(cfgPath);
    const provider = createProvider(
      {
        providerName: "openai",
        provider: config.providers.openai as never,
        model: "gpt-5.5",
        contextWindow: 1000,
      },
      "k",
    );
    let executions = 0;
    const echo = defineTool({
      name: "echo",
      description: "",
      parameters: Type.Object({ s: Type.String() }),
      async execute(a) {
        executions++;
        return a.s;
      },
    });
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "gpt-5.5", system: "sys" });
    log.append({ type: "user/message", at: "", text: "go" });
    let visible = "";
    try {
      expect(
        await runTurn({
          log,
          provider,
          tools: [echo],
          onDelta: (delta) => {
            visible += delta;
          },
        }),
      ).toBe("idle");
      expect(visible).toBe(refusal);
      expect(calls).toHaveLength(2);
      expect(log.events.filter((event) => event.type === "assistant/message").at(-1)).toMatchObject(
        {
          text: refusal,
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 12, outputTokens: 7 },
        },
      );
      expect(executions).toBe(1);
      for (const outcome of ["failed", "incomplete"] as const) {
        failed = outcome;
        const previous = calls.length;
        failedRequest = previous + 1;
        const failure = new EventLog();
        failure.append({ type: "session/start", at: "", model: "gpt-5.5", system: "sys" });
        failure.append({ type: "user/message", at: "", text: "go" });
        await expect(runTurn({ log: failure, provider, tools: [echo] })).rejects.toThrow(
          outcome === "failed" ? "response failed" : "max_time_limit",
        );
        expect(calls.length).toBe(previous + 1);
        expect(executions).toBe(1);
        expect(failure.events.find((event) => event.type === "request/error")).toMatchObject({
          kind: "stream",
        });
        expect(failure.events.find((event) => event.type === "request/error")).not.toHaveProperty(
          "body",
        );
        expect(
          failure.events.some(
            (event) => event.type === "tool/result" || event.type === "assistant/message",
          ),
        ).toBe(false);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(calls[0]?.url).toBe("/responses");
    expect(calls[0]?.body.instructions).toBe("sys");
    // 第二次请求把推理项(含密文)原样放回,位于函数调用之前,然后是函数结果。
    const input2 = calls[1]?.body.input as { type: string; encrypted_content?: string }[];
    expect(input2.map((i) => i.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input2[1]?.encrypted_content).toBe("ENC1");
    const first = log.events.find((e) => e.type === "assistant/message");
    expect(first).toMatchObject({
      reasoning: "看看",
      reasoningKind: "summary",
      usage: { reasoningTokens: 5 },
    });
  });
});
