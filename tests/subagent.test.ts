import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { readRequestRecording } from "../cli/session-records.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import {
  type ChildInfo,
  createTaskTool,
  fork,
  inProcessRunner,
  taskOnly,
  userMessagesOnly,
} from "../src/subagent.js";
import { defineTool } from "../src/tools.js";

const PARENT: AgentEvent[] = [
  { type: "session/start", at: "t", model: "m", system: "父系统提示" },
  { type: "user/message", at: "t", text: "帮我查一下 a.ts" },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    stopReason: "tool",
  },
  { type: "tool/result", at: "t", callId: "c1", name: "read", content: "内容", isError: false },
  { type: "user/message", at: "t", text: "再深入研究一下" },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c2", name: "task", args: { task: "研究 a.ts" } }],
    stopReason: "tool",
  },
];

const snapshot = { events: PARENT, system: "父系统提示", model: "m" };

describe("ContextScope 三档", () => {
  it("taskOnly:只有系统提示词,缺省沿用父的", () => {
    expect(taskOnly()(snapshot)).toMatchObject([{ type: "session/start", system: "父系统提示" }]);
    expect(taskOnly("自定义")(snapshot)[0]).toMatchObject({ system: "自定义" });
  });

  it("fork:复制到发起派活的 assistant 消息之前,工具对完整", () => {
    const events = fork()(snapshot);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "session/start",
      "user/message",
      "assistant/message",
      "tool/result",
      "user/message",
    ]);
  });

  it("userMessagesOnly:只留系统提示与用户消息", () => {
    const events = userMessagesOnly()(snapshot);
    expect(events.map((e) => e.type)).toEqual(["session/start", "user/message", "user/message"]);
  });
});

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

