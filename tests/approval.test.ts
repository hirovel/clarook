// 审批策略:规则裁决、cwd 之外、拒绝附理由;日志半行恢复;统一入口。
import { spawnSync } from "node:child_process";
import { ftruncateSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { ApprovalPrompt } from "../cli/tui-slots.js";
import { Agent } from "../src/agent.js";
import { DEFAULT_APPROVAL, decide, describeApproval, policyApprove } from "../src/approval.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, ftruncateSync: vi.fn(fs.ftruncateSync) };
});

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");
const cwd = "C:/work/repo";
const call = (name: string, args: unknown) => ({ id: "c", name, args });

describe("规则裁决", () => {
  it("缺省:只读放行、其余问人;deny 优先;bash 模式匹配整条命令;路径模式匹配相对路径", () => {
    expect(decide(call("read", { path: "a.ts" }), DEFAULT_APPROVAL, cwd).verdict).toBe("allow");
    expect(decide(call("bash", { command: "git status" }), DEFAULT_APPROVAL, cwd)).toEqual({
      verdict: "ask",
      reason: "no rule for bash",
    });
    const cfg = {
      ...DEFAULT_APPROVAL,
      allow: [...(DEFAULT_APPROVAL.allow ?? []), "bash:git *", "edit:src/**"],
      deny: ["bash:rm -rf *", "bash:git push*"],
    };
    expect(decide(call("bash", { command: "git status" }), cfg, cwd).verdict).toBe("allow");
    expect(decide(call("bash", { command: "git push origin main" }), cfg, cwd)).toEqual({
      verdict: "deny",
      reason: "deny rule bash:git push*",
    });
    expect(decide(call("bash", { command: "rm -rf /" }), cfg, cwd).verdict).toBe("deny");
    expect(decide(call("edit", { path: "src/a/b.ts" }), cfg, cwd).verdict).toBe("allow");
    expect(decide(call("edit", { path: "tests/a.ts" }), cfg, cwd).verdict).toBe("ask");
    expect(decide(call("write", { path: "x" }), { default: "allow" }, cwd).verdict).toBe("allow");
  });

  it("cwd 之外:缺省问,就算 allow 命中;outsideCwd allow 时照规则;deny 时直接拒", () => {
    const outside = call("read", { path: "../secrets.txt" });
    expect(decide(outside, DEFAULT_APPROVAL, cwd)).toEqual({
      verdict: "ask",
      reason: "path outside the working directory",
    });
    expect(decide(outside, { ...DEFAULT_APPROVAL, outsideCwd: "allow" }, cwd).verdict).toBe(
      "allow",
    );
    expect(decide(outside, { ...DEFAULT_APPROVAL, outsideCwd: "deny" }, cwd).verdict).toBe("deny");
    expect(
      decide(call("read", { path: "C:/work/repo/src/a.ts" }), DEFAULT_APPROVAL, cwd).verdict,
    ).toBe("allow");
    expect(describeApproval(DEFAULT_APPROVAL)).toContain("default ask");
  });

  it("policyApprove:没有人可问时 ask 按拒绝并说明;拒绝理由进工具结果", async () => {
    const noAsker = policyApprove(DEFAULT_APPROVAL, undefined, cwd);
    expect(await noAsker(call("read", { path: "a" }))).toBe(true);
    const denied = await noAsker(call("bash", { command: "ls" }));
    expect(denied).toMatchObject({ allowed: false });
    expect((denied as { reason: string }).reason).toContain("no one to ask");

    let calls = 0;
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        calls++;
        return calls === 1
          ? { text: "", toolCalls: [call("bash", { command: "ls" })], stopReason: "tool" }
          : { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const bash = defineTool({
      name: "bash",
      description: "run",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return "ran";
      },
    });
    const log = new EventLog();
    const agent = new Agent({
      log,
      provider,
      tools: [bash],
      slots: { approve: policyApprove(DEFAULT_APPROVAL, undefined, cwd) },
    });
    await agent.prompt("go");
    const result = log.events.find((e) => e.type === "tool/result");
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain(
      "The user denied this call: approval policy: no rule for bash",
    );
  });
});

