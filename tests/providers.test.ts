import { describe, expect, it } from "vitest";
import {
  CONFIG_TEMPLATE,
  modelNames,
  type ProviderConfig,
  resolveApiKey,
  resolveModel,
} from "../src/config.js";
import type { AgentEvent } from "../src/events.js";
import { deriveMessages, type Message } from "../src/messages.js";
import { clampEffort, parseEffort } from "../src/provider.js";
import {
  type AnthropicEvent,
  anthropic,
  anthropicEffortParams,
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
  thinkingText,
  toAnthropicWire,
} from "../src/providers/anthropic.js";
import { openaiCompat, openaiEffortParams } from "../src/providers/openai-chat.js";

describe("Anthropic 流式累积", () => {
  it("文本 + 工具调用分块累积,usage 来自 message_start 与 message_delta", () => {
    const acc = newAnthropicAcc();
    const events: AnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 120, output_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先看" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "文件" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "read" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pa' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];
    const deltas = events.map((e) => feedAnthropicEvent(acc, e)).filter(Boolean);
    expect(deltas).toEqual(["先看", "文件"]);

    const turn = finishAnthropicAcc(acc, false);
    expect(turn).toEqual({
      text: "先看文件",
      toolCalls: [{ id: "tu_1", name: "read", args: { path: "a.ts" } }],
      stopReason: "tool",
      usage: { inputTokens: 120, outputTokens: 30 },
      extras: { stop_reason: "tool_use" },
    });
  });

  it("max_tokens → length;aborted 丢弃调用保留文本", () => {
    const acc = newAnthropicAcc();
    feedAnthropicEvent(acc, {
      type: "message_start",
      message: { usage: { input_tokens: 120, output_tokens: 7 } },
    });
    feedAnthropicEvent(acc, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "半" },
    });
    feedAnthropicEvent(acc, { type: "message_delta", delta: { stop_reason: "max_tokens" } });
    expect(finishAnthropicAcc(acc, false).stopReason).toBe("length");
    expect(finishAnthropicAcc(acc, true)).toMatchObject({
      text: "半",
      stopReason: "aborted",
      usage: { inputTokens: 120, outputTokens: 7 },
    });
    feedAnthropicEvent(acc, { type: "message_delta", delta: {}, usage: {} });
    expect(finishAnthropicAcc(acc, true).usage?.outputTokens).toBe(7);
    feedAnthropicEvent(acc, { type: "message_delta", delta: {}, usage: { output_tokens: 0 } });
    expect(finishAnthropicAcc(acc, true).usage?.outputTokens).toBe(0);
  });
});

describe("toAnthropicWire", () => {
  it("system 抽顶层;连续工具结果合并进一条 user 消息;空 assistant 补占位", () => {
    const wire = toAnthropicWire([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "read", args: { path: "x" } },
          { id: "b", name: "bash", args: { command: "ls" } },
        ],
      },
      { role: "tool", callId: "a", name: "read", content: "R", isError: false },
      { role: "tool", callId: "b", name: "bash", content: "E", isError: true },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    expect(wire.system).toEqual([{ type: "text", text: "S" }]);
    expect(wire.messages).toHaveLength(4);
    expect(wire.messages[1]?.content.map((b) => b.type)).toEqual(["tool_use", "tool_use"]);
    expect(wire.messages[2]?.role).toBe("user");
    expect(wire.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "R" },
      { type: "tool_result", tool_use_id: "b", content: "E", is_error: true },
    ]);
    expect(wire.messages[3]?.content).toEqual([{ type: "text", text: "(空)" }]);
  });
});

