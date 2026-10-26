import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffLines, hunks } from "../cli/tools/diff.js";
import { createGrepTool, globTool } from "../cli/tools/search.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function project(): string {
  tmp = mkdtempSync(join(tmpdir(), "ak-search-"));
  mkdirSync(join(tmp, "src", "deep"), { recursive: true });
  mkdirSync(join(tmp, "node_modules", "x"), { recursive: true });
  writeFileSync(join(tmp, "src", "a.ts"), "export const alpha = 1;\nfunction beta() {}\n");
  writeFileSync(join(tmp, "src", "deep", "b.ts"), "const Alpha = 2;\n");
  writeFileSync(join(tmp, "README.md"), "alpha in docs\n");
  writeFileSync(join(tmp, "node_modules", "x", "index.js"), "alpha should be skipped\n");
  return tmp;
}

describe("只读工具", () => {
  it("glob 按整个路径匹配,包含隐藏文件并跳过构建目录", async () => {
    const root = project();
    writeFileSync(join(root, ".hidden.ts"), "export {};");
    writeFileSync(join(root, ".gitignore"), "src/a.ts\n");
    expect(
      await globTool.execute(
        { pattern: "src/**/*.ts", path: root },
        { signal: new AbortController().signal },
      ),
    ).toBe("src/a.ts\nsrc/deep/b.ts");
    expect(
      await globTool.execute(
        { pattern: "*.ts", path: root },
        { signal: new AbortController().signal },
      ),
    ).toBe(".hidden.ts");
    expect(
      await globTool.execute(
        { pattern: "**/*.js", path: root },
        { signal: new AbortController().signal },
      ),
    ).toBe("(no matches)");
    expect(
      await globTool.execute(
        { pattern: "**", path: root },
        { signal: new AbortController().signal },
      ),
    ).toBe(".gitignore\n.hidden.ts\nREADME.md\nsrc/a.ts\nsrc/deep/b.ts");
    expect(
      await globTool.execute(
        { pattern: "src/**", path: root },
        { signal: new AbortController().signal },
      ),
    ).toBe("src/a.ts\nsrc/deep/b.ts");
  });

  it("grep 返回可交给 read 的路径,支持文件过滤和大小写选项", async () => {
    const root = project();
    const grep = createGrepTool();
    const out = await grep.execute(
      { pattern: "alpha", path: root, glob: "*.ts", ignoreCase: true },
      { signal: new AbortController().signal },
    );
    expect(out).toContain(`${root.split("\\").join("/")}/src/a.ts:1:export const alpha`);
    expect(out).toContain(`${root.split("\\").join("/")}/src/deep/b.ts:1:const Alpha`);
    expect(out).not.toContain("README.md");
    expect(out).not.toContain("node_modules");
    expect(
      await grep.execute(
        { pattern: "alpha", path: root, glob: "*.js" },
        { signal: new AbortController().signal },
      ),
    ).toBe("(no matches)");
    const none = await grep.execute(
      { pattern: "zzz", path: root },
      { signal: new AbortController().signal },
    );
    expect(none).toBe("(no matches)");
    await expect(
      grep.execute({ pattern: "(", path: root }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/search failed/);
  });

  it("执行中的搜索可被取消", async () => {
    const root = project();
    const controller = new AbortController();
    const pending = globTool.execute(
      { pattern: "**/*", path: root },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/search interrupted/);
  });

  it("目录链接回环不会使已有搜索结果失败", async () => {
    const root = project();
    symlinkSync(
      root,
      join(root, "src", "deep", "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const files = await globTool.execute(
      { pattern: "src/**/*.ts", path: root },
      { signal: new AbortController().signal },
    );
    expect(files).toBe("src/a.ts\nsrc/deep/b.ts");
  });
});

describe("行级 diff", () => {
  it("增删改与上下文折叠", () => {
    const d = diffLines("a\nb\nc\nd\ne\nf\ng", "a\nb\nX\nd\ne\nf\ng\nh");
    expect(d.map((l) => l.kind + l.text)).toEqual([
      " a",
      " b",
      "-c",
      "+X",
      " d",
      " e",
      " f",
      " g",
      "+h",
    ]);
    const h = hunks(d, 1);
    expect(h.map((l) => l.kind + l.text)).toEqual([
      " b",
      "-c",
      "+X",
      " d",
      "……2 unchanged lines…",
      " g",
      "+h",
    ]);
  });

  it("超长片段退化为整删整增,不做二次方计算", () => {
    const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const d = diffLines(big, `${big}\nmore`);
    expect(d.filter((l) => l.kind === "-")).toHaveLength(500);
    expect(d.filter((l) => l.kind === "+")).toHaveLength(501);
  });
});
