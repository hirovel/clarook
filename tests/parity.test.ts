// 对照 pi 吸收的部分:每一项都是槽或可选项,缺省行为不变。
// 执行槽(并行/串行)、后续留言、实测优先的上下文口径、提示词模板、@文件、技能段、分叉、扩展模块。
import * as fs from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { expandFileRefs } from "../cli/attachments.js";
import { forkSession, loadExtensions } from "../cli/bootstrap.js";
import { buildSystemPrompt, discoverSkills, parseSkill } from "../cli/prompt.js";
import { discoverTemplates, expandTemplate, parseTemplate, splitArgs } from "../cli/templates.js";
import { Agent } from "../src/agent.js";
import { contextSize, contextTokens, estimateAfter } from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider, ToolDef } from "../src/provider.js";
import { anthropic } from "../src/providers/anthropic.js";
import { openaiCompat } from "../src/providers/openai-chat.js";
import { createToolDefinitionQuery, toolDefinitionsForRequest } from "../src/tool-definitions.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";
import { testDirectory } from "./helpers/setup.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 脚本化 provider:按顺序吐出预设的响应。 */
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const t = turns[i++];
      if (!t) return { text: "done", toolCalls: [], stopReason: "end" };
      return t;
    },
  };
}

function slowTool(name: string, ms: number, concurrency?: "parallel" | "sequential") {
  const order: string[] = [];
  const tool = defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    ...(concurrency && { concurrency }),
    async execute() {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    },
  });
  return { tool, order };
}

describe("执行槽:并行只在选了策略且工具声明并行安全时发生", () => {
  const calls = [
    { id: "a", name: "ra", args: {} },
    { id: "b", name: "rb", args: {} },
    { id: "c", name: "w", args: {} },
  ];

  it("缺省串行:逐个跑,无 execution 决策事件", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 30, "parallel");
    const b = slowTool("rb", 30, "parallel");
    const w = slowTool("w", 5);
    const provider = scripted([{ text: "", toolCalls: calls, stopReason: "tool" }]);
    await runTurn({ log, provider, tools: [a.tool, b.tool, w.tool] });
    expect([...a.order, ...b.order].join(",")).toBe("ra:start,ra:end,rb:start,rb:end");
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);
  });

  it("parallel:相邻并行安全的调用同时跑,写工具仍独占;结果按调用顺序落盘,并记一条决策", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 40, "parallel");
    const b = slowTool("rb", 10, "parallel");
    const w = slowTool("w", 5);
    const timeline: string[] = [];
    const wrap = (t: ReturnType<typeof slowTool>) => ({
      ...t.tool,
      async execute(args: never, ctx: never) {
        const out = await t.tool.execute(args, ctx);
        timeline.push(t.tool.name);
        return out;
      },
    });
    const provider = scripted([{ text: "", toolCalls: calls, stopReason: "tool" }]);
    await runTurn({
      log,
      provider,
      tools: [wrap(a), wrap(b), wrap(w)],
      slots: { execution: "parallel" },
    });
    // rb 比 ra 先完成,说明两者同时在跑;w 在两者之后才开始。
    expect(timeline).toEqual(["rb", "ra", "w"]);
    const results = log.events.filter((e) => e.type === "tool/result").map((e) => e.callId);
    expect(results).toEqual(["a", "b", "c"]);
    const decision = log.events.find((e) => e.type === "decision" && e.slot === "execution");
    expect(decision).toMatchObject({ slot: "execution", parallel: 2, tools: ["ra", "rb"] });
  });

  it("parallel 下未声明并行安全的工具与校验失败的调用不会进批", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 5, "parallel");
    const bad = defineTool({
      name: "bad",
      description: "",
      parameters: Type.Object({ n: Type.Number() }),
      concurrency: "parallel",
      async execute() {
        return "x";
      },
    });
    const provider = scripted([
      {
        text: "",
        toolCalls: [
          { id: "1", name: "ra", args: {} },
          { id: "2", name: "bad", args: { n: "not-a-number-at-all" } },
          { id: "3", name: "ra", args: {} },
        ],
        stopReason: "tool",
      },
    ]);
    await runTurn({ log, provider, tools: [a.tool, bad], slots: { execution: "parallel" } });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results.map((e) => [e.callId, e.isError])).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
    ]);
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);
  });
});

