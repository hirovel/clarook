// 事实附注与计划复述:代码算的事实贴在产生它的事件上,模型写的计划只在压缩后或久未更新时复述到末尾;
// 两者都只追加,前缀不动。还量了三种注入方式的重算代价,证明"贴在事件上"是缓存代价最低的一种。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { buildTools } from "../cli/bootstrap.js";
import { unchangedPrefix } from "../cli/cards.js";
import { messageTokens } from "../src/context.js";
import type { AgentEvent, ToolCall } from "../src/events.js";
import { annotateResult, dateNote, priorFailures, slowNote } from "../src/facts.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { deriveMessages, type Message } from "../src/messages.js";
import { planState, planText, planTool, stepsSincePlan } from "../src/plan.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const turn = turns[Math.min(i, turns.length - 1)] as AssistantTurn;
      i += 1;
      return turn;
    },
  };
}

const failTool = defineTool({
  name: "fail",
  description: "always fails",
  parameters: Type.Object({ path: Type.String() }),
  async execute() {
    throw new Error("no such file");
  },
});

const echoTool = defineTool({
  name: "echo",
  description: "echo",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function newLog(): EventLog {
  const log = new EventLog();
  log.append({
    type: "session/start",
    at: "2026-09-06T10:00:00.000Z",
    model: "fake",
    system: "sys",
  });
  log.append({ type: "user/message", at: "2026-09-06T10:00:00.000Z", text: "go" });
  return log;
}

const call = (name: string, args: unknown, id: string): ToolCall => ({ id, name, args });

describe("事实附注", () => {
  it("同一工具同样参数再次失败,结果末尾说此前失败过几次;参数不同不算;成功不算", async () => {
    const log = newLog();
    const c = (id: string, path = "a.txt") => ({
      text: "",
      toolCalls: [call("fail", { path }, id)],
      stopReason: "tool" as const,
    });
    await runTurn({
      log,
      provider: scripted([
        c("c1"),
        c("c2"),
        c("c3", "b.txt"),
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [failTool],
    });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results[0]?.type === "tool/result" && results[0].content).not.toContain("[note:");
    expect(results[1]?.type === "tool/result" && results[1].content).toContain(
      "[note: fail failed with exactly these arguments 1 time before in this session]",
    );
    expect(results[2]?.type === "tool/result" && results[2].content).not.toContain("[note:");
    // 关掉就没有
    const log2 = newLog();
    await runTurn({
      log: log2,
      provider: scripted([c("c1"), c("c2"), { text: "", toolCalls: [], stopReason: "end" }]),
      tools: [failTool],
      facts: { repeats: false },
    });
    expect(log2.events.some((e) => e.type === "tool/result" && e.content.includes("[note:"))).toBe(
      false,
    );
    expect(priorFailures(log.events, call("fail", { path: "a.txt" }, "x"))).toBe(2);
  });

  it("慢调用:至少三个样本、至少 30 秒、超过中位五倍才说;日期变了才说", () => {
    const at = "2026-09-06T10:00:00.000Z";
    const events: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "s" },
      ...[200, 300, 400].map(
        (d, i): AgentEvent => ({
          type: "tool/result",
          at,
          callId: `r${i}`,
          name: "bash",
          content: "",
          isError: false,
          durationMs: d,
        }),
      ),
    ];
    expect(slowNote(events, "bash", 45_000)).toBe(
      "this bash call took 45s; the median for bash in this session is 0.3s",
    );
    expect(slowNote(events, "bash", 20_000)).toBeUndefined(); // 不到 30 秒
    expect(slowNote(events.slice(0, 3), "bash", 45_000)).toBeUndefined(); // 样本不够
    expect(slowNote(events, "read", 45_000)).toBeUndefined();
    expect(
      annotateResult(events, call("bash", { command: "x" }, "c"), {
        content: "out",
        isError: false,
        durationMs: 45_000,
      }),
    ).toBe("out\n\n[note: this bash call took 45s; the median for bash in this session is 0.3s]");

    expect(dateNote(events, new Date("2026-09-07T01:00:00Z"))).toBeUndefined(); // 还没有请求
    const withRequest: AgentEvent[] = [
      ...events,
      {
        type: "request",
        at,
        model: "m",
        messages: 1,
        tools: [],
        estimatedTokens: 1,
        reason: "turn",
      },
    ];
    expect(dateNote(withRequest, new Date("2026-09-06T23:00:00Z"))).toBeUndefined();
    expect(dateNote(withRequest, new Date("2026-09-07T01:00:00Z"))).toBe(
      "The date is now 2026-09-07.",
    );
  });

  it("日期变化以一条用户消息追加在请求之前,并记 facts 决策", async () => {
    const log = newLog();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    log.append({
      type: "request",
      at: yesterday,
      model: "fake",
      messages: 2,
      tools: [],
      estimatedTokens: 1,
      reason: "turn",
    });
    log.append({
      type: "assistant/message",
      at: yesterday,
      text: "hi",
      toolCalls: [],
      stopReason: "end",
    });
    log.append({ type: "user/message", at: yesterday, text: "again" });
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      tools: [],
    });
    const i = log.events.findIndex((e) => e.type === "decision" && e.slot === "facts");
    expect(i).toBeGreaterThan(0);
    const next = log.events[i + 1];
    expect(next?.type === "user/message" && next.text).toMatch(
      /^The date is now \d{4}-\d{2}-\d{2}\.$/,
    );
    expect(log.events[i + 2]?.type).toBe("request");
  });

  it("bash 的工作目录跨调用保持:cd 之后下一次从那里起,结果末尾说目录变了", async () => {
    const make = () => {
      const tool = buildTools().find((t) => t.name === "bash");
      if (!tool) throw new Error("missing bash tool");
      return tool;
    };
    const tool = make();
    const sibling = make();
    const signal = new AbortController().signal;
    const first = await tool.execute({ command: "cd .. && echo moved" }, { signal });
    expect(first).toMatch(/^moved\n\[cwd is now .+\]$/);
    const second = await tool.execute({ command: "pwd -W 2>/dev/null || pwd" }, { signal });
    expect(second).not.toContain("[cwd");
    expect(second.replace(/\\/g, "/").toLowerCase()).toBe(
      (first.match(/\[cwd is now (.+)\]/)?.[1] ?? "").replace(/\\/g, "/").toLowerCase(),
    );
    const same = await tool.execute({ command: "echo still" }, { signal });
    expect(same).toBe("still");
    for (const independent of [sibling, make()]) {
      const pwd = await independent.execute({ command: "pwd -W 2>/dev/null || pwd" }, { signal });
      expect(pwd.replace(/\\/g, "/").toLowerCase()).toBe(
        process.cwd().replace(/\\/g, "/").toLowerCase(),
      );
    }
  });
});

