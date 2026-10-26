// 子 agent 打磨项:审批继承与收紧、步数上限与续聊、类型注册表、嵌套深度、描述的注册表段。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { EventLog as Log } from "../src/log.js";
import type { ApproveOrigin, TurnDeps } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import type { Provider, ToolDef } from "../src/provider.js";
import { createTaskTool, type TaskToolOptions } from "../src/subagent.js";
import { defineTool } from "../src/tools.js";

function parentLog(): EventLog {
  const log = new Log();
  log.append({ type: "session/start", at: "t", model: "m", system: "parent system" });
  log.append({ type: "user/message", at: "t", text: "hi" });
  return log;
}

const echo = defineTool({
  name: "echo",
  description: "",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});
const other = defineTool({
  name: "other",
  description: "",
  parameters: Type.Object({}),
  async execute() {
    return "other";
  },
});

/** 子模型:奇数步调 echo,偶数步收尾。记下它看到的工具与消息数。 */
function childProvider(model = "fake"): Provider & { tools: string[][]; seen: number[] } {
  const tools: string[][] = [];
  const seen: number[] = [];
  let step = 0;
  return {
    model,
    tools,
    seen,
    async complete(messages: unknown[], defs: ToolDef[]) {
      tools.push(defs.map((t) => t.name));
      seen.push(messages.length);
      step += 1;
      if (step % 2 === 1) {
        return {
          text: "",
          toolCalls: [{ id: `k${step}`, name: "echo", args: { text: "x" } }],
          stopReason: "tool" as const,
        };
      }
      return { text: `child done ${step}`, toolCalls: [], stopReason: "end" as const };
    },
  };
}

/** 永远调工具的子模型:用来触发步数上限。 */
function loopingProvider(): Provider {
  let n = 0;
  return {
    model: "fake",
    async complete() {
      n += 1;
      return {
        text: `step ${n}`,
        toolCalls: [{ id: `k${n}`, name: "echo", args: { text: String(n) } }],
        stopReason: "tool",
      };
    },
  };
}

/** task 工具加一个子日志收集器:每次派活(含续聊)把子日志按顺序记下。 */
function mk(opts: Omit<TaskToolOptions, "parent" | "onChild"> & { parent?: EventLog }) {
  const logs: EventLog[] = [];
  const tool = createTaskTool({
    parent: opts.parent ?? parentLog(),
    ...opts,
    onChild: (child) => logs.push(child.log),
  });
  return {
    tool,
    logs,
    firstResult: (nth = 1) => logs[nth - 1]?.events.find((e) => e.type === "tool/result"),
  };
}

const ctx = (callId = "c1") => ({ signal: new AbortController().signal, callId });

