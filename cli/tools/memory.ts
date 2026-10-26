// 跨会话记忆:载体是通用标准 AGENTS.md 里一个由工具写入的节,别的工具也能读。
// 写入只走显式 remember 工具;读取在会话开始随项目指令进系统提示词(--memory 打开时);
// 预算硬上限,超限报错不静默截断。没有隐藏目录,没有向量库。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";

export const MEMORY_HEADING = "## Memory (written by agent)";
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 8 * 1024;
export const MEMORY_KINDS = ["preference", "correction", "project-fact", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 把文件拆成"人写的部分"与"记忆节正文"(不含标题)。记忆节从标题起到下一个二级标题或文件尾。 */
export function splitMemory(content: string): { rest: string; memory: string | undefined } {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === MEMORY_HEADING);
  if (start < 0) return { rest: content, memory: undefined };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const memory = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  return { rest, memory: memory || undefined };
}

/** 记忆条目:记忆节里以 "- " 开头的行。 */
export function memoryEntries(content: string): string[] {
  const { memory } = splitMemory(content);
  if (!memory) return [];
  return memory
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

function readOrEmpty(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function writeWithMemory(file: string, rest: string, entries: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const block =
    entries.length > 0 ? `${MEMORY_HEADING}\n${entries.map((e) => `- ${e}`).join("\n")}\n` : "";
  const head = rest.trim();
  writeFileSync(file, `${head ? `${head}\n\n` : ""}${block}`, "utf8");
}

/** 追加一条记忆;超预算就抛错,由调用方(模型)先精简。 */
export function appendMemory(
  file: string,
  kind: MemoryKind,
  text: string,
  now = new Date(),
): { entries: number } {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  if (!oneLine) throw new Error("memory text is empty");
  const { rest } = splitMemory(readOrEmpty(file));
  const entries = memoryEntries(readOrEmpty(file));
  const next = [...entries, `[${kind}] ${now.toISOString().slice(0, 10)} ${oneLine}`];
  const bytes = Buffer.byteLength(next.join("\n"), "utf8");
  if (next.length > MEMORY_MAX_LINES || bytes > MEMORY_MAX_BYTES) {
    throw new Error(
      `memory is full (${MEMORY_MAX_LINES} entries / ${MEMORY_MAX_BYTES} bytes); trim with /memory forget first. Currently ${entries.length} entries.`,
    );
  }
  writeWithMemory(file, rest, next);
  return { entries: next.length };
}

/** 删除第 n 条(从 1 起),返回被删的内容。 */
export function forgetMemory(file: string, n: number): string {
  const content = readOrEmpty(file);
  const entries = memoryEntries(content);
  const target = entries[n - 1];
  if (target === undefined) throw new Error(`no memory entry ${n} (${entries.length} total)`);
  writeWithMemory(
    file,
    splitMemory(content).rest,
    entries.filter((_, i) => i !== n - 1),
  );
  return target;
}

export function clearMemory(file: string): number {
  const content = readOrEmpty(file);
  const count = memoryEntries(content).length;
  if (count > 0) writeWithMemory(file, splitMemory(content).rest, []);
  return count;
}

export type MemoryFiles = {
  /** 项目级:git 根(或 cwd)下的 AGENTS.md。 */
  project?: string;
  /** 用户级:~/.clarook/AGENTS.md。 */
  user: string;
};

export function createRememberTool(files: MemoryFiles) {
  const scopes = files.project ? (["project", "user"] as const) : (["user"] as const);
  return defineTool({
    name: "remember",
    description:
      "Write one thing worth remembering across sessions into the memory section of AGENTS.md (loaded with the project instructions at the start of the next session). " +
      "Record only what cannot be derived from the code and the user would want you to still know next time: user preferences, corrected practices, project facts, reference links. " +
      `One line per entry; do not record the conversation itself. Limit ${MEMORY_MAX_LINES} entries.`,
    parameters: Type.Object({
      text: Type.String({ description: "one sentence, single line" }),
      kind: Type.Union(
        MEMORY_KINDS.map((k) => Type.Literal(k)),
        { description: "preference | correction | project-fact | reference" },
      ),
      scope: Type.Optional(
        Type.Union(
          scopes.map((s) => Type.Literal(s)),
          {
            description:
              "project = this project's AGENTS.md (default); user = cross-project user-level file",
          },
        ),
      ),
    }),
    async execute(args) {
      const scope = args.scope ?? (files.project ? "project" : "user");
      const file = scope === "project" && files.project ? files.project : files.user;
      const r = appendMemory(file, args.kind, args.text);
      return `recorded in ${file} (entry ${r.entries}); takes effect at the next session.`;
    },
  });
}
