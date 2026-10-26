import { describe, expect, it } from "vitest";
import {
  clearToolResults,
  estimateAfter,
  keepRatio,
  keepRecentTokens,
  legalizeCut,
  llmSummarize,
  pipeline,
} from "../src/compaction.js";
import { summaryPrompt } from "../src/compaction-presets.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { CLEARED_PLACEHOLDER, deriveMessages, type Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";

function ev(events: Partial<AgentEvent>[]): AgentEvent[] {
  return events as AgentEvent[];
}

const BASE: AgentEvent[] = ev([
  { type: "session/start", at: "t", model: "m", system: "系统提示" },
  { type: "user/message", at: "t", text: "任务:修复测试" },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    stopReason: "tool",
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c1",
    name: "read",
    content: "x".repeat(400),
    isError: false,
  },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c2", name: "bash", args: { command: "pnpm test" } }],
    stopReason: "tool",
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c2",
    name: "bash",
    content: "y".repeat(400),
    isError: false,
  },
  { type: "assistant/message", at: "t", text: "修好了", toolCalls: [], stopReason: "end" },
  { type: "user/message", at: "t", text: "继续下一个" },
]);

describe("投影处理 compaction 事件", () => {
  it("摘要覆盖区被跳过,摘要在覆盖起点注入;首条用户消息豁免可见", () => {
    const events = [
      ...BASE,
      { type: "compaction", at: "t", summary: "前段摘要", coversFrom: 2, coversUpTo: 7 },
    ] as AgentEvent[];
    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(msgs[1]).toMatchObject({ content: "任务:修复测试" });
    expect(msgs[2]?.content).toContain("前段摘要");
    expect(msgs[3]).toMatchObject({ content: "继续下一个" });
  });

  it("被清除的工具结果换成占位文本,其余原样", () => {
    const events = [...BASE, { type: "compaction", at: "t", cleared: [3] }] as AgentEvent[];
    const msgs = deriveMessages(events);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]?.content).toBe(CLEARED_PLACEHOLDER);
    expect(tools[1]?.content).toBe("y".repeat(400));
  });

  it("多次压缩:取最新摘要,清除集合并集", () => {
    const events = [
      ...BASE,
      { type: "compaction", at: "t", cleared: [3] },
      {
        type: "compaction",
        at: "t",
        summary: "新摘要",
        coversFrom: 2,
        coversUpTo: 5,
        cleared: [5],
      },
    ] as AgentEvent[];
    const msgs = deriveMessages(events);
    expect(msgs.some((m) => m.content.includes("新摘要"))).toBe(true);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1); // idx3 被摘要覆盖,idx5 被清除但可见
    expect(tools[0]?.content).toBe(CLEARED_PLACEHOLDER);
  });
});