describe("子的审批", () => {
  it("inherit(缺省):子沿用父此刻的审批实现,调用带上子的名字", async () => {
    const asked: { call: ToolCall; origin?: ApproveOrigin }[] = [];
    const slots: TurnDeps["slots"] = {
      approve: (call, origin) => {
        asked.push({ call, ...(origin && { origin }) });
        return true;
      },
    };
    const { tool } = mk({ provider: childProvider(), tools: [echo], slots });
    const out = await tool.execute({ task: "go" }, ctx());
    expect(out).toContain("child done 2");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.call.name).toBe("echo");
    expect(asked[0]?.origin).toEqual({ agent: "sub-1" });
  });

  it("父拒绝则子也被拒;allow 档让子绕过父的审批", async () => {
    const denyAll: TurnDeps["slots"] = { approve: () => ({ allowed: false, reason: "no" }) };
    const inherit = mk({ provider: childProvider(), tools: [echo], slots: denyAll });
    await inherit.tool.execute({ task: "go" }, ctx());
    expect(inherit.firstResult()).toMatchObject({
      isError: true,
      content: "The user denied this call: no",
    });

    const allow = mk({
      provider: childProvider(),
      tools: [echo],
      slots: denyAll,
      approval: "allow",
    });
    await allow.tool.execute({ task: "go" }, ctx());
    expect(allow.firstResult()).toMatchObject({ isError: false, content: "echo:x" });
  });

  it("规则对象只能收紧:命中 deny 直接拒,其余交给父", async () => {
    let parentAsked = 0;
    const slots: TurnDeps["slots"] = {
      approve: () => {
        parentAsked += 1;
        return true;
      },
    };
    const { tool, firstResult } = mk({
      provider: childProvider(),
      tools: [echo],
      slots,
      approval: { deny: ["echo"] },
      cwd: "C:/tmp",
    });
    await tool.execute({ task: "go" }, ctx());
    expect(firstResult()).toMatchObject({
      isError: true,
      content: "The user denied this call: sub-agent policy: deny rule echo",
    });
    expect(parentAsked).toBe(0);
    const cancel = new AbortController();
    let waiting = false;
    let release = () => {};
    const forwarded = mk({
      provider: childProvider(),
      tools: [echo],
      slots: {
        approve: (_call, _origin, signal) =>
          new Promise<boolean>((resolve) => {
            waiting = true;
            release = () => resolve(false);
            signal?.addEventListener("abort", release, { once: true });
          }),
      },
      approval: { deny: [] },
    });
    const pending = forwarded.tool
      .execute({ task: "forward" }, { callId: "cancelled-child", signal: cancel.signal })
      .catch((error: unknown) => error as Error);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      cancel.abort();
      await vi.waitFor(() => expect(finished).toBe(true));
      const outcome = await pending;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("interrupted");
      expect(forwarded.firstResult()).toMatchObject({
        content: "Interrupted by the user; not executed.",
        isError: true,
      });
    } finally {
      release();
      await pending;
    }
  });

  it("槽给函数:会话中切换审批对之后派出的子生效", async () => {
    let current: TurnDeps["slots"] = { approve: () => true };
    const { tool, firstResult } = mk({
      provider: childProvider(),
      tools: [echo],
      slots: () => current,
    });
    await tool.execute({ task: "one" }, ctx());
    expect(firstResult(1)).toMatchObject({ isError: false });
    current = { approve: () => ({ allowed: false, reason: "switched" }) };
    await tool.execute({ task: "two" }, ctx("c2"));
    expect(firstResult(2)).toMatchObject({ isError: true });
  });
});