describe("留言投递方式:steer 步边界,followUp 等到 turn 边界", () => {
  it("followUp 不在步边界注入,模型不再调工具时才注入", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    const t = slowTool("r", 5, "parallel");
    const provider = scripted([
      { text: "", toolCalls: [{ id: "1", name: "r", args: {} }], stopReason: "tool" },
      { text: "第一步做完", toolCalls: [], stopReason: "end" },
      { text: "回答后续", toolCalls: [], stopReason: "end" },
    ]);
    const agent = new Agent({ log, provider, tools: [t.tool] });
    const run = agent.prompt("开始");
    await sleep(1);
    void agent.prompt("后续问题", { deliverAs: "followUp" });
    expect(agent.queued).toBe(1);
    await run;
    const seq = log.events
      .filter(
        (e) =>
          e.type === "user/message" || e.type === "assistant/message" || e.type === "tool/result",
      )
      .map((e) =>
        e.type === "user/message" ? `U:${e.text}` : e.type === "tool/result" ? "T" : `A:${e.text}`,
      );
    // 后续留言排在"第一步做完"之后,而不是工具结果之后。
    expect(seq).toEqual(["U:开始", "A:", "T", "A:第一步做完", "U:后续问题", "A:回答后续"]);
    const decision = log.events.find((e) => e.type === "decision" && e.slot === "steering");
    expect(decision).toMatchObject({ boundary: "turn", injected: 1 });
  });
});

