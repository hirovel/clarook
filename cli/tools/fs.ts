// 文件三工具:read / write / edit。内核对它们一无所知,从 CLI 层注入。
// read 的截断策略可换:默认保头,自定义策略经 createReadTool 注入。
// read 传目录即列举:目录列举工具在各家退场,并进 read 省一个工具名。
// 描述文案的写法:每条说清输出形状、硬限制、失败原因与该换哪个工具;不写行为以外的话。
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool, described } from "../../src/tools.js";
import { capLineLength, keepHead, type TruncationPolicy } from "./truncate.js";

/** 整读上限;大文件走按行流式读取,不把整个文件拉进内存。 */
export const MAX_READ_BYTES = 20 * 1024 * 1024;

/** 头部采样里出现 NUL 即视为二进制;文本文件不会有它。 */
export function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** 大文件的原文边读边记录,内存只保留所选行的可显示前缀。 */
async function readLargeRange(
  path: string,
  start: number,
  limit: number,
  maxLineChars: number,
  signal: AbortSignal,
  record?: (text: string) => void,
): Promise<{ lines: string[]; more: boolean; total?: number; clipped: boolean }> {
  const lines: string[] = [];
  let line = 1;
  let prefix = "";
  let clipped = false;
  let anyClipped = false;
  let rawLineStarted = false;
  const end = start + limit - 1;
  const beginRawLine = () => {
    if (rawLineStarted) return;
    if (lines.length > 0) record?.("\n");
    rawLineStarted = true;
  };
  const append = (part: string) => {
    if (line < start || line > end) return;
    beginRawLine();
    if (part) record?.(part);
    const room = Math.max(0, maxLineChars - prefix.length);
    prefix += part.slice(0, room);
    if (part.length > room) clipped = true;
  };
  const finish = () => {
    if (line >= start && line <= end) {
      beginRawLine();
      lines.push(clipped ? `${prefix}…[line truncated to ${maxLineChars} chars]` : prefix);
      anyClipped ||= clipped;
    }
    prefix = "";
    clipped = false;
    rawLineStarted = false;
    line++;
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    signal.throwIfAborted();
    const text = String(chunk);
    let from = 0;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", from)) {
      append(text.slice(from, at));
      finish();
      if (line > end) return { lines, more: true, clipped: anyClipped };
      from = at + 1;
    }
    append(text.slice(from));
  }
  finish(); // 与 split("\n") 一样,末尾换行后仍有一个空行。
  return { lines, more: false, total: line - 1, clipped: anyClipped };
}

