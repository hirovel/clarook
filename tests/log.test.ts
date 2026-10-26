import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { readRequestRecording } from "../cli/session-records.js";
import { forkSession } from "../cli/sessions.js";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import { Recording } from "../src/recording.js";

const START: AgentEvent = {
  type: "session/start",
  at: "t0",
  model: "m",
  system: "你是测试用 agent。",
};
const ASK: AgentEvent = { type: "user/message", at: "t1", text: "读一下 a.txt" };

const SESSION: AgentEvent[] = [
  START,
  ASK,
  {
    type: "assistant/message",
    at: "t2",
    text: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }],
    stopReason: "tool",
  },
  { type: "tool/result", at: "t3", callId: "c1", name: "read", content: "hello", isError: false },
  { type: "assistant/message", at: "t4", text: "内容是 hello。", toolCalls: [], stopReason: "end" },
];

describe("EventLog", () => {
  it("独立进程不能同时续写;释放后可恢复编辑,锁被接管后旧写入者不能污染文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-owner-"));
    const file = join(dir, "session.jsonl");
    const first = new EventLog(file);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import { EventLog } from './src/log.ts';
      const log = EventLog.load(process.argv[1], {attach:true});
      try {
        const target=log.events.length;
        log.append({type:'user/message',at:'t',text:'B'});
        log.append({type:'context/edit',at:'t',target,field:'content',value:'B edited'});
        log.recording.flush();
      } finally { log.recording.dispose(); }
    `,
          file,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    try {
      first.append(START);
      first.append({ ...ASK, text: "A" });
      first.recording?.flush();
      const blocked = run();
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("File is in use");
      expect(EventLog.load(file).events).toEqual(first.events);
      first.recording?.dispose();
      const resumed = run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(deriveMessages(EventLog.load(file).events).map((m) => m.content)).toEqual([
        START.system,
        "A",
        "B edited",
      ]);
      const stale = EventLog.load(file, { attach: true });
      try {
        // 模拟崩溃后遗留或进程长期暂停的租约,不让回归真实等待一分钟。
        const expired = new Date(Date.now() - 120000);
        utimesSync(`${file}.lock`, expired, expired);
        const replacement = EventLog.load(file, { attach: true });
        try {
          const before = EventLog.load(file).events;
          stale.append(ASK);
          expect(stale.events.at(-1)).toEqual(ASK);
          expect(stale.recording?.error).toMatch(/ownership changed/);
          expect(EventLog.load(file).events).toEqual(before);
          stale.recording?.dispose();
          replacement.append({ ...ASK, text: "new owner" });
          replacement.recording?.flush();
          expect(EventLog.load(file).events.at(-1)).toMatchObject({ text: "new owner" });
        } finally {
          replacement.recording?.dispose();
        }
      } finally {
        stale.recording?.dispose();
      }
    } finally {
      first.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("保存失败仍完成任务;修复后自动补写且不重跑工具;分叉独立保留原始输出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-record-gate-"));
    const file = join(dir, "s.jsonl");
    const backup = join(dir, "backup");
    const log = new EventLog(file);
    const store = log.recording;
    if (!store) throw new Error("missing store");
    let requests = 0;
    let executions = 0;
    log.append(START);
    store.flush();
    writeFileSync(store.directory, "blocked");
    const agent = new Agent({
      log,
      provider: {
        model: "m",
        async complete() {
          requests++;
          return requests === 1
            ? { text: "", toolCalls: [{ id: "one", name: "act", args: {} }], stopReason: "tool" }
            : { text: "done", toolCalls: [], stopReason: "end" };
        },
      },
      tools: [
        {
          name: "act",
          description: "act",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            executions++;
            ctx.output?.write("original text that the model does not receive");
            renameSync(file, backup);
            mkdirSync(file);
            log.append({
              type: "ext/event",
              at: "t",
              source: "fixture",
              kind: "executed",
              payload: {},
            });
            return "short result";
          },
        },
      ],
    });
    const run = agent.prompt("go");
    try {
      expect(await run).toBe("idle");
      expect(store.error).toBeTruthy();
      expect(requests).toBe(2);
      expect(executions).toBe(1);
      expect(agent.running).toBe(false);
      const bufferedFork = forkSession(log.events, log.events.length, dir, store);
      const forkEvents = EventLog.load(bufferedFork.file).events;
      expect(forkEvents).toEqual(log.events);
      const request = forkEvents.findIndex((event) => event.type === "request");
      expect(
        readRequestRecording(bufferedFork.file, forkEvents, request)?.outputs?.[0],
      ).toMatchObject({
        original: "original text that the model does not receive",
      });
      expect(store.error).toBeTruthy();
      rmSync(store.directory);
      rmSync(file, { recursive: true });
      renameSync(backup, file);
      await vi.waitFor(() => expect(store.error).toBeUndefined(), { timeout: 2500 });
      expect(executions).toBe(1);
      expect(requests).toBe(2);
      const loaded = EventLog.load(file);
      const index = loaded.events.findIndex((e) => e.type === "request");
      const saved = readRequestRecording(file, loaded.events, index);
      expect(saved?.outputs?.[0]).toMatchObject({
        original: "original text that the model does not receive",
      });
      expect(
        deriveMessages(loaded.events).find((message) => message.role === "tool")?.content,
      ).toBe("short result");
      const fork = forkSession(loaded.events, loaded.events.length, dir, new Recording(file));
      rmSync(store.directory, { recursive: true });
      expect(
        readRequestRecording(bufferedFork.file, EventLog.load(bufferedFork.file).events, index)
          ?.outputs,
      ).toEqual(saved?.outputs);
      expect(
        readRequestRecording(fork.file, EventLog.load(fork.file).events, index)?.outputs,
      ).toEqual(saved?.outputs);
      expect(readRequestRecording(file, loaded.events, index)?.error).toContain("Missing");
      const outputEvent = loaded.events.find(
        (e) => e.type === "ext/event" && e.source === "recording" && e.kind === "tool/output",
      );
      if (outputEvent?.type !== "ext/event") throw new Error("missing output reference");
      const ref = outputEvent.payload.output as { file: string };
      truncateSync(join(fork.file.replace(/\.jsonl$/, ".records"), ref.file), 2);
      expect(readRequestRecording(fork.file, loaded.events, index)?.error).toContain(
        "size mismatch",
      );
    } finally {
      agent.interrupt();
      // 测试失败也解除人为故障,避免把等待中的 Agent 留给下一用例。
      if (store.error) {
        rmSync(file, { recursive: true, force: true });
        writeFileSync(file, "");
        rmSync(store.directory, { recursive: true, force: true });
        store.flush();
      }
      await run.catch(() => {});
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("写入积压达到上限时停止当前工具,保存恢复前拒绝新任务且不重跑未知结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-record-full-"));
    const file = join(dir, "s.jsonl");
    const backup = join(dir, "backup");
    const log = new EventLog(file, 8192);
    const store = log.recording;
    if (!store) throw new Error("missing store");
    let requests = 0;
    let executions = 0;
    log.append(START);
    store.flush();
    renameSync(file, backup);
    mkdirSync(file);
    const agent = new Agent({
      log,
      provider: {
        model: "m",
        async complete() {
          requests++;
          return requests === 1
            ? {
                text: "",
                toolCalls: [
                  { id: "one", name: "act", args: {} },
                  { id: "two", name: "act", args: {} },
                ],
                stopReason: "tool",
              }
            : { text: "saved again", toolCalls: [], stopReason: "end" };
        },
      },
      tools: [
        {
          name: "act",
          description: "act",
          parameters: Type.Object({}),
          async execute(_args, ctx) {
            executions++;
            ctx.output?.write(Buffer.alloc(4096, 97));
            ctx.output?.write(Buffer.alloc(4096, 98));
            if (ctx.signal.aborted) throw new Error("cancelled; external outcome not confirmed");
            return "unexpected";
          },
        },
      ],
    });
    try {
      expect(await agent.prompt("go")).toBe("aborted");
      expect(store.full).toBe(true);
      expect(requests).toBe(1);
      expect(executions).toBe(1);
      expect(log.events.filter((e) => e.type === "tool/result")).toMatchObject([
        { callId: "one", outcome: "unknown" },
        { callId: "two", isError: true },
      ]);
      expect(log.events).toContainEqual(
        expect.objectContaining({ type: "ext/event", source: "recording", kind: "buffer/full" }),
      );
      const count = log.events.length;
      await expect(agent.prompt("blocked")).rejects.toThrow(/Recording buffer full/);
      expect(log.events).toHaveLength(count);
      expect(store.gaps).toBe(1);
      expect(store.pendingBytes).toBeLessThan(8192);
      rmSync(file, { recursive: true });
      renameSync(backup, file);
      store.flush();
      expect(store.full).toBe(false);
      expect(await agent.prompt("continue explicitly")).toBe("idle");
      expect(requests).toBe(2);
      expect(executions).toBe(1);
      store.flush();
      expect(EventLog.load(file).events).toEqual(log.events);
    } finally {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("落盘再加载,事件逐字节一致(回放地基)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernel-"));
    const file = join(dir, "s.jsonl");
    try {
      const log = new EventLog(file);
      for (const e of SESSION) log.append(e);
      const loaded = EventLog.load(file);
      expect(loaded.events).toEqual(SESSION);
      rmSync(file);
      mkdirSync(file);
      log.append(ASK);
      expect(log.recording?.error).toBeTruthy();
      expect(log.events).toEqual([...SESSION, ASK]);
      rmSync(file, { recursive: true });
      writeFileSync(file, `${SESSION.map((e) => JSON.stringify(e)).join("\n")}\n`);
      log.recording?.flush();
      expect(log.recording?.error).toBeUndefined();
      expect(EventLog.load(file).events).toEqual([...SESSION, ASK]);
      // 有限原文缓冲耗尽后保留前缀和缺口;恢复后仅新正文继续捕获。
      const limited = new Recording(join(dir, "limited.jsonl"), 4);
      const gapLog = new EventLog();
      limited.onGap = (ref) =>
        gapLog.append({
          type: "ext/event",
          at: "t",
          source: "recording",
          kind: "body/gap",
          payload: { ref },
        });
      const body = limited.open("large response");
      gapLog.append({
        type: "ext/event",
        at: "t",
        source: "recording",
        kind: "http/start",
        payload: { request: 0, attempt: 1, sent: body.ref, received: body.ref },
      });
      body.write("a");
      const hold = `${limited.directory}-hold`;
      renameSync(limited.directory, hold);
      writeFileSync(limited.directory, "blocked");
      body.write("bcde");
      body.write("fghi");
      expect(body.ref.missingFrom).toBe(5);
      expect(limited.gaps).toBe(1);
      rmSync(limited.directory);
      renameSync(hold, limited.directory);
      limited.flush();
      body.write("later");
      expect(limited.read({ ...body.ref, bytes: body.bytes })).toBe("abcde");
      const unfinished = readRequestRecording(
        limited.journal,
        gapLog.events,
        0,
        "received",
        limited,
      );
      expect(unfinished?.error).toContain("Recording gap");
      expect(unfinished?.attempts?.[0]?.body?.read()).toBe("abcde");
      expect(gapLog.events[0]).toMatchObject({ payload: { received: { file: body.ref.file } } });
      if (gapLog.events[0]?.type !== "ext/event") throw new Error("missing start");
      expect(gapLog.events[0].payload.received).not.toHaveProperty("missingFrom");
      const next = limited.open("next response");
      next.write("ok");
      limited.flush();
      expect(next.ref.missingFrom).toBeUndefined();
      expect(limited.read(next.ref)).toBe("ok");
      const copied = new Recording(join(dir, "copy.jsonl"), 2);
      try {
        limited.copy({ ...body.ref, bytes: body.bytes }, copied);
        copied.flush();
        expect(copied.read(body.ref)).toBe("abcde");
      } finally {
        copied.dispose();
      }
      limited.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("订阅是只读旁路:收到每个事件,退订后停止", () => {
    const log = new EventLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.type));
    log.append(START);
    off();
    log.append(ASK);
    expect(seen).toEqual(["session/start"]);
    const event: AgentEvent = {
      type: "ext/event",
      at: "t",
      source: "fixture",
      kind: "snapshot",
      payload: { nested: { value: "original" } },
    };
    log.append(event);
    (event.payload.nested as { value: string }).value = "changed outside log";
    const captured = log.events.at(-1);
    expect(captured).toMatchObject({ payload: { nested: { value: "original" } } });
    if (captured?.type !== "ext/event") throw new Error("missing snapshot");
    expect(Reflect.set(captured.payload.nested as object, "value", "changed by reader")).toBe(
      false,
    );
  });
});

describe("deriveMessages", () => {
  it("完整会话投影为模型可见序列", () => {
    expect(deriveMessages(SESSION)).toEqual([
      { role: "system", content: "你是测试用 agent。" },
      { role: "user", content: "读一下 a.txt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }],
      },
      { role: "tool", callId: "c1", name: "read", content: "hello", isError: false },
      { role: "assistant", content: "内容是 hello。", toolCalls: [] },
    ]);
  });

  it("interrupt 不投影;aborted 半截消息照常投影(真相不丢)", () => {
    const events: AgentEvent[] = [
      START,
      ASK,
      { type: "session/interrupt", at: "t2" },
      { type: "assistant/message", at: "t3", text: "我正要", toolCalls: [], stopReason: "aborted" },
    ];
    const msgs = deriveMessages(events);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toEqual({ role: "assistant", content: "我正要", toolCalls: [] });
  });

  it("同一日志投影不受读取者修改影响,显式编辑仍生效", () => {
    const log = new EventLog();
    for (const event of SESSION) log.append(event);
    const first = deriveMessages(log.events);
    const original = structuredClone(first);
    for (const message of first) Reflect.set(message, "content", "changed by reader");
    expect(deriveMessages(log.events)).toEqual(original);

    log.append({ type: "context/edit", at: "t5", target: 1, field: "content", value: "新问题" });
    const edited = deriveMessages(log.events);
    expect(edited[1]).toEqual({ role: "user", content: "新问题", edited: true });
    expect(first).toEqual(original);
    expect(log.events[1]).toEqual(ASK);
  });
});
