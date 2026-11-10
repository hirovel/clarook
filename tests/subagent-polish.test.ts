// 子 agent 打磨项:审批继承与收紧、步数上限与续聊、类型注册表、嵌套深度、描述的注册表段。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { EventLog as Log } from "../src/log.js";
import { type ApproveOrigin, maxSteps, type TurnDeps } from "../src/loop.js";
import { deriveMessages, type Message } from "../src/messages.js";
import type { Provider, ToolDef } from "../src/provider.js";
import { type ChildTools, TaskSessions, type TaskToolOptions } from "../src/subagent.js";
import { defineTool } from "../src/tools.js";
import { testImage } from "./helpers/image.js";

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
function loopingProvider(model = "fake"): Provider & { tools: string[][] } {
  let n = 0;
  const tools: string[][] = [];
  return {
    model,
    tools,
    async complete(_messages, definitions) {
      tools.push(definitions.map((tool) => tool.name));
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
function mk({
  parent = parentLog(),
  ...opts
}: Omit<TaskToolOptions, "onChild"> & { parent?: EventLog }) {
  const logs: EventLog[] = [];
  const sessions = new TaskSessions(parent);
  const tool = sessions.tool({
    ...opts,
    onChild: (child) => logs.push(child.log),
  });
  return {
    tool,
    logs,
    sessions,
    firstResult: (nth = 1) => logs[nth - 1]?.events.find((e) => e.type === "tool/result"),
  };
}

const ctx = (callId = "c1") => ({ signal: new AbortController().signal, callId });

describe("子的审批", () => {
  it("inherit(缺省):子沿用父此刻的审批实现,调用带上子的名字", async () => {
    const asked: { call: ToolCall; origin?: ApproveOrigin }[] = [];
    let inheritedHooks = 0;
    let inheritedAfterHooks = 0;
    const slots: TurnDeps["slots"] = {
      beforeToolCall: () => {
        inheritedHooks += 1;
        return { args: { text: "static-inherited" } };
      },
      afterToolCall: ({ result }) => {
        inheritedAfterHooks += 1;
        return { content: `static-after:${result.content}` };
      },
      approve: (call, origin) => {
        asked.push({ call, ...(origin && { origin }) });
        return true;
      },
    };
    const { tool, firstResult } = mk({ provider: childProvider(), tools: [echo], slots });
    const out = await tool.execute({ task: "go" }, ctx());
    expect(out).toContain("child done 2");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.call.name).toBe("echo");
    expect(asked[0]?.origin).toEqual({ agent: "sub-1" });
    expect(asked[0]?.call.args).toEqual({ text: "static-inherited" });
    expect(firstResult()).toMatchObject({ content: "static-after:echo:static-inherited" });
    expect(inheritedHooks).toBe(1);
    expect(inheritedAfterHooks).toBe(1);

    // 工厂没有本地 hook 时也不能回退父闭包;有 hook 时只操作自己的子日志。
    for (const local of [false, true]) {
      const parent = parentLog();
      const child = mk({
        parent,
        provider: childProvider(),
        slots,
        tools: async (log): Promise<ChildTools> => {
          const resources: ChildTools = { tools: [echo], dispose: async () => {} };
          if (local) {
            resources.beforeToolCall = () => {
              log.append({
                type: "ext/event",
                at: "t",
                source: "owner-test",
                kind: "before",
                payload: {},
              });
              return { args: { text: "child-local" } };
            };
            resources.afterToolCall = ({ result }) => {
              log.append({
                type: "ext/event",
                at: "t",
                source: "owner-test",
                kind: "after",
                payload: {},
              });
              return { content: `child-after:${result.content}` };
            };
          }
          return resources;
        },
      });
      await child.tool.execute({ task: "go" }, ctx());
      expect(inheritedHooks).toBe(1);
      expect(inheritedAfterHooks).toBe(1);
      expect(child.firstResult()).toMatchObject({
        content: local ? "child-after:echo:child-local" : "echo:x",
      });
      expect(
        child.logs[0]?.events.filter(
          (event) => event.type === "ext/event" && event.source === "owner-test",
        ),
      ).toHaveLength(local ? 2 : 0);
      expect(
        parent.events.some((event) => event.type === "ext/event" && event.source === "owner-test"),
      ).toBe(false);
    }
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

  it("非默认类型省略 type 续聊仍沿用首次模型、工具和每轮步数上限", async () => {
    const cheap = loopingProvider("cheap");
    const { tool, logs } = mk({
      provider: childProvider("parent"),
      providerFor: () => ({ provider: cheap, modelLocator: "cheap" }),
      tools: [echo, other],
      maxSteps: 5,
      types: {
        quick: { description: "one step", model: "cheap", tools: ["echo"], maxSteps: 1 },
      },
    });
    await tool.execute({ task: "endless", type: "quick" }, ctx());
    expect(logs[0]?.events.filter((e) => e.type === "assistant/message")).toHaveLength(1);
    await tool.execute({ task: "follow-up", resume: "sub-1" }, ctx("c2"));
    expect(cheap.tools).toEqual([["echo"], ["echo"]]);
    expect(logs[1]).toBe(logs[0]);
    expect(logs[0]?.events.filter((e) => e.type === "assistant/message")).toHaveLength(2);
  });

  it("续聊:同一子日志上追加简报再跑;未知 id 报错;运行中的不许续", async () => {
    const provider = childProvider();
    let slots: TurnDeps["slots"] = {};
    const { tool, logs } = mk({ provider, tools: [echo], slots: () => slots });
    const first = await tool.execute({ task: "first" }, ctx());
    expect(first).toContain("Sub-agent sub-1 finished");
    const log = logs[0];
    const before = log?.events.length ?? 0;

    slots = { termination: maxSteps(1) };
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
        depth: 3,
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
          async complete(messages, definitions) {
            if (messages.at(-1)?.content !== "new child")
              expect(definitions.map((tool) => tool.name)).toEqual(["echo"]);
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

  it("同一子任务准备资源期间只接受一次续聊", async () => {
    let requests = 0;
    let blocked: Promise<void> | undefined;
    let release = () => {};
    let entered = () => {};
    const { tool, logs } = mk({
      provider: {
        model: "fake",
        async complete() {
          requests++;
          return { text: "done", toolCalls: [], stopReason: "end" };
        },
      },
      tools: async () => {
        entered();
        await blocked;
        return { tools: [], dispose: async () => {} };
      },
    });
    await tool.execute({ task: "first" }, ctx());
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const firstResume = tool.execute({ task: "follow-up", resume: "sub-1" }, ctx());
    await preparing;
    const overlap = tool.execute({ task: "duplicate", resume: "sub-1" }, ctx());
    release();
    const results = await Promise.allSettled([firstResume, overlap]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("still preparing") }),
    });
    expect(requests).toBe(2);
    expect(
      logs[0]?.events.filter((event) => event.type === "user/message").map((event) => event.text),
    ).toEqual(["first", "follow-up"]);
  });

  it("首次约束或资源准备失败不发布子任务或新简报,清掉候选日志后仍可派发", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-child-preparation-"));
    const parent = new Log(join(dir, "parent.jsonl"));
    for (const event of parentLog().events) parent.append(event);
    let requests = 0;
    let preparations = 0;
    let postprocessed = 0;
    let limit = 1;
    let modelLocator = " ";
    let failedPath: string | undefined;
    let fail = false;
    const { tool, logs, sessions } = mk({
      parent,
      provider: {
        model: "fake",
        async complete(messages) {
          requests++;
          if (messages.at(-1)?.role === "user")
            return {
              text: "",
              toolCalls: [{ id: "prepared-echo", name: "echo", args: { text: "ready" } }],
              stopReason: "tool",
            };
          return { text: "done", toolCalls: [], stopReason: "end" };
        },
      },
      modelLocator: () => modelLocator,
      slots: () => ({
        termination: maxSteps(limit),
        afterToolCall: () => {
          throw new Error("A factory child must use its own hook");
        },
      }),
      tools: async (log) => {
        preparations++;
        if (fail) {
          failedPath = log.path;
          log.append({
            type: "ext/event",
            at: "t",
            source: "fixture",
            kind: "prepare",
            payload: {},
          });
          throw new Error("resource preparation failed");
        }
        return {
          tools: [echo],
          afterToolCall: ({ result }) => {
            postprocessed++;
            return { content: `prepared-after:${result.content}` };
          },
          dispose: async () => {},
        };
      },
    });
    try {
      const nonfiniteProvider = loopingProvider();
      const invalidDepth = mk({ parent, provider: nonfiniteProvider, tools: [], depth: Infinity });
      await expect(invalidDepth.tool.execute({ task: "invalid depth" }, ctx())).rejects.toThrow(
        "finite delegation depth",
      );
      expect(nonfiniteProvider.tools).toEqual([]);
      expect(invalidDepth.logs).toEqual([]);
      expect(invalidDepth.sessions.logs()).toEqual([parent]);
      await expect(tool.execute({ task: "invalid model locator" }, ctx())).rejects.toThrow(
        "non-empty model locator",
      );
      expect(preparations).toBe(0);
      modelLocator = "fixture/fake";
      limit = -Infinity;
      await expect(tool.execute({ task: "invalid limit" }, ctx())).rejects.toThrow(
        "finite step limit",
      );
      expect(preparations).toBe(0);
      expect(requests).toBe(0);
      expect(logs).toEqual([]);
      expect(sessions.logs()).toEqual([parent]);
      expect(postprocessed).toBe(0);
      limit = 1;
      fail = true;
      await expect(tool.execute({ task: "must not start" }, ctx())).rejects.toThrow(
        "resource preparation failed",
      );
      expect(requests).toBe(0);
      expect(logs).toEqual([]);
      expect(sessions.logs()).toEqual([parent]);
      expect(postprocessed).toBe(0);
      if (!failedPath) throw new Error("missing failed preparation path");
      const candidatePath = failedPath;
      expect(existsSync(candidatePath)).toBe(false);
      expect(existsSync(candidatePath.replace(/\.jsonl$/, ".records"))).toBe(false);
      const candidate = new Log(candidatePath);
      candidate.recording?.dispose();
      fail = false;
      limit = 2;
      expect(await tool.execute({ task: "start" }, ctx())).toContain("finished");
      expect(requests).toBe(2);
      expect(postprocessed).toBe(1);
      expect(logs[0]?.events.find((event) => event.type === "tool/result")).toMatchObject({
        content: "prepared-after:echo:ready",
      });
      expect(
        logs[0]?.events.filter((event) => event.type === "user/message").map((event) => event.text),
      ).toEqual(["start"]);
    } finally {
      parent.recording?.dispose();
      for (const log of logs) log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重建工具后继承首次实际约束,同名模型不换供应商,祖先身份和新注册表不扩权", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-child-identity-"));
    const opened: EventLog[] = [];
    try {
      const parent = new Log(join(dir, "parent.jsonl"));
      opened.push(parent);
      for (const event of parentLog().events) parent.append(event);
      parent.append({
        type: "ext/event",
        at: "t",
        source: "subagent",
        kind: "identity",
        payload: {
          id: "sub-1",
          type: "ancestor",
          scope: "taskOnly",
          model: "q/same",
          tools: ["other"],
          maxSteps: 9,
          remainingDepth: 0,
        },
      });
      const original = loopingProvider("same");
      const initial = mk({
        parent,
        provider: childProvider("parent"),
        modelLocator: "q/parent",
        tools: [echo, other],
        depth: 2,
        slots: { termination: maxSteps(2) },
        types: {
          research: {
            description: "restricted",
            model: "alias",
            tools: ["echo", "task", "not-installed"],
            scope: "fork",
          },
        },
        providerFor: (model) => {
          expect(model).toBe("alias");
          return { provider: original, modelLocator: "p/same" };
        },
      });
      await initial.tool.execute({ task: "first", type: "research" }, ctx());
      expect(original.tools).toEqual([
        ["echo", "task"],
        ["echo", "task"],
      ]);
      const child = initial.logs[0];
      if (!child) throw new Error("missing child");
      opened.push(child);
      child.append({ type: "context/edit", at: "t", target: 0, field: "system", value: "CHILD" });
      for (const log of opened) {
        log.recording?.flush();
        log.recording?.dispose();
      }

      const requests: { tools: string[]; system: string }[] = [];
      const lookups: string[] = [];
      const restoredParent = Log.load(parent.path as string, { attach: true });
      opened.push(restoredParent);
      const restored = mk({
        parent: restoredParent,
        provider: childProvider("same"),
        modelLocator: "q/same",
        tools: async (target) => {
          opened.push(target);
          return { tools: [echo, other], dispose: async () => {} };
        },
        depth: 3,
        slots: { termination: maxSteps(7) },
        types: {
          research: {
            description: "changed",
            model: "q/same",
            tools: ["other", "task"],
            maxSteps: 9,
            system: "CHANGED",
            scope: "taskOnly",
          },
        },
        providerFor: (model) => {
          lookups.push(model);
          if (model !== "p/same") throw new Error(`unavailable model ${model}`);
          return {
            modelLocator: "p/same",
            provider: {
              model: "same",
              async complete(messages, definitions) {
                requests.push({
                  tools: definitions.map((tool) => tool.name),
                  system: messages.find((message) => message.role === "system")?.content ?? "",
                });
                const brief = messages.at(-1);
                if (brief?.role === "user" && brief.content === "nested")
                  return { text: "nested done", toolCalls: [], stopReason: "end" };
                return {
                  text: "working",
                  toolCalls: [
                    brief?.role === "user" && brief.content === "follow-up"
                      ? { id: "nested", name: "task", args: { task: "nested", scope: "fork" } }
                      : { id: "echo", name: "echo", args: { text: "x" } },
                  ],
                  stopReason: "tool",
                };
              },
            },
          };
        },
      });
      await restored.tool.execute({ task: "follow-up", resume: "sub-1", scope: "taskOnly" }, ctx());
      opened.push(...restored.logs);
      expect(lookups).toEqual(["p/same"]);
      expect(requests).toEqual([
        { tools: ["echo", "task"], system: "CHILD" },
        { tools: ["echo"], system: "CHILD" },
        { tools: ["echo", "task"], system: "CHILD" },
      ]);
      expect(
        restored.logs[0]?.events.filter((event) => event.type === "assistant/message"),
      ).toHaveLength(4);
      const beforeConflict = requests.length;
      await expect(
        restored.tool.execute({ task: "switch", resume: "sub-1", type: "default" }, ctx()),
      ).rejects.toThrow('cannot resume as "default"');
      expect(requests).toHaveLength(beforeConflict);
      expect(
        restored.logs[0]?.events
          .filter((event) => event.type === "user/message")
          .map((event) => event.text),
      ).toEqual(["hi", "first", "follow-up"]);
    } finally {
      for (const log of opened) log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("恢复缺模型、错供应商、原工具或嵌套深度均零执行且释放写锁;旧日志只允许查看", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-child-unavailable-"));
    const opened: EventLog[] = [];
    try {
      const parent = new Log(join(dir, "parent.jsonl"));
      opened.push(parent);
      for (const event of parentLog().events) parent.append(event);
      const initial = mk({
        parent,
        provider: childProvider("same"),
        modelLocator: "p/same",
        tools: [echo],
        depth: 2,
      });
      await initial.tool.execute({ task: "first" }, ctx());
      opened.push(...initial.logs);
      for (const log of opened) {
        log.recording?.flush();
        log.recording?.dispose();
      }
      const childPath = join(dir, "parent-sub-1.jsonl");
      const original = readFileSync(childPath, "utf8");
      const originalMessages = deriveMessages(Log.load(childPath).events);
      const resumedProvider = childProvider("same");
      let mode: "offline" | "wrong-provider" | "missing-tools" | "available" = "offline";
      let disposed = 0;
      const restoredParent = Log.load(parent.path as string, { attach: true });
      opened.push(restoredParent);
      const shallow = mk({
        parent: restoredParent,
        provider: resumedProvider,
        modelLocator: "p/same",
        tools: [echo],
        depth: 1,
      });
      await expect(
        shallow.tool.execute({ task: "insufficient depth", resume: "sub-1" }, ctx()),
      ).rejects.toThrow("requires delegation depth 1, but only 0 is available");
      expect(resumedProvider.tools).toEqual([]);
      expect(shallow.logs).toEqual([]);
      expect(shallow.sessions.logs()).toEqual([restoredParent]);
      const afterShallow = Log.load(childPath, { attach: true });
      expect(deriveMessages(afterShallow.events)).toEqual(originalMessages);
      afterShallow.recording?.dispose();
      const restored = mk({
        parent: restoredParent,
        provider: childProvider("same"),
        modelLocator: "q/same",
        depth: 2,
        providerFor: (model) => {
          expect(model).toBe("p/same");
          if (mode === "offline") throw new Error("Model p/same is offline");
          return {
            provider: resumedProvider,
            modelLocator: mode === "wrong-provider" ? "q/same" : "p/same",
          };
        },
        tools: async (log) => {
          log.append({
            type: "ext/event",
            at: "t",
            source: "fixture",
            kind: "prepared",
            payload: {},
          });
          return {
            tools: mode === "missing-tools" ? [] : [echo, other],
            dispose: async () => {
              disposed++;
            },
          };
        },
      });
      for (const [next, error] of [
        ["offline", "is offline"],
        ["wrong-provider", "lookup returned q/same"],
        ["missing-tools", "requires unavailable tools: echo"],
      ] as const) {
        mode = next;
        await expect(
          restored.tool.execute({ task: "must not run", resume: "sub-1" }, ctx()),
        ).rejects.toThrow(error);
        expect(resumedProvider.tools).toEqual([]);
        expect(restored.logs).toEqual([]);
        expect(restored.sessions.logs()).toEqual([restoredParent]);
        expect(readFileSync(childPath, "utf8").startsWith(original)).toBe(true);
        const inspect = Log.load(childPath, { attach: true });
        expect(deriveMessages(inspect.events)).toEqual(originalMessages);
        expect(
          inspect.events.filter(
            (event) => event.type === "ext/event" && event.source === "subagent",
          ),
        ).toHaveLength(1);
        inspect.recording?.dispose();
      }
      expect(disposed).toBe(1);
      mode = "available";
      await restored.tool.execute({ task: "follow-up", resume: "sub-1" }, ctx());
      opened.push(...restored.logs);
      expect(resumedProvider.tools).toEqual([
        ["echo", "task"],
        ["echo", "task"],
      ]);
      expect(disposed).toBe(2);
      const ownedAfterResume = restored.sessions.logs();

      const legacyPath = join(dir, "parent-sub-2.jsonl");
      const legacy = new Log(legacyPath);
      for (const event of parentLog().events) legacy.append(event);
      legacy.recording?.flush();
      legacy.recording?.dispose();
      const beforeLegacy = readFileSync(legacyPath, "utf8");
      await expect(
        restored.tool.execute({ task: "guess", resume: "sub-2" }, ctx()),
      ).rejects.toThrow("has no original execution identity");
      expect(resumedProvider.tools).toHaveLength(2);
      expect(restored.sessions.logs()).toEqual(ownedAfterResume);
      expect(readFileSync(legacyPath, "utf8")).toBe(beforeLegacy);
      const inspectedLegacy = Log.load(legacyPath, { attach: true });
      expect(deriveMessages(inspectedLegacy.events)).toEqual([
        { role: "system", content: "parent system" },
        { role: "user", content: "hi" },
      ]);
      inspectedLegacy.recording?.dispose();
      for (const [index, invalid] of [
        { maxSteps: "1" },
        { model: " " },
        { remainingDepth: 1 },
        { tools: ["echo", "task"] },
        null,
      ].entries()) {
        const id = `sub-${index + 3}`;
        const invalidPath = join(dir, `parent-${id}.jsonl`);
        const invalidLog = new Log(invalidPath);
        for (const event of parentLog().events) invalidLog.append(event);
        invalidLog.append({
          type: "ext/event",
          at: "t",
          source: "subagent",
          kind: "identity",
          payload: (invalid === null
            ? null
            : {
                id,
                type: "default",
                scope: "taskOnly",
                model: "p/same",
                tools: ["echo"],
                maxSteps: null,
                remainingDepth: 0,
                ...invalid,
              }) as unknown as Record<string, unknown>,
        });
        invalidLog.recording?.flush();
        invalidLog.recording?.dispose();
        const beforeInvalid = readFileSync(invalidPath, "utf8");
        await expect(
          restored.tool.execute({ task: "must not coerce identity", resume: id }, ctx()),
        ).rejects.toThrow("invalid execution identity");
        expect(resumedProvider.tools).toHaveLength(2);
        expect(restored.sessions.logs()).toEqual(ownedAfterResume);
        expect(readFileSync(invalidPath, "utf8")).toBe(beforeInvalid);
        const inspectedInvalid = Log.load(invalidPath, { attach: true });
        inspectedInvalid.recording?.dispose();
      }
    } finally {
      for (const log of opened) log.recording?.dispose();
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
        return { provider: cheap, modelLocator: "cheap" };
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

  it("新子继承当前system与有效用户要求,类型覆盖最后生效;续聊保留子自己的修改", async () => {
    for (const [scope, override] of [
      ["taskOnly", undefined],
      ["userMessagesOnly", undefined],
      ["fork", undefined],
      ["fork", "OVERRIDE"],
      ["fork", ""],
    ] as const) {
      const parent = parentLog();
      if (scope === "userMessagesOnly") {
        parent.append({ type: "user/message", at: "t", text: "PHOTO", images: [testImage] });
        parent.append({ type: "user/message", at: "t", text: "REMOVED", images: [testImage] });
        parent.append({
          type: "assistant/message",
          at: "t",
          text: "old assistant step",
          toolCalls: [],
          stopReason: "end",
        });
        parent.append({
          type: "context/edit",
          at: "t",
          target: 1,
          field: "content",
          value: "EARLY_EDITED",
        });
        parent.append({
          type: "context/edit",
          at: "t",
          target: 2,
          field: "content",
          value: "PHOTO_EDITED",
        });
        parent.append({ type: "context/edit", at: "t", target: 2, field: "content", value: "" });
        parent.append({ type: "context/drop", at: "t", target: 3 });
        parent.append({ type: "compaction", at: "t", summary: "summary", coversUpTo: 5 });
        parent.append({ type: "user/message", at: "t", text: "latest" });
        parent.append({
          type: "session/directory",
          at: "t",
          cwd: "/parent",
          environment: "PARENT_ENVIRONMENT",
        });
        expect(
          deriveMessages(parent.events).some((message) => message.content === "EARLY_EDITED"),
        ).toBe(false);
      }
      const currentSystem = [
        { id: "role", name: "Role", text: "CURRENT", enabled: true },
        { id: "private", name: "Private", text: "DISABLED", enabled: false },
      ];
      parent.append({
        type: "context/edit",
        at: "t",
        target: 0,
        field: "system",
        value: currentSystem,
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
      const requests: Message[][] = [];
      const { tool, logs } = mk({
        parent,
        tools: [],
        types: {
          custom: { description: "custom", ...(override !== undefined && { system: override }) },
        },
        provider: {
          model: "fake",
          async complete(messages) {
            requests.push(structuredClone(messages));
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
      if (scope === "userMessagesOnly") {
        expect(requests[0]?.filter((message) => message.role === "user")).toEqual([
          { role: "user", content: "EARLY_EDITED" },
          { role: "user", content: "", images: [testImage] },
          { role: "user", content: "latest" },
          { role: "user", content: "inspect" },
        ]);
        expect(child?.events[0]).toMatchObject({ type: "session/start", system: currentSystem });
      }
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
      if (scope === "userMessagesOnly") {
        expect(requests[1]?.filter((message) => message.role === "user")).toEqual([
          ...(requests[0]?.filter((message) => message.role === "user") ?? []),
          { role: "user", content: "continue" },
        ]);
        expect(logs[1]).toBe(child);
      }
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

  it("有限小数 depth 逐层限制工具,子续聊重建工具仍继续同一孙日志,最终释放整树", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-nested-owner-"));
    const parent = new Log(join(dir, "parent.jsonl"));
    for (const event of parentLog().events) parent.append(event);
    const seen: string[][] = [];
    const owned: EventLog[] = [];
    let n = 0;
    const provider: Provider = {
      model: "fake",
      async complete(messages, defs: ToolDef[]) {
        seen.push(defs.map((t) => t.name));
        n += 1;
        // 子的第一步派一个孙;孙执行自己的工具后收尾;子第二步收尾。
        if (n === 1) {
          return {
            text: "",
            toolCalls: [{ id: "g1", name: "task", args: { task: "grandchild" } }],
            stopReason: "tool",
          };
        }
        if (n === 2)
          return {
            text: "",
            toolCalls: [{ id: "grandchild-echo", name: "echo", args: { text: "raw" } }],
            stopReason: "tool",
          };
        if (n === 5)
          return {
            text: "",
            toolCalls: [
              { id: "g2", name: "task", args: { task: "grandchild follow-up", resume: "sub-1" } },
            ],
            stopReason: "tool",
          };
        if (n === 6)
          expect(
            messages.filter((message) => message.role === "user").map((message) => message.content),
          ).toEqual(["grandchild", "grandchild follow-up"]);
        return { text: `done ${n}`, toolCalls: [], stopReason: "end" };
      },
    };
    const factory = async (log: EventLog): Promise<ChildTools> => {
      owned.push(log);
      return {
        tools: [echo, other],
        beforeToolCall: ({ call }) => {
          log.append({
            type: "ext/event",
            at: "t",
            source: "owner-test",
            kind: "before",
            payload: { tool: call.name },
          });
          if (call.name === "echo") return { args: { text: "grandchild-local" } };
        },
        afterToolCall: ({ call, result }) => {
          log.append({
            type: "ext/event",
            at: "t",
            source: "owner-test",
            kind: "after",
            payload: { tool: call.name },
          });
          return { content: `local-after:${result.content}` };
        },
        dispose: async () => {},
        fork: factory,
      };
    };
    const { tool, sessions } = mk({
      parent,
      provider,
      tools: factory,
      slots: {
        beforeToolCall: () => {
          throw new Error("A factory child must use its own hook");
        },
        afterToolCall: () => {
          throw new Error("A factory child must use its own hook");
        },
      },
      depth: 1.5,
      types: { limited: { description: "restricted tools", tools: ["echo", "task"] } },
    });
    try {
      const out = await tool.execute({ task: "child", type: "limited" }, ctx());
      expect(out).toContain("done 4");
      expect(seen[0]).toEqual(["echo", "task"]);
      expect(seen[1]).toEqual(["echo"]);
      expect(owned).toHaveLength(2);
      expect(
        owned.map((log) =>
          log.events.flatMap((event) =>
            event.type === "ext/event" && event.source === "owner-test"
              ? [`${event.kind}:${event.payload.tool}`]
              : [],
          ),
        ),
      ).toEqual([
        ["before:task", "after:task"],
        ["before:echo", "after:echo"],
      ]);
      const grandchild = owned[1];
      if (!grandchild) throw new Error("missing grandchild log");
      expect(grandchild.events.find((event) => event.type === "tool/result")).toMatchObject({
        content: "local-after:echo:grandchild-local",
      });
      const before = grandchild.events;
      expect(await tool.execute({ task: "follow-up", resume: "sub-1" }, ctx())).toContain("done 7");
      expect(seen[4]).toEqual(["echo", "task"]);
      expect(seen[5]).toEqual(["echo"]);
      expect(sessions.logs().find((log) => log.path === grandchild.path)).toBe(grandchild);
      expect(grandchild.events.slice(0, before.length)).toEqual(before);
      expect(grandchild.events.filter((event) => event.type === "session/start")).toHaveLength(1);
      expect(
        grandchild.events.filter(
          (event) =>
            event.type === "ext/event" && event.source === "subagent" && event.kind === "identity",
        ),
      ).toHaveLength(1);
      const logs = sessions.logs();
      expect(logs).toHaveLength(3);
      expect(logs).toEqual(expect.arrayContaining([parent, owned[0], grandchild]));
      for (const log of logs) {
        await log.checkpoint();
        log.recording?.dispose();
      }
      for (const log of logs) {
        const attached = Log.load(log.path as string, { attach: true });
        try {
          expect(attached.events).toEqual(log.events);
        } finally {
          attached.recording?.dispose();
        }
      }
    } finally {
      for (const log of sessions.logs()) log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
