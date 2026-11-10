// 界面运行与长会话回放的性能:防止每段增量或每次恢复重复处理累计全文。
// ① 原样投影按事件对象缓存 → 两次投影里同一事件给同一个消息对象;upTo 参数不复制前缀。
// ② 会话累计用量增量累加,与一次性扫描结果一致。
// ③ 界面回放 2000+ 事件的会话在秒级以内(原先 2 秒起,9000 事件 48 秒)。
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { UsageAccumulator, usageTotals } from "../src/cost.js";
import { EventLog } from "../src/log.js";
import { composeContext } from "../src/messages.js";
import type { Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function bigSession(turns: number): EventLog {
  const log = new EventLog();
  const at = "2026-09-05T00:00:00.000Z";
  log.append({ type: "session/start", at, model: "m", system: "S".repeat(2000) });
  log.append({ type: "user/message", at, text: "start" });
  for (let i = 0; i < turns; i++) {
    log.append({
      type: "request",
      at,
      model: "m",
      messages: 2 + i * 3,
      tools: ["bash"],
      estimatedTokens: i * 600,
      threshold: 99000,
      reason: "turn",
    });
    log.append({
      type: "assistant/message",
      at,
      text: `step ${i}`,
      toolCalls: [{ id: `c${i}`, name: "bash", args: { command: `echo ${i}` } }],
      stopReason: "tool",
      usage: { inputTokens: i * 600, outputTokens: 20, cacheReadTokens: i * 100 },
      latencyMs: 800,
    });
    log.append({
      type: "tool/result",
      at,
      callId: `c${i}`,
      name: "bash",
      content: "out".repeat(300),
      isError: false,
      durationMs: 5,
    });
  }
  return log;
}

const slack = process.env.CI ? 3 : 1;
const ms = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe("投影缓存", () => {
  it("原样消息在两次投影里是同一个对象;改过的不缓存;upTo 与切片前缀等价", () => {
    const log = bigSession(5);
    const a = composeContext(log.events);
    const b = composeContext(log.events);
    expect(a.messages.length).toBe(b.messages.length);
    for (let i = 0; i < a.messages.length; i++) expect(a.messages[i]).toBe(b.messages[i]);
    const prefix = composeContext(log.events.slice(0, 8));
    const bounded = composeContext(log.events, 8);
    expect(bounded.messages).toEqual(prefix.messages);
    expect(bounded.provenance).toEqual(prefix.provenance);
    expect(bounded.messages.length).toBeLessThan(a.messages.length);
    log.append({ type: "context/edit", at: "", target: 1, field: "content", value: "changed" });
    const c = composeContext(log.events);
    expect(c.messages[1]).not.toBe(a.messages[1]);
    expect(c.messages[1]).toMatchObject({ content: "changed", edited: true });
    expect(c.messages[2]).toBe(a.messages[2]);
    // 缓存的对象不会被投影改动:再来一次,内容一致
    expect(composeContext(log.events).messages[2]).toEqual(a.messages[2]);
  });
});

describe("用量累计", () => {
  it("增量累加与一次性扫描逐字段相同,含价格与模型切换", () => {
    const log = bigSession(20);
    log.append({ type: "session/model", at: "", model: "m2" });
    log.append({
      type: "compaction",
      at: "",
      summary: "s",
      coversFrom: 1,
      coversUpTo: 10,
      usage: { inputTokens: 500, outputTokens: 50 },
    });
    const priceFor = (model: string) =>
      model === "m2" ? { input: 2, output: 4 } : { input: 1, output: 2, cacheRead: 0.1 };
    const acc = new UsageAccumulator(priceFor);
    for (const e of log.events) acc.add(e);
    expect(acc.totals()).toEqual(usageTotals(log.events, priceFor));
    expect(acc.totals().requests).toBe(21);
    expect(new UsageAccumulator().totals().cost).toBeUndefined();
  });
});

describe("界面运行与回放", () => {
  it("5000 段思考增量的接收回调在 100ms 内,最终原文与展开内容完整", async () => {
    const reasoning = `${"Reasoning 中文 0123456789.\n".repeat(5000)}FINAL_THINKING`;
    let took = 0;
    const provider: Provider = {
      model: "m",
      async complete(_messages, _tools, opts) {
        took = ms(() => {
          for (let i = 0; i < 5000; i++)
            opts?.onStream?.({ type: "reasoning/delta", delta: "Reasoning 中文 0123456789.\n" });
          opts?.onStream?.({ type: "reasoning/delta", delta: "FINAL_THINKING" });
        });
        opts?.onStream?.({ type: "text/delta", delta: "FINAL_REPLY" });
        return { text: "FINAL_REPLY", reasoning, toolCalls: [], stopReason: "end" };
      },
    };
    const log = new EventLog();
    const app = createTuiApp({
      terminal: new VirtualTerminal(80, 30),
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 1000000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      onExit: () => {},
    });
    try {
      await app.submit("measure");
      expect(took).toBeLessThan(100 * slack);
      expect(log.events.find((event) => event.type === "assistant/message")).toMatchObject({
        reasoning,
        text: "FINAL_REPLY",
      });
      app.toggleReasoning();
      const lines = stripAnsi(app.lines(80).join("\n"));
      expect(lines).toContain("FINAL_THINKING");
      expect(lines).toContain("FINAL_REPLY");
    } finally {
      app.stop();
    }
  });

  it("2102 条事件的会话回放在 1.5 秒内,画面完整(最新三步展开、旧步各一行账目)", () => {
    const log = bigSession(700);
    const provider: Provider = {
      model: "m",
      wire: (messages, tools) => ({ model: "m", messages, tools }),
      async complete() {
        throw new Error("x");
      },
    };
    let app: ReturnType<typeof createTuiApp> | undefined;
    const took = ms(() => {
      app = createTuiApp({
        terminal: new VirtualTerminal(120, 40),
        log,
        provider,
        tools: [],
        compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
        reserveTokens: 1000,
        info: { model: "m", providerName: "p", sessionFile: "s", resumed: true },
        onExit: () => {},
      });
    });
    expect(took).toBeLessThan(1500 * slack);
    const lines = (app as ReturnType<typeof createTuiApp>).lines(120).join("\n");
    expect(lines).toContain("resumed: 2102 events");
    // 最新三步显示请求边界,其余 697 步各折成一行账目。
    expect(stripAnsi(lines).match(/── Request #/g)?.length).toBe(3);
    expect(stripAnsi(lines).match(/≡ Request #/g)?.length).toBe(697);
    (app as ReturnType<typeof createTuiApp>).stop();
  });
});