describe("计划复述", () => {
  const plan = (id: string, items: { text: string; status: string }[]): AssistantTurn => ({
    text: "",
    toolCalls: [call("plan", { items }, id)],
    stopReason: "tool",
  });
  const echo = (id: string): AssistantTurn => ({
    text: "",
    toolCalls: [call("echo", { text: id }, id)],
    stopReason: "tool",
  });

  it("模型写计划;连续 planReminder 步没碰且有未完成项才复述一次,记 plan 决策;完成后不再复述", async () => {
    const log = newLog();
    const turns: AssistantTurn[] = [
      plan("p1", [
        { text: "read", status: "done" },
        { text: "fix", status: "in_progress" },
        { text: "test", status: "pending" },
      ]),
      ...Array.from({ length: 4 }, (_, i) => echo(`e${i}`)),
      plan("p2", [
        { text: "read", status: "done" },
        { text: "fix", status: "done" },
        { text: "test", status: "done" },
      ]),
      ...Array.from({ length: 4 }, (_, i) => echo(`f${i}`)),
      { text: "done", toolCalls: [], stopReason: "end" },
    ];
    await runTurn({ log, provider: scripted(turns), tools: [planTool, echoTool], planReminder: 3 });
    const restated = log.events.filter((e) => e.type === "decision" && e.slot === "plan");
    expect(restated).toHaveLength(1);
    expect(restated[0]).toMatchObject({ reason: "stale" });
    const idx = log.events.indexOf(restated[0] as AgentEvent);
    const msg = log.events[idx + 1];
    expect(msg?.type === "user/message" && msg.text).toBe(
      "[plan] 3 steps · 1 done · 1 in progress · 1 pending\n[x] 1. read\n[>] 2. fix\n[ ] 3. test",
    );
    // 复述之后计数归零;第二张计划全完成,之后四步也不复述
    const state = planState(log.events);
    expect(state?.every((i) => i.status === "done")).toBe(true);
    expect(stepsSincePlan(log.events)).toBe(5);
    expect(planText(state ?? [])).toContain("[x] 3. test");
    log.append({ type: "user/message", at: "t", text: "[plan] this is ordinary user text" });
    expect(stepsSincePlan(log.events)).toBe(5);
    expect(stepsSincePlan(log.events.slice(0, idx + 1))).toBe(0);
    // 缺省关闭:超过旧的八步阈值也不插入提醒。
    const log2 = newLog();
    await runTurn({
      log: log2,
      provider: scripted([
        plan("p1", [{ text: "keep working", status: "in_progress" }]),
        ...Array.from({ length: 12 }, (_, i) => echo(`default${i}`)),
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [planTool, echoTool],
    });
    expect(log2.events.some((e) => e.type === "decision" && e.slot === "plan")).toBe(false);
  });

  it("压缩之后立刻复述有未完成项的计划", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        plan("p1", [{ text: "a", status: "pending" }]),
        echo("e1"),
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [planTool, echoTool],
      compaction: {
        strategy: async () => ({ summary: "S", coversFrom: 1, coversUpTo: 6 }),
        window: 20,
        reserveTokens: 10,
      },
    });
    const i = log.events.findIndex((e) => e.type === "decision" && e.slot === "plan");
    expect(i).toBeGreaterThan(0);
    expect(log.events[i]).toMatchObject({ reason: "compacted" });
    expect(log.events[i - 1]?.type).toBe("compaction");

    for (const withPlan of [true, false]) {
      const manualLog = newLog();
      await runTurn({
        log: manualLog,
        provider: scripted([
          ...(withPlan ? [plan("p1", [{ text: "finish verification", status: "pending" }])] : []),
          { text: "Older findings. ".repeat(80), toolCalls: [], stopReason: "end" },
        ]),
        tools: [planTool],
        facts: { date: false },
      });
      await runTurn({
        log: manualLog,
        provider: scripted([{ text: "unused", toolCalls: [], stopReason: "end" }]),
        tools: [],
        manualCompaction: "",
        compaction: {
          strategy: async ({ events }) => ({
            summary: "Task summary without the plan.",
            coversFrom: 2,
            coversUpTo: events.length,
          }),
          window: 100000,
          trigger: "manual",
        },
      });
      expect(manualLog.events.some((event) => event.type === "compaction")).toBe(true);
      manualLog.append({ type: "user/message", at: "t", text: "Continue." });
      let nextInput: Message[] = [];
      await runTurn({
        log: manualLog,
        provider: {
          model: "fake",
          async complete(messages) {
            nextInput = messages;
            return { text: "ok", toolCalls: [], stopReason: "end" };
          },
        },
        tools: [],
        facts: { date: false },
      });
      expect(
        nextInput
          .filter((message) => message.content.startsWith("[plan]"))
          .map((message) => message.content),
      ).toEqual(
        withPlan
          ? ["[plan] 1 step · 0 done · 0 in progress · 1 pending\n[ ] 1. finish verification"]
          : [],
      );
    }
  });
});

