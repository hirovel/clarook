import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { maxSteps, queueToTurnEnd, runTurn, steer } from "../src/loop.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { toolDefinitionsForRequest } from "../src/tool-definitions.js";
import { defineTool, type Tool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";

// 脚本化 provider:按序吐出预设的 turn,离线验证循环语义。
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const turn = turns[i];
      if (!turn) throw new Error(`脚本只有 ${turns.length} 个 turn,第 ${i + 1} 次请求越界`);
      i += 1;
      return turn;
    },
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

const failTool = defineTool({
  name: "fail",
  description: "总是失败",
  parameters: Type.Object({}),
  async execute() {
    throw new Error("工具内部错误");
  },
});

function newLog(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  log.append({ type: "user/message", at: "t", text: "开始" });
  return log;
}

function call(name: string, args: unknown, id = "c1") {
  return { id, name, args };
}

/** 首条工具结果。请求/决策等只给人的事件夹在中间,不按固定下标取。 */
function firstResult(log: EventLog) {
  return log.events.find((e) => e.type === "tool/result");
}

describe("runTurn", () => {
  it("压缩无结果或没有缩小文字时记录原因,保留图片并继续请求", async () => {
    for (const [strategy, reason] of [
      [async () => null, "no-result"],
      [async () => ({ cleared: [] }), "no-gain"],
    ] as const) {
      const log = newLog();
      log.append({ type: "user/message", at: "t", text: "x".repeat(200), images: [testImage] });
      let sentImages = 0;
      const outcome = await runTurn({
        log,
        provider: {
          model: "fake",
          async complete(messages) {
            sentImages = messages.filter((m) => m.role === "user" && m.images?.length).length;
            return { text: "ok", toolCalls: [], stopReason: "end" };
          },
        },
        tools: [],
        compaction: { strategy, window: 50, reserveTokens: 10 },
      });
      expect(outcome).toBe("idle");
      expect(sentImages).toBe(1);
      expect(log.events).toContainEqual(
        expect.objectContaining({ type: "decision", slot: "compaction", reason, images: true }),
      );
      expect(log.events.some((e) => e.type === "compaction")).toBe(false);
    }
  });

  it("压缩等待中打断:不记无进展、不应用摘要、不再派发请求", async () => {
    for (const result of ["null", "payload", "error"] as const) {
      const log = newLog();
      log.append({ type: "user/message", at: "t", text: "x".repeat(200) });
      const cancel = new AbortController();
      const outcome = await runTurn({
        log,
        provider: {
          model: "fake",
          async complete() {
            throw new Error("request must not start");
          },
        },
        tools: [],
        signal: cancel.signal,
        compaction: {
          window: 50,
          reserveTokens: 10,
          strategy: async () => {
            cancel.abort();
            if (result === "error") throw new Error("cancelled during summary");
            return result === "payload" ? { summary: "short", coversUpTo: 2 } : null;
          },
        },
      });
      expect(outcome).toBe("aborted");
      expect(
        log.events.some(
          (e) => e.type === "request" || e.type === "compaction" || e.type === "decision",
        ),
      ).toBe(false);
    }

    const log = newLog();
    const cancel = new AbortController();
    const outcome = await runTurn({
      log,
      provider: {
        model: "fake",
        async complete() {
          throw new Error("maximum context length exceeded");
        },
      },
      tools: [],
      signal: cancel.signal,
      compaction: {
        window: 100_000,
        trigger: "manual",
        strategy: async () => {
          cancel.abort();
          return null;
        },
      },
    });
    expect(outcome).toBe("aborted");
    expect(log.events.some((e) => e.type === "request/error")).toBe(true);
    expect(log.events.some((e) => e.type === "decision" && e.slot === "compaction")).toBe(false);
  });

  it("工具调用→执行→回喂→模型收尾:事件序列完整", async () => {
    const log = newLog();
    const parameters = Type.Object({ text: Type.String({ description: "first" }) });
    const tools: Tool[] = [{ ...echoTool, parameters }];
    let requests = 0;
    const outcome = await runTurn({
      log,
      provider: {
        model: "fake",
        async complete(_messages, definitions) {
          if (requests++ === 0) {
            expect(definitions).toEqual([
              {
                name: "echo",
                description: "回显",
                parameters: {
                  type: "object",
                  properties: { text: { type: "string", description: "first" } },
                  required: ["text"],
                },
              },
            ]);
            expect(
              Reflect.ownKeys(definitions[0]?.parameters ?? {}).every(
                (key) => typeof key === "string",
              ),
            ).toBe(true);
            // adapter 与原始 schema 都能变化,本步执行器和历史事实仍使用已捕获内容。
            const sent = definitions[0];
            if (sent) {
              sent.description = "adapter edit";
              sent.parameters.properties = {};
            }
            (parameters.properties.text as Record<string, unknown>).type = "integer";
            parameters.properties.text.description = "updated schema";
            tools[0] = {
              ...echoTool,
              parameters,
              description: "updated",
              async execute() {
                return "wrong version";
              },
            };
            return { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" };
          }
          expect(definitions[0]?.description).toBe("updated");
          return { text: "完成", toolCalls: [], stopReason: "end" };
        },
      },
      tools: () => tools,
    });
    expect(outcome).toBe("idle");
    // 每次模型请求前落一条 request(只给人看),响应紧随其后。
    expect(log.events.map((e) => e.type)).toEqual([
      "session/start",
      "user/message",
      "tools/snapshot",
      "request",
      "assistant/message",
      "tool/result",
      "tools/snapshot",
      "request",
      "assistant/message",
    ]);
    expect(firstResult(log)).toMatchObject({ callId: "c1", content: "echo:hi", isError: false });
    const requestsAt = log.events.flatMap((event, index) =>
      event.type === "request" ? [index] : [],
    );
    const first = toolDefinitionsForRequest(log.events, requestsAt[0] as number);
    expect(first?.[0]).toMatchObject({
      description: "回显",
      parameters: { properties: { text: { type: "string", description: "first" } } },
    });
    expect(toolDefinitionsForRequest(log.events, requestsAt[1] as number)?.[0]).toMatchObject({
      description: "updated",
      parameters: { properties: { text: { type: "integer", description: "updated schema" } } },
    });

    const snapshots = () => log.events.filter((event) => event.type === "tools/snapshot");
    const next = async () => {
      log.append({ type: "user/message", at: "t", text: "next" });
      await runTurn({
        log,
        tools: () => tools,
        provider: scripted([{ text: "done", toolCalls: [], stopReason: "end" }]),
      });
      const index = log.events.reduce(
        (last, event, at) => (event.type === "request" ? at : last),
        -1,
      );
      return toolDefinitionsForRequest(log.events, index);
    };
    // JSON 等价的键序与本地字段变化不应制造新目录版本。
    const updated = tools[0] as Tool;
    tools[0] = {
      ...updated,
      describe: { core: "local guidance" },
      parameters: Type.Unsafe({
        required: ["text"],
        properties: {
          text: { description: "updated schema", type: "integer", omitted: undefined },
        },
        type: "object",
      }),
    };
    await next();
    expect(snapshots()).toHaveLength(2);

    tools[0] = {
      ...updated,
      parameters: Type.Object({ text: Type.Union([Type.Literal("a"), Type.Literal("b")]) }),
    };
    await next();
    expect(snapshots()).toHaveLength(3);
    tools[0] = {
      ...updated,
      parameters: Type.Object({ text: Type.Union([Type.Literal("b"), Type.Literal("a")]) }),
    };
    await next();
    expect(snapshots()).toHaveLength(4);
    tools.push(failTool);
    await next();
    expect(snapshots()).toHaveLength(5);
    tools.reverse();
    expect((await next())?.map((tool) => tool.name)).toEqual(["fail", "echo"]);
    expect(snapshots()).toHaveLength(6);
    tools.length = 0;
    expect(await next()).toEqual([]);
    expect(snapshots().at(-1)?.tools).toEqual([]);
    expect(snapshots()).toHaveLength(7);
    await next();
    expect(snapshots()).toHaveLength(7);
    expect(first?.[0]?.description).toBe("回显");
  });

  it("工具抛异常→isError 结果回喂,循环继续不炸", async () => {
    for (const failure of [new Error("工具内部错误"), "extension rejected", null]) {
      const log = newLog();
      const expected = failure instanceof Error ? failure.message : String(failure);
      let requests = 0;
      const outcome = await runTurn({
        log,
        provider: {
          model: "fake",
          async complete(messages) {
            if (requests++ === 0)
              return { text: "", toolCalls: [call("fail", {})], stopReason: "tool" };
            expect(messages.at(-1)).toMatchObject({
              role: "tool",
              content: expected,
              isError: true,
            });
            return { text: "看到错误了", toolCalls: [], stopReason: "end" };
          },
        },
        tools: [
          {
            ...failTool,
            async execute() {
              throw failure;
            },
          },
        ],
      });
      expect(outcome).toBe("idle");
      expect(firstResult(log)).toMatchObject({ content: expected, isError: true });
      expect(requests).toBe(2);
    }
  });

  it("参数校验失败→错误文本含路径与原参数,不执行工具", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { wrong: 1 })], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    const result = firstResult(log) as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool argument validation failed");
    expect(result.content).toContain('"wrong": 1');
  });

  it("审批拒绝→不执行,以错误结果回喂", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { approve: () => false },
    });
    expect(firstResult(log)).toMatchObject({
      content: "The user denied this call.",
      isError: true,
    });
  });

  it("maxSteps 终止策略叫停,返回 stopped 理由", async () => {
    const log = newLog();
    const loopForever: AssistantTurn = {
      text: "",
      toolCalls: [call("echo", { text: "x" })],
      stopReason: "tool",
    };
    const outcome = await runTurn({
      log,
      provider: scripted([loopForever, loopForever, loopForever]),
      tools: [echoTool],
      slots: { termination: maxSteps(2) },
    });
    expect(outcome).toEqual({ stopped: "step limit 2 reached" });
  });

  it("length:一个都不执行,逐个补错误应答后让模型重发", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [call("echo", { text: "a" }, "c1"), call("echo", { text: "b" }, "c2")],
          stopReason: "length",
        },
        { text: "重发", toolCalls: [call("echo", { text: "a" }, "c3")], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results[0]).toMatchObject({ callId: "c1", isError: true });
    expect(results[1]).toMatchObject({ callId: "c2", isError: true });
    expect(results[2]).toMatchObject({ callId: "c3", content: "echo:a", isError: false });
  });

  it("无工具的 length 保留回答并报告不完整,不重复请求", async () => {
    const log = newLog();
    let requests = 0;
    const outcome = await runTurn({
      log,
      provider: {
        model: "fake",
        async complete() {
          requests++;
          return { text: "Partial answer.", toolCalls: [], stopReason: "length" };
        },
      },
      tools: [],
      slots: { termination: maxSteps(3) },
    });
    expect(requests).toBe(1);
    expect(outcome).toEqual({
      stopped: "Response incomplete: generation reached the token or context limit.",
    });
    expect(log.events.filter((e) => e.type === "assistant/message")).toEqual([
      expect.objectContaining({ text: "Partial answer.", toolCalls: [], stopReason: "length" }),
    ]);
    expect(log.events.at(-1)).toMatchObject({
      type: "decision",
      slot: "termination",
      steps: 1,
      reason: "Response incomplete: generation reached the token or context limit.",
    });
  });

  it("steer 模式:插话在 step 边界注入,模型下一步就看到", async () => {
    const log = newLog();
    const queue = ["插话"];
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "收到插话", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { steering: steer },
      drainQueue: () => queue.splice(0),
    });
    const types = log.events.map((e) => e.type);
    // 插话紧跟在工具结果之后、下一条请求之前;注入决定先于留言落盘
    expect(types).toEqual([
      "session/start",
      "user/message",
      "tools/snapshot",
      "request",
      "assistant/message",
      "tool/result",
      "decision",
      "user/message",
      "request",
      "assistant/message",
    ]);
  });

  it("queue 模式:插话等到 turn 末才注入,并触发新一轮", async () => {
    const log = newLog();
    const queue = ["插话"];
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "第一件事完成", toolCalls: [], stopReason: "end" },
        { text: "处理插话", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { steering: queueToTurnEnd },
      drainQueue: () => queue.splice(0),
    });
    const types = log.events.map((e) => e.type);
    // 插话出现在第二条 assistant(end)之后
    expect(types).toEqual([
      "session/start",
      "user/message",
      "tools/snapshot",
      "request",
      "assistant/message",
      "tool/result",
      "request",
      "assistant/message",
      "decision",
      "user/message",
      "request",
      "assistant/message",
    ]);
  });

  it("打断:剩余调用不执行但逐个补应答,投影保持合法", async () => {
    const log = newLog();
    const ac = new AbortController();
    const abortingTool = defineTool({
      name: "boom",
      description: "执行时触发打断",
      parameters: Type.Object({}),
      async execute() {
        ac.abort();
        throw new Error("执行中被打断");
      },
    });
    const outcome = await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [call("boom", {}, "c1"), call("echo", { text: "x" }, "c2")],
          stopReason: "tool",
        },
      ]),
      tools: [abortingTool, echoTool],
      signal: ac.signal,
    });
    expect(outcome).toBe("aborted");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ callId: "c1", isError: true });
    expect(results[1]).toMatchObject({
      callId: "c2",
      content: "Interrupted by the user; not executed.",
      isError: true,
    });

    // 审批等待与批次刷新都能让取消跨过最外层检查;以实际副作用计数验证执行入口。
    for (const mode of ["approval", "buffered", "flush"] as const) {
      const boundaryLog = newLog();
      const cancel = new AbortController();
      const executed: string[] = [];
      const first = defineTool({
        name: "first",
        description: "first",
        parameters: Type.Object({}),
        concurrency: "parallel",
        async execute() {
          executed.push("first");
          if (mode === "flush") cancel.abort();
          return "first finished";
        },
      });
      const second = defineTool({
        name: "second",
        description: "second",
        parameters: Type.Object({}),
        async execute() {
          executed.push("second");
          return "second finished";
        },
      });
      const stopped = await runTurn({
        log: boundaryLog,
        tools: [first, second],
        signal: cancel.signal,
        provider: scripted([
          {
            text: "",
            toolCalls: [call("first", {}, "one"), call("second", {}, "two")],
            stopReason: "tool",
          },
        ]),
        slots: {
          execution: mode === "approval" ? "sequential" : "parallel",
          approve: async (call) => {
            if (
              (mode === "approval" && call.id === "one") ||
              (mode === "buffered" && call.id === "two")
            )
              cancel.abort();
            return true;
          },
        },
      });
      expect(stopped).toBe("aborted");
      expect(executed, mode).toEqual(mode === "flush" ? ["first"] : []);
      const boundaryResults = boundaryLog.events.filter((e) => e.type === "tool/result");
      expect(boundaryResults.map((r) => r.callId)).toEqual(["one", "two"]);
      for (const result of boundaryResults.slice(mode === "flush" ? 1 : 0)) {
        expect(result).toMatchObject({
          content: "Interrupted by the user; not executed.",
          isError: true,
        });
        expect(result.durationMs).toBeUndefined();
      }
    }

    const lateLog = newLog();
    const lateCancel = new AbortController();
    const lateOutcome = await runTurn({
      log: lateLog,
      tools: [],
      signal: lateCancel.signal,
      provider: {
        model: "fake",
        async complete() {
          lateCancel.abort();
          return { text: "reply arrived after cancel", toolCalls: [], stopReason: "end" };
        },
      },
    });
    expect(lateOutcome).toBe("aborted");
    expect(lateLog.events.at(-1)).toMatchObject({
      type: "assistant/message",
      text: "reply arrived after cancel",
    });
  });

  it("未知工具→错误回喂,不抛出", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("nope", {})], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    expect(firstResult(log)).toMatchObject({ content: 'Unknown tool "nope".', isError: true });
  });
});
