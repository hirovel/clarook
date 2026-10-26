// 命令的选单:次级选项不打字,选。每个命令无参数时弹选单,选中即落地;Esc 回去;
// 打字形态仍然认;帮助只列十四个命令;未知命令给去处。/tools 的开关真的改随请求发出的工具集。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { COMMANDS } from "../cli/tui-commands.js";
import type { SessionTarget, TuiContext } from "../cli/tui-context.js";
import { choose } from "../cli/tui-menu.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider, ToolDef } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});
const shout = defineTool({
  name: "shout",
  description: "Echo the text in capitals.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text.toUpperCase();
  },
});

function boot(over: Partial<TuiAppDeps> = {}, seen: ToolDef[][] = []) {
  const provider: Provider = {
    model: "m",
    async complete(_m, tools): Promise<AssistantTurn> {
      seen.push(tools);
      return { text: "ok", toolCalls: [], stopReason: "end" };
    },
  };
  const term = new VirtualTerminal(110, 40);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [echo, shout],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    onExit: () => {},
    ...over,
  });
  const doc = () => app.lines(110).map(stripAnsi).join("\n");
  const menu = () => app.dialogLines().map(stripAnsi).join("\n");
  return { app, term, doc, menu };
}

describe("命令选单", () => {
  it("帮助列出内置命令,按组;未知命令说去哪找", async () => {
    const { app, doc } = boot();
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "help",
      "inspect",
      "set",
      "settings",
      "edit",
      "model",
      "login",
      "tools",
      "session",
      "memory",
      "compact",
      "copy",
      "shell",
      "stop",
      "quit",
    ]);
    await app.command("/help");
    const d = doc();
    expect(d).toContain("/inspect");
    expect(d).toContain("Keys");
    expect(d).not.toContain("/toolprompts");
    expect(d).not.toContain("/approve");
    await app.command("/approve ask");
    expect(doc()).toContain(
      "unknown command /approve  /help lists the commands · Ctrl+K searches everything",
    );
    app.stop();
  });

  it("/inspect 弹分区选单,行注带数量;选 usage 直接印;选 requests 开检视器;Esc 回去", async () => {
    const { app, doc, menu } = boot();
    await app.submit("hi");
    await app.command("/inspect");
    const m = menu();
    expect(m).toContain("Inspect");
    expect(m).toContain("requests");
    expect(m).toContain("every request as sent and received · 1");
    expect(m).toContain("Esc back");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    // 关闭真实命令选单也必须结束等待,不能留下悬空的命令流程。
    let cancel = () => {};
    const context = {
      tui: { requestRender() {} },
      deps: { terminal: { rows: 24 } },
      dialog: {
        open(_component: unknown, onClose?: () => void) {
          cancel = onClose ?? (() => {});
        },
        close() {
          cancel();
        },
      },
    } as unknown as TuiContext;
    let settled = false;
    const closedMenu = choose(context, "Close", []).then((result) => {
      settled = true;
      return result;
    });
    context.dialog.close();
    await tick();
    expect(settled).toBe(true);
    expect(await closedMenu).toBeUndefined();
    await app.command("/inspect");
    app.dialogInput("3"); // usage
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("Context  estimated");
    await app.command("/inspect");
    app.dialogInput("\r"); // requests(第一行)
    await tick();
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.close();
    app.stop();
  });

  it("/set 弹槽选单(行注是当前值)→ 值选单 → 落地并记 session/slot;打字形态等价", async () => {
    const { app, doc, menu } = boot();
    await app.command("/set");
    let m = menu();
    expect(m).toContain("Set");
    expect(m).toContain("execution");
    expect(m).toContain("sequential · one tool call at a time");
    app.dialogInput("5"); // execution
    app.dialogInput("\r");
    await tick();
    m = menu();
    expect(m).toContain("now sequential");
    expect(m).toContain("parallel");
    app.dialogInput("2");
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("execution → parallel");
    expect(app.agent.slots.execution).toBe("parallel");
    await app.command("/set execution sequential");
    expect(app.agent.slots.execution).toBe("sequential");
    // 审批选单:模式与规则;规则要打字,选中后填进输入框
    await app.command("/set approve");
    app.dialogInput("4"); // allow a rule
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("type the rule after the command");
    // 使用真正的覆盖层与输入路由:长列表、长值分页不能改写选项或草稿。
    app.stop();
    const narrow = new VirtualTerminal(60, 18);
    const next = boot({ terminal: narrow });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      label: `model-${i + 1}`,
      note: `${"项目路径/".repeat(80)}END-${i + 1}`,
    }));
    next.app.setDraft("未发送的草稿");
    const chosen = next.app.choose("Choose a model", rows);
    let completed = false;
    void chosen.then(() => {
      completed = true;
    });
    narrow.feed("d");
    await tick();
    expect(completed).toBe(false);
    for (let i = 0; i < 30; i++) narrow.feed("\x1bOB");
    const lines = next.app.dialogLines();
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    next.app.tui.renderNow(true);
    expect((await narrow.screen()).join("\n")).toContain("model-31");
    expect((await narrow.screen()).join("\n")).toContain("Esc back");
    for (let i = 0; i < 40; i++) {
      narrow.feed("\x1b[6~");
      next.app.tui.renderNow(true);
    }
    expect((await narrow.screen()).join("\n")).toContain("END-31");
    narrow.feed("\x1b[A");
    next.app.tui.renderNow(true);
    expect((await narrow.screen()).join("\n")).toContain("model-30");
    narrow.feed("\r");
    expect(await chosen).toBe("model-30");
    expect(next.app.draft()).toBe("未发送的草稿");
    const cancelled = next.app.choose("Choose again", rows);
    narrow.feed("\x1b");
    expect(await cancelled).toBeUndefined();
    narrow.feed("继续输入");
    expect(next.app.draft()).toBe("未发送的草稿继续输入");
    next.app.stop();
  });

  it("/tools 选单里 Enter 翻开关:关掉的不随请求发出,/inspect tools 标 off,记 session/slot;打字 only 一次选集", async () => {
    const seen: ToolDef[][] = [];
    const log = new EventLog();
    const { app, doc, menu } = boot({ log }, seen);
    await app.command("/tools");
    const m = menu();
    expect(m).toContain("2 of 2 on");
    expect(m).toContain("echo");
    app.dialogInput("2"); // shout
    const selected = menu();
    const eventCount = log.events.length;
    for (const key of ["d", "j", "k", "q", "s", "c", "y", "n"]) app.dialogInput(key);
    await tick();
    expect(menu()).toBe(selected);
    expect(log.events).toHaveLength(eventCount);
    app.dialogInput("\r");
    await tick();
    expect(menu()).toContain("1 of 2 on"); // 翻完重开
    app.dialogInput("\x1b");
    await tick();
    expect(doc()).toContain("tools off: shout");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["echo"]);
    await app.command("/inspect tools");
    expect(doc()).toMatch(/shout.*off/);
    await app.command("/tools only shout");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["shout"]);
    await app.command("/tools on echo");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["echo", "shout"]);
    await app.command("/tools off nope");
    expect(doc()).toContain("no tool named nope");
    app.stop();
  });

  it("/session 选单:new 与历史来源正确;搜索能恢复第15项以外的会话,取消保留草稿", async () => {
    const targets: SessionTarget[] = [];
    const { app, menu } = boot({ switchSession: (t) => targets.push(t) });
    await app.command("/session");
    expect(menu()).toContain("fresh log");
    app.dialogInput("\r"); // new
    await tick();
    expect(menu()).toContain("Session setup");
    expect(targets).toEqual([]);
    app.dialogInput("d");
    expect(targets).toEqual([]);
    app.dialogInput("\r");
    await tick();
    expect(targets).toEqual([{ kind: "new", source: "current" }]);
    const bare = boot();
    await bare.app.command("/session new");
    expect(bare.doc()).toContain("switching sessions is not available here");
    bare.app.stop();
    app.stop();
    const dir = mkdtempSync(join(tmpdir(), "clarook-session-search-"));
    const narrow = new VirtualTerminal(60, 18);
    const restored: SessionTarget[] = [];
    const older = join(dir, "00-old session.jsonl");
    for (let i = 0; i < 24; i++) {
      const file = i === 0 ? older : join(dir, `${String(i).padStart(2, "0")}.jsonl`);
      writeFileSync(
        file,
        `${[
          { type: "session/start", at: "2026-10-01T10:00:00Z", model: "p/m", system: "sys" },
          {
            type: "user/message",
            at: "t",
            text: i < 2 ? "修复 checkout 404 🙂" : `Recent work ${i}`,
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
      );
    }
    const next = boot({
      terminal: narrow,
      sessionsDir: dir,
      switchSession: (target) => restored.push(target),
    });
    try {
      next.app.setDraft("Keep my draft");
      await next.app.command("/session resume");
      narrow.feed("\x1b[200~checkout 404\x1b[201~");
      const found = next.app.dialogLines();
      expect(found.map(stripAnsi).join("\n")).toContain("修复 checkout 404 🙂");
      expect(found.length).toBeLessThanOrEqual(18);
      expect(found.every((line) => visibleWidth(line) <= 60)).toBe(true);
      expect(restored).toEqual([]);
      // 摘要相同也必须按路径选对文件,数字是搜索文字而非快捷操作。
      for (const _char of "checkout 404") narrow.feed("\x7f");
      narrow.feed("00-old session");
      expect(next.menu()).toContain("› 00-old session");
      narrow.feed("\r");
      await tick();
      expect(next.menu()).toContain("Session setup");
      narrow.feed("\r");
      await tick();
      expect(restored).toEqual([{ kind: "resume", file: older, source: "history" }]);
      expect(next.app.draft()).toBe("Keep my draft");
      await next.app.command("/session resume");
      narrow.feed("absent query");
      expect(next.menu()).toContain("no match");
      narrow.feed("\x7f");
      narrow.feed("\x1b");
      expect(next.app.dialogLines()).toEqual([]);
      expect(restored).toHaveLength(1);
      expect(next.app.draft()).toBe("Keep my draft");
    } finally {
      next.app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/edit 选单:retry 与 list;/copy 无代码块时直接复制;/memory 关着时选单不弹", async () => {
    const { app, doc, menu } = boot();
    await app.submit("hi");
    await app.command("/edit");
    expect(menu()).toContain("retry");
    app.dialogInput("3"); // list
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("No edits");
    await app.command("/copy");
    expect(app.dialogLines()).toEqual([]);
    expect(doc()).toContain("copied the last reply");
    await app.command("/memory");
    expect(app.dialogLines()).toEqual([]);
    expect(doc()).toContain("memory is off");
    app.stop();
  });
});