describe("inProcessRunner", () => {
  it("跑完返回子的最终文本,状态 completed", async () => {
    const res = await inProcessRunner({
      task: "任务",
      startEvents: taskOnly()(snapshot),
      provider: scripted([{ text: "子结果", toolCalls: [], stopReason: "end" }]),
      tools: [],
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ text: "子结果", status: "completed" });
  });

  it("父打断传播到子,返回 partial", async () => {
    const ac = new AbortController();
    const provider: Provider = {
      model: "fake",
      async complete(_m, _t, opts) {
        await new Promise<void>((r) =>
          opts?.signal?.addEventListener("abort", () => r(), { once: true }),
        );
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const p = inProcessRunner({
      task: "长任务",
      startEvents: taskOnly()(snapshot),
      provider,
      tools: [],
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    const res = await p;
    expect(res.status).toBe("partial");
    expect(res.text).toBe("半截");
  });
});

describe("createTaskTool", () => {
  function parentLog(): EventLog {
    const log = new EventLog();
    for (const e of PARENT.slice(0, 5)) log.append(e);
    return log;
  }

  it("父调用 task → 子在独立日志里跑完 → 结果回喂父;子拿不到 task 工具", async () => {
    const parent = parentLog();
    let childTools: string[] = [];
    const childProvider: Provider = {
      model: "fake",
      async complete(_m, tools) {
        childTools = tools.map((t) => t.name);
        return { text: "子结果:a.ts 是入口", toolCalls: [], stopReason: "end" };
      },
    };
    const echo = defineTool({
      name: "echo",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return "";
      },
    });
    const task = createTaskTool({ parent, provider: childProvider, tools: [echo] });

    await runTurn({
      log: parent,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c9", name: "task", args: { task: "研究 a.ts" } }],
          stopReason: "tool",
        },
        { text: "完成", toolCalls: [], stopReason: "end" },
      ]),
      tools: [task, echo],
    });

    const result = parent.events.find((e) => e.type === "tool/result" && e.callId === "c9");
    expect(result).toMatchObject({ isError: false });
    expect((result as { content: string }).content).toContain("子结果:a.ts 是入口");
    expect(childTools).toEqual(["echo"]); // 没有 task
  });

  it("scope 参数由父模型选择:fork 让子看到父历史", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-fork-records-"));
    const parent = new EventLog(join(dir, "parent.jsonl"));
    for (const event of parentLog().events) parent.append(event);
    let childLog: EventLog | undefined;
    let childSaw = 0;
    const childProvider: Provider = {
      model: "fake",
      async complete(messages) {
        childSaw = messages.length;
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const task = createTaskTool({
      parent,
      provider: childProvider,
      tools: [],
      onChild: (child) => {
        childLog = child.log;
      },
    });
    try {
      await runTurn({
        log: parent,
        provider: scripted([
          {
            text: "",
            toolCalls: [{ id: "c9", name: "task", args: { task: "总结", scope: "fork" } }],
            stopReason: "tool",
          },
          { text: "完成", toolCalls: [], stopReason: "end" },
        ]),
        tools: [task],
      });
      // fork 复制了父的 5 条事件(投影 5 条消息)+ 任务 1 条 = 6
      expect(childSaw).toBe(6);
      if (!childLog?.path || !parent.path || !parent.recording)
        throw new Error("missing recorded child");
      const request = parent.events.findIndex((event) => event.type === "request");
      const expected = readRequestRecording(parent.path, parent.events, request, "input");
      expect(expected?.input?.messages).toHaveLength(5);
      parent.recording.dispose();
      rmSync(parent.recording.directory, { recursive: true });
      const restored = EventLog.load(childLog.path);
      const inherited = readRequestRecording(childLog.path, restored.events, request, "input");
      expect(inherited?.error).toBeUndefined();
      expect(inherited?.input).toEqual(expected?.input);
      // 原附件已经删除时,新分叉明确失败并清理候选目录,不发布残缺子会话。
      await expect(
        task.execute(
          { task: "another fork", scope: "fork" },
          {
            signal: new AbortController().signal,
            callId: "missing-records",
          },
        ),
      ).rejects.toThrow("ENOENT");
      expect(existsSync(join(dir, "parent-sub-2.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "parent-sub-2.records"))).toBe(false);
    } finally {
      parent.recording?.dispose();
      childLog?.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope 枚举来自注册表;未知值被参数校验拦下", async () => {
    const parent = parentLog();
    const task = createTaskTool({ parent, provider: scripted([]), tools: [] });
    const schema = task.parameters as unknown as {
      properties: { scope: { anyOf: { const: string }[] } };
    };
    expect(schema.properties.scope.anyOf.map((x) => x.const)).toEqual([
      "taskOnly",
      "fork",
      "userMessagesOnly",
    ]);

    await runTurn({
      log: parent,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c9", name: "task", args: { task: "x", scope: "nope" } }],
          stopReason: "tool",
        },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [task],
    });
    const result = parent.events.find((e) => e.type === "tool/result" && e.callId === "c9");
    expect(result).toMatchObject({ isError: true });
  });

  it("outputSchema:子以 JSON 收尾则校验后附上;不合规则 isError 回喂", async () => {
    const schema = Type.Object({ answer: Type.Number() });
    const mk = (reply: string) =>
      createTaskTool({
        parent: parentLog(),
        provider: scripted([{ text: reply, toolCalls: [], stopReason: "end" }]),
        tools: [],
        outputSchema: schema,
      });
    const ctx = { signal: new AbortController().signal };

    const ok = await mk('分析完毕。\n```json\n{"answer": 42}\n```').execute({ task: "算" }, ctx);
    expect(ok).toContain('Structured result:\n{"answer":42}');

    await expect(mk("我不知道").execute({ task: "算" }, ctx)).rejects.toThrow(
      "Structured result failed validation",
    );
  });

  it("子失败或打断保留 partial 原因与续聊入口;执行和清理同时失败保留两者", async () => {
    const parent = parentLog();
    const ac = new AbortController();
    const childProvider: Provider = {
      model: "fake",
      async complete(_m, _t, opts) {
        await new Promise<void>((r) =>
          opts?.signal?.addEventListener("abort", () => r(), { once: true }),
        );
        return { text: "做了一半", toolCalls: [], stopReason: "aborted" };
      },
    };
    const task = createTaskTool({ parent, provider: childProvider, tools: [] });
    const p = task.execute({ task: "长活" }, { signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await expect(p).rejects.toThrow("做了一半");

    // 自定义 runner 可拒绝任意值;失败原文与资源清理不能被二次异常覆盖。
    for (const failure of ["runner rejected", null]) {
      let child: ChildInfo | undefined;
      let released = 0;
      let fail = true;
      let failCleanup = false;
      const custom = createTaskTool({
        parent: parentLog(),
        provider: scripted([]),
        tools: async () => ({
          tools: [],
          dispose: async () => {
            released++;
            if (failCleanup) throw "cleanup rejected";
          },
        }),
        onChild: (info) => {
          child = info;
        },
        runner: async (request) => {
          request.onLog?.(request.log as EventLog);
          if (fail) throw failure;
          return { text: "continued", status: "completed" };
        },
      });
      const ctx = { signal: new AbortController().signal };
      await expect(custom.execute({ task: "fail" }, ctx)).rejects.toBe(failure);
      expect(child?.state).toEqual({ status: "partial", reason: String(failure) });
      expect(released).toBe(1);
      fail = false;
      expect(await custom.execute({ task: "continue", resume: "sub-1" }, ctx)).toContain(
        "continued",
      );
      expect(child?.state.status).toBe("completed");
      expect(released).toBe(2);
      fail = true;
      failCleanup = true;
      const combined = custom.execute({ task: "fail again", resume: "sub-1" }, ctx);
      await expect(combined).rejects.toThrow(
        `Sub-agent failed and cleanup failed: ${String(failure)}; cleanup rejected`,
      );
      expect(child?.state.reason).toContain("cleanup rejected");
      expect(released).toBe(3);
    }
  });
});