export function createReadTool(
  opts: { truncate?: TruncationPolicy; maxLineChars?: number; cwd?: string } = {},
) {
  const directory = resolve(opts.cwd ?? process.cwd());
  const truncate = opts.truncate ?? keepHead();
  return defineTool({
    name: "read",
    ...described({
      core:
        "Read a text file as numbered lines, or list a directory (one entry per line; directories end with /, files show their size). " +
        "Output defaults to 2000 lines / 50 KiB; maxOutputBytes can raise the byte budget for one call. " +
        "Output past the limit is shortened; the note gives a next-line offset only when displayed lines are complete. Overlong lines can be recovered with a larger maxOutputBytes. " +
        "Text only: binary files and images are refused.",
      guidance:
        "Use offset and limit to read only the part you need, and read several files in one turn when you know which ones. " +
        "No need to read a file again right after editing it; the edit result already confirms the change.",
      rules:
        "ALWAYS read only the part you need with offset and limit. NEVER re-read a file right after editing it.",
    }),
    parameters: Type.Object({
      path: Type.String({ description: "file or directory path, relative or absolute" }),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "starting line number, 1-based" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "maximum number of lines to return" }),
      ),
      maxOutputBytes: Type.Optional(
        Type.Integer({
          minimum: 51200,
          description:
            "raise the 50 KiB output byte budget for this call; the 2000-line limit still applies",
        }),
      ),
    }),
    concurrency: "parallel",
    async execute(args, ctx) {
      const path = resolve(directory, args.path);
      const st = statSync(path);
      if (st.isDirectory()) {
        const listing = listDirectory(path);
        ctx.output?.write(listing);
        const shown = truncate(
          listing,
          args.maxOutputBytes ? { maxBytes: args.maxOutputBytes } : undefined,
        );
        return shown.truncated
          ? `${shown.text}\n[${shown.note ?? "directory listing truncated"}; use glob to narrow the list]`
          : shown.text;
      }
      const start = args.offset ?? 1;
      const limit = args.limit;
      if (
        !Number.isSafeInteger(start) ||
        start < 1 ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      ) {
        throw new Error("offset and limit must be positive integers.");
      }
      if (st.size > MAX_READ_BYTES && limit === undefined) {
        throw new Error(
          `file is ${Math.round(st.size / 1024 / 1024)} MB; specify offset and limit to read a range without loading the whole file.`,
        );
      }
      if (st.size > 0 && looksBinary(path)) {
        throw new Error(
          `${args.path} is a binary file (${st.size} bytes); read only handles text.`,
        );
      }
      const maxLineChars = Math.max(
        opts.maxLineChars ?? 2000,
        args.maxOutputBytes ? Math.floor(args.maxOutputBytes / 4) - 100 : 0,
      );
      const capLine = capLineLength(maxLineChars);
      const range =
        st.size > MAX_READ_BYTES
          ? await readLargeRange(path, start, limit as number, maxLineChars, ctx.signal, (text) =>
              ctx.output?.write(text),
            )
          : undefined;
      const allLines = range ? undefined : readFileSync(path, "utf8").split("\n");
      const slice =
        range?.lines ??
        allLines?.slice(start - 1, limit === undefined ? undefined : start - 1 + limit) ??
        [];
      if (slice.length === 0 && allLines && start > allLines.length) {
        throw new Error(
          `offset ${start} is beyond the end of the file (${allLines.length} lines).`,
        );
      }
      if (slice.length === 0 && range?.total !== undefined && start > range.total) {
        throw new Error(`offset ${start} is beyond the end of the file (${range.total} lines).`);
      }
      if (!range) ctx.output?.write(slice.join("\n"));
      const lineClipped = range?.clipped ?? slice.some((line) => line.length > maxLineChars);
      const numberedLines = slice.map((l, i) => `${start + i}\t${range ? l : capLine(l)}`);
      const numbered = numberedLines.join("\n");
      const t = truncate(
        numbered,
        args.maxOutputBytes ? { maxBytes: args.maxOutputBytes } : undefined,
      );
      const source = ctx.output?.path ? `; original selected text: ${ctx.output.path}` : "";
      const lineNote = lineClipped
        ? `\n[one or more lines shortened; raise maxOutputBytes to see more of each line${source}]`
        : "";
      if (
        !t.truncated &&
        !range?.more &&
        (allLines === undefined || start - 1 + slice.length >= allLines.length)
      )
        return t.text + lineNote;
      const shownLines = t.text.split("\n");
      const completeLines =
        !lineClipped && shownLines.every((line, i) => line === numberedLines[i]);
      const total = range?.total ?? allLines?.length;
      const next = completeLines
        ? `continue with offset=${start + shownLines.length}`
        : lineClipped
          ? `one or more selected lines are shortened; raise maxOutputBytes or read fewer lines${source}`
          : `current line is incomplete; raise maxOutputBytes or read fewer lines${source}`;
      return `${t.text}\n[${t.note ?? "more lines available"}${total === undefined ? "" : `; file has ${total} lines`}; ${next}]`;
    },
  });
}