describe("上下文口径:实测优先", () => {
  it("实测不重复加工具;已知输入条件变化后重算,新实测到来再接替", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "x".repeat(400) },
      { type: "user/message", at: "", text: "hi" },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: "1", name: "r", args: {} }],
        stopReason: "tool",
        usage: { inputTokens: 5000, outputTokens: 20 },
      },
      {
        type: "tool/result",
        at: "",
        callId: "1",
        name: "r",
        content: "y".repeat(400),
        isError: false,
      },
    ];
    expect(contextTokens(events)).toBe(5000 + 20 + 100);
    expect(
      contextTokens(events, [{ name: "r", description: "x".repeat(40000), parameters: {} }]),
    ).toBe(5120);
    expect(contextSize(events).basis).toBe("usage");
    expect(contextTokens(events.slice(0, 2))).toBe(estimateAfter(events.slice(0, 2)));
    expect(contextSize(events.slice(0, 2)).basis).toBe("estimate");
    expect(
      contextSize([
        ...events.slice(0, 2),
        {
          type: "assistant/message",
          at: "",
          text: "unmeasured input",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 0, outputTokens: 9 },
        },
      ]).basis,
    ).toBe("estimate");
    const partial: AgentEvent = {
      type: "assistant/message",
      at: "",
      text: "p".repeat(40000),
      toolCalls: [],
      stopReason: "aborted",
      usage: { inputTokens: 1000, outputTokens: 1 },
    };
    expect(contextSize([...events, partial])).toEqual({ tokens: 15120, basis: "usage" });
    expect(contextSize([...events.slice(0, 2), partial])).toEqual({
      tokens: 10101,
      basis: "estimate",
    });
    expect(contextSize([...events, { ...partial, stopReason: "length" }])).toEqual({
      tokens: 1001,
      basis: "usage",
    });
    const after: AgentEvent[] = [...events, { type: "compaction", at: "", cleared: [3] }];
    expect(contextTokens(after)).toBe(estimateAfter(after));
    expect(contextSize(after).basis).toBe("estimate");
    expect(
      contextSize([
        ...events,
        { type: "session/slot", at: "", slot: "compactionTrigger", value: "manual" },
      ]),
    ).toEqual({ tokens: 5120, basis: "usage" });
    const changes: { event: AgentEvent; expected: number }[] = [
      {
        event: {
          type: "context/edit",
          at: "",
          target: 1,
          field: "content",
          value: "u".repeat(40000),
        },
        expected: 10209,
      },
      {
        event: { type: "context/edit", at: "", target: 1, field: "content", value: "" },
        expected: 209,
      },
      { event: { type: "context/drop", at: "", target: 2 }, expected: 101 },
      { event: { type: "session/model", at: "", model: "different" }, expected: 210 },
      { event: { type: "session/slot", at: "", slot: "tools", value: "off: r" }, expected: 210 },
      {
        event: { type: "session/slot", at: "", slot: "toolPrompts", value: "reset r" },
        expected: 210,
      },
      {
        event: {
          type: "ext/event",
          at: "",
          source: "mcp",
          kind: "tools",
          payload: { server: "fixture", added: ["new"], removed: [], total: 1 },
        },
        expected: 210,
      },
      { event: { type: "user/message", at: "", text: "next", images: [testImage] }, expected: 211 },
    ];
    for (const { event, expected } of changes) {
      const revised = [...events, event];
      expect(contextTokens(revised)).toBe(expected);
      expect(contextSize(revised).basis).toBe("estimate");
      const fresh: AgentEvent[] = [
        ...revised,
        {
          type: "assistant/message",
          at: "",
          text: "",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 8000, outputTokens: 4 },
        },
        { type: "user/message", at: "", text: "more" },
      ];
      expect(contextTokens(fresh)).toBe(8005);
    }

    const definitions: ToolDef[] = [{ name: "r", description: "brief", parameters: {} }];
    const known: AgentEvent[] = [
      ...events.slice(0, 2),
      { type: "tools/snapshot", at: "", tools: definitions },
      {
        type: "request",
        at: "",
        model: "m",
        messages: 2,
        tools: ["r"],
        estimatedTokens: 1,
        reason: "turn",
      },
      ...events.slice(2),
    ];
    expect(contextSize(known, definitions)).toEqual({ tokens: 5120, basis: "usage" });
    const changed = [{ name: "r", description: "x".repeat(40000), parameters: {} }];
    // 活动目录先变化,尚未追加快照;自动 gate 也必须在这个边界放弃旧实测。
    expect(contextSize(known, changed)).toEqual({ tokens: 10222, basis: "estimate" });
    expect(contextSize(known)).toEqual({ tokens: 5120, basis: "usage" });
    expect(contextSize(known, [])).toEqual({ tokens: 210, basis: "estimate" });
    const changedHistory: AgentEvent[] = [
      ...known,
      { type: "tools/snapshot", at: "", tools: changed },
    ];
    expect(contextSize(changedHistory)).toEqual({ tokens: 10222, basis: "estimate" });
    const request = known[3] as Extract<AgentEvent, { type: "request" }>;
    expect(
      contextSize([
        ...changedHistory,
        request,
        {
          type: "assistant/message",
          at: "",
          text: "",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 12000, outputTokens: 21 },
        },
      ]),
    ).toEqual({ tokens: 12021, basis: "usage" });

    const schema: ToolDef[] = [
      { name: "r", description: "brief", parameters: { type: "object", description: "schema" } },
    ];
    const schemaKnown = known.map((event) =>
      event.type === "tools/snapshot" ? { ...event, tools: schema } : event,
    );
    expect(
      contextSize(schemaKnown, [
        {
          name: "r",
          description: "brief",
          parameters: { description: "schema", type: "object", local: undefined },
        },
      ]),
    ).toEqual({ tokens: 5120, basis: "usage" });
    expect(
      contextSize(known, [
        {
          name: "r",
          description: "brief",
          parameters: { type: "object", description: "x".repeat(40000) },
        },
      ]),
    ).toEqual({ tokens: 10231, basis: "estimate" });
    const arrayKnown = known.map((event) =>
      event.type === "tools/snapshot"
        ? {
            ...event,
            tools: [{ name: "r", description: "brief", parameters: { enum: ["a", "b"] } }],
          }
        : event,
    );
    expect(
      contextSize(arrayKnown, [
        { name: "r", description: "brief", parameters: { enum: ["b", "a"] } },
      ]).basis,
    ).toBe("estimate");

    // 纯快照往返没有实际 B 输入,不把思考回传的单调失效规则套在 usage 上。
    expect(
      contextSize([...changedHistory, { type: "tools/snapshot", at: "", tools: definitions }]),
    ).toEqual({ tokens: 5120, basis: "usage" });
    const signedKnown = known.map((event) =>
      event.type === "assistant/message"
        ? {
            ...event,
            opaque: {
              kind: "anthropic-thinking",
              model: "m",
              blocks: [{ type: "thinking", thinking: "reason", signature: "A" }],
            },
          }
        : event,
    );
    const cleanedTail = deriveMessages(signedKnown)
      .slice(2)
      .map((message) => {
        const clean = { ...message };
        if (clean.role === "assistant") delete clean.opaque;
        return clean;
      });
    const failedB: AgentEvent[] = [
      ...signedKnown,
      { type: "tools/snapshot", at: "", tools: changed },
      { ...request, body: { prefixEvents: 4, tail: cleanedTail } },
      { type: "request/error", at: "", error: "offline failure" },
      { type: "tools/snapshot", at: "", tools: definitions },
    ];
    expect(
      deriveMessages(failedB).find((message) => message.role === "assistant")?.opaque,
    ).toBeUndefined();
    expect(contextSize(failedB)).toEqual({ tokens: 223, basis: "estimate" });

    // 未知旧目录不因首次快照改变政策,明确无工具请求仍能证明空目录。
    expect(contextSize([...events, { type: "tools/snapshot", at: "", tools: changed }])).toEqual({
      tokens: 5120,
      basis: "usage",
    });
    expect(
      toolDefinitionsForRequest([...known, { ...request, tools: ["legacy"] }], known.length),
    ).toBeUndefined();
    // 跨快照逆查后再向前查,不能把更早的声明错配给较晚请求。
    const queryHistory: AgentEvent[] = [
      request,
      ...known,
      { type: "tools/snapshot", at: "", tools: changed },
      request,
      { ...request, tools: ["legacy"] },
      { ...request, tools: [], reason: "compaction" },
      { ...request, reason: "compaction" },
    ];
    const query = createToolDefinitionQuery(queryHistory);
    expect(query(known.length + 2)).toEqual(changed);
    expect(query(4)).toEqual(definitions);
    expect(query(0)).toBeUndefined();
    expect(query(known.length + 3)).toBeUndefined();
    expect(query(known.length + 4)).toEqual([]);
    expect(query(known.length + 5)).toBeUndefined();
    expect(query(known.length + 2)).toEqual(changed);
    expect(
      contextSize(
        [
          ...known,
          { ...request, tools: ["legacy"] },
          {
            type: "assistant/message",
            at: "",
            text: "",
            toolCalls: [],
            stopReason: "end",
            usage: { inputTokens: 9000, outputTokens: 2 },
          },
        ],
        changed,
      ),
    ).toEqual({ tokens: 9002, basis: "usage" });
    const noTools: AgentEvent[] = [
      ...events.slice(0, 2),
      { ...request, tools: [] },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 1000, outputTokens: 20 },
      },
    ];
    expect(contextSize(noTools, [])).toEqual({ tokens: 1020, basis: "usage" });
    expect(contextSize([...known, { ...request, tools: [], reason: "compaction" }])).toEqual({
      tokens: 5120,
      basis: "usage",
    });
    expect(
      contextSize([
        ...known,
        { type: "ext/event", at: "", source: "subagent", kind: "identity", payload: {} },
      ]),
    ).toEqual({ tokens: 210, basis: "estimate" });
  });

  it("真实 Anthropic 流取消后保留初始 usage,半截正文仍能触发下次自动压缩", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "S" });
    log.append({ type: "user/message", at: "", text: "go" });
    const partial = "p".repeat(40000);
    let requests = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const first = requests++ === 0;
      const events = [
        {
          type: "message_start",
          message: { usage: { input_tokens: first ? 1000 : 10004, output_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: first ? partial : "done" },
        },
        ...(!first
          ? [
              { type: "message_delta", delta: { stop_reason: "end_turn" } },
              { type: "message_stop" },
            ]
          : []),
      ];
      const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      if (!first) return new Response(sse);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("The request was aborted.", "AbortError"));
            });
          },
        }),
      );
    });
    try {
      const provider = anthropic({ apiKey: "bad", model: "m" });
      const cancel = new AbortController();
      expect(
        await runTurn({
          log,
          provider,
          tools: [],
          signal: cancel.signal,
          onDelta: () => cancel.abort(),
        }),
      ).toBe("aborted");
      expect(log.events.find((event) => event.type === "assistant/message")).toMatchObject({
        text: partial,
        stopReason: "aborted",
        usage: { inputTokens: 1000, outputTokens: 1 },
      });
      log.append({ type: "user/message", at: "", text: "continue" });
      let compactions = 0;
      await runTurn({
        log,
        provider,
        tools: [],
        compaction: {
          window: 5000,
          reserveTokens: 1000,
          strategy: async () => {
            compactions++;
            return null;
          },
        },
      });
      expect(compactions).toBe(1);
      expect(log.events.filter((event) => event.type === "request").at(-1)).toMatchObject({
        estimatedTokens: 10004,
        threshold: 4000,
      });
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("提示词模板", () => {
  it("frontmatter 的 description、$ARGUMENTS 与 $n 展开、引号参数", () => {
    const t = parseTemplate(
      "/x/review.md",
      "---\ndescription: 审查\n---\n审查 $1,重点 $2。全部:$ARGUMENTS",
    );
    expect(t).toMatchObject({ name: "review", description: "审查" });
    expect(expandTemplate(t, 'src/a.ts "错误 处理"')).toBe(
      '审查 src/a.ts,重点 错误 处理。全部:src/a.ts "错误 处理"',
    );
    expect(splitArgs(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
    const literal = "Keep $& $$ $` $' $1 $ARGUMENTS unchanged.\n    Indented  line";
    expect(expandTemplate({ ...t, body: "$ARGUMENTS" }, literal)).toBe(literal);
  });

  it("发现:用户级 → 项目级,同名以项目级为准", () => {
    const home = testDirectory("ak-home-");
    const proj = testDirectory("ak-proj-");
    mkdirSync(join(home, "prompts"), { recursive: true });
    mkdirSync(join(proj, ".clarook", "prompts"), { recursive: true });
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(home, "prompts", "a.md"), "用户级 A");
    writeFileSync(join(home, "prompts", "b.md"), "用户级 B");
    writeFileSync(join(proj, ".clarook", "prompts", "a.md"), "项目级 A");
    const unreadable = join(proj, ".clarook", "prompts", "unreadable.md");
    writeFileSync(unreadable, "Must be skipped without losing normal templates.");
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === unreadable) throw new Error("EACCES: template file");
      return read(...args);
    });
    const warnings: string[] = [];
    let found: ReturnType<typeof discoverTemplates>;
    try {
      found = discoverTemplates(proj, home, (error) => warnings.push(error.message));
    } finally {
      spy.mockRestore();
    }
    expect(found.map((t) => [t.name, t.body])).toEqual([
      ["a", "项目级 A"],
      ["b", "用户级 B"],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(unreadable);
    expect(warnings[0]).toContain("EACCES");
    const badHome = testDirectory("ak-template-source-");
    writeFileSync(join(badHome, "prompts"), "Expected a directory, not this file.");
    warnings.length = 0;
    const validProject = testDirectory("ak-template-project-");
    mkdirSync(join(validProject, ".clarook", "prompts"), { recursive: true });
    writeFileSync(join(validProject, ".clarook", "prompts", "ok.md"), "Still works.");
    expect(
      discoverTemplates(validProject, badHome, (error) => warnings.push(error.message)),
    ).toMatchObject([{ name: "ok", body: "Still works." }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(badHome, "prompts"));
  });
});

describe("@文件引用", () => {
  it("存在的文本文件附成 <file> 块;不存在的原样保留;二进制与超大文件跳过并说明", () => {
    const dir = testDirectory("ak-attach-");
    writeFileSync(join(dir, "a.txt"), "hello");
    writeFileSync(join(dir, "bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "big.txt"), "z".repeat(60 * 1024));
    const r = expandFileRefs("看 @a.txt 和 @nope.txt 与 @bin @big.txt", dir);
    expect(r.text).toContain('<file name="a.txt">\nhello\n</file>');
    expect(r.text).not.toContain('name="nope.txt"');
    expect(r.attachments.map((a) => [a.ref, a.skipped ?? "ok"])).toEqual([
      ["a.txt", "ok"],
      ["bin", "binary file, not attached"],
      ["big.txt", expect.stringContaining("exceeds")],
    ]);
    const content = "\uFEFF第一行 🙂\r\n  第二行\n";
    writeFileSync(join(dir, "report & notes.txt"), content, "utf8");
    writeFileSync(join(dir, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const quoted = expandFileRefs(
      `查看 @"report & notes.txt" @'./report & notes.txt' @invalid.txt`,
      dir,
    );
    expect(quoted.text).toBe(
      `查看 @"report & notes.txt" @'./report & notes.txt' @invalid.txt\n\n<file name="report &amp; notes.txt">\n${content}\n</file>`,
    );
    expect(quoted.attachments.map((a) => [a.ref, a.skipped ?? "ok"])).toEqual([
      ["report & notes.txt", "ok"],
      ["invalid.txt", "not valid UTF-8 text, not attached"],
    ]);
    expect(expandFileRefs('输入未完成 @"report & notes.txt', dir).attachments).toEqual([]);
    const unreadable = join(dir, "unreadable.txt");
    writeFileSync(unreadable, "Do not attach this content.");
    const vanished = join(dir, "vanished.txt");
    writeFileSync(vanished, "Gone after the file check.");
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === unreadable) throw new Error("EACCES: attachment file");
      if (args[0] === vanished)
        throw Object.assign(new Error("ENOENT: attachment disappeared"), { code: "ENOENT" });
      return read(...args);
    });
    try {
      const failed = expandFileRefs("中文要求 @unreadable.txt @a.txt @a.txt", dir);
      expect(failed.text).toBe(
        '中文要求 @unreadable.txt @a.txt @a.txt\n\n<file name="a.txt">\nhello\n</file>',
      );
      expect(failed.attachments).toEqual([
        {
          ref: "unreadable.txt",
          path: unreadable,
          bytes: 27,
          skipped: expect.stringContaining("EACCES"),
        },
        { ref: "a.txt", path: join(dir, "a.txt"), bytes: 5 },
      ]);
      expect(expandFileRefs("@vanished.txt @nope.txt", dir).attachments).toEqual([
        {
          ref: "vanished.txt",
          path: vanished,
          bytes: 26,
          skipped: expect.stringContaining("ENOENT"),
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("技能段", () => {
  it("发现 SKILL.md,frontmatter 取名与描述,注入只放名字、描述与路径", () => {
    const home = testDirectory("ak-sk-home-");
    const proj = testDirectory("ak-sk-proj-");
    mkdirSync(join(proj, ".git"));
    mkdirSync(join(home, "skills", "deploy"), { recursive: true });
    mkdirSync(join(proj, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(
      join(home, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 发布流程\n---\n步骤很长很长",
    );
    writeFileSync(join(proj, ".agents", "skills", "review", "SKILL.md"), "没有 frontmatter 的技能");
    const skills = discoverSkills(proj, { home, root: proj });
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["deploy", "发布流程"],
      ["review", ""],
    ]);
    const built = buildSystemPrompt({
      base: "角色",
      cwd: proj,
      skills: { mode: "auto" },
      catalog: skills,
      discover: { home, root: proj },
      env: { git: false },
    });
    const sec = built.sections.find((s) => s.name === "Skills");
    expect(sec?.text).toContain("- deploy: 发布流程");
    expect(sec?.text).not.toContain("步骤很长很长");
    // 不点名技能段就不注入已经发现的目录。
    const without = buildSystemPrompt({
      base: "角色",
      cwd: proj,
      skills: { mode: "auto" },
      catalog: skills,
      discover: { home, root: proj },
      env: { git: false },
      sections: ["role", "env"],
    });
    expect(without.sections.some((s) => s.name === "Skills")).toBe(false);
    expect(parseSkill("/x/foo/SKILL.md", "no front").name).toBe("foo");
  });
});

describe("分叉与扩展模块", () => {
  it("forkSession:复制前 N 条事件到新文件,原日志不动", () => {
    const dir = testDirectory("ak-fork-");
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "s" },
      { type: "user/message", at: "", text: "1" },
      { type: "assistant/message", at: "", text: "a", toolCalls: [], stopReason: "end" },
      { type: "user/message", at: "", text: "2" },
    ];
    const r = forkSession(events, 3, dir);
    expect(r.events).toBe(3);
    const copied = EventLog.load(r.file);
    expect(copied.events).toEqual(events.slice(0, 3));
    expect(events).toHaveLength(4);
  });

  it("loadExtensions:default 导出函数,返回工具与槽,可订阅事件;非函数报错", async () => {
    const dir = testDirectory("ak-ext-");
    const file = join(dir, "ext.mjs");
    writeFileSync(
      file,
      [
        "export default (ctx) => ({",
        '  tools: [{ name: "hello", description: "d", parameters: { type: "object", properties: {} }, execute: async () => "hi " + ctx.cwd }],',
        '  slots: { execution: "parallel" },',
        "  onEvent: (e) => { globalThis.__seen = (globalThis.__seen ?? 0) + 1; },",
        "  dispose: () => { globalThis.__released = (globalThis.__released ?? 0) + 1; },",
        "});",
      ].join("\n"),
    );
    const log = new EventLog();
    const ext = await loadExtensions(["ext.mjs"], { cwd: dir, log });
    expect(ext.tools?.map((t) => t.name)).toEqual(["hello"]);
    expect(await ext.tools?.[0]?.execute({}, { signal: new AbortController().signal })).toBe(
      `hi ${dir}`,
    );
    expect(ext.slots?.execution).toBe("parallel");
    log.append({ type: "user/message", at: "", text: "x" });
    expect((globalThis as { __seen?: number }).__seen).toBe(1);
    await ext.dispose();
    await ext.dispose();
    log.append({ type: "user/message", at: "", text: "after release" });
    expect((globalThis as { __seen?: number }).__seen).toBe(1);
    expect((globalThis as { __released?: number }).__released).toBe(1);
    writeFileSync(join(dir, "bad.mjs"), "export default 42;");
    await expect(loadExtensions([file, join(dir, "bad.mjs")], { cwd: "/w", log })).rejects.toThrow(
      /must default-export a function/,
    );
    log.append({ type: "user/message", at: "", text: "after failed initialization" });
    expect((globalThis as { __seen?: number }).__seen).toBe(1);
    expect((globalThis as { __released?: number }).__released).toBe(2);
    const failing = join(dir, "failing.mjs");
    const brokenCleanup = join(dir, "broken-cleanup.mjs");
    writeFileSync(failing, 'export default () => { throw "initialization rejected"; };');
    writeFileSync(
      brokenCleanup,
      'export default () => ({ dispose() { throw "release rejected"; } });',
    );
    await expect(
      loadExtensions([file, brokenCleanup, failing], { cwd: "/w", log }),
    ).rejects.toThrow("initialization rejected");
    log.append({ type: "user/message", at: "", text: "after failed cleanup" });
    expect((globalThis as { __seen?: number }).__seen).toBe(1);
    expect((globalThis as { __released?: number }).__released).toBe(3);
  });
});

describe("OpenAI 兼容:输出上限字段按方言", () => {
  it("openai 发 max_completion_tokens,deepseek 发 max_tokens,不配置则都不发", () => {
    const base = { baseUrl: "http://x", apiKey: "k", model: "m" };
    const oa = openaiCompat({ ...base, maxTokens: 100 }).wire?.([], []) as Record<string, unknown>;
    expect(oa.max_completion_tokens).toBe(100);
    expect(oa.max_tokens).toBeUndefined();
    const ds = openaiCompat({ ...base, maxTokens: 100, dialect: "deepseek" }).wire?.(
      [],
      [],
    ) as Record<string, unknown>;
    expect(ds.max_tokens).toBe(100);
    const none = openaiCompat(base).wire?.([], []) as Record<string, unknown>;
    expect(none.max_tokens).toBeUndefined();
    expect(none.max_completion_tokens).toBeUndefined();
  });
});

// 让 readFileSync 的导入有用武之地:分叉文件是逐行 JSON。
it("分叉文件是 JSONL", () => {
  const dir = testDirectory("ak-fork2-");
  const r = forkSession([{ type: "session/start", at: "", model: "m", system: "s" }], 1, dir);
  expect(readFileSync(r.file, "utf8").trim().split("\n")).toHaveLength(1);
});

describe("自动压缩阈值", () => {
  it("余量不许吃掉超过一半窗口:小窗口下阈值不为负", async () => {
    const { compactionThreshold } = await import("../src/loop.js");
    expect(compactionThreshold(131072, 32000)).toBe(99072);
    expect(compactionThreshold(8000, 32000)).toBe(4000);
    expect(compactionThreshold(50000)).toBe(33616);
    expect(compactionThreshold(1000000, 32000, 0.8)).toBe(800000);
    expect(compactionThreshold(1000000, 32000, 0)).toBe(968000);
    expect(compactionThreshold(128000, 32000, 0.8)).toBe(96000);
    expect(compactionThreshold(8000, 32000, 0.4)).toBe(3200);
  });
});
