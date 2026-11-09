// 跨会话记忆、系统提示词段控制与预设。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginSession } from "../cli/bootstrap.js";
import { buildSystemPrompt, discoverProjectInstructions } from "../cli/prompt.js";
import {
  appendMemory,
  clearMemory,
  createRememberTool,
  forgetMemory,
  MEMORY_HEADING,
  MEMORY_MAX_LINES,
  memoryEntries,
  splitMemory,
} from "../cli/tools/memory.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const ctx = { signal: new AbortController().signal };

describe("记忆节:AGENTS.md 里由工具写入的一节", () => {
  it("拆分:人写部分与记忆节分开;记忆节到下一个二级标题为止", () => {
    const content = `# 项目\n规则 A\n\n${MEMORY_HEADING}\n- [correction] 2026-09-03 不要用 any\n- [preference] 2026-09-03 回答简短\n\n## 其它\n人写的`;
    const s = splitMemory(content);
    expect(s.memory).toBe(
      "- [correction] 2026-09-03 不要用 any\n- [preference] 2026-09-03 回答简短",
    );
    expect(s.rest).toContain("规则 A");
    expect(s.rest).toContain("## 其它");
    expect(s.rest).not.toContain(MEMORY_HEADING);
    expect(memoryEntries(content)).toEqual([
      "[correction] 2026-09-03 不要用 any",
      "[preference] 2026-09-03 回答简短",
    ]);
    expect(splitMemory("没有记忆节").memory).toBeUndefined();
  });

  it("追加、删除、清空:不动人写部分;上限报错不截断", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-mem-"));
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, "# 项目\n规则 A\n");
    const day = new Date("2026-09-03T00:00:00Z");
    appendMemory(file, "correction", "测试要跑 pnpm check", day);
    appendMemory(file, "preference", "多行\n要压成一行", day);
    let text = readFileSync(file, "utf8");
    expect(text.startsWith("# 项目\n规则 A")).toBe(true);
    expect(text).toContain(
      `${MEMORY_HEADING}\n- [correction] 2026-09-03 测试要跑 pnpm check\n- [preference] 2026-09-03 多行 要压成一行`,
    );

    expect(forgetMemory(file, 1)).toContain("pnpm check");
    expect(memoryEntries(readFileSync(file, "utf8"))).toHaveLength(1);
    expect(() => forgetMemory(file, 5)).toThrow("no memory entry 5");

    expect(clearMemory(file)).toBe(1);
    text = readFileSync(file, "utf8");
    expect(text).toContain("规则 A");
    expect(text).not.toContain(MEMORY_HEADING);

    // 上限
    for (let i = 0; i < MEMORY_MAX_LINES; i++) appendMemory(file, "reference", `第 ${i} 条`, day);
    expect(() => appendMemory(file, "reference", "多一条", day)).toThrow("memory is full");
    expect(memoryEntries(readFileSync(file, "utf8"))).toHaveLength(MEMORY_MAX_LINES);
    // 不存在的文件也能建
    const fresh = join(tmp, "sub", "AGENTS.md");
    appendMemory(fresh, "project-fact", "新建", day);
    expect(readFileSync(fresh, "utf8")).toBe(
      `${MEMORY_HEADING}\n- [project-fact] 2026-09-03 新建\n`,
    );
  });

  it("remember 工具:缺省写项目文件,scope=user 写用户文件,返回文案含路径", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-mem-"));
    const project = join(tmp, "AGENTS.md");
    const user = join(tmp, "home", "AGENTS.md");
    const tool = createRememberTool({ project, user });
    const out = await tool.execute({ text: "用 pnpm", kind: "project-fact" }, ctx);
    expect(out).toContain(project);
    await tool.execute({ text: "喜欢简短", kind: "preference", scope: "user" }, ctx);
    expect(memoryEntries(readFileSync(project, "utf8"))).toHaveLength(1);
    expect(memoryEntries(readFileSync(user, "utf8"))[0]).toContain("喜欢简短");
    const parameters = tool.parameters as { properties: { scope: { anyOf: { const: string }[] } } };
    expect(parameters.properties.scope.anyOf.map((x) => x.const)).toEqual(["project", "user"]);
  });
});