describe("legalizeCut / keepRecentTokens", () => {
  it("切点不落在工具结果上(不拆调用对)", () => {
    expect(legalizeCut(BASE, 3)).toBe(2); // idx3 是 tool/result → 退到 assistant
    expect(legalizeCut(BASE, 7)).toBe(7); // idx7 是 assistant,合法
    const notice: AgentEvent = {
      type: "request",
      at: "t",
      model: "m",
      messages: 0,
      tools: [],
      estimatedTokens: 0,
      threshold: 100,
      reason: "turn",
    };
    const parallel: AgentEvent[] = [
      BASE[0] as AgentEvent,
      BASE[2] as AgentEvent,
      ...Array.from({ length: 20000 }, () => BASE[3] as AgentEvent),
      notice,
    ];
    expect(legalizeCut(parallel, parallel.length - 2)).toBe(1);
    expect(legalizeCut(parallel, parallel.length - 1)).toBe(parallel.length - 1);
    expect(legalizeCut(parallel, parallel.length)).toBe(parallel.length);
    // 不可见事件可留在切点,但其后的工具结果仍须回退到调用。
    expect(
      legalizeCut([BASE[0] as AgentEvent, BASE[2] as AgentEvent, notice, BASE[3] as AgentEvent], 2),
    ).toBe(1);
    expect(legalizeCut([BASE[0] as AgentEvent, notice, BASE[2] as AgentEvent], 1)).toBe(1);
  });

  it("固定与比例预算按当前投影累计,保留合法尾部", () => {
    const cut = keepRecentTokens(50)(BASE);
    expect(cut).toBeGreaterThan(1);
    expect(BASE[cut]?.type === "tool/result").toBe(false);

    // 保留预算应按当前内容计算,不能因修改前的长正文而少留近期原文。
    const original = ev([
      { type: "session/start", system: "s" },
      { type: "user/message", text: "task" },
      {
        type: "assistant/message",
        text: "old history ".repeat(10000),
        toolCalls: [],
        stopReason: "end",
      },
      { type: "user/message", text: "u".repeat(40000) },
      { type: "assistant/message", text: "a".repeat(40000), toolCalls: [], stopReason: "end" },
      { type: "user/message", text: "next" },
    ]);
    const edited = ev([
      ...original,
      { type: "context/edit", target: 4, field: "text", value: "short" },
    ]);
    const shortened = original.map((event, i) =>
      i === 4 ? ({ ...event, text: "short" } as AgentEvent) : event,
    );
    for (const policy of [keepRecentTokens(), keepRatio(0.5)]) {
      expect(policy(edited)).toBe(3);
      expect(policy(edited)).toBe(policy(shortened));
    }
    const dropped = ev([...original, { type: "context/drop", target: 4 }]);
    expect(keepRecentTokens()(dropped)).toBe(3);

    // 清除结果只占占位文本预算;合法化仍保留它对应的调用。
    const cleared = ev([...BASE, { type: "compaction", cleared: [3, 5] }]);
    expect(keepRecentTokens(100)(cleared)).toBe(1);
    const summarized = ev([
      ...original,
      { type: "compaction", summary: "short history", coversFrom: 2, coversUpTo: 5 },
    ]);
    expect(keepRecentTokens(100)(summarized)).toBe(1);
  });
});

