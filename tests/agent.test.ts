import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { EventLog } from "../src/log.js";
import { maxSteps } from "../src/loop.js";
import type { Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";

const echoTool = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function newLog(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  return log;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("Agent", () => {
  it("手动压缩共享运行周期:排队输入随后发送,Esc 取消并暂停新输入", async () => {
    const log = newLog();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summaries = 0;
    let requests = 0;
    const agent = new Agent({
      log,
      provider: {
        model: "fake",
        async complete() {
          requests++;
          return { text: "done", toolCalls: [], stopReason: "end" };
        },
      },
      tools: [],
      compaction: {
        strategy: async ({ signal, instructions }) => {
          summaries++;
          expect(instructions).toBe("keep details");
          if (summaries === 1) await gate;
          else
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          return null;
        },
        trigger: "manual",
        window: 100000,
        reserveTokens: 1000,
      },
    });

    const first = agent.compact("keep details");
    await tick();
    expect(agent.running).toBe(true);
    expect(requests).toBe(0);
    void agent.prompt("continue after compact");
    release();
    expect(await first).toBe("idle");
    expect(requests).toBe(1);
    expect(
      log.events.some((e) => e.type === "user/message" && e.text === "continue after compact"),
    ).toBe(true);

    const second = agent.compact("keep details");
    await tick();
    void agent.prompt("wait for me");
    agent.interrupt();
    expect(await second).toBe("aborted");
    expect(agent.pending).toMatchObject([{ text: "wait for me", paused: true }]);
    expect(requests).toBe(1);
    expect(log.events.some((e) => e.type === "compaction")).toBe(false);
  });

  it("运行中 prompt 进入队列,steer 默认策略在步边界注入", async () => {
    const log = newLog();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const provider: Provider = {
      model: "fake",
      async complete() {
        calls += 1;
        if (calls === 1) {
          await gate; // 卡住第一次请求,给插话留出时间窗
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }],
            stopReason: "tool",
          };
        }
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent({ log, provider, tools: [echoTool] });

    const first = agent.prompt("第一条");
    await tick();
    expect(agent.running).toBe(true);

    void agent.prompt("插话", { images: [testImage] }); // 运行中 → 排队
    const viewed = agent.pending[0]?.images;
    if (!viewed?.[0]) throw new Error("missing queued image");
    viewed[0].name = "changed by reader";
    viewed.push({ ...testImage });
    release();
    const outcome = await first;

    expect(outcome).toBe("idle");
    const texts = log.events.filter((e) => e.type === "user/message").map((e) => e.text);
    expect(texts).toEqual(["第一条", "插话"]);
    expect(log.events.filter((e) => e.type === "user/message")[1]).toMatchObject({
      images: [testImage],
    });
    // 插话位于工具结果之后(步边界),不在末尾游离
    const types = log.events.map((e) => e.type);
    expect(types.indexOf("user/message", types.indexOf("tool/result"))).toBeLessThan(
      types.lastIndexOf("assistant/message"),
    );
    const restoredImage = { ...testImage };
    const restored = new Agent({
      log: newLog(),
      provider,
      tools: [],
      pending: [
        { id: "restored", text: "", deliverAs: "steer", paused: true, images: [restoredImage] },
      ],
    });
    restoredImage.name = "changed after restore";
    expect(restored.pending[0]?.images).toEqual([testImage]);
  });

  it("interrupt:记 session/interrupt 事件并让 turn 以 aborted 收场", async () => {
    const log = newLog();
    const provider: Provider = {
      model: "fake",
      async complete(_msgs, _tools, opts) {
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const agent = new Agent({ log, provider, tools: [] });

    const running = agent.prompt("跑一个长任务");
    await tick();
    agent.interrupt();
    const outcome = await running;

    expect(outcome).toBe("aborted");
    expect(log.events.some((e) => e.type === "session/interrupt")).toBe(true);
    expect(log.events.at(-1)).toMatchObject({ type: "assistant/message", stopReason: "aborted" });
    expect(agent.running).toBe(false);
    const failing = agent.prompt("日志写入失败时仍须取消");
    await tick();
    const append = vi.spyOn(log, "append").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    expect(() => agent.interrupt()).toThrow("disk unavailable");
    append.mockRestore();
    expect(await failing).toBe("aborted");
    expect(agent.running).toBe(false);
  });

  it("终结后暂停待发送消息,新问题不夹带旧消息,可编辑移除并手动继续", async () => {
    const log = newLog();
    let firstRun = true;
    const provider: Provider = {
      model: "fake",
      async complete(_msgs, _tools, opts) {
        if (firstRun) {
          firstRun = false;
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { text: "", toolCalls: [], stopReason: "aborted" };
        }
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent({ log, provider, tools: [] });

    const running = agent.prompt("任务A");
    await tick();
    void agent.prompt("打断期间的留言"); // 排队
    void agent.prompt("移除这条");
    agent.interrupt(); // aborted 返回,队列保留
    await expect(agent.continuePending()).rejects.toThrow("cannot continue pending while stopping");
    void agent.prompt("取消后新到的留言");
    expect(agent.pending.every((p) => p.paused)).toBe(true);
    await running;

    await agent.prompt("任务B");
    expect(log.events.filter((e) => e.type === "user/message").map((e) => e.text)).toEqual([
      "任务A",
      "任务B",
    ]);
    expect(agent.pending.every((p) => p.paused)).toBe(true);
    const [kept, removed, afterStop] = agent.pending;
    if (!kept || !removed) throw new Error("missing queued inputs");
    agent.editPending(kept.id, "修改后的留言");
    agent.removePending(removed.id);
    if (afterStop) agent.removePending(afterStop.id);
    await agent.continuePending();
    await agent.continuePending();
    expect(log.events.filter((e) => e.type === "user/message").map((e) => e.text)).toEqual([
      "任务A",
      "任务B",
      "修改后的留言",
    ]);
    expect(agent.queued).toBe(0);

    let fail = true;
    agent.setProvider({
      model: "fake",
      async complete() {
        await tick();
        if (fail) throw new Error("provider unavailable");
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    });
    const failed = agent.prompt("失败的任务");
    const queued = agent.prompt("失败前排队的留言");
    await expect(failed).rejects.toThrow("provider unavailable");
    await expect(queued).rejects.toThrow("provider unavailable");
    expect(agent.pending).toMatchObject([{ text: "失败前排队的留言", paused: true }]);
    fail = false;
    await agent.prompt("失败后的新问题");
    expect(log.events.filter((e) => e.type === "user/message").map((e) => e.text)).not.toContain(
      "失败前排队的留言",
    );
    await agent.continuePending();
    await agent.continuePending();
    expect(
      log.events.filter((e) => e.type === "user/message" && e.text === "失败前排队的留言"),
    ).toHaveLength(1);
    expect(agent.queued).toBe(0);

    for (const stop of ["limit", "aborted"] as const) {
      const stoppedLog = newLog();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const stoppedAgent = new Agent({
        log: stoppedLog,
        tools: [echoTool],
        slots: { termination: maxSteps(1) },
        provider: {
          model: "fake",
          async complete() {
            if (first) {
              first = false;
              await gate;
              return stop === "limit"
                ? {
                    text: "",
                    toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }],
                    stopReason: "tool",
                  }
                : { text: "", toolCalls: [], stopReason: "aborted" };
            }
            return { text: "ok", toolCalls: [], stopReason: "end" };
          },
        },
      });
      const stopped = stoppedAgent.prompt("first task");
      await tick();
      const followUp = stoppedAgent.prompt("unfinished follow-up", { deliverAs: "followUp" });
      release();
      expect(await stopped).toEqual(
        stop === "limit" ? { stopped: "step limit 1 reached" } : "aborted",
      );
      await followUp;
      expect(stoppedAgent.pending).toMatchObject([{ text: "unfinished follow-up", paused: true }]);
      await stoppedAgent.prompt("new question");
      const texts = () =>
        stoppedLog.events.filter((e) => e.type === "user/message").map((e) => e.text);
      expect(texts()).toEqual(["first task", "new question"]);
      await stoppedAgent.continuePending();
      await stoppedAgent.continuePending();
      expect(texts()).toEqual(["first task", "new question", "unfinished follow-up"]);
      expect(stoppedAgent.queued).toBe(0);
      expect(stoppedLog.events.some((e) => e.type === "session/interrupt")).toBe(false);
    }
  });
});