describe("系统提示词段控制", () => {
  function repo(): { root: string; home: string } {
    tmp = mkdtempSync(join(tmpdir(), "ak-prompt-"));
    const root = join(tmp, "repo");
    const home = join(tmp, "home");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(root, "AGENTS.md"),
      `# 仓库规则\n用 pnpm\n\n${MEMORY_HEADING}\n- [correction] 2026-09-03 别用 any\n`,
    );
    writeFileSync(
      join(home, "AGENTS.md"),
      `全局规则\n\n${MEMORY_HEADING}\n- [preference] 2026-09-03 简短\n`,
    );
    return { root, home };
  }

  it("发现:记忆节从指令里拆出来单独成段;缺省(记忆关)不注入,开了才注入", () => {
    const { root, home } = repo();
    const d = discoverProjectInstructions(root, { home });
    expect(d.section?.text).toContain("用 pnpm");
    expect(d.section?.text).not.toContain("别用 any");
    expect(d.memory?.text).toContain("别用 any");
    expect(d.memory?.text).toContain("简短");
    expect(d.files.map((f) => f.memoryBytes > 0)).toEqual([true, true]);

    const off = buildSystemPrompt({
      base: "B",
      cwd: root,
      discover: { home },
      env: { git: false },
    });
    expect(off.sections.map((s) => s.name)).toEqual([
      "Role and rules",
      "Environment",
      "Project instructions",
    ]);
    expect(off.text).not.toContain("别用 any");
    const on = buildSystemPrompt({
      base: "B",
      cwd: root,
      discover: { home },
      env: { git: false },
      memory: true,
    });
    expect(on.sections.map((s) => s.name)).toEqual([
      "Role and rules",
      "Environment",
      "Project instructions",
      "Memory",
    ]);
    expect(on.text).toContain("# Memory ");
    expect(on.text).toContain("别用 any");
  });

  it("段的选择与顺序、放到首条 user 消息", () => {
    const { root, home } = repo();
    const picked = buildSystemPrompt({
      base: "B",
      cwd: root,
      discover: { home },
      env: { git: false },
      memory: true,
      sections: ["instructions", "role"],
    });
    expect(picked.sections.map((s) => s.name)).toEqual(["Project instructions", "Role and rules"]);
    expect(picked.text.startsWith("# Project instructions")).toBe(true);

    const asUser = buildSystemPrompt({
      base: "B",
      cwd: root,
      discover: { home },
      env: { git: false },
      memory: true,
      instructionsAs: "user",
    });
    expect(asUser.sections.map((s) => s.name)).toEqual(["Role and rules", "Environment"]);
    expect(asUser.preamble.map((s) => s.name)).toEqual(["Project instructions", "Memory"]);
    expect(asUser.text).not.toContain("用 pnpm");
  });

  it("beginSession:instructionsAs=user 的首条 user 消息", () => {
    const { root } = repo();
    // 用 openSession 的新建路径:resume 未给
    const cwdBefore = process.cwd();
    process.chdir(tmp as string);
    try {
      const s = beginSession(
        { continue: false, instructionsAs: "user", memory: true },
        { model: "m" },
        root,
      );
      expect(s.log.events[0]?.type).toBe("session/start");
      const first = s.log.events.find((event) => event.type === "user/message");
      expect(first?.type).toBe("user/message");
      expect(first?.type === "user/message" && first.text).toContain("用 pnpm");
      expect(first?.type === "user/message" && first.text).toContain("别用 any");
      const start = s.log.events[0];
      expect(start?.type === "session/start" && start.sections?.map((x) => x.name)).toEqual([
        "Role and rules",
        "Environment",
      ]);
    } finally {
      process.chdir(cwdBefore);
    }
  });
});

describe("TUI /memory 与 /prompt", () => {
  it("列出、删一条、清空;未打开时提示", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-mem-"));
    const project = join(tmp, "AGENTS.md");
    const user = join(tmp, "home", "AGENTS.md");
    appendMemory(project, "correction", "一", new Date("2026-09-03T00:00:00Z"));
    appendMemory(user, "preference", "二", new Date("2026-09-03T00:00:00Z"));
    const make = (memory: boolean) =>
      createTuiApp({
        terminal: new VirtualTerminal(100, 40),
        log: new EventLog(),
        provider: {
          model: "m",
          async complete() {
            throw new Error("x");
          },
        },
        tools: [],
        compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
        reserveTokens: 20000,
        info: { model: "m", providerName: "p", sessionFile: "s" },
        systemPrompt: "sys",
        onExit: () => {},
        ...(memory && { memory: { project, user } }),
      });
    const text = (app: ReturnType<typeof make>) => app.lines(100).map(stripAnsi).join("\n");
    const off = make(false);
    await off.command("/memory");
    expect(text(off)).toContain("memory is off. Start with --memory");
    await off.command("/inspect prompt");
    expect(text(off)).toContain("System prompt");
    expect(text(off)).toContain("memory: off");
    off.stop();

    const on = make(true);
    await on.command("/memory show");
    const doc = text(on);
    expect(doc).toContain("Memory 2 entries");
    expect(doc).toContain("[correction] 2026-09-03 一");
    expect(doc).toContain("[preference] 2026-09-03 二");
    await on.command("/memory forget 2");
    expect(text(on)).toContain("· removed: [preference] 2026-09-03 二");
    expect(memoryEntries(readFileSync(user, "utf8"))).toHaveLength(0);
    await on.command("/memory clear");
    expect(text(on)).toContain("· cleared 1 memories");
    expect(memoryEntries(readFileSync(project, "utf8"))).toHaveLength(0);
    on.stop();
  });
});