describe("config 解析", () => {
  it("按 models 列表匹配、按前缀猜、供应商/模型显式写法", () => {
    expect(resolveModel(CONFIG_TEMPLATE, "deepseek-v4-pro").providerName).toBe("deepseek");
    expect(resolveModel(CONFIG_TEMPLATE, "claude-opus-5").providerName).toBe("anthropic");
    expect(resolveModel(CONFIG_TEMPLATE, "claude-unlisted-9").providerName).toBe("anthropic");
    const explicit = resolveModel(CONFIG_TEMPLATE, "openai/gpt-x");
    expect(explicit).toMatchObject({
      providerName: "openai",
      model: "gpt-x",
      contextWindow: 128000,
    });
    expect(resolveModel(CONFIG_TEMPLATE).model).toBe("deepseek-flash");
  });

  it("匹配失败时列出全部已配置模型", () => {
    expect(() => resolveModel(CONFIG_TEMPLATE, "mystery")).toThrow("deepseek/deepseek-v4-pro");
  });

  it("key:环境变量 > 凭据文件 > 配置字段,都缺则指路;测试指向一个不存在的凭据文件,不碰本机的", () => {
    const p = CONFIG_TEMPLATE.providers.deepseek;
    if (!p) throw new Error("模板缺 deepseek");
    const env = { CLAROOK_CREDENTIALS: "C:/nonexistent/clarook-test-credentials.json" };
    expect(resolveApiKey("deepseek", { ...p, apiKey: " k1 " }, env)).toBe("k1");
    expect(resolveApiKey("deepseek", p, { ...env, DEEPSEEK_API_KEY: "k2" })).toBe("k2");
    expect(() => resolveApiKey("deepseek", p, env)).toThrow("DEEPSEEK_API_KEY");
  });
});

describe("按模型的能力数据与强度映射", () => {
  it("模型对象:强度集合与 thinking 模式取模型级;模板不预填窗口,配置层只给内置缺省,真值由登记簿层给", () => {
    const r = resolveModel(CONFIG_TEMPLATE, "claude-haiku-4-5-20251001");
    expect(r.contextWindow).toBe(128000);
    expect(r.maxTokens).toBeUndefined();
    expect(r.thinkingMode).toBe("budget");
    expect(r.effortLevels).toEqual(["off", "low", "medium", "high"]);
    const d = resolveModel(CONFIG_TEMPLATE, "deepseek-flash");
    expect(d.contextWindow).toBe(128000);
    expect(d.provider.dialect).toBe("deepseek");
    expect(modelNames(CONFIG_TEMPLATE.providers.openai as ProviderConfig)).toEqual([
      "gpt-5.5",
      "gpt-5.6",
    ]);
  });

  it("clampEffort:不支持的级别向下回退,没有更低的取最低", () => {
    expect(clampEffort("xhigh", ["off", "low", "high", "max"])).toBe("high");
    expect(clampEffort("medium", ["high", "max"])).toBe("high");
    expect(clampEffort("high", undefined)).toBe("high");
    expect(parseEffort("minimal")).toBe("low");
    expect(parseEffort("ultra")).toBeUndefined();
  });

  it("openai 方言:reasoning_effort 直传,off→none;deepseek 方言:thinking 开关 + 三档", () => {
    expect(openaiEffortParams(undefined, "openai")).toEqual({});
    expect(openaiEffortParams("xhigh", "openai")).toEqual({ reasoning_effort: "xhigh" });
    expect(openaiEffortParams("off", "openai")).toEqual({ reasoning_effort: "none" });
    expect(openaiEffortParams("off", "deepseek")).toEqual({ thinking: { type: "disabled" } });
    expect(openaiEffortParams("medium", "deepseek")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(openaiEffortParams("max", "deepseek")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("anthropic:adaptive 发 output_config.effort;budget 按级别给 budget_tokens 且小于 max_tokens", () => {
    expect(anthropicEffortParams(undefined, "adaptive", 8192)).toEqual({});
    expect(anthropicEffortParams("xhigh", "adaptive", 8192)).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    });
    expect(anthropicEffortParams("off", "adaptive", 8192)).toEqual({
      thinking: { type: "disabled" },
    });
    expect(anthropicEffortParams("high", "budget", 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 8191 },
    });
    expect(anthropicEffortParams("low", "budget", 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    const provider = anthropic({
      apiKey: "fixture",
      model: "m",
      maxTokens: 8192,
      thinkingMode: "budget",
    });
    expect(provider.wire?.([], [], { effort: "high", maxTokens: 2048 })).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 2047 },
    });
    expect(provider.wire?.([], [], { effort: "high" })).toMatchObject({
      max_tokens: 8192,
      thinking: { type: "enabled", budget_tokens: 8191 },
    });
  });

  it("wire 层:强度参数与 extraBody 进入正文,extraBody 最后合并可覆盖一切", () => {
    const p = openaiCompat({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      dialect: "deepseek",
      effortLevels: ["off", "low", "high", "max"],
      extraBody: { temperature: 0.2 },
    });
    const body = p.wire?.([{ role: "user", content: "hi" }], [], { effort: "xhigh" }) as Record<
      string,
      unknown
    >;
    expect(body.reasoning_effort).toBe("high"); // xhigh 向下回退到 high
    expect(body.temperature).toBe(0.2);
    const bare = p.wire?.([{ role: "user", content: "hi" }], []) as Record<string, unknown>;
    expect("reasoning_effort" in bare).toBe(false);
    const summary = p.wire?.([], [], { maxTokens: 321 }) as Record<string, unknown>;
    expect(summary.max_tokens).toBe(321);
    expect(summary.max_completion_tokens).toBeUndefined();
    expect(bare.max_tokens).toBeUndefined();
  });
});

