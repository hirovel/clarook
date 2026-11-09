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

  it("edit 只接受非空 edits 数组,拒绝旧输入、形状修复和两级额外字段", () => {
    const edit = { oldText: "before", newText: "after" };
    const valid = { path: "a.txt", edits: [edit] };
    expect(validateArgs(editTool.parameters, valid)).toEqual({ ok: true, value: valid });
    expect(
      validateArgs(editTool.parameters, {
        path: "a.txt",
        edits: [{ oldText: 5, newText: 6, replaceAll: "true" }],
      }),
    ).toEqual({
      ok: true,
      value: { path: "a.txt", edits: [{ oldText: "5", newText: "6", replaceAll: true }] },
    });
    for (const raw of [
      { path: "a.txt", ...edit },
      { path: "a.txt", edits: [] },
      { path: "a.txt", edits: edit },
      { path: "a.txt", edits: JSON.stringify([edit]) },
      { ...valid, replaceAll: true },
      { path: "a.txt", edits: [{ ...edit, extra: true }] },
    ]) {
      expect(validateArgs(editTool.parameters, raw).ok).toBe(false);
    }
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
        const edits = [
          { oldText: "ccc", newText: "CCC" },
          { oldText: "bbb", newText: "ccc" },
        ];
        for (const items of [edits, [...edits].reverse()]) {
          await write.execute({ path, content: "aaa bbb ccc" }, ctx);
          expect(await read.execute({ path }, ctx)).toBe("1\taaa bbb ccc");
          const result = await edit.execute({ path, edits: items }, ctx);
          expect(result).toBe(`applied 2 edits with 2 replacements in ${path}.`);
          expect(readFileSync(actual, "utf8")).toBe("aaa ccc CCC");
        }
      }
    } finally {
      // 根绑定回归时,也清理测试可能误写到启动目录的唯一临时文件。
      rmSync(resolve(relative), { force: true });
    }
  });

  it("后项不存在或依赖前项生成的文字时整组不写,错误标出下标并提示先 read", async () => {
    const path = tempFile("aaa");
    for (const oldText of ["missing", "zzz"]) {
      await expect(
        editTool.execute(
          {
            path,
            edits: [
              { oldText: "aaa", newText: "zzz" },
              { oldText, newText: "x" },
            ],
          },
          ctx,
        ),
      ).rejects.toThrow(/edits\[1\].*not found/);
      expect(readFileSync(path, "utf8")).toBe("aaa");
    }
  });

  it("标点或空白不同时拒绝写入,让模型按文件原文重试", async () => {
    const original = "cost—benefit  \n";
    const path = tempFile(original);
    await expect(
      editTool.execute({ path, edits: [{ oldText: "cost-benefit", newText: "gain" }] }, ctx),
    ).rejects.toThrow("not found");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("前项 replaceAll 不放宽后项唯一性,后项多处匹配时整组不写", async () => {
    const original = "aa aa bb bb";
    const path = tempFile(original);
    await expect(
      editTool.execute(
        {
          path,
          edits: [
            { oldText: "aa", newText: "x", replaceAll: true },
            { oldText: "bb", newText: "y" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/edits\[1\].*occurs 2 times.*replaceAll/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("原文区间交叉、包含或全量重复目标时整组不写;相邻区间可改", async () => {
    const original = "abcde abcde";
    const path = tempFile(original);
    for (const oldText of ["cde", "bc", "abc"]) {
      await expect(
        editTool.execute(
          {
            path,
            edits: [
              { oldText: "abc", newText: "X", replaceAll: true },
              { oldText, newText: "Y", replaceAll: true },
            ],
          },
          ctx,
        ),
      ).rejects.toThrow(/edits\[0\] and edits\[1\].*overlap/);
      expect(readFileSync(path, "utf8")).toBe(original);
    }
    await editTool.execute(
      {
        path,
        edits: [
          { oldText: "abc", newText: "X", replaceAll: true },
          { oldText: "de", newText: "Y", replaceAll: true },
        ],
      },
      ctx,
    );
    expect(readFileSync(path, "utf8")).toBe("XY XY");
  });

  it("replaceAll 只替换原文非重叠命中并保留替换字面量;没有命中仍失败", async () => {
    const path = tempFile("foo(a); foo(b);\nbar();");
    const out = await editTool.execute(
      {
        path,
        edits: [
          { oldText: "foo(", newText: "$&$`$'$$foo(", replaceAll: true },
          { oldText: "bar();", newText: "" },
        ],
      },
      ctx,
    );
    expect(out).toBe(`applied 2 edits with 3 replacements in ${path}.`);
    expect(readFileSync(path, "utf8")).toBe("$&$`$'$$foo(a); $&$`$'$$foo(b);\n");
    await expect(
      editTool.execute({ path, edits: [{ oldText: "nope", newText: "x", replaceAll: true }] }, ctx),
    ).rejects.toThrow(/edits\[0\].*not found/);
    const overlapping = tempFile("aaaaa");
    await editTool.execute(
      { path: overlapping, edits: [{ oldText: "aa", newText: "x", replaceAll: true }] },
      ctx,
    );
    expect(readFileSync(overlapping, "utf8")).toBe("xxa");
  });
});
