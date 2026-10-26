import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  composeSystemPrompt,
  discoverProjectInstructions,
  environmentSection,
  findGitRoot,
} from "../cli/prompt.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function tree(): { root: string; deep: string; home: string } {
  tmp = mkdtempSync(join(tmpdir(), "ak-prompt-"));
  const root = join(tmp, "repo");
  const deep = join(root, "packages", "app");
  const home = join(tmp, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(deep, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "AGENTS.md"), "全局规则");
  writeFileSync(join(root, "AGENTS.md"), "仓库规则");
  writeFileSync(join(root, "packages", "CLAUDE.md"), "中层规则(CLAUDE.md 兜底)");
  writeFileSync(join(deep, "AGENTS.md"), "叶子规则");
  writeFileSync(join(deep, "CLAUDE.md"), "同目录 CLAUDE.md 不应被选中");
  // 仓库之外的父目录文件不该被读到
  writeFileSync(join(tmp, "AGENTS.md"), "越界规则");
  return { root, deep, home };
}

describe("系统提示词组装", () => {
  it("段列表以空行相接,空段跳过", () => {
    expect(
      composeSystemPrompt([
        { name: "a", text: "A\n" },
        { name: "b", text: "  " },
        { name: "c", text: "C" },
      ]),
    ).toBe("A\n\nC");
  });

  it("项目指令:全局 → git 根 → 中层 → cwd,每目录取一个,AGENTS.md 优先,不越过 git 根", () => {
    const { deep, home } = tree();
    const r = discoverProjectInstructions(deep, { home });
    expect(r.files.map((f) => f.path.split(/[\\/]/).slice(-2).join("/"))).toEqual([
      "home/AGENTS.md",
      "repo/AGENTS.md",
      "packages/CLAUDE.md",
      "app/AGENTS.md",
    ]);
    const text = r.section?.text ?? "";
    expect(text.indexOf("全局规则")).toBeLessThan(text.indexOf("仓库规则"));
    expect(text.indexOf("仓库规则")).toBeLessThan(text.indexOf("中层规则"));
    expect(text.indexOf("中层规则")).toBeLessThan(text.indexOf("叶子规则"));
    expect(text).not.toContain("同目录 CLAUDE.md");
    expect(text).not.toContain("越界规则");
    expect(text).toContain("# Project instructions ");
  });

  it("预算:超限先丢最宽泛的;只剩一份仍超限就截它", () => {
    const { deep, home } = tree();
    const small = discoverProjectInstructions(deep, { home, budgetBytes: 40 });
    const kept = small.files.filter((f) => !f.dropped);
    expect(small.files.filter((f) => f.dropped).length).toBeGreaterThan(0);
    expect(kept.at(-1)?.path.endsWith("AGENTS.md")).toBe(true);
    expect(small.section?.text).toContain("叶子规则");
    expect(small.section?.text).not.toContain("全局规则");

    const tiny = discoverProjectInstructions(deep, { home, budgetBytes: 6 });
    expect(tiny.files.filter((f) => !f.dropped)).toHaveLength(1);
    expect(tiny.files.at(-1)?.truncated).toBe(true);
    expect(tiny.section?.text).toContain("truncated to 6 bytes");
  });

  it("不在仓库内只看 cwd 与全局;没有文件时无该段", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-prompt-"));
    const home = join(tmp, "home");
    mkdirSync(home);
    expect(findGitRoot(tmp)).toBeUndefined();
    expect(discoverProjectInstructions(tmp, { home }).section).toBeUndefined();
    writeFileSync(join(tmp, "CLAUDE.md"), "只有 cwd");
    expect(discoverProjectInstructions(tmp, { home }).section?.text).toContain("只有 cwd");
  });

  it("环境块含 cwd、OS、shell、日期与 git 状态;整体拼装顺序 角色 → 环境 → 项目 → 追加;替换模式只剩替换与追加", () => {
    const { deep, home } = tree();
    const env = environmentSection(deep, {
      now: new Date("2026-09-02T10:00:00Z"),
      env: { SHELL: "/bin/zsh" },
      git: false,
    });
    expect(env.text).toContain("working directory: ");
    expect(env.text).toContain("host shell: /bin/zsh");
    expect(env.text).toContain("built-in bash tool executes Bash commands");
    expect(env.text).toContain("date: 2026-09-02");

    const full = buildSystemPrompt({
      base: "你是助手。",
      cwd: deep,
      append: "追加段",
      discover: { home },
      env: { git: false },
    });
    expect(full.sections.map((s) => s.name)).toEqual([
      "Role and rules",
      "Environment",
      "Project instructions",
      "Appended",
    ]);
    expect(full.text.startsWith("你是助手。")).toBe(true);
    expect(full.text.endsWith("追加段")).toBe(true);

    const replaced = buildSystemPrompt({
      base: "x",
      cwd: deep,
      replace: "完全自定义",
      append: "追加段",
    });
    expect(replaced.sections.map((s) => s.name)).toEqual(["Custom", "Appended"]);
    expect(replaced.text).toBe("完全自定义\n\n追加段");
  });
});
