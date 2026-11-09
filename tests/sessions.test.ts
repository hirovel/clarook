// 会话列表与清理:概要读首尾事件;清理按时间或条数,旁车同删,不加 apply 只算计划;子进程入口 clarook sessions。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DirectoryIssue, prepareSessionDirectory } from "../cli/session-directory.js";
import { listSessions, parseAge, pruneSessions, sessionRows } from "../cli/sessions.js";
import { EventLog } from "../src/log.js";
import { directoryAt, recordSessionDirectory } from "../src/session-directory.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function session(
  dir: string,
  name: string,
  at: string,
  opts: { trace?: boolean; mcp?: boolean } = {},
) {
  const file = join(dir, `${name}.jsonl`);
  const lines = [
    { type: "session/start", at, model: "p/m", system: "s" },
    { type: "user/message", at, text: "first ask\nsecond line" },
    { type: "request", at, tools: [] },
    { type: "assistant/message", at, text: "ok", toolCalls: [], stopReason: "end" },
    { type: "user/message", at, text: "second ask" },
    { type: "request", at, tools: [] },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
  if (opts.trace) writeFileSync(join(dir, `${name}.trace.jsonl`), "{}\n");
  if (opts.mcp) {
    mkdirSync(join(dir, `${name}.mcp`));
    writeFileSync(join(dir, `${name}.mcp`, "a.png"), "x");
  }
  return file;
}

describe("listSessions / pruneSessions", () => {
  it("旧日志与搬迁共用目录选择,取消不写,提交后恢复记住新根且保留历史", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-sessions-"));
    const entryCwd = tmp;
    const first = join(tmp, "first");
    const moved = join(tmp, "moved");
    const blocked = join(tmp, "file");
    mkdirSync(first);
    mkdirSync(moved);
    writeFileSync(blocked, "not a directory");
    const file = join(tmp, "legacy.jsonl");
    let log = new EventLog(file);
    try {
      log.append({ type: "session/start", at: "2026-09-01", model: "p/m", system: "old root" });
      log.append({ type: "user/message", at: "2026-09-01", text: "keep this history" });
      log.append({
        type: "request",
        at: "2026-09-01",
        model: "p/m",
        messages: 2,
        tools: [],
        estimatedTokens: 10,
        reason: "turn",
      });
      const history = [...log.events];
      expect(
        await prepareSessionDirectory(log, { entryCwd, chooseDirectory: async () => undefined }),
      ).toBeUndefined();
      expect(log.events).toEqual(history);
      await expect(prepareSessionDirectory(log, { entryCwd })).rejects.toThrow(
        "clarook sessions directory <file> <directory>",
      );

      const issues: DirectoryIssue[] = [];
      const answers = ["   ", "file", "first"];
      const chooseDirectory = async (issue: DirectoryIssue) => {
        issues.push(issue);
        return answers.shift();
      };
      const prepared = await prepareSessionDirectory(log, { entryCwd, chooseDirectory });
      expect(issues.map((issue) => issue.kind)).toEqual([
        "unrecorded",
        "unavailable",
        "unavailable",
      ]);
      expect(issues[1]?.detail).toContain("Enter a directory path");
      expect(issues[2]?.detail).toContain("Not a directory");
      expect(prepared?.cwd).toBe(first);
      expect(log.events).toEqual(history);
      prepared?.commit();
      prepared?.commit();
      const same = await prepareSessionDirectory(log, { entryCwd, directory: "first" });
      same?.commit();
      expect(log.events.filter((event) => event.type === "session/directory")).toHaveLength(1);
      expect(log.events.slice(0, history.length)).toEqual(history);
      await log.checkpoint();
      log.recording?.dispose();
      log = EventLog.load(file, { attach: true });
      expect((await prepareSessionDirectory(log, { entryCwd }))?.cwd).toBe(first);

      rmSync(first, { recursive: true });
      const beforeMove = [...log.events];
      expect(await prepareSessionDirectory(log, { entryCwd, chooseDirectory })).toBeUndefined();
      expect(issues.at(-1)).toMatchObject({ kind: "unavailable", recorded: first });
      expect(log.events).toEqual(beforeMove);
      await expect(prepareSessionDirectory(log, { entryCwd })).rejects.toThrow(
        "clarook sessions directory <file> <directory>",
      );
      answers.push("moved");
      const migration = await prepareSessionDirectory(log, { entryCwd, chooseDirectory });
      expect(migration?.cwd).toBe(moved);
      expect(log.events).toEqual(beforeMove);
      migration?.commit();
      expect(log.events.slice(0, beforeMove.length)).toEqual(beforeMove);
      await log.checkpoint();
      log.recording?.dispose();
      log = EventLog.load(file, { attach: true });
      const restored = await prepareSessionDirectory(log, { entryCwd });
      expect(restored?.cwd).toBe(moved);
      restored?.commit();
      expect(log.events.filter((event) => event.type === "session/directory")).toHaveLength(2);

      const stale = await prepareSessionDirectory(log, { entryCwd, directory: "moved" });
      recordSessionDirectory(log, entryCwd);
      expect(() => stale?.commit()).toThrow("Session directory changed during preparation");
      expect(directoryAt(log.events)?.cwd).toBe(entryCwd);
    } finally {
      log.recording?.flush();
      log.recording?.dispose();
    }
  });

  it("列表新的在前,概要含模型、请求数、最后一条用户消息、旁车;坏行跳过", () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-sessions-"));
    session(tmp, "2026-09-01T10-00-00-000Z", "2026-09-01T10:00:00.000Z", { trace: true });
    session(tmp, "2026-09-03T10-00-00-000Z-fork", "2026-09-03T10:00:00.000Z", { mcp: true });
    const list = listSessions(tmp);
    expect(list.map((s) => s.name)).toEqual([
      "2026-09-03T10-00-00-000Z-fork.jsonl",
      "2026-09-01T10-00-00-000Z.jsonl",
    ]);
    expect(list[0]).toMatchObject({
      model: "p/m",
      events: 6,
      userMessages: 2,
      requests: 2,
      lastUser: "second ask",
      fork: true,
    });
    expect(list[0]?.sidecars.some((p) => p.endsWith(".mcp"))).toBe(true);
    expect(list[1]?.sidecars.some((p) => p.endsWith(".trace.jsonl"))).toBe(true);
    const rows = sessionRows(list);
    expect(rows[0]).toContain("2026-09-03 10:00");
    expect(rows[0]).toContain("[fork mcp]");
    expect(rows[0]).toContain("second ask");
    expect(listSessions(join(tmp, "nope"))).toEqual([]);
  });

  it("按时间或条数选出要删的;不 apply 不动文件;apply 连旁车删", () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-sessions-"));
    const old = session(tmp, "a-old", "2026-07-01T00:00:00.000Z", { trace: true, mcp: true });
    writeFileSync(join(tmp, "a-old.inputs.json"), "{}");
    writeFileSync(join(tmp, "a-old.inputs.json.tmp"), "{}");
    mkdirSync(join(tmp, "a-old.records"));
    writeFileSync(join(tmp, "a-old.records", "fixture.body"), "x".repeat(8192));
    const mid = session(tmp, "b-mid", "2026-08-20T00:00:00.000Z");
    const fresh = session(tmp, "c-new", "2026-09-03T00:00:00.000Z");
    const now = new Date("2026-09-04T00:00:00.000Z");
    const plan = pruneSessions(tmp, { olderThanDays: 30, apply: false, now });
    expect(plan.removed.map((s) => s.file)).toEqual([old]);
    expect(plan.kept).toBe(2);
    expect(existsSync(old)).toBe(true);
    expect(plan.bytes).toBeGreaterThan(8192);
    const byCount = pruneSessions(tmp, { keep: 1, apply: false, now });
    expect(byCount.removed.map((s) => s.file).sort()).toEqual([old, mid].sort());
    const active = EventLog.load(old, { attach: true });
    try {
      expect(() => pruneSessions(tmp as string, { olderThanDays: 30, apply: true, now })).toThrow(
        "File is in use",
      );
      expect(existsSync(old)).toBe(true);
      expect(existsSync(join(tmp, "a-old.records", "fixture.body"))).toBe(true);
    } finally {
      active.recording?.flush();
      active.recording?.dispose();
    }
    const done = pruneSessions(tmp, { olderThanDays: 30, apply: true, now });
    expect(done.removed).toHaveLength(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(tmp, "a-old.trace.jsonl"))).toBe(false);
    expect(existsSync(join(tmp, "a-old.mcp"))).toBe(false);
    expect(existsSync(join(tmp, "a-old.inputs.json"))).toBe(false);
    expect(existsSync(join(tmp, "a-old.inputs.json.tmp"))).toBe(false);
    expect(existsSync(join(tmp, "a-old.records"))).toBe(false);
    expect(existsSync(mid)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(parseAge("30d")).toBe(30);
    expect(parseAge("12h")).toBe(0.5);
    expect(parseAge("7")).toBe(7);
    expect(() => parseAge("soon")).toThrow("--older-than");
  });

  it("子进程入口:clarook sessions 列表;prune 不带 --yes 只打印计划", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clarook-sessions-"));
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    session(tmp, "s1", new Date(now - 60 * day).toISOString());
    session(tmp, "s2", new Date(now - day).toISOString());
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(
          process.execPath,
          [resolve("node_modules/tsx/dist/cli.mjs"), resolve("cli/sessions-cli.ts"), ...args],
          { cwd: tmp, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          out += d;
        });
        child.on("close", (code) => done({ code, out }));
      });
    const list = await run(["--dir", tmp as string]);
    expect(list.code, list.out).toBe(0);
    expect(list.out).toContain("2 sessions in");
    expect(list.out).toContain("clarook --resume");
    const plan = await run(["prune", "--older-than", "30d", "--dir", tmp as string]);
    expect(plan.code, plan.out).toBe(0);
    expect(plan.out).toContain("would delete 1 sessions");
    expect(existsSync(join(tmp as string, "s1.jsonl"))).toBe(true);
    const bad = await run(["prune", "--dir", tmp as string]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("prune needs");
  }, 60000);
});
