import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      const originalBody = first.recording?.open("existing output");
      if (!originalBody) throw new Error("missing recording");
      originalBody.write("preserve existing output");
      first.recording?.flush();
      const existingBytes = readFileSync(file, "utf8");
      expect(() => EventLog.create([START], { filePath: file })).toThrow("File is in use");
      const rejected = new Recording(file);
      expect(() => rejected.discard()).toThrow("File is in use");
      expect(readFileSync(file, "utf8")).toBe(existingBytes);
      expect(first.recording?.read(originalBody.ref)).toBe("preserve existing output");
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
      const restoredBytes = readFileSync(file, "utf8");
      expect(() => EventLog.create([START], { filePath: file })).toThrow("already exists");
      expect(readFileSync(file, "utf8")).toBe(restoredBytes);
      expect(new Recording(file).read(originalBody.ref)).toBe("preserve existing output");
      expect(existsSync(`${file}.lock`)).toBe(false);
      const orphan = join(dir, "orphan.jsonl");
      const orphanRecords = join(dir, "orphan.records");
      mkdirSync(orphanRecords);
      writeFileSync(join(orphanRecords, "keep.txt"), "preserve orphan records");
      expect(() => EventLog.create([START], { filePath: orphan })).toThrow("already exists");
      expect(readFileSync(join(orphanRecords, "keep.txt"), "utf8")).toBe("preserve orphan records");
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(`${orphan}.lock`)).toBe(false);
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
          expect(() => stale.recording?.discard()).toThrow(/ownership changed/);
          expect(EventLog.load(file).events).toEqual(before);
          expect(replacement.recording?.read(originalBody.ref)).toBe("preserve existing output");
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
    log.subscribe((event) => {
      if (event.type === "request")
        log.append({
          type: "ext/event",
          at: "t",
          source: "fixture",
          kind: "request-observed",
          payload: {},
        });
    });
    writeFileSync(store.directory, "blocked");
    const bodies: string[] = [];
    const agent = new Agent({
      log,
      provider: {
        model: "m",
        async complete(messages, tools, opts) {
          requests++;
          const body = JSON.stringify({ messages, tools });
          bodies.push(body);
          const record = await opts?.record?.(body);
          record?.response(200, "application/json");
          await record?.chunk(Buffer.from(JSON.stringify({ request: requests })));
          await record?.end("complete");
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
      // 原对象中的假引用不能参与复制;新日志只认独立JSON捕获后的引用。
      const capturedFile = join(dir, "captured.jsonl");
      const captured = EventLog.create(
        log.events.map((event) =>
          event.type === "ext/event" && event.source === "recording" && event.kind === "tool/output"
            ? {
                ...event,
                payload: { output: { file: "deadbeef.body", bytes: 1 } },
                toJSON: () => event,
              }
            : event,
        ),
        { filePath: capturedFile, sourceRecording: store },
      );
      try {
        expect(captured.events).toEqual(log.events);
        expect(
          readRequestRecording(capturedFile, captured.events, request)?.outputs?.[0],
        ).toMatchObject({
          original: "original text that the model does not receive",
        });
      } finally {
        captured.recording?.dispose();
      }
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
      expect(saved?.bodies).toEqual([bodies[0]]);
      expect(saved?.attempts?.[0]?.response).toBe('{"request":1}');
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
      expect(
        readRequestRecording(capturedFile, EventLog.load(capturedFile).events, index)?.outputs,
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
      const empty = EventLog.create([], { filePath: file });
      expect(empty.events).toEqual([]);
      expect(existsSync(file)).toBe(false);
      empty.recording?.dispose();
      const log = EventLog.create(SESSION, { filePath: file });
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

  it("订阅读取独立快照:外部修改不能改变事实或恢复后的投影", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-snapshot-"));
    const file = join(dir, "s.jsonl");
    const event: AgentEvent = {
      type: "ext/event",
      at: "t",
      source: "fixture",
      kind: "snapshot",
      payload: { nested: { value: "original" } },
    };
    const keys: string[] = [];
    const initial: AgentEvent[] = [
      START,
      ASK,
      {
        ...event,
        toJSON(key: string) {
          keys.push(key);
          return event;
        },
      } as AgentEvent,
      event,
    ];
    const log = EventLog.create(initial, { filePath: file });
    try {
      expect(keys).toEqual([""]);
      initial.splice(0);
      (event.payload.nested as { value: string }).value = "changed outside log";
      const before = log.events;
      const captured = before.at(-1);
      expect(captured).toMatchObject({ payload: { nested: { value: "original" } } });
      if (captured?.type !== "ext/event") throw new Error("missing snapshot");
      expect(Reflect.set(captured.payload.nested as object, "value", "changed by reader")).toBe(
        false,
      );
      expect(() => Array.prototype.reverse.call(before)).toThrow(TypeError);
      expect(() => Array.prototype.splice.call(before, 1, 1)).toThrow(TypeError);
      expect(before[2]).not.toBe(captured);
      if (before[2]?.type !== "ext/event") throw new Error("missing independent snapshot");
      expect(before[2].payload).not.toBe(captured.payload);
      const seen: string[] = [];
      const off = log.subscribe((e) => seen.push(e.type));
      log.append({ type: "context/edit", at: "t", target: 1, field: "content", value: "edited" });
      off();
      expect(before).toHaveLength(4);
      expect(deriveMessages(before).map((message) => message.content)).toEqual([
        START.system,
        ASK.text,
      ]);
      expect(log.events[1]).toEqual(ASK);
      expect(deriveMessages(log.events).map((message) => message.content)).toEqual([
        START.system,
        "edited",
      ]);
      log.recording?.flush();
      const loaded = EventLog.load(file);
      expect(loaded.events).toEqual(log.events);
      expect(deriveMessages(loaded.events)).toEqual(deriveMessages(log.events));
      expect(Reflect.set(loaded.events, "1", START)).toBe(false);
      const unallocated = join(dir, "unallocated");
      const bad: AgentEvent & { toJSON(): undefined } = {
        ...ASK,
        toJSON: () => undefined,
      };
      expect(() =>
        EventLog.create([START, bad], { filePath: join(unallocated, "bad.jsonl") }),
      ).toThrow();
      expect(existsSync(unallocated)).toBe(false);
      const sparse = new Array<AgentEvent>(2);
      sparse[0] = START;
      expect(() => EventLog.create(sparse)).toThrow();
      expect(() =>
        EventLog.create(sparse, { filePath: join(unallocated, "sparse.jsonl") }),
      ).toThrow();
      expect(existsSync(unallocated)).toBe(false);

      // 保存状态观察者追加事实时,接纳顺序、事件身份与恢复后的顺序必须一致。
      const store = log.recording;
      if (!store) throw new Error("missing recording");
      const backup = join(dir, "backup");
      const beforeNested = log.events.length;
      let nestedIndex: number | undefined;
      let nested = false;
      const observed: { event: AgentEvent; index: number }[] = [];
      const stopEvents = log.subscribe((event, index) => observed.push({ event, index }));
      const stopSaving = store.subscribe(() => {
        if (!store.error || nested) return;
        nested = true;
        nestedIndex = log.append({ type: "user/message", at: "t", text: "B" });
      });
      renameSync(file, backup);
      mkdirSync(file);
      const outerIndex = log.append({ type: "user/message", at: "t", text: "A" });
      stopSaving();
      stopEvents();
      expect(nested).toBe(true);
      expect(outerIndex).toBe(beforeNested);
      expect(nestedIndex).toBe(beforeNested + 1);
      expect(log.events.slice(beforeNested)).toMatchObject([{ text: "A" }, { text: "B" }]);
      for (const item of observed) expect(log.events[item.index]).toBe(item.event);
      expect(seen).toEqual(["context/edit"]);
      rmSync(file, { recursive: true });
      renameSync(backup, file);
      store.flush();
      expect(EventLog.load(file).events).toEqual(log.events);
      store.dispose();
      const closed = log.events;
      expect(() => log.append(ASK)).toThrow("Recording is closed");
      expect(log.events).toBe(closed);
    } finally {
      log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
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
