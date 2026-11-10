import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { contextSize } from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { maxSteps, queueToTurnEnd, runTurn, steer } from "../src/loop.js";
import { deriveMessages, type Message, requestMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { toAnthropicWire } from "../src/providers/anthropic.js";
import { captureToolDefinitions, toolDefinitionsForRequest } from "../src/tool-definitions.js";
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
    const seen: Message[][] = [];
    const opaque = (n: number) => ({
      kind: "anthropic-thinking",
      model: "fake",
      blocks: [
        { type: "thinking", thinking: `reasoning ${n}`, signature: `signature-${n}` },
        { type: "redacted_thinking", data: `redacted-${n}` },
      ],
    });
    const signatures = (messages: Message[]) =>
      toAnthropicWire(messages, { model: "fake" }).messages.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "thinking"
            ? [block.signature]
            : block.type === "redacted_thinking"
              ? [block.data]
              : [],
        ),
      );
    let requests = 0;
    const outcome = await runTurn({
      log,
      provider: {
        model: "fake",
        async complete(_messages, definitions) {
          seen.push(_messages);
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
            return {
              text: "",
              toolCalls: [call("echo", { text: "hi" })],
              stopReason: "tool",
              opaque: opaque(1),
              reasoning: "reasoning 1",
              reasoningKind: "summary",
            };
          }
          expect(definitions[0]?.description).toBe("updated");
          return { text: "完成", toolCalls: [], stopReason: "end", opaque: opaque(2) };
        },
      },
      tools: () => tools,
    });
    expect(outcome).toBe("idle");
    // 第二个真实输入先清掉旧块;旧正文、调用与事件仍保留。
    expect(signatures(seen[1] ?? [])).toEqual([]);
    expect(seen[1]?.find((message) => message.role === "assistant")).toMatchObject({
      reasoning: "reasoning 1",
      toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
    });
    expect(log.events.find((event) => event.type === "assistant/message")?.opaque).toEqual(
      opaque(1),
    );
    // 每次模型请求前落一条 request(只给人看),响应紧随其后。
    expect(log.events.map((e) => e.type)).toEqual([
      "session/start",
      "user/message",
      "tools/snapshot",
      "request",
      "assistant/message",
      "tool/arguments",
      "tool/executed",
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
    const historic = JSON.stringify(log.events);
    const next = async () => {
      log.append({ type: "user/message", at: "t", text: "next" });
      await runTurn({
        log,
        tools: () => tools,
        provider: {
          model: "fake",
          async complete(messages) {
            seen.push(messages);
            return {
              text: "done",
              toolCalls: [],
              stopReason: "end",
              opaque: opaque(++requests),
              usage: { inputTokens: 100, outputTokens: 10 },
            };
          },
        },
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
    expect(signatures(seen.at(-1) ?? [])).toEqual(["signature-2", "redacted-2"]);
    expect(log.events.filter((event) => event.type === "request").at(-1)?.body).toBeUndefined();
    expect(contextSize(log.events)).toEqual({ basis: "usage", tokens: 110 });

    tools[0] = {
      ...updated,
      parameters: Type.Object({ text: Type.Union([Type.Literal("a"), Type.Literal("b")]) }),
    };
    await next();
    expect(snapshots()).toHaveLength(3);
    expect(signatures(seen.at(-1) ?? [])).toEqual([]);
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
    expect(signatures(seen.at(-1) ?? [])).toEqual(["signature-8", "redacted-8"]);
    expect(first?.[0]?.description).toBe("回显");
    tools.push({
      ...echoTool,
      parameters: Type.Object({ text: Type.String({ description: "first" }) }),
    });
    await next();
    expect(signatures(seen.at(-1) ?? [])).toEqual([]);
    await next();
    expect(signatures(seen.at(-1) ?? [])).toEqual(["signature-10", "redacted-10"]);
    tools[0] = { ...(tools[0] as Tool), description: "Explain before editing." };
    await next();
    expect(signatures(seen.at(-1) ?? [])).toEqual([]);
    await next();
    expect(signatures(seen.at(-1) ?? [])).toEqual(["signature-12", "redacted-12"]);
    tools[0] = { ...(tools[0] as Tool), description: "Read now." };
    await runTurn({
      log,
      tools: () => tools,
      slots: {
        assemble: (events) => [
          ...deriveMessages(events),
          { role: "user", content: "Only this request." },
        ],
      },
      provider: {
        model: "fake",
        async complete(messages) {
          seen.push(messages);
          return { text: "custom", toolCalls: [], stopReason: "end", opaque: opaque(++requests) };
        },
      },
    });
    expect(signatures(seen.at(-1) ?? [])).toEqual([]);
    // 自定义结构的请求不会把清理或额外消息变成后续默认上下文。
    expect(
      deriveMessages(log.events).some((message) => message.content === "Only this request."),
    ).toBe(false);
    expect(signatures(deriveMessages(log.events))).toEqual([
      "signature-12",
      "redacted-12",
      "signature-13",
      "redacted-13",
      "signature-14",
      "redacted-14",
    ]);
    expect(JSON.stringify(log.events.slice(0, JSON.parse(historic).length))).toBe(historic);

    // 升级前 B 请求没有清理输入,它的响应不能只凭发生在 B 之后获准回传。
    for (const legacy of ["known-dirty", "unknown", "mixed"] as const) {
      const restored = new EventLog();
      const historicalEvents: AgentEvent[] = JSON.parse(historic);
      const appendUnknown = (n: number) => {
        restored.append({
          type: "request",
          at: "t",
          model: "fake",
          messages: 1,
          tools: ["legacy"],
          estimatedTokens: 1,
          reason: "turn",
        });
        restored.append({
          type: "assistant/message",
          at: "t",
          text: "legacy",
          toolCalls: [],
          stopReason: "end",
          opaque: opaque(n),
        });
      };
      for (const [index, event] of historicalEvents.entries()) {
        if (legacy === "unknown" && event.type === "tools/snapshot") continue;
        if (event.type === "request") delete event.body;
        restored.append(event);
        if (legacy === "mixed" && index === 0) {
          // 这个producer确实缺定义证据,后面的已知A→B也不能反过来补证。
          appendUnknown(99);
        }
        if (legacy === "mixed" && event.type === "tool/result") appendUnknown(98);
      }
      const prior = deriveMessages(restored.events);
      const unknownBlocks =
        legacy === "mixed" ? ["signature-99", "redacted-99", "signature-98", "redacted-98"] : [];
      expect(signatures(prior)).toEqual([
        ...(legacy === "mixed" ? ["signature-99", "redacted-99"] : []),
        "signature-1",
        "redacted-1",
        ...(legacy === "mixed" ? ["signature-98", "redacted-98"] : []),
        "signature-2",
        "redacted-2",
      ]);
      const oldRequest = restored.events.reduce(
        (last, event, index) => (event.type === "request" ? index : last),
        -1,
      );
      const oldInput = requestMessages(restored.events, oldRequest);
      let actual: Message[] = [];
      await runTurn({
        log: restored,
        tools: [updated],
        provider: {
          model: "fake",
          async complete(messages) {
            actual = messages;
            return { text: "resumed", toolCalls: [], stopReason: "end", opaque: opaque(12) };
          },
        },
      });
      expect(signatures(actual)).toEqual(
        legacy === "unknown"
          ? ["signature-1", "redacted-1", "signature-2", "redacted-2"]
          : unknownBlocks,
      );
      expect(requestMessages(restored.events, oldRequest)).toEqual(oldInput);
      expect(signatures(prior)).toHaveLength(legacy === "mixed" ? 8 : 4);
    }

    // 真实重新观测 A 必须给新回复建立前向身份,不能因 raw 旧快照同值而一直 unknown。
    for (const boundary of ["unknown", "empty", "compaction"] as const) {
      let restored = newLog();
      const a: Tool = { ...echoTool, description: "A" };
      const b: Tool = { ...a, description: "B" };
      captureToolDefinitions(restored, [a]);
      const request = (names: string[], reason: "turn" | "compaction" = "turn") =>
        restored.append({
          type: "request",
          at: "t",
          model: "fake",
          messages: 1,
          tools: names,
          estimatedTokens: 1,
          reason,
        });
      if (boundary === "unknown") request(["other"]);
      request(
        boundary === "unknown" ? ["echo"] : [],
        boundary === "compaction" ? "compaction" : "turn",
      );
      if (boundary !== "compaction")
        restored.append({
          type: "assistant/message",
          at: "t",
          text: "G",
          toolCalls: [],
          stopReason: "end",
          opaque: opaque(90),
        });
      const original = JSON.stringify(restored.events);
      const historicalRequest = restored.events.reduce(
        (last, event, index) => (event.type === "request" ? index : last),
        -1,
      );
      const historicalInput = requestMessages(restored.events, historicalRequest);
      const inputs: Message[][] = [];
      const provider: Provider = {
        model: "fake",
        async complete(messages) {
          inputs.push(messages);
          return {
            text: "F",
            toolCalls: [],
            stopReason: "end",
            opaque: opaque(90 + inputs.length),
          };
        },
      };
      await runTurn({ log: restored, provider, tools: [a], facts: { date: false } });
      const snapshotCount = boundary === "compaction" ? 1 : 2;
      expect(restored.events.filter((event) => event.type === "tools/snapshot")).toHaveLength(
        snapshotCount,
      );
      const reloaded = new EventLog();
      for (const event of JSON.parse(JSON.stringify(restored.events))) reloaded.append(event);
      restored = reloaded;
      await runTurn({ log: restored, provider, tools: [a], facts: { date: false } });
      expect(signatures(inputs[1] ?? [])).toEqual([
        ...(boundary === "unknown" ? ["signature-90", "redacted-90"] : []),
        "signature-91",
        "redacted-91",
      ]);
      expect(restored.events.filter((event) => event.type === "tools/snapshot")).toHaveLength(
        snapshotCount,
      );
      await runTurn({ log: restored, provider, tools: [b], facts: { date: false } });
      expect(signatures(inputs[2] ?? [])).toEqual(
        boundary === "unknown" ? ["signature-90", "redacted-90"] : [],
      );
      expect(restored.events.filter((event) => event.type === "tools/snapshot")).toHaveLength(
        snapshotCount + 1,
      );
      expect(JSON.stringify(restored.events.slice(0, JSON.parse(original).length))).toBe(original);
      expect(requestMessages(restored.events, historicalRequest)).toEqual(historicalInput);
      const firstFresh = restored.events.find(
        (event) => event.type === "assistant/message" && event.text === "F",
      );
      expect(firstFresh).toMatchObject({ opaque: opaque(91) });
    }
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
      slots: {
        approve: () => {
          throw new Error("Invalid arguments must not prompt for approval");
        },
      },
    });
    const result = firstResult(log) as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool argument validation failed");
    expect(result.content).toContain('"wrong": 1');
  });

  it("前置显式改参后重新校验,审批固定最终值,原始调用和跨请求身份保留", async () => {
    const log = newLog();
    log.subscribe((event) => {
      if (event.type === "tool/executed")
        log.append({ type: "ext/event", at: "", source: "test", kind: "observed", payload: {} });
    });
    const raw = [
      call("echo", { text: "original" }, "same-id"),
      call("echo", { text: "second" }, "second"),
      call("echo", { text: "valid" }, "invalid"),
      call("echo", { text: "valid" }, "undefined"),
      call("echo", { text: "valid" }, "thrown"),
      call("echo", { text: "valid" }, "denied"),
    ];
    const again = call("echo", { text: "new-original" }, "same-id");
    const executed: string[] = [];
    const approved: string[] = [];
    let retained: { text: string } | undefined;
    const replacement = { text: 123 };
    const echo = defineTool({
      ...echoTool,
      concurrency: "parallel",
      async execute(args) {
        const text = args.text;
        executed.push(text);
        args.text = "tool-private-change";
        return `echo:${text}`;
      },
    });
    expect(
      await runTurn({
        log,
        tools: [echo],
        provider: scripted([
          { text: "", toolCalls: raw, stopReason: "tool" },
          { text: "", toolCalls: [again], stopReason: "tool" },
          { text: "done", toolCalls: [], stopReason: "end" },
        ]),
        slots: {
          execution: "parallel",
          beforeToolCall: ({ call: original, args }) => {
            expect(Object.isFrozen(original)).toBe(true);
            expect(Object.isFrozen(args)).toBe(true);
            if (original.id === "same-id")
              return {
                args:
                  (args as { text: string }).text === "original"
                    ? replacement
                    : { text: "new-final" },
              };
            if (original.id === "second") {
              replacement.text = 456;
              return;
            }
            if (original.id === "invalid") return { args: { text: { nested: true } } };
            if (original.id === "undefined") return { args: undefined };
            if (original.id === "thrown") throw new Error("extension unavailable");
            return { args: { text: "denied-final" } };
          },
          approve: (prepared) => {
            const args = prepared.args as { text: string };
            approved.push(args.text);
            expect(Object.isFrozen(args)).toBe(true);
            if (prepared.id === "same-id") retained = args;
            if (prepared.id === "second")
              expect(() => {
                (retained as { text: string }).text = "late-change";
              }).toThrow(TypeError);
            return prepared.id !== "denied";
          },
        },
      }),
    ).toBe("idle");
    expect(approved).toEqual(["123", "second", "denied-final", "new-final"]);
    expect(executed).toEqual(["123", "second", "new-final"]);
    const prepared = log.events.filter((event) => event.type === "tool/arguments");
    expect(prepared.map((event) => event.args)).toEqual([
      { text: "123" },
      { text: "second" },
      { text: "denied-final" },
      { text: "new-final" },
    ]);
    const reused = prepared.filter((event) => event.callId === "same-id");
    expect(reused).toHaveLength(2);
    expect(reused[0]?.callEvent).not.toBe(reused[1]?.callEvent);
    for (const event of reused) {
      const owner = log.events[event.callEvent];
      expect(owner?.type).toBe("assistant/message");
      if (owner?.type === "assistant/message")
        expect(owner.toolCalls.find((item) => item.id === event.callId)?.args).toEqual({
          text: event === reused[0] ? "original" : "new-original",
        });
    }
    const results = log.events.filter((event) => event.type === "tool/result");
    expect(results.map((event) => event.isError)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(results[2]?.content).toContain("Tool argument validation failed");
    expect(results[3]?.content).toContain("Tool argument preparation failed");
    expect(results[4]?.content).toContain("extension unavailable");
    expect(results[5]?.content).toContain("The user denied this call");
    const executions = log.events.filter((event) => event.type === "tool/executed");
    expect(executions.map((event) => event.content)).toEqual([
      "echo:123",
      "echo:second",
      "echo:new-final",
    ]);
    expect(log.recording).toBeUndefined();
    for (const result of results) {
      if (result.isError) expect(result.executionEvent).toBeUndefined();
      else {
        const execution = log.events[result.executionEvent as number];
        expect(execution).toMatchObject({
          type: "tool/executed",
          callId: result.callId,
          content: result.content,
          isError: false,
        });
        if (execution?.type === "tool/executed") {
          expect(execution.output).toBeUndefined();
          expect(log.events[execution.callEvent]?.type).toBe("assistant/message");
        }
      }
    }
    expect(deriveMessages(log.events).filter((message) => message.role === "tool")).toHaveLength(
      results.length,
    );
    expect(deriveMessages(JSON.parse(JSON.stringify(log.events)) as AgentEvent[])).toEqual(
      deriveMessages(log.events),
    );
    expect(raw[0]?.args).toEqual({ text: "original" });
    expect(again.args).toEqual({ text: "new-original" });
    expect(
      deriveMessages(log.events).filter((message) => message.role === "assistant")[0],
    ).toMatchObject({
      toolCalls: raw,
    });
  });

  it("外来工具的 JSON 自有键在审批与执行副本中保持,不变成原型", async () => {
    const args = JSON.parse('{"path":"b.ts","__proto__":{"inherited":"marker"}}');
    const log = newLog();
    let seen: unknown;
    const tool = defineTool({
      name: "foreign",
      description: "Foreign JSON schema",
      parameters: JSON.parse('{"type":"object"}'),
      async execute(input) {
        seen = input;
        return "done";
      },
    });
    await runTurn({
      log,
      tools: [tool],
      provider: scripted([
        { text: "", toolCalls: [call("foreign", { path: "a.ts" })], stopReason: "tool" },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      slots: {
        beforeToolCall: () => ({ args }),
        approve: (prepared) => {
          expect(prepared.args).toEqual(args);
          return true;
        },
      },
    });
    expect(JSON.stringify(seen)).toBe(JSON.stringify(args));
    expect(Object.getPrototypeOf(seen)).toBe(Object.prototype);
    expect(log.events.find((event) => event.type === "tool/arguments")?.args).toEqual(args);
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
      "tool/arguments",
      "tool/executed",
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
      "tool/arguments",
      "tool/executed",
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
    expect(log.events.filter((event) => event.type === "tool/executed")).toMatchObject([
      { callId: "c1", content: "执行中被打断", isError: true },
    ]);
    expect(results[1]?.executionEvent).toBeUndefined();

    // 审批等待与批次刷新都能让取消跨过最外层检查;以实际副作用计数验证执行入口。
    for (const mode of ["before", "arguments", "approval", "buffered", "flush"] as const) {
      const boundaryLog = newLog();
      const cancel = new AbortController();
      const executed: string[] = [];
      let approvals = 0;
      if (mode === "arguments")
        boundaryLog.subscribe((event) => {
          if (event.type === "tool/arguments") cancel.abort();
        });
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
          beforeToolCall: async () => {
            if (mode === "before") cancel.abort();
          },
          approve: async (call) => {
            approvals += 1;
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
      if (mode === "before" || mode === "arguments") expect(approvals).toBe(0);
      if (mode === "before")
        expect(boundaryLog.events.some((event) => event.type === "tool/arguments")).toBe(false);
      if (mode === "arguments")
        expect(boundaryLog.events.filter((event) => event.type === "tool/arguments")).toHaveLength(
          1,
        );
      expect(executed, mode).toEqual(mode === "flush" ? ["first"] : []);
      expect(
        boundaryLog.events
          .filter((event) => event.type === "tool/executed")
          .map((event) => event.callId),
      ).toEqual(mode === "flush" ? ["one"] : []);
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
