import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createAutocompleteProvider } from "../cli/autocomplete.js";
import { testDirectory } from "./helpers/setup.js";

describe("文件补全路径规则", () => {
  it("目录候选可继续补全,显式相对路径和绝对路径保留原来的作用域", async () => {
    const root = testDirectory("completion-scope-");
    mkdirSync(join(root, "docs", "deep"), { recursive: true });
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "docs", "deep", "notes.txt"), "");
    writeFileSync(join(root, "other", "notes.txt"), "");
    const provider = createAutocompleteProvider([], root);
    const options = { signal: new AbortController().signal };
    const line = "Read @docs/";
    const dirs = await provider.getSuggestions([line], 0, line.length, options);
    const dir = dirs?.items.find((item) => item.value === "@docs/deep/");
    expect(dir).toBeDefined();
    if (!dirs || !dir) throw new Error("Missing directory suggestion");
    const completed = provider.applyCompletion([line], 0, line.length, dir, dirs.prefix);
    expect(completed).toEqual({ lines: ["Read @docs/deep/"], cursorLine: 0, cursorCol: 16 });

    const relativeBase = [".", "docs", "deep", ""].join(sep);
    for (const [input, expected] of [
      [`@${relativeBase}no`, `@${relativeBase}notes.txt`],
      [`@${root}/docs/deep/no`, `@${root}/docs/deep/notes.txt`],
    ] as const) {
      const suggestions = await provider.getSuggestions([input], 0, input.length, options);
      expect(suggestions?.items.map((item) => item.value)).toEqual([expected]);
    }
    expect(await provider.getSuggestions(["@missing/"], 0, 9, options)).toBeNull();
    const fileAsDirectory = "@other/notes.txt/";
    expect(
      await provider.getSuggestions([fileAsDirectory], 0, fileAsDirectory.length, options),
    ).toBeNull();
  });

  it("含空格目录保持单引号与光标位置,已有闭引号不重复插入", async () => {
    const root = testDirectory("completion-quoted-dir-");
    mkdirSync(join(root, "work notes"));
    writeFileSync(join(root, "work notes", "part.txt"), "");
    writeFileSync(join(root, "work notes", "part's.txt"), "");
    const provider = createAutocompleteProvider([], root);
    const beforeCursor = "Read @'work n";
    const line = `${beforeCursor}' after`;
    const options = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions([line], 0, beforeCursor.length, options);
    const dir = suggestions?.items.find((item) => item.label === "work notes/");
    expect(dir?.value).toBe("@'work notes/'");
    if (!suggestions || !dir) throw new Error("Missing quoted directory suggestion");
    const completed = provider.applyCompletion(
      [line],
      0,
      beforeCursor.length,
      dir,
      suggestions.prefix,
    );
    expect(completed).toEqual({
      lines: ["Read @'work notes/' after"],
      cursorLine: 0,
      cursorCol: 18,
    });
    const next = await provider.getSuggestions(completed.lines, 0, completed.cursorCol, options);
    expect(next?.items.map((item) => item.value).sort()).toEqual([
      '@"work notes/part\'s.txt"',
      "@'work notes/part.txt'",
    ]);
  });

  it("只查文件名,包含隐藏文件并沿用搜索工具的跳过目录", async () => {
    const root = testDirectory("completion-ignored-");
    writeFileSync(join(root, "alpha.txt"), "not readable", { mode: 0 });
    writeFileSync(join(root, ".alpha.txt"), "");
    for (const directory of [".git", "node_modules", "dist", "build", ".preview", "sessions"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "alpha-secret.txt"), "");
    }
    const provider = createAutocompleteProvider([], root);
    const suggestions = await provider.getSuggestions(["@alpha"], 0, 6, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((item) => item.value).sort()).toEqual([
      "@.alpha.txt",
      "@alpha.txt",
    ]);
  });

  it("取消旧查询得到空结果,新的查询仍返回自己的候选", async () => {
    const root = testDirectory("completion-abort-");
    writeFileSync(join(root, "alpha.txt"), "");
    writeFileSync(join(root, "beta.txt"), "");
    const provider = createAutocompleteProvider([], root);
    const old = new AbortController();
    const pending = provider.getSuggestions(["@alpha"], 0, 6, { signal: old.signal });
    old.abort();
    const latest = provider.getSuggestions(["@beta"], 0, 5, {
      signal: new AbortController().signal,
    });
    expect(await pending).toBeNull();
    expect((await latest)?.items.map((item) => item.value)).toEqual(["@beta.txt"]);
  });

  it("命令与普通路径仍从同一个公开补全接口选择", async () => {
    const root = testDirectory("completion-ordinary-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "notes.txt"), "");
    const provider = createAutocompleteProvider([{ name: "help" }], root);
    const options = { signal: new AbortController().signal };
    for (const [input, expected] of [
      ["/he", "/help "],
      ["Read ./src/no", "Read ./src/notes.txt"],
    ] as const) {
      const suggestions = await provider.getSuggestions([input], 0, input.length, options);
      const item = suggestions?.items[0];
      expect(item).toBeDefined();
      if (!suggestions || !item) throw new Error("Missing completion");
      expect(provider.applyCompletion([input], 0, input.length, item, suggestions.prefix)).toEqual({
        lines: [expected],
        cursorLine: 0,
        cursorCol: expected.length,
      });
    }
  });
});
