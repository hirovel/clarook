import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createEditTool, createReadTool, createWriteTool, editTool } from "../cli/tools/fs.js";
import { validateArgs } from "../src/tools.js";
import { testDirectory } from "./helpers/setup.js";

const SCHEMA = Type.Object({
  path: Type.String(),
  limit: Type.Optional(Type.Number()),
});

const ctx = { signal: new AbortController().signal };

describe("validateArgs", () => {
  it("合法参数通过,数字字符串被强转(Value.Convert)", () => {
    const r = validateArgs(SCHEMA, { path: "a.txt", limit: "5" });
    expect(r).toEqual({ ok: true, value: { path: "a.txt", limit: 5 } });
  });

  it("缺字段→错误含路径与收到的参数原文", () => {
    const r = validateArgs(SCHEMA, { limit: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("path");
      expect(r.error).toContain('"limit": 3');
    }
  });

  it("__unparsed(烂 JSON)→专门的错误文本", () => {
    const r = validateArgs(SCHEMA, { __unparsed: '{"broken' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not valid JSON");
  });

  it("校验不改动原始参数对象(历史不可变)", () => {
    const raw = { path: "a.txt", limit: "5" };
    validateArgs(SCHEMA, raw);
    expect(raw.limit).toBe("5");
  });
});

describe("文件工具", () => {
  function tempFile(content: string): string {
    const path = join(testDirectory("kernel-edit-"), "f.txt");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("读写和唯一替换使用显式根,绝对路径仍可访问根外文件", async () => {
    const root = testDirectory("kernel-files-");
    const relative = `${basename(root)}.txt`;
    const absolute = join(testDirectory("kernel-files-absolute-"), "f.txt");
    const read = createReadTool({ cwd: root });
    const write = createWriteTool(root);
    const edit = createEditTool(root);
    try {
      for (const [path, actual] of [
        [relative, join(root, relative)],
        [absolute, absolute],
      ] as const) {
        await write.execute({ path, content: "aaa bbb ccc" }, ctx);
        expect(await read.execute({ path }, ctx)).toBe("1\taaa bbb ccc");
        await edit.execute({ path, oldText: "bbb", newText: "xxx" }, ctx);
        expect(readFileSync(actual, "utf8")).toBe("aaa xxx ccc");
      }
    } finally {
      // 根绑定回归时,也清理测试可能误写到启动目录的唯一临时文件。
      rmSync(resolve(relative), { force: true });
    }
  });

  it("不存在→报错提示先 read", async () => {
    const path = tempFile("aaa");
    await expect(editTool.execute({ path, oldText: "zzz", newText: "x" }, ctx)).rejects.toThrow(
      "not found",
    );
  });

  it("标点或空白不同时拒绝写入,让模型按文件原文重试", async () => {
    const original = "cost—benefit  \n";
    const path = tempFile(original);
    await expect(
      editTool.execute({ path, oldText: "cost-benefit", newText: "gain" }, ctx),
    ).rejects.toThrow("not found");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("多处匹配→报错并给出次数,提示 replaceAll", async () => {
    const path = tempFile("aa aa");
    await expect(editTool.execute({ path, oldText: "aa", newText: "x" }, ctx)).rejects.toThrow(
      /occurs 2 times.*replaceAll/,
    );
  });

  it("replaceAll→全部替换并报次数;没有命中仍走 not found", async () => {
    const path = tempFile("foo(a); foo(b);\nbar();");
    const out = await editTool.execute(
      { path, oldText: "foo(", newText: "baz(", replaceAll: true },
      ctx,
    );
    expect(out).toBe(`replaced 2 occurrences in ${path}.`);
    expect(readFileSync(path, "utf8")).toBe("baz(a); baz(b);\nbar();");
    await expect(
      editTool.execute({ path, oldText: "nope", newText: "x", replaceAll: true }, ctx),
    ).rejects.toThrow("not found");
  });
});