/** 目录列举:目录在前并以 / 结尾,文件带字节数;空目录说明。 */
export function listDirectory(dir: string): string {
  const entries = readdirSync(dir)
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, dir: st.isDirectory(), size: st.size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  if (entries.length === 0) return "(empty directory)";
  return entries.map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${e.size} B`)).join("\n");
}

/** 默认实例:保头截断 —— 文件开头是结构所在。 */
export const readTool = createReadTool();

export function createWriteTool(cwd = process.cwd()) {
  const directory = resolve(cwd);
  return defineTool({
    name: "write",
    ...described({
      core: "Write a text file, replacing its contents; creates missing directories.",
      guidance:
        "For a change inside an existing file use edit; write is for new files and full rewrites. Read an existing file before overwriting it.",
      rules:
        "ALWAYS read an existing file before overwriting it. NEVER use write for a partial change to an existing file; use edit. NEVER create documentation files unless asked.",
    }),
    parameters: Type.Object({
      path: Type.String({ description: "file path" }),
      content: Type.String({ description: "complete file content" }),
    }),
    async execute(args) {
      const path = resolve(directory, args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content, "utf8");
      return `wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
    },
  });
}

export const writeTool = createWriteTool();

export function createEditTool(cwd = process.cwd()) {
  const directory = resolve(cwd);
  return defineTool({
    name: "edit",
    ...described({
      core:
        "Replace text in a file. oldText must match the file exactly, indentation included, and occur exactly once unless replaceAll is set. " +
        "Uniform CRLF files also accept LF in oldText. No match or several matches fail with the reason.",
      guidance:
        "Keep oldText as short as it can be while still unique. Set replaceAll to change every occurrence, e.g. for a rename. " +
        "Read the file in this session before editing it.",
      rules:
        "You MUST read the file in this session before editing it. oldText MUST match exactly and MUST occur exactly once unless replaceAll is set.",
    }),
    parameters: Type.Object({
      path: Type.String({ description: "file path" }),
      oldText: Type.String({ description: "text to replace; must be unique unless replaceAll" }),
      newText: Type.String({ description: "replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "replace every occurrence" })),
    }),
    async execute(args) {
      const path = resolve(directory, args.path);
      // 编辑会重写文件;解码失败时拒绝修改,避免把未知字节变成替换字符。
      const bytes = readFileSync(path);
      if (bytes.includes(0)) {
        throw new Error(`${args.path} contains NUL bytes; edit only handles UTF-8 text.`);
      }
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error(`${args.path} is not valid UTF-8 text; edit refused without writing.`);
      }
      // 仅对统一 CRLF 文件归一化。混合换行按原文匹配,保留未触及的行。
      const crlf = raw.includes("\r\n") && !raw.replaceAll("\r\n", "").includes("\n");
      const content = crlf ? raw.replaceAll("\r\n", "\n") : raw;
      const oldText = crlf ? args.oldText.replaceAll("\r\n", "\n") : args.oldText;
      const newText = crlf ? args.newText.replaceAll("\r\n", "\n") : args.newText;
      if (!oldText) throw new Error("oldText must not be empty.");
      const count = content.split(oldText).length - 1;
      if (args.replaceAll && count > 0) {
        const all = content.replaceAll(oldText, () => newText);
        if (all === content)
          throw new Error("replacement is identical to the original; nothing written.");
        writeFileSync(path, crlf ? all.replaceAll("\n", "\r\n") : all, "utf8");
        return `replaced ${count} occurrences in ${args.path}.`;
      }
      if (count > 1) {
        throw new Error(
          `oldText occurs ${count} times in ${args.path}, not unique. Provide more context, or set replaceAll to change every occurrence.`,
        );
      }
      if (count === 0) {
        throw new Error(`oldText not found in ${args.path}; read the file first to confirm it.`);
      }
      const next = content.replace(oldText, () => newText);
      if (next === content)
        throw new Error("replacement is identical to the original; nothing written.");
      writeFileSync(path, crlf ? next.replaceAll("\n", "\r\n") : next, "utf8");
      return `replaced one occurrence in ${args.path}.`;
    },
  });
}

export const editTool = createEditTool();
