// 编辑上下文的收口:压缩与清除当作编辑点、Anthropic 编辑点断点、变化说明里的编辑点与预计命中、/retry。
import { describe, expect, it } from "vitest";
import { cacheNote, changeNote, predictedCache } from "../cli/cards.js";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { toAnthropicWire } from "../src/providers/anthropic.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");
const thinking = {
  kind: "anthropic-thinking",
  model: "m",
  blocks: [{ type: "thinking", thinking: "t", signature: "s" }],
};

function base(): AgentEvent[] {
  return [
    { type: "session/start", at: "", model: "m", system: "S" },
    { type: "user/message", at: "", text: "u1" },
    {
      type: "assistant/message",
      at: "",
      text: "",
      toolCalls: [{ id: "c1", name: "r", args: {} }],
      stopReason: "tool",
      opaque: thinking,
    },
    { type: "tool/result", at: "", callId: "c1", name: "r", content: "R1", isError: false },
    {
      type: "assistant/message",
      at: "",
      text: "a1",
      toolCalls: [],
      stopReason: "end",
      opaque: thinking,
    },
    { type: "user/message", at: "", text: "u2" },
    {
      type: "assistant/message",
      at: "",
      text: "a2",
      toolCalls: [],
      stopReason: "end",
      opaque: thinking,
    },
  ];
}

describe("压缩与清除是编辑点", () => {
  it("摘要消息与被清除的工具结果标 edited;Anthropic 之后的思考块不再回传", () => {
    const events: AgentEvent[] = [...base(), { type: "compaction", at: "", cleared: [3] }];
    const msgs = deriveMessages(events);
    expect(msgs[3]).toMatchObject({ role: "tool", edited: true });
    const wire = toAnthropicWire(msgs, { model: "m" });
    const assistants = wire.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.content.some((b) => b.type === "thinking")).toBe(true);
    expect(assistants[1]?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(assistants[2]?.content.some((b) => b.type === "thinking")).toBe(false);

    const summarized: AgentEvent[] = [
      ...base(),
      { type: "compaction", at: "", summary: "摘要", coversFrom: 2, coversUpTo: 5 },
    ];
    const m2 = deriveMessages(summarized);
    expect(m2[2]).toMatchObject({ role: "user", edited: true });
    const w2 = toAnthropicWire(m2, { model: "m" });
    expect(w2.messages.some((m) => m.content.some((b) => b.type === "thinking"))).toBe(false);
  });
});

describe("Anthropic 编辑点断点", () => {
  it("第一条改过的消息之前那条挂 cache_control,系统与末条照旧,共三个断点", () => {
    const events: AgentEvent[] = [
      ...base(),
      { type: "context/edit", at: "", target: 5, field: "content", value: "u2 改" },
    ];
    const wire = toAnthropicWire(deriveMessages(events), { model: "m", cache: true });
    const marked = wire.messages
      .map((m, i) => ({ i, hit: m.content.some((b) => "cache_control" in b) }))
      .filter((x) => x.hit)
      .map((x) => x.i);
    // wire 消息:0 user u1 · 1 assistant(tool_use) · 2 user(tool_result) · 3 assistant a1 · 4 user u2(改) · 5 assistant a2
    expect(marked).toEqual([3, 5]);
    expect(JSON.stringify(wire.system)).toContain("cache_control");
  });
});

describe("变化说明里的编辑点与预计命中", () => {
  const req: Extract<AgentEvent, { type: "request" }> = {
    type: "request",
    at: "",
    model: "m",
    messages: 6,
    tools: [],
    estimatedTokens: 100,
    reason: "turn",
  };
  it("有编辑点时多一行,写明从哪条起重算、丢几条思考;预计命中与实测并排", () => {
    const events: AgentEvent[] = [
      ...base(),
      { type: "context/edit", at: "", target: 5, field: "content", value: "u2 改" },
    ];
    const prev = deriveMessages(base());
    const cur = deriveMessages(events);
    // 编辑点信息在变化说明里:改了哪条、从哪起重算、丢几条思考、预计命中上限。
    const edit = plain(
      changeNote({ n: 3, request: req, messages: cur, previous: prev, dropsThinking: true }) ?? "",
    );
    expect(edit.startsWith("✎ ")).toBe(true);
    expect(edit).toContain("1 edited (#6)");
    expect(edit).toContain("2 after prefix");
    expect(edit).toContain("1 thinking block dropped");
    expect(edit).toMatch(/unchanged ≈\S+ tok/);
    const predicted = predictedCache(prev, cur);
    expect(predicted).toBeGreaterThan(0);
    // 实测命中明显低于预计时才有缓存说明;预计与实测并排。
    const note = plain(
      cacheNote({ inputTokens: 5000, outputTokens: 5, cacheReadTokens: 1000 }, 4000) ?? "",
    );
    expect(note).toMatch(/^≈ cache hit 20% · \S+ of \S+ tok · unchanged text ≈\S+ tok$/);
  });
});

describe("/retry", () => {
  it("丢掉最后一条助手消息(连同工具结果)并从当前投影重跑,不加用户消息", async () => {
    const log = new EventLog();
    for (const e of base()) log.append(e);
    const seen: number[] = [];
    const provider: Provider = {
      model: "m",
      async complete(messages): Promise<AssistantTurn> {
        seen.push(messages.length);
        return { text: "重来", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent({ log, provider, tools: [] });
    expect(await agent.retry()).toBe("idle");
    const drop = log.events.find((e) => e.type === "context/drop");
    expect(drop).toMatchObject({ target: 6, note: "retry" });
    // 投影里最后是 u2,没有新增用户消息;重跑的响应接在后面。
    expect(seen).toEqual([6]);
    const msgs = deriveMessages(log.events);
    expect(msgs.at(-2)).toMatchObject({ role: "user", content: "u2" });
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: "重来" });
    expect(log.events.filter((e) => e.type === "user/message")).toHaveLength(2);
    // 再 retry 一次:跳过已丢弃的,丢新的那条。
    await agent.retry();
    const drops = log.events
      .filter((e) => e.type === "context/drop")
      .map((e) => (e as { target: number }).target);
    expect(drops[1]).toBe(log.events.length - 4);
  });

  it("当前投影没有助手消息时拒绝重试,不重新发送被摘要覆盖的回答", async () => {
    for (const history of [
      [{ type: "session/start", at: "", model: "m", system: "S" }],
      [
        ...base(),
        { type: "compaction", at: "", summary: "Earlier work", coversFrom: 2, coversUpTo: 7 },
      ],
    ] as AgentEvent[][]) {
      const log = new EventLog();
      for (const event of history) log.append(event);
      let calls = 0;
      const agent = new Agent({
        log,
        provider: {
          model: "m",
          async complete() {
            calls++;
            return { text: "", toolCalls: [], stopReason: "end" };
          },
        },
        tools: [],
      });
      await expect(agent.retry()).rejects.toThrow(/no assistant message to retry/);
      expect(calls).toBe(0);
    }
  });
});
