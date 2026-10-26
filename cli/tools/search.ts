// 两个工具入口共用一个可取消的 rg 进程;只在此处决定遍历范围与忽略目录。
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "@sinclair/typebox";
import { rgPath } from "@vscode/ripgrep";
import { defineTool, described } from "../../src/tools.js";
import { capLineLength } from "./truncate.js";

const SKIP_DIRS = [".git", "node_modules", "dist", "build", ".preview", "sessions"];
const SEARCH_ARGS = [
  "--hidden",
  "--no-ignore",
  ...SKIP_DIRS.flatMap((dir) => ["--glob", `!${dir}`]),
];

/** 读取 rg 的逐行输出;达到搜索边界或收到 Esc 时停止同一个子进程。 */
async function searchLines(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
): Promise<void> {
  if (signal.aborted) throw new Error("search interrupted before starting");
  const child = spawn(rgPath, [...SEARCH_ARGS, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stoppedAtLimit = false;
  let interrupted = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const closed = new Promise<number>((done, fail) => {
    child.once("error", fail);
    child.once("close", (code) => done(code ?? 2));
  });
  const onAbort = () => {
    interrupted = true;
    child.kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!onLine(line)) {
        stoppedAtLimit = true;
        child.kill();
        break;
      }
    }
    const code = await closed;
    if (interrupted) throw new Error("search interrupted");
    if (!stoppedAtLimit && code > 1)
      throw new Error(`search failed: ${stderr.trim() || `rg exited with code ${code}`}`);
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    lines.close();
  }
}

/** 只匹配整个相对路径:** 跨层级,* 留在单层,? 匹配一个字符。 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

const capLine = capLineLength(500);

export function createGrepTool(opts: { maxResults?: number } = {}) {
  const maxResults = opts.maxResults ?? 200;
  return defineTool({
    name: "grep",
    ...described({
      core:
        "Search file contents by regular expression; returns path:line:content, at most 200 results, lines cut to 500 characters. " +
        "Skips .git, node_modules and build output.",
      guidance:
        "Use it to locate text, then read for context. For match counts, context lines or advanced searches, use rg in bash.",
    }),
    parameters: Type.Object({
      pattern: Type.String({ description: "regular expression (ripgrep syntax)" }),
      path: Type.Optional(
        Type.String({ description: "directory or file to search, default current directory" }),
      ),
      glob: Type.Optional(
        Type.String({ description: "only search matching file names, e.g. *.ts or src/**/*.ts" }),
      ),
      ignoreCase: Type.Optional(Type.Boolean({ description: "case-insensitive" })),
    }),
    concurrency: "parallel",
    async execute(args, ctx) {
      const root = resolve(args.path ?? ".");
      const rootIsFile = statSync(root).isFile();
      // 用户提供的路径保留在结果中,可直接交给 read。
      const given = (args.path ?? ".").split(sep).join("/").replace(/\/+$/, "");
      const base = rootIsFile || given === "." || given === "" ? "" : given;
      const shown: string[] = [];
      let more = false;
      await searchLines(
        [
          "--line-number",
          "--with-filename",
          "--null",
          "--no-heading",
          "--color",
          "never",
          ...(args.ignoreCase ? ["--ignore-case"] : []),
          ...(args.glob ? ["--glob", args.glob] : []),
          "--regexp",
          args.pattern,
          rootIsFile ? basename(root) : ".",
        ],
        rootIsFile ? dirname(root) : root,
        ctx.signal,
        (line) => {
          const boundary = line.indexOf("\0");
          if (boundary < 0) throw new Error("search returned a result without a file path");
          const file = line.slice(0, boundary).split(sep).join("/").replace(/^\.\//, "");
          const path = rootIsFile ? given : base ? `${base}/${file}` : file;
          const result = `${path}:${line.slice(boundary + 1)}`;
          ctx.output?.write(`${result}\n`);
          if (shown.length < maxResults) shown.push(capLine(result));
          else {
            more = true;
            return false;
          }
          return true;
        },
      );
      if (shown.length === 0) return "(no matches)";
      return (
        shown.join("\n") +
        (more ? `\n[showing first ${maxResults} results; more exist; narrow the search]` : "")
      );
    },
  });
}

export const grepTool = createGrepTool();

export const globTool = defineTool({
  name: "glob",
  ...described({
    core: "List files matching a glob pattern, e.g. src/**/*.ts; returns relative paths, at most 500 in the preview, with a saved scanned-match list when more match. Skips .git, node_modules and build output.",
    guidance:
      "Use it to find files by name; use grep for contents. For advanced file queries, use rg in bash.",
  }),
  parameters: Type.Object({
    pattern: Type.String({
      description: "glob pattern: ** any depth, * one segment, ? one character",
    }),
    path: Type.Optional(
      Type.String({ description: "starting directory, default current directory" }),
    ),
  }),
  concurrency: "parallel",
  async execute(args, ctx) {
    const root = resolve(args.path ?? ".");
    if (!existsSync(root)) return "(no matches)";
    const rootIsFile = statSync(root).isFile();
    const re = globToRegExp(args.pattern);
    const files: string[] = [];
    let scanned = 0;
    let scanLimited = false;
    await searchLines(
      ["--files", rootIsFile ? basename(root) : "."],
      rootIsFile ? dirname(root) : root,
      ctx.signal,
      (line) => {
        if (scanned >= 20000) {
          scanLimited = true;
          return false;
        }
        scanned++;
        const path = line.split(sep).join("/").replace(/^\.\//, "");
        if (re.test(path)) files.push(path);
        return true;
      },
    );
    files.sort();
    if (files.length === 0)
      return scanLimited ? "(no matches in first 20000 files; scan incomplete)" : "(no matches)";
    const shown = files.slice(0, 500);
    if (files.length > 500) ctx.output?.write(files.join("\n"));
    const saved = ctx.output?.path
      ? ctx.output.ref.missingFrom === undefined
        ? `; recorded ${files.length} scanned matches: ${ctx.output.path}`
        : `; recording incomplete from byte ${ctx.output.ref.missingFrom}: ${ctx.output.path}`
      : "; narrow the pattern to see more";
    return (
      shown.join("\n") +
      (files.length > 500
        ? `\n[showing first 500 of ${files.length} scanned matches${saved}]`
        : "") +
      (scanLimited ? "\n[scan stopped at 20000 files; results may be incomplete]" : "")
    );
  },
});
