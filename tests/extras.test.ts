// 用满 API 返回的信息:三家的 extras、raw 缺省开与 /raw N、/tools。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { parseCommonArgs } from "../cli/bootstrap.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import {
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
} from "../src/providers/anthropic.js";
import { feedChunk, finishAcc, newAcc } from "../src/providers/openai-chat.js";
import {
  feedResponsesEvent,
  finishResponsesAcc,
  newResponsesAcc,
} from "../src/providers/openai-responses.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

describe("extras:供应商元数据原样保存", () => {
  it("chat completions:id、model、system_fingerprint、finish_reason 原文", () => {
    const acc = newAcc();
    feedChunk(acc, {
      id: "chatcmpl-1",
      model: "deepseek-v4-pro-0903",
      system_fingerprint: "fp_x",
      choices: [{ delta: { content: "hi" } }],
    });
    feedChunk(acc, { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop" }] });
    expect(finishAcc(acc, false).extras).toEqual({
      id: "chatcmpl-1",
      model: "deepseek-v4-pro-0903",
      system_fingerprint: "fp_x",
      finish_reason: "stop",
    });
    expect(() => finishAcc(newAcc(), false)).toThrow("stream ended without finish_reason");
    expect(finishAcc(newAcc(), true)).not.toHaveProperty("extras");
  });

  it("Anthropic:message.id、model、stop_reason 原文、stop_sequence", () => {
    const acc = newAnthropicAcc();
    feedAnthropicEvent(acc, {
      type: "message_start",
      message: { id: "msg_1", model: "claude-sonnet-5-20260901", usage: { input_tokens: 1 } },
    });
    feedAnthropicEvent(acc, {
      type: "message_delta",
      delta: { stop_reason: "stop_sequence", stop_sequence: "###" },
      usage: { output_tokens: 2 },
    });
    expect(finishAnthropicAcc(acc, false, "claude-sonnet-5").extras).toEqual({
      id: "msg_1",
      model: "claude-sonnet-5-20260901",
      stop_reason: "stop_sequence",
      stop_sequence: "###",
    });
  });

  it("Responses:response.id、model、status、incomplete_details", () => {
    const acc = newResponsesAcc();
    feedResponsesEvent(acc, {
      type: "response.incomplete",
      response: {
        id: "resp_1",
        model: "gpt-5.5-2026",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    });
    const turn = finishResponsesAcc(acc, false, "gpt-5.5");
    expect(turn.stopReason).toBe("length");
    expect(turn.extras).toEqual({
      id: "resp_1",
      model: "gpt-5.5-2026",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
  });
});

describe("raw 缺省开;/raw N;/tools", () => {
  it("旧 trace 开关显式报错;/tools 列出定义;/raw N 打开检视器接收分区且自定义供应商无实录时明确显示缺口", async () => {
    expect(() => parseCommonArgs(["--trace"])).toThrow("removed");
    expect(() => parseCommonArgs(["--no-trace"])).toThrow("removed");

    const echo = defineTool({
      name: "echo",
      description: "Echo back the text.\nSecond line.",
      parameters: Type.Object({ text: Type.String() }),
      concurrency: "parallel",
      async execute(a) {
        return a.text;
      },
    });
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        return {
          text: "ok",
          toolCalls: [],
          stopReason: "end",
          extras: { id: "x1", finish_reason: "stop" },
        };
      },
    };
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 30),
      log: new EventLog(),
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",

      onExit: () => {},
    });
    await app.command("/inspect tools");
    let doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("Tools 1");
    expect(doc).toContain("echo");
    expect(doc).toContain("parallel");
    expect(doc).toContain("params: text");

    await app.submit("hi");
    doc = plain(app.lines(120).join("\n"));
    // 供应商元数据与原始流不进对话流,在检视器的接收分区
    expect(doc).not.toContain("finish_reason");
    expect(doc).not.toContain("as received");

    await app.command("/inspect raw 9");
    expect(plain(app.lines(120).join("\n"))).toContain("No request #9");
    await app.command("/inspect raw 1");
    expect(app.inspector.isOpen()).toBe(true);
    const ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Request #1");
    expect(ins).toContain("No HTTP response captured");
    expect(ins).toContain("Provider metadata");
    app.stop();
  });
});