describe("步数上限与续聊", () => {
  it("到上限:结果不是错误,附 stopped 说明与 resume 提示;子日志有 termination 决定", async () => {
    const { tool, logs } = mk({ provider: loopingProvider(), tools: [echo], maxSteps: 2 });
    const out = await tool.execute({ task: "endless" }, ctx());
    expect(out).toContain("Sub-agent sub-1 stopped early");
    expect(out).toContain('resume: "sub-1"');
    const log = logs[0];
    expect(log?.events.some((e) => e.type === "decision" && e.slot === "termination")).toBe(true);
    expect(log?.events.filter((e) => e.type === "assistant/message")).toHaveLength(2);
  });

  it("类型的 maxSteps 覆盖全局的", async () => {
    const { tool, logs } = mk({
      provider: loopingProvider(),
      tools: [echo],
      maxSteps: 5,
      types: { quick: { description: "one step", maxSteps: 1 } },
    });
    await tool.execute({ task: "endless", type: "quick" }, ctx());
    expect(logs[0]?.events.filter((e) => e.type === "assistant/message")).toHaveLength(1);
  });

  it("续聊:同一子日志上追加简报再跑;未知 id 报错;运行中的不许续", async () => {
    const provider = childProvider();
    const { tool, logs } = mk({ provider, tools: [echo] });
    const first = await tool.execute({ task: "first" }, ctx());
    expect(first).toContain("Sub-agent sub-1 finished");
    const log = logs[0];
    const before = log?.events.length ?? 0;

    const second = await tool.execute({ task: "follow-up", resume: "sub-1" }, ctx("c2"));
    expect(second).toContain("child done 4");
    expect(logs[1]).toBe(log);
    const texts = log?.events.filter((e) => e.type === "user/message").map((e) => e.text);
    expect(texts).toEqual(["first", "follow-up"]);
    expect(log?.events.length).toBeGreaterThan(before);
    // 续聊的第一次请求看到了第一次的全部历史
    expect(provider.seen[2]).toBeGreaterThan(provider.seen[0] ?? 0);

    await expect(tool.execute({ task: "x", resume: "sub-9" }, ctx())).rejects.toThrow(
      'Unknown sub-agent id "sub-9"',
    );

    // 重建工具等价于恢复父会话:新子不能把自己的起始事件写进旧子的文件。
    const dir = mkdtempSync(join(tmpdir(), "clarook-child-resume-"));
    try {
      const parent = new Log(join(dir, "parent.jsonl"));
      for (const event of parentLog().events) parent.append(event);
      const initial = mk({ parent, provider: childProvider(), tools: [echo] });
      await initial.tool.execute({ task: "original child" }, ctx());
      const childPath = join(dir, "parent-sub-1.jsonl");
      const original = readFileSync(childPath, "utf8");
      parent.recording?.flush();
      parent.recording?.dispose();
      for (const child of initial.logs) {
        child.recording?.flush();
        child.recording?.dispose();
      }
      let missingResultSeen = 0;
      let toolCalls = 0;
      const restored = mk({
        parent: Log.load(parent.path as string, { attach: true }),
        tools: [
          {
            ...echo,
            execute: async () => {
              toolCalls++;
              return "unexpected replay";
            },
          },
        ],
        provider: {
          model: "fake",
          async complete(messages) {
            if (messages.some((m) => m.role === "tool" && m.callId === "unfinished")) {
              expect(
                messages.find((m) => m.role === "tool" && m.callId === "unfinished"),
              ).toMatchObject({ content: expect.stringContaining("execution outcome is unknown") });
              missingResultSeen++;
            }
            return { text: "checked", toolCalls: [], stopReason: "end" };
          },
        },
      });
      expect(await restored.tool.execute({ task: "new child" }, ctx())).toContain("sub-2 finished");
      expect(readFileSync(childPath, "utf8")).toBe(original);
      const interrupted = Log.load(childPath, { attach: true });
      interrupted.append({
        type: "assistant/message",
        at: "t",
        text: "Working",
        toolCalls: [{ id: "unfinished", name: "echo", args: { text: "side effect unknown" } }],
        stopReason: "tool",
      });
      interrupted.recording?.flush();
      interrupted.recording?.dispose();
      await restored.tool.execute({ task: "check actual state", resume: "sub-1" }, ctx());
      await restored.tool.execute({ task: "follow-up", resume: "sub-1" }, ctx());
      expect(missingResultSeen).toBe(2);
      expect(toolCalls).toBe(0);
      const recovered = Log.load(childPath);
      expect(recovered.events.filter((e) => e.type === "tool/unresolved")).toHaveLength(1);
      expect(recovered.events.filter((e) => e.type === "session/start")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("类型注册表与嵌套", () => {
  it("类型决定工具子集、模型、系统提示词与缺省范围;枚举进参数;描述带注册表段", async () => {
    const cheap = childProvider("cheap");
    const { tool, logs } = mk({
      provider: childProvider(),
      tools: [echo, other],
      types: {
        research: {
          description: "read-only investigation",
          tools: ["echo"],
          model: "cheap",
          system: "you are a researcher",
          scope: "userMessagesOnly",
        },
      },
      providerFor: (model) => {
        expect(model).toBe("cheap");
        return cheap;
      },
    });
    const schema = tool.parameters as unknown as {
      properties: { type: { anyOf: { const: string }[] } };
    };
    expect(schema.properties.type.anyOf.map((x) => x.const)).toEqual(["default", "research"]);
    expect(tool.description).toContain("Sub-agent types (type parameter)");
    expect(tool.description).toContain("- research: read-only investigation");
    expect(tool.describe.suffix).toContain("- default (default)");

    await tool.execute({ task: "dig", type: "research" }, ctx());
    expect(cheap.tools[0]).toEqual(["echo"]);
    expect(deriveMessages(logs[0]?.events ?? [])[0]).toMatchObject({
      role: "system",
      content: "you are a researcher",
    });
    // userMessagesOnly:父的 user/message 也进了子日志
    const texts = logs[0]?.events.filter((e) => e.type === "user/message").map((e) => e.text);
    expect(texts).toEqual(["hi", "dig"]);
  });

  it("新子继承当前system,类型覆盖最后生效;续聊保留子自己的修改", async () => {
    for (const [scope, override] of [
      ["taskOnly", undefined],
      ["userMessagesOnly", undefined],
      ["fork", undefined],
      ["fork", "OVERRIDE"],
      ["fork", ""],
    ] as const) {
      const parent = parentLog();
      parent.append({
        type: "context/edit",
        at: "t",
        target: 0,
        field: "system",
        value: "CURRENT",
      });
      parent.append({
        type: "assistant/message",
        at: "t",
        text: "",
        toolCalls: [{ id: "dispatch", name: "task", args: { task: "inspect" } }],
        stopReason: "tool",
      });
      const before = JSON.stringify(parent.events);
      const seen: string[] = [];
      const { tool, logs } = mk({
        parent,
        tools: [],
        types: {
          custom: { description: "custom", ...(override !== undefined && { system: override }) },
        },
        provider: {
          model: "fake",
          async complete(messages) {
            seen.push(messages.find((m) => m.role === "system")?.content ?? "MISSING");
            return { text: "done", toolCalls: [], stopReason: "end" };
          },
        },
      });
      await tool.execute({ task: "inspect", scope, type: "custom" }, ctx("dispatch"));
      expect(seen).toEqual([override ?? "CURRENT"]);
      expect(JSON.stringify(parent.events)).toBe(before);
      const child = logs[0];
      expect(child).toBeDefined();
      child?.append({ type: "context/edit", at: "t", target: 0, field: "system", value: "CHILD" });
      parent.append({
        type: "context/edit",
        at: "t",
        target: 0,
        field: "system",
        value: "PARENT_CHANGED",
      });
      await tool.execute({ task: "continue", type: "custom", resume: "sub-1" }, ctx());
      expect(seen).toEqual([override ?? "CURRENT", "CHILD"]);
    }
  });

  it("类型要的模型没有 providerFor 时报错回喂", async () => {
    const { tool } = mk({
      provider: childProvider(),
      tools: [echo],
      types: { far: { description: "x", model: "elsewhere" } },
    });
    await expect(tool.execute({ task: "t", type: "far" }, ctx())).rejects.toThrow(
      "no provider lookup is configured",
    );
  });

  it("depth 2:子有 task 工具,孙没有", async () => {
    const seen: string[][] = [];
    let n = 0;
    const provider: Provider = {
      model: "fake",
      async complete(_m: unknown[], defs: ToolDef[]) {
        seen.push(defs.map((t) => t.name));
        n += 1;
        // 子的第一步派一个孙;孙直接收尾;子第二步收尾。
        if (n === 1) {
          return {
            text: "",
            toolCalls: [{ id: "g1", name: "task", args: { task: "grandchild" } }],
            stopReason: "tool",
          };
        }
        return { text: `done ${n}`, toolCalls: [], stopReason: "end" };
      },
    };
    const { tool } = mk({
      provider,
      tools: [echo, other],
      depth: 2,
      types: { limited: { description: "restricted tools", tools: ["echo", "task"] } },
    });
    const out = await tool.execute({ task: "child", type: "limited" }, ctx());
    expect(out).toContain("done 3");
    expect(seen[0]).toEqual(["echo", "task"]);
    expect(seen[1]).toEqual(["echo"]);
  });
});