describe("clearToolResults", () => {
  it("保最近 keepRecent 个,清除更旧的", async () => {
    const p = await clearToolResults({ keepRecent: 1, clearAtLeast: 10 })({
      events: BASE,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toMatchObject({ cleared: [3] });
  });

  it("清除量不足 clearAtLeast 不动手", async () => {
    const p = await clearToolResults({ keepRecent: 1, clearAtLeast: 99999 })({
      events: BASE,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toBeNull();
  });

  it("已清除过的不重复计入", async () => {
    const events = [...BASE, { type: "compaction", at: "t", cleared: [3] }] as AgentEvent[];
    const p = await clearToolResults({ keepRecent: 0, clearAtLeast: 10 })({
      events,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toMatchObject({ cleared: [5] });

    // 已排除或改短的结果不能凭旧文本触发清除,也不占近期结果名额。
    const revised = ev([
      ...BASE,
      { type: "context/drop", target: 2 },
      { type: "context/edit", target: 5, field: "content", value: "short" },
    ]);
    expect(
      await clearToolResults({ keepRecent: 0, clearAtLeast: 10 })({
        events: revised,
        window: 1000,
        targetTokens: 500,
      }),
    ).toBeNull();
  });
});

function fakeProvider(reply: string, capture?: { messages?: Message[] }): Provider {
  return {
    model: "fake",
    async complete(messages) {
      if (capture) capture.messages = messages;
      return { text: reply, toolCalls: [], stopReason: "end" };
    },
  };
}

describe("llmSummarize", () => {
  it("replay 模式:请求 = 前缀投影 + 指令;载荷含覆盖范围与程序化文件清单", async () => {
    const capture: { messages?: Message[] } = {};
    const p = await llmSummarize()({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("摘要内容", capture),
      preservation: () => 7,
    });
    expect(p).not.toBeNull();
    expect(p).toMatchObject({ coversFrom: 2, coversUpTo: 7 });
    expect(p?.summary).toContain("摘要内容");
    expect(p?.summary).toContain("Files read: a.ts");
    // 最后一条是摘要指令,其前是前缀投影
    const last = capture.messages?.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(summaryPrompt("pi"));
    expect(capture.messages?.[0]?.role).toBe("system");
    // 小窗口不能暗中缩减默认保留预算,让本来很短的历史又被摘要。
    const shortCapture: { messages?: Message[] } = {};
    const short = ev([
      ...BASE.slice(0, 5),
      {
        type: "tool/result",
        at: "t",
        callId: "c2",
        name: "bash",
        isError: false,
        content: "x".repeat(12000),
      },
      ...BASE.slice(6),
    ]);
    expect(
      await llmSummarize()({
        events: short,
        window: 4000,
        targetTokens: 2000,
        provider: fakeProvider("unused", shortCapture),
      }),
    ).toBeNull();
    expect(shortCapture.messages).toBeUndefined();
  });

  it("手动指示拼进提示词", async () => {
    const capture: { messages?: Message[] } = {};
    await llmSummarize()({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("摘要", capture),
      preservation: () => 7,
      instructions: "重点保留报错",
    });
    expect(capture.messages?.at(-1)?.content).toContain("重点保留报错");
  });

  it("摘要读取当前修订,排除的调用与文件不复活,保留尾部不发送", async () => {
    const events = ev([
      ...BASE,
      { type: "context/edit", target: 0, field: "system", value: "Current system" },
      { type: "context/edit", target: 5, field: "content", value: "CORRECTED ".repeat(100) },
      { type: "context/drop", target: 2 },
    ]);
    for (const callStyle of ["replay", "standalone"] as const) {
      const capture: { messages?: Message[] } = {};
      const p = await llmSummarize({ callStyle })({
        events,
        window: 100000,
        targetTokens: 50000,
        provider: fakeProvider("Updated summary", capture),
        preservation: () => 7,
      });
      expect(p).toMatchObject({ summary: "Updated summary", coversFrom: 2, coversUpTo: 7 });
      const input = JSON.stringify(capture.messages);
      expect(input).toContain("Current system");
      expect(input).toContain("CORRECTED");
      expect(input).not.toContain("x".repeat(400));
      expect(input).not.toContain("y".repeat(400));
      expect(input).not.toContain("a.ts");
      expect(input).not.toContain("继续下一个");
      if (callStyle === "replay")
        expect(capture.messages?.slice(0, -1)).toEqual(deriveMessages(events).slice(0, -1));
      expect(
        deriveMessages([...events, { type: "compaction", at: "t", ...p }]).at(-1),
      ).toMatchObject({ role: "user", content: "继续下一个" });
    }
    expect(BASE[5]).toMatchObject({ content: "y".repeat(400) });
  });

  it("再次摘要携带旧摘要,晚到的未知结果跟随对应调用,恢复投影一致", async () => {
    const events = ev([
      ...BASE.slice(0, 5),
      ...BASE.slice(6, 8),
      { type: "compaction", summary: "PREVIOUS ".repeat(80), coversFrom: 2, coversUpTo: 4 },
      { type: "tool/unresolved", callEvent: 4, callId: "c2", name: "bash", content: "UNKNOWN" },
      { type: "context/edit", target: 8, field: "content", value: "UNKNOWN_REVISED" },
    ]);
    const capture: { messages?: Message[] } = {};
    const p = await llmSummarize()({
      events,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("Merged summary", capture),
      preservation: () => 6,
    });
    expect(p).toMatchObject({ coversFrom: 2, coversUpTo: 6 });
    expect(capture.messages?.slice(0, -1)).toEqual(deriveMessages(events).slice(0, -1));
    expect(capture.messages?.[2]?.content).toContain("PREVIOUS");
    expect(capture.messages?.[4]).toMatchObject({
      role: "tool",
      callId: "c2",
      content: "UNKNOWN_REVISED",
    });
    expect(JSON.stringify(capture.messages)).not.toContain("x".repeat(400));
    const completed = [...events, { type: "compaction", at: "t", ...p }] as AgentEvent[];
    expect(deriveMessages(JSON.parse(JSON.stringify(completed)))).toEqual(
      deriveMessages(completed),
    );
    expect(deriveMessages(completed).map((m) => m.content)).toEqual([
      "系统提示",
      "任务:修复测试",
      "[Earlier conversation was compacted; summary follows]\nMerged summary",
      "继续下一个",
    ]);
  });

  it("完整性不可关闭;旧收益条件只在显式 reduced 策略下生效", async () => {
    for (const stopReason of ["length", "tool", "aborted"] as const) {
      await expect(
        llmSummarize()({
          events: BASE,
          window: 100000,
          targetTokens: 50000,
          provider: {
            model: "fake",
            async complete() {
              return { text: "残缺摘要", toolCalls: [], stopReason };
            },
          },
          preservation: () => 7,
        }),
      ).rejects.toThrow(`Summary did not finish (${stopReason})`);
    }
    const p = await llmSummarize({ acceptance: "reduced" })({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("废".repeat(2000)),
      preservation: () => 7,
    });
    expect(p).toBeNull();
    // 原始正文很大,但当前有效内容很小;不能用旧大小放行一个反而变长的摘要。
    const revised = ev([
      ...BASE,
      { type: "context/drop", target: 2 },
      { type: "context/edit", target: 5, field: "content", value: "short" },
    ]);
    expect(
      await llmSummarize({ acceptance: "reduced" })({
        events: revised,
        window: 100000,
        targetTokens: 50000,
        provider: fakeProvider("s".repeat(200)),
        preservation: () => 7,
      }),
    ).toBeNull();
    expect(
      await llmSummarize({ acceptance: "smaller" })({
        events: revised,
        window: 100000,
        targetTokens: 50000,
        provider: fakeProvider("s".repeat(200)),
        preservation: () => 7,
      }),
    ).toBeNull();
  });
});

describe("pipeline", () => {
  it("清除已达标则不再调用摘要", async () => {
    let summarizeCalled = 0;
    const spy: Provider = {
      model: "fake",
      async complete() {
        summarizeCalled++;
        return { text: "摘要", toolCalls: [], stopReason: "end" };
      },
    };
    const target = estimateAfter(BASE, { cleared: [3] }) + 1;
    const p = await pipeline(
      clearToolResults({ keepRecent: 1, clearAtLeast: 10 }),
      llmSummarize(),
    )({
      events: BASE,
      window: 100000,
      targetTokens: target,
      provider: spy,
      preservation: () => 7,
    });
    expect(p?.cleared).toEqual([3]);
    expect(p?.summary).toBeUndefined();
    expect(summarizeCalled).toBe(0);
  });

  it("清除不够则叠加摘要,载荷合并", async () => {
    const p = await pipeline(
      clearToolResults({ keepRecent: 1, clearAtLeast: 10 }),
      llmSummarize(),
    )({
      events: BASE,
      window: 100000,
      targetTokens: 1, // 永远不达标 → 两段都跑
      provider: fakeProvider("摘要内容"),
      preservation: () => 7,
    });
    expect(p?.cleared).toEqual([3]);
    expect(p?.summary).toContain("摘要内容");
  });
});

describe("循环触发", () => {
  function log(): EventLog {
    const l = new EventLog();
    for (const e of BASE) l.append(e);
    return l;
  }

  it("超阈值时自动压缩,压缩事件先于下一次请求落盘", async () => {
    const l = log();
    const turns: AssistantTurn[] = [{ text: "好", toolCalls: [], stopReason: "end" }];
    const provider: Provider = {
      model: "fake",
      async complete() {
        const t = turns.shift();
        if (!t) throw new Error("越界");
        return t;
      },
    };
    await runTurn({
      log: l,
      provider,
      tools: [],
      compaction: {
        strategy: clearToolResults({ keepRecent: 0, clearAtLeast: 10 }),
        window: 3000, // 余量线 2900 不触发;比例线 150 触发。
        reserveTokens: 100,
        ratio: 0.05,
      },
    });
    const types = l.events.map((e) => e.type);
    expect(types).toContain("compaction");
    expect(types.indexOf("compaction")).toBeLessThan(types.lastIndexOf("assistant/message"));
    expect(l.events.filter((e) => e.type === "request").at(-1)).toMatchObject({ threshold: 150 });
  });

  it("溢出恢复:压缩取得进展才重试,后续工具续做标记普通请求", async () => {
    const l = log();
    let calls = 0;
    const provider: Provider = {
      model: "fake",
      async complete() {
        calls++;
        if (calls === 1) throw new Error("maximum context length exceeded");
        return calls === 2
          ? {
              text: "继续核实",
              toolCalls: [{ id: "check", name: "missing", args: {} }],
              stopReason: "tool",
            }
          : { text: "恢复了", toolCalls: [], stopReason: "end" };
      },
    };
    const outcome = await runTurn({
      log: l,
      provider,
      tools: [],
      compaction: {
        strategy: clearToolResults({ keepRecent: 0, clearAtLeast: 10 }),
        window: 100000, // 不触发自动,只走溢出路径
        reserveTokens: 100,
      },
    });
    expect(outcome).toBe("idle");
    expect(calls).toBe(3);
    expect(l.events.some((e) => e.type === "compaction")).toBe(true);
    expect(l.events.filter((e) => e.type === "request").map((e) => e.reason)).toEqual([
      "turn",
      "overflow-retry",
      "turn",
    ]);
  });

  it("溢出但压缩无进展:原样抛出", async () => {
    const l = log();
    const provider: Provider = {
      model: "fake",
      async complete() {
        throw new Error("maximum context length exceeded");
      },
    };
    await expect(
      runTurn({
        log: l,
        provider,
        tools: [],
        compaction: {
          strategy: async () => null, // 无能为力的策略
          window: 100000,
          reserveTokens: 100,
        },
      }),
    ).rejects.toThrow("maximum context length");
  });

  it("应用条件控制是否保留候选;完整但变长的摘要不能触发溢出重发", async () => {
    const events = ev([
      { type: "session/start", model: "m", system: "system" },
      { type: "user/message", text: "Keep this request" },
      { type: "assistant/message", text: "x".repeat(2000), toolCalls: [], stopReason: "end" },
      { type: "assistant/message", text: "x".repeat(2000), toolCalls: [], stopReason: "end" },
      { type: "user/message", text: "Continue" },
    ]);
    for (const acceptance of ["reduced", "smaller", "complete"] as const) {
      for (const length of [3800, 4500]) {
        const log = new EventLog();
        for (const event of events) log.append(event);
        let calls = 0;
        await runTurn({
          log,
          provider: {
            model: "summary",
            async complete(_messages, _tools, options) {
              calls++;
              expect(options?.maxTokens).toBe(512);
              return { text: "s".repeat(length), toolCalls: [], stopReason: "end" };
            },
          },
          tools: [],
          manualCompaction: "",
          compaction: {
            strategy: llmSummarize({ acceptance, maxTokens: 512 }),
            acceptance,
            window: 100000,
            preservation: () => 4,
          },
        });
        expect(calls).toBe(1);
        const applied = acceptance === "complete" || (acceptance === "smaller" && length === 3800);
        expect(log.events.some((event) => event.type === "compaction")).toBe(applied);
        expect(log.events.find((event) => event.type === "request")).toMatchObject({
          reason: "compaction",
          maxTokens: 512,
        });
        expect(log.events.slice(0, events.length)).toEqual(events);
      }
    }

    const log = new EventLog();
    for (const event of events) log.append(event);
    let calls = 0;
    await expect(
      runTurn({
        log,
        provider: {
          model: "m",
          async complete(_messages, _tools, options) {
            calls++;
            if (calls === 1) throw new Error("maximum context length exceeded");
            // 显式 0 继承 provider,不能恢复为内置摘要上限。
            expect(options?.maxTokens).toBeUndefined();
            return { text: "s".repeat(4500), toolCalls: [], stopReason: "end" };
          },
        },
        tools: [],
        compaction: {
          strategy: llmSummarize({ maxTokens: 0 }),
          acceptance: "complete",
          window: 100000,
          preservation: () => 4,
        },
      }),
    ).rejects.toThrow("maximum context length");
    expect(calls).toBe(2);
    expect(log.events.some((event) => event.type === "compaction")).toBe(true);
    expect(
      log.events.filter((event) => event.type === "request").map((event) => event.reason),
    ).toEqual(["turn", "compaction"]);
  });
});