describe("界面:策略提示、选择理由、/approve 规则", () => {
  it("非只读工具弹提示并写明原因;选择第三项 + 理由 → 拒绝结果带理由;/approve allow 后不再问", async () => {
    let rows = 12;
    let decision: { kind: string; reason?: string } | undefined;
    const prompt = new ApprovalPrompt(
      call(`mcp__server__${"long_tool_name_".repeat(5)}`, {
        command: `review-start ${"long argument ".repeat(100)}review-end`,
      }),
      "needs approval",
      (value) => {
        decision = value;
      },
      () => {},
      () => rows,
    );
    const narrow = prompt.render(36).map(plain);
    expect(narrow.length).toBeLessThanOrEqual(rows);
    expect(narrow.join("\n")).toContain("Enter confirm");
    for (let i = 0; i < 150; i++) prompt.handleInput("\x1b[6~");
    const parameterEnd = prompt.render(36).map(plain).join("\n");
    expect(parameterEnd).toContain("review-end");
    expect(parameterEnd).toContain("mcp__server__");
    prompt.handleInput("3");
    prompt.handleInput("\r");
    const reason = `reason-start ${"中文理由 ".repeat(200)}reason-end`;
    prompt.handleInput(reason);
    const reasonEnd = prompt.render(36).map(plain);
    expect(reasonEnd.length).toBeLessThanOrEqual(rows);
    expect(reasonEnd.join("\n")).toContain("reason-end");
    expect(reasonEnd.join("\n")).toContain("Enter deny");
    for (let i = 0; i < 150; i++) prompt.handleInput("\x1b[5~");
    expect(prompt.render(36).map(plain).join("\n")).toContain("reason-start");
    rows = 18;
    expect(prompt.render(60).length).toBeLessThanOrEqual(rows);
    prompt.handleInput("\x1b");
    rows = 12;
    expect(prompt.render(36).map(plain).join("\n")).toContain("review-end");
    expect(decision).toBeUndefined();
    prompt.handleInput("\r");
    prompt.handleInput(reason);
    prompt.handleInput("\r");
    expect(decision).toEqual({ kind: "deny", reason });

    let n = 0;
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        n++;
        return n % 2 === 1
          ? {
              text: "",
              toolCalls: [
                call("echo", { text: `review-start ${"long argument ".repeat(100)}review-end` }),
              ],
              stopReason: "tool",
            }
          : { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(a) {
        return a.text;
      },
    });
    const log = new EventLog();
    const term = new VirtualTerminal(60, 24);
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      approve: DEFAULT_APPROVAL,
      onExit: () => {},
    });
    const pending = app.submit("one");
    await new Promise((r) => setTimeout(r, 20));
    let lines = plain(app.approvalLines().join("\n"));
    expect(lines).toContain("? echo");
    expect(lines).toContain("1. Allow once");
    expect(lines).toContain("no rule for echo");
    expect(lines).toContain("3. Deny and tell the model why");
    expect(plain(app.lines(60).join("\n"))).toContain("Waiting for approval");
    term.feed("\x12");
    term.feed("\x05");
    expect(app.inspector.isOpen()).toBe(false);
    app.tui.renderNow(true);
    expect((await term.screen()).join("\n")).toContain("Enter confirm");
    term.feed("\x1b[6~");
    term.feed("\x1b[6~");
    app.tui.renderNow(true);
    const reviewed = await term.screen();
    expect(reviewed.length).toBeLessThanOrEqual(24);
    expect(reviewed.join("\n")).toContain("review-end");
    expect(reviewed.join("\n")).toContain("Enter confirm");
    const eventCount = log.events.length;
    const unchanged = plain(app.approvalLines().join("\n"));
    for (const key of ["y", "a", "r", "n", "j", "k", "Y"]) app.approvalInput(key);
    expect(log.events).toHaveLength(eventCount);
    expect(plain(app.approvalLines().join("\n"))).toBe(unchanged);
    app.approvalInput("3");
    expect(log.events).toHaveLength(eventCount);
    app.approvalInput("\r");
    for (const ch of "not now") app.approvalInput(ch);
    lines = plain(app.approvalLines().join("\n"));
    expect(lines).toContain("reason: not now");
    app.approvalInput("\r");
    await pending;
    const denied = log.events.find((e) => e.type === "tool/result");
    expect((denied as { content: string }).content).toBe("The user denied this call: not now");
    expect(plain(app.lines(120).join("\n"))).toContain("· approve: denied echo: not now");

    await app.command("/set approve allow echo");
    const slot = log.events.at(-1);
    expect(slot).toMatchObject({ type: "session/slot", slot: "approve" });
    expect((slot as { value: string }).value).toContain("echo");
    await app.submit("two");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    expect((results[1] as { content: string; isError: boolean }).isError).toBe(false);
    await app.command("/set approve");
    expect(plain(app.dialogLines().join("\n"))).toContain("now policy");
    app.dialogInput("\x1b");
    await app.command("/set approve ask");
    const cancelling = app.submit("three");
    try {
      await vi.waitFor(() => expect(app.approvalLines().length).toBeGreaterThan(0));
      app.setDraft("Keep this draft");
      app.agent.interrupt();
      await vi.waitFor(() => expect(app.agent.running).toBe(false), { timeout: 150 });
      await cancelling;
      expect(app.approvalLines()).toEqual([]);
      expect(app.draft()).toBe("Keep this draft");
      expect(log.events.filter((e) => e.type === "tool/result").at(-1)).toMatchObject({
        isError: true,
        content: "Interrupted by the user; not executed.",
      });
      expect(n).toBe(5);
    } finally {
      // 失败的取消复现也释放旧审批,不让测试留下悬挂任务或计时器。
      app.approvalInput("\x1b");
      await cancelling;
      app.stop();
    }
  });
});