describe("Anthropic thinking 块", () => {
  it("流式累积 thinking 与签名;finish 产出可读 reasoning 与 opaque 回传物;打断丢弃块", () => {
    const acc = newAnthropicAcc();
    const events: AnthropicEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先想" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "一下" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig1" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque-bytes" },
      },
      { type: "content_block_start", index: 2, content_block: { type: "text" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "答" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ];
    for (const e of events) feedAnthropicEvent(acc, e);
    expect(thinkingText(acc)).toBe("先想一下");
    const turn = finishAnthropicAcc(acc, false, "claude-sonnet-5");
    expect(turn.reasoning).toBe("先想一下");
    expect(turn.opaque).toEqual({
      kind: "anthropic-thinking",
      model: "claude-sonnet-5",
      blocks: [
        { type: "thinking", thinking: "先想一下", signature: "sig1" },
        { type: "redacted_thinking", data: "opaque-bytes" },
      ],
    });
    const aborted = finishAnthropicAcc(acc, true, "claude-sonnet-5");
    expect(aborted.reasoning).toBe("先想一下");
    expect("opaque" in aborted).toBe(false);
  });

  it("wire:同模型的 thinking 块原样放在 assistant 内容之首;换模型后丢弃", () => {
    const opaque = {
      kind: "anthropic-thinking",
      model: "claude-sonnet-5",
      blocks: [{ type: "thinking", thinking: "t", signature: "s" }],
    };
    const messages: Message[] = [
      { role: "user", content: "U" },
      { role: "assistant", content: "A", toolCalls: [{ id: "x", name: "read", args: {} }], opaque },
      { role: "tool", callId: "x", name: "read", content: "R", isError: false },
    ];
    const same = toAnthropicWire(messages, { model: "claude-sonnet-5" });
    expect(same.messages[1]?.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(same.messages[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "t",
      signature: "s",
    });
    const other = toAnthropicWire(messages, { model: "claude-opus-5" });
    expect(other.messages[1]?.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    // 非 Anthropic 的 opaque(如别家适配器留下的)一律忽略
    const foreign = toAnthropicWire(
      [{ role: "assistant", content: "A", toolCalls: [], opaque: { kind: "other" } }],
      { model: "claude-sonnet-5" },
    );
    expect(foreign.messages[0]?.content).toEqual([{ type: "text", text: "A" }]);
  });

  it("opaque 经事件日志投影原样回到消息里", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "t", model: "m", system: "s" },
      {
        type: "assistant/message",
        at: "t",
        text: "A",
        toolCalls: [],
        stopReason: "end",
        opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
      },
    ];
    const m = deriveMessages(events)[1];
    expect(m?.role === "assistant" && m.opaque).toEqual({
      kind: "anthropic-thinking",
      model: "m",
      blocks: [],
    });
  });
});
