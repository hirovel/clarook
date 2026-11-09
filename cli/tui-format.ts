// 屏幕文本的小工具:工具参数的人读形态、edit/write 的改动详情、任务简报、百分比。渲染、审批提示、编辑命令共用。
import { isAbsolute } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fileUrl, osc8 } from "./terminal-extras.js";
import { c } from "./theme.js";
import { diffLines, hunks } from "./tools/diff.js";

/** 单行设置输入保留粘贴正文,过滤终端标记和控制字符。 */
export function printableInput(data: string): string {
  return cleanPasteText(data).replace(/\p{Cc}/gu, "");
}

/** 多行粘贴保留正文;完整移除终端协议序列,不让它们进入编辑器的按键解析。 */
export function cleanPasteText(text: string): string {
  // 宽度工具只识别显示协议;编辑前还需移除按键和粘贴边界等 CSI 序列。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 清除完整 CSI 控制序列。
  const csi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  return stripTerminalSequences(text.replace(csi, "")).replace(/\p{Cc}/gu, (char) =>
    "\n\r\t".includes(char) ? char : "",
  );
}

/** 外部文本只作正文显示;终端协议不执行,原文仍由事件与实录保存。 */
export function plainDisplayText(text: string): string {
  // CRLF 是换行,单独 CR 的进度片段分行保留,不模拟覆盖或把两段正文粘在一起。
  return cleanPasteText(text).replace(/\r\n?/g, "\n");
}

/** 原文阅读保留控制字符的可见表示;LF/Tab 留给排版,精确核对仍用 JSON 或原文复制。 */
export function visibleSourceText(text: string): string {
  return text.replace(/\p{Cc}/gu, (char) =>
    "\n\t".includes(char) ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** 任务简报的一句话形态,给会话选择器与标题用。 */
export function brief(task: string): string {
  const first = plainDisplayText(task).split("\n")[0]?.trim() ?? "";
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

/** 缺省只给摘要文字;路径显示传入当时目录,未知根仅为绝对路径生成链接。 */
export function formatArgs(args: unknown, location?: { cwd: string | undefined }): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let s: string;
  if (typeof a.command === "string") s = a.command;
  else if (typeof a.path === "string") {
    const range =
      typeof a.offset === "number" || typeof a.limit === "number"
        ? `  from line ${a.offset ?? 1}${typeof a.limit === "number" ? `, ${a.limit} lines` : ""}`
        : "";
    const path = plainDisplayText(a.path);
    const shown = path.length > 120 ? `${path.slice(0, 120)}…` : path;
    const linked = location && (location.cwd !== undefined || isAbsolute(a.path));
    return `${linked ? osc8(shown, fileUrl(a.path, location.cwd ?? "")) : shown}${range}`;
  } else if (typeof a.task === "string") {
    s = `${a.scope ? `scope=${a.scope}  ` : ""}${brief(a.task)}`;
  } else if (Array.isArray(a.items)) {
    const items = a.items as { status?: string }[];
    const done = items.filter((i) => i.status === "done").length;
    s = `${items.length} step${items.length === 1 ? "" : "s"} · ${done} done`;
  } else s = JSON.stringify(args) ?? "";
  s = plainDisplayText(s);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 最多展示的改动行数;超出的折成一行计数。 */
const DETAIL_MAX_LINES = 60;

const DEL = (s: string) => c.delBg(c.zhu(s));
const ADD = (s: string) => c.addBg(c.green(s));

function detailLines(lines: string[], view: "preview" | "full"): string[] {
  if (view === "preview" && lines.length > DETAIL_MAX_LINES) {
    return [
      ...lines.slice(0, DETAIL_MAX_LINES),
      c.faint(`… ${lines.length - DETAIL_MAX_LINES} more changed lines`),
    ];
  }
  return lines;
}

/** 工具参数和上下文比较共用文本排版,不赋予文件执行语义。 */
export function textDiff(
  oldText: string,
  newText: string,
  view: "preview" | "full" = "preview",
): string[] {
  const lines = hunks(diffLines(oldText, newText)).map((line) => {
    const text = plainDisplayText(line.text);
    return line.kind === "-"
      ? DEL(`- ${text}`)
      : line.kind === "+"
        ? ADD(`+ ${text}`)
        : c.faint(`  ${text}`);
  });
  return detailLines(lines, view);
}

type EditPreviewItem = { oldText: string; newText: string; replaceAll?: unknown };

/** 只识别已记录参数的显示形态;旧顶层字段不流入工具执行。 */
export function editPreviewItems(args: unknown): EditPreviewItem[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const a = args as Record<string, unknown>;
  const isItem = (item: unknown): item is EditPreviewItem =>
    !!item &&
    typeof item === "object" &&
    "oldText" in item &&
    typeof item.oldText === "string" &&
    "newText" in item &&
    typeof item.newText === "string";
  if (Object.hasOwn(a, "edits")) {
    return Array.isArray(a.edits) && a.edits.every(isItem) ? a.edits : [];
  }
  return isItem(a) ? [a] : [];
}

/** edit → 行级 diff(- 朱字深红底 / + 绿字深绿底 / 上下文淡字无底);write → 前几行加总行数。其它工具无详情。 */
export function toolCallDetail(
  name: string,
  args: unknown,
  view: "preview" | "full" = "preview",
): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let lines: string[] = [];
  if (name === "edit") {
    const edits = editPreviewItems(args);
    if (edits.length) {
      lines = [
        c.faint("Parameter preview · not a full-file diff"),
        ...edits.flatMap((edit, i) => {
          const scope =
            edit.replaceAll === true
              ? "all occurrences requested"
              : edit.replaceAll === false || edit.replaceAll === undefined
                ? "unique match required"
                : `replaceAll=${plainDisplayText(JSON.stringify(edit.replaceAll) ?? String(edit.replaceAll))} (raw)`;
          return [
            c.faint(`Edit ${i + 1}/${edits.length} · ${scope}`),
            ...textDiff(edit.oldText, edit.newText, "full"),
          ];
        }),
      ];
    }
  } else if (name === "write" && typeof a.content === "string") {
    const all = a.content.split("\n");
    lines = (view === "full" ? all : all.slice(0, 12)).map((l) => ADD(`+ ${plainDisplayText(l)}`));
    if (view === "preview" && all.length > 12) lines.push(c.faint(`… ${all.length} lines total`));
  } else if (name === "plan" && Array.isArray(a.items)) {
    // 计划整张可见:进行中的是墨色,其余淡色。
    const MARK: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      done: "[x]",
      cancelled: "[-]",
    };
    lines = (a.items as { text?: string; status?: string }[]).map((it, i) => {
      const line = `${MARK[it.status ?? "pending"] ?? "[ ]"} ${i + 1}. ${plainDisplayText(it.text ?? "")}`;
      return it.status === "in_progress" ? c.ink(line) : c.faint(line);
    });
  }
  if (lines.length === 0) return "";
  return detailLines(lines, view).join("\n");
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