describe("日志半行恢复", () => {
  it("恢复保留完整末行并隔开新事件,半行明确恢复;中间坏行仍报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarook-log-"));
    const file = join(dir, "s.jsonl");
    const good = JSON.stringify({ type: "session/start", at: "t", model: "m", system: "s" });
    const attached: EventLog[] = [];
    try {
      const complete = join(dir, "complete.jsonl");
      for (const ending of ["", "\r\n"]) {
        const original = good + ending;
        writeFileSync(complete, original);
        const before = EventLog.load(complete).events;
        expect(readFileSync(complete, "utf8")).toBe(original);
        const resumed = EventLog.load(complete, { attach: true });
        attached.push(resumed);
        resumed.append({ type: "user/message", at: "next", text: "继续工作" });
        resumed.recording?.flush();
        expect(EventLog.load(complete).events).toEqual([
          ...before,
          { type: "user/message", at: "next", text: "继续工作" },
        ]);
        expect(readFileSync(complete, "utf8").startsWith(original)).toBe(true);
        resumed.recording?.dispose();
      }
      const half = '{"type":"user/message","at":"t","te';
      writeFileSync(file, `${good}\n${half}`);
      vi.mocked(ftruncateSync).mockImplementationOnce(() => {
        throw new Error("repair disk unavailable");
      });
      const log = EventLog.load(file, { attach: true });
      attached.push(log);
      expect(log.events.map((e) => e.type)).toEqual(["session/start", "session/recovered"]);
      expect(log.events[1]).toMatchObject({ droppedBytes: Buffer.byteLength(half), preview: half });
      expect(log.recording?.error).toBe("repair disk unavailable");
      expect(readFileSync(file, "utf8")).toBe(`${good}\n${half}`);
      log.append({ type: "user/message", at: "next", text: "continue during repair" });
      expect(log.events).toHaveLength(3);
      log.recording?.flush();
      expect(log.recording?.error).toBeUndefined();
      expect(EventLog.load(file).events).toEqual(log.events);
      expect(readFileSync(file, "utf8").startsWith(`${good}\n`)).toBe(true);
      const rewritten = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(rewritten).toHaveLength(3);
      expect(JSON.parse(rewritten[1] as string).type).toBe("session/recovered");

      const bad = join(dir, "bad.jsonl");
      writeFileSync(bad, `{"broken\n${good}\n`);
      expect(() => EventLog.load(bad)).toThrow(/corrupt event log .*:1/);
      // 合法 JSON 但不是事件不能当成崩溃尾行删除。
      writeFileSync(bad, `${good}\nnull`);
      expect(() => EventLog.load(bad, { attach: true })).toThrow("Invalid event record");
      expect(readFileSync(bad, "utf8")).toBe(`${good}\nnull`);
    } finally {
      for (const log of attached) log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("统一入口", () => {
  it("clarook once --help 走一次性入口,exit 0", () => {
    // 直接用本机 node 跑 tsx 的入口:npx 的解析本身要 4 秒多,会撞上测试的 5 秒上限。
    const r = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "cli/main.ts", "once", "--help"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 60000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 30000);
});