describe("前缀不变量与注入方式的代价", () => {
  it("正常的多步 turn 里,每次请求相对上一次只多了新消息,前缀一条都不重算", async () => {
    const log = newLog();
    const turns: AssistantTurn[] = [
      ...Array.from(
        { length: 6 },
        (_, i): AssistantTurn => ({
          text: "",
          toolCalls: [call("echo", { text: `e${i}` }, `e${i}`)],
          stopReason: "tool",
        }),
      ),
      { text: "done", toolCalls: [], stopReason: "end" },
    ];
    await runTurn({ log, provider: scripted(turns), tools: [echoTool] });
    let prev: Message[] | undefined;
    for (let k = 0; k < log.events.length; k++) {
      if (log.events[k]?.type !== "request") continue;
      const cur = deriveMessages(log.events.slice(0, k));
      if (prev) expect(unchangedPrefix(prev, cur)).toBe(prev.length);
      prev = cur;
    }
  });

  it("三种注入方式在同一段会话上的重算代价:贴在事件上最低,每轮替换最高", () => {
    // 30 步的合成会话:每步一条助手消息、一条工具结果;状态栏每步一条。
    const status = (n: number): Message => ({ role: "user", content: `[status] step ${n} of 30` });
    const step = (n: number): Message[] => [
      { role: "assistant", content: "", toolCalls: [call("echo", { text: `s${n}` }, `c${n}`)] },
      { role: "tool", callId: `c${n}`, name: "echo", content: `s${n} ok`, isError: false },
    ];
    const base: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];
    const cost = (build: (n: number) => Message[]) => {
      let prev: Message[] | undefined;
      let recomputed = 0;
      let sent = 0;
      for (let n = 1; n <= 30; n++) {
        const cur = build(n);
        const tokens = cur.map((m) => messageTokens(m));
        sent += tokens.reduce((a, b) => a + b, 0);
        if (prev) {
          const keep = unchangedPrefix(prev, cur);
          for (let i = keep; i < cur.length; i++) recomputed += tokens[i] as number;
        }
        prev = cur;
      }
      return { recomputed, sent };
    };
    const attach = cost((n) => [
      ...base,
      ...Array.from({ length: n }, (_, i) => step(i + 1)).flat(),
    ]);
    const append = cost((n) => [
      ...base,
      ...Array.from({ length: n }, (_, i) => [...step(i + 1), status(i + 1)]).flat(),
    ]);
    const replace = cost((n) => [
      ...base,
      ...Array.from({ length: n }, (_, i) => step(i + 1)).flat(),
      status(n),
    ]);
    // 重算:贴在事件上只重算新增的两条;状态在末尾时,替换与追加重算的一样多(都是新增两条加一条状态)。
    expect(attach.recomputed).toBeLessThan(append.recomputed);
    expect(append.recomputed).toBe(replace.recomputed);
    // 发送总量:追加把过时的状态一直留着,三十步下来最多;替换其次;贴在事件上最少。
    expect(attach.sent).toBeLessThan(replace.sent);
    expect(replace.sent).toBeLessThan(append.sent);
  });
});
