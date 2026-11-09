// 上下文工作台(Ctrl+E)的行:屏上这一列就是下一次请求的正文,按发送顺序。
// 系统提示词与工具定义是前两行;摘要后面折一行"被覆盖的消息";被丢弃的消息淡显在原位;
// 上次请求相同前缀到哪一条,就在那条下面画一条线,改动发生在线上方时线上移变金。
// 全部是纯函数:输入是事件、上次发出的消息、工具定义;没有自己的状态,每次事件到达重画一遍。
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  estimateTokens,
  eventTokens,
  messageTokens,
  toolDefinitionTokens,
} from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import { compactionState, editState, type Message } from "../src/messages.js";
import type { Provider, ToolDef } from "../src/provider.js";
import { systemAt, systemParts } from "../src/system-prompt.js";
import { firstLine } from "./cards.js";
import {
  type ChangeStatus,
  compareInputs,
  type InputComparison,
  type InputSnapshot,
  requestSnapshot,
  textDifferenceLabel,
} from "./input-comparison.js";
import { compactionChanges, compactionSourceLines } from "./inspector-compactions.js";
import { type CompositionRow, compositionRows } from "./inspector-composition.js";
import { eventSummary } from "./inspector-events.js";
import { fmtTok } from "./inspector-format.js";
import { SECTION_LABELS } from "./prompt.js";
import { c, G, selectedText } from "./theme.js";

export type WorkbenchRow =
  | { kind: "system"; row: CompositionRow; tok: number; sections: string[]; edited: boolean }
  | { kind: "tools"; count: number; names: string[]; tok: number; change?: ChangeStatus }
  | { kind: "message"; row: CompositionRow; tok: number }
  | { kind: "covered"; from: number; upTo: number; count: number; tok: number; summary: number }
  | { kind: "dropped"; event: number; tok: number; by: number | undefined; role: string }
  | { kind: "records"; from: number; upTo: number; tok: 0 }
  | {
      kind: "prefix";
      /** 相同前缀的最后一条消息的事件号;undefined = 没有相同前缀。 */
      through: number | undefined;
      tok: number;
      /** 上次发过的前缀断了(编辑、丢弃、压缩)。 */
      broken: boolean;
      /** 断在哪:"the edit at #20"。 */
      reason?: string;
    };

export type Workbench = {
  rows: WorkbenchRow[];
  /** 已知消息文本与当前工具声明的粗估;媒体、私有回传物与协议封装未计入。 */
  total: number;
  /** 相同前缀的估算 token(上次前缀里未变的部分)。 */
  prefixTokens: number | undefined;
  /** 前缀断了。 */
  broken: boolean;
  /** 最新一次 request 事件的下标;之后的消息还没发过。 */
  lastRequest: number;
  comparison: InputComparison | undefined;
};

export type WorkbenchInput = {
  events: readonly AgentEvent[];
  provider?: Provider | undefined;
  /** 随请求发出的工具定义。 */
  tools: ToolDef[] | undefined;
  /** 上一次正常请求发出的消息;没有就不画缓存线。 */
  lastSent?: Message[] | undefined;
  previous?: InputSnapshot | undefined;
};

/** 段名的短写:登记的段用键名,自定义的原样。 */
export function shortSection(name: string): string {
  const hit = (Object.entries(SECTION_LABELS) as [string, string][]).find(([, v]) => v === name);
  return hit ? hit[0] : name;
}

export function workbench(input: WorkbenchInput): Workbench {
  const { events } = input;
  const tools = input.tools ?? [];
  const { rows: crows, omitted } = compositionRows(events, input.provider);
  const messages = crows.map((r) => r.message);
  const lastNormalRequest = events.reduce(
    (last, event, index) =>
      event.type === "request" && event.reason !== "compaction" ? index : last,
    -1,
  );
  const previous =
    input.previous ??
    (input.lastSent
      ? {
          ...requestSnapshot(events, lastNormalRequest),
          messages: input.lastSent,
        }
      : undefined);
  const comparison = previous
    ? compareInputs(previous, {
        origin: "current-candidate",
        messages,
        system: systemAt(events),
        tools: input.tools,
        model: input.provider?.model,
      })
    : undefined;
  const keep = comparison?.text.sameMessages;
  const state = compactionState(events);
  const ed = editState(events);
  const sections = systemParts(systemAt(events))
    .filter((section) => section.enabled)
    .map((section) => shortSection(section.name));
  const lastRequest = events.reduce((last, e, i) => (e.type === "request" ? i : last), -1);
  const droppedBy = new Map<number, number>();
  events.forEach((e, i) => {
    if (e.type === "context/drop") droppedBy.set(e.target, i);
  });
  const dropped = omitted
    .filter((o) => o.reason === "dropped")
    .map((o) => o.event)
    .sort((a, b) => a - b);
  const covered = omitted.filter((o) => o.reason === "covered");
  const rows: WorkbenchRow[] = [];
  let prefixTokens = 0;
  let total = 0;
  let broken = false;
  let changeReason: string | undefined;
  const pushDropped = (before: number) => {
    while (dropped.length > 0 && (dropped[0] as number) < before) {
      const event = dropped.shift() as number;
      const e = events[event];
      rows.push({
        kind: "dropped",
        event,
        tok: e ? eventTokens(e) : 0,
        by: droppedBy.get(event),
        role: e?.type === "user/message" ? "user" : "assistant",
      });
    }
  };
  const pushCache = (k: number) => {
    if (keep === undefined || k !== keep) return;
    const through = k > 0 ? crows[k - 1]?.event : undefined;
    const next = crows[k];
    const lastLen = previous?.messages.length ?? 0;
    broken = k < lastLen;
    if (broken && next) {
      const what = next.stages.some((s) => s.startsWith("edited"))
        ? "the edit"
        : next.stages.some((s) => s.startsWith("summary"))
          ? "the summary"
          : next.stages.includes("cleared")
            ? "the cleared result"
            : "the change";
      changeReason = `${what} at #${next.event}`;
    }
    rows.push({
      kind: "prefix",
      through,
      tok: prefixTokens,
      broken,
      ...(changeReason && { reason: changeReason }),
    });
  };
  crows.forEach((r, k) => {
    pushDropped(r.event);
    const tok = messageTokens(r.message);
    total += tok;
    if (keep !== undefined && k < keep) prefixTokens += tok;
    if (k === 0 && r.message.role === "system") {
      rows.push({
        kind: "system",
        row: r,
        tok,
        sections,
        edited: ed.edits.has(r.event),
      });
      if (input.tools) {
        const ttok = toolDefinitionTokens(tools);
        total += ttok;
        rows.push({
          kind: "tools",
          count: tools.length,
          names: tools.map((t) => t.name),
          tok: ttok,
          ...(comparison && { change: comparison.tools }),
        });
      }
    } else rows.push({ kind: "message", row: r, tok });
    if (r.stages.some((s) => s.startsWith("summary")) && covered.length > 0) {
      const before = compactionChanges(events, r.event);
      rows.push({
        kind: "covered",
        from: state.coversFrom,
        upTo: state.coversUpTo,
        count: before.covered.length,
        tok: before.coveredTokens,
        summary: r.event,
      });
    }
    pushCache(k + 1);
  });
  pushDropped(Number.MAX_SAFE_INTEGER);
  if (keep === 0) {
    broken = (previous?.messages.length ?? 0) > 0;
    rows.unshift({ kind: "prefix", through: undefined, tok: 0, broken });
  }
  return {
    rows: withRecords(
      events,
      rows,
      covered.map((o) => o.event),
    ),
    total,
    prefixTokens: keep === undefined ? undefined : prefixTokens,
    broken,
    lastRequest,
    comparison,
  };
}

/** 用原事件时间定位折叠记录,不假设压缩后的消息仍按事件下标排序。 */
function withRecords(
  events: readonly AgentEvent[],
  rows: WorkbenchRow[],
  covered: number[],
): WorkbenchRow[] {
  const anchors = new Map<number, WorkbenchRow>();
  for (const r of rows) {
    if (r.kind === "system" || r.kind === "message") anchors.set(r.row.event, r);
    else if (r.kind === "dropped") anchors.set(r.event, r);
  }
  const shown = new Set([...anchors.keys(), ...covered]);
  const groups = new Map<WorkbenchRow | undefined, WorkbenchRow[]>();
  let anchor: WorkbenchRow | undefined;
  for (let i = 0; i < events.length; ) {
    if (shown.has(i)) {
      anchor = anchors.get(i) ?? anchor;
      i++;
      continue;
    }
    const from = i;
    while (i < events.length && !shown.has(i)) i++;
    const group = groups.get(anchor) ?? [];
    group.push({ kind: "records", from, upTo: i, tok: 0 });
    groups.set(anchor, group);
  }
  const out = [...(groups.get(undefined) ?? [])];
  let source: WorkbenchRow | undefined;
  rows.forEach((r, i) => {
    out.push(r);
    if (r.kind === "message" || r.kind === "system" || r.kind === "dropped") source = r;
    const next = rows[i + 1];
    // 提示词的工具定义、摘要原文和前缀线保持挨着原消息。
    if (next?.kind === "tools" || next?.kind === "covered" || next?.kind === "prefix") return;
    if (source) out.push(...(groups.get(source) ?? []));
    source = undefined;
  });
  return out;
}

/** 光标能停的行。 */
export function selectable(r: WorkbenchRow): boolean {
  return r.kind !== "prefix";
}

function roleOf(m: Message): string {
  switch (m.role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "result";
  }
}

/** 一行的记号、角色词、预览、淡色与否。 */
function describe(
  events: readonly AgentEvent[],
  r: WorkbenchRow,
): { sign: string; role: string; text: string; faint: boolean; gold?: boolean } {
  switch (r.kind) {
    case "system":
      return {
        sign: r.edited ? G.edited : "·",
        role: "system",
        text: r.sections.length > 0 ? r.sections.join(" · ") : firstLine(r.row.message.content, 70),
        faint: false,
        ...(r.edited && { gold: true }),
      };
    case "tools":
      return {
        sign: "·",
        role: "tools",
        text: `${r.count} definition${r.count === 1 ? "" : "s"}${r.change ? ` · ${r.change === "same" ? "unchanged" : r.change}` : ""}  ${r.names.join(" ")}`,
        faint: false,
        ...(r.change === "changed" && { gold: true }),
      };
    case "covered":
      return {
        sign: G.compact,
        role: "",
        text: `#${r.from}–#${r.upTo - 1}  ${r.count} message${r.count === 1 ? "" : "s"} · ${fmtTok(r.tok)} → summary · Enter shows them`,
        faint: true,
      };
    case "dropped":
      return {
        sign: "–",
        role: r.role,
        text: `dropped${r.by !== undefined ? ` by #${r.by}` : ""} · was ${fmtTok(r.tok)} tok`,
        faint: true,
      };
    case "prefix":
    case "records":
      return { sign: "", role: "", text: "", faint: true };
    case "message": {
      const m = r.row.message;
      const edited = r.row.stages.some((s) => s.startsWith("edited"));
      if (r.row.stages.some((s) => s.startsWith("summary")))
        return {
          sign: G.compact,
          role: "summary",
          text: summaryPreview(m.content),
          faint: false,
          gold: true,
        };
      if (m.role === "tool") {
        const src = events[r.row.event];
        if (r.row.stages.includes("unknown-result"))
          return {
            sign: G.ask,
            role: "unknown",
            text: `${m.name} · no recorded result`,
            faint: false,
            gold: true,
          };
        if (r.row.stages.includes("cleared")) {
          const was = src?.type === "tool/result" ? eventTokens(src) : 0;
          return {
            sign: "·",
            role: "result",
            text: `${m.name} · cleared to save context · was ${fmtTok(was)}`,
            faint: true,
          };
        }
        const lines = m.content.split("\n").length;
        return {
          sign: edited ? G.edited : G.body,
          role: "result",
          text: m.isError
            ? `${G.err} ${m.name} · ${firstLine(m.content, 60)}`
            : `${m.name} · ${lines} line${lines === 1 ? "" : "s"}`,
          faint: false,
          ...(edited && { gold: true }),
        };
      }
      if (m.role === "assistant") {
        const calls = m.toolCalls.map((t) => t.name).join(" ");
        const text = m.content
          ? `${firstLine(m.content, 60)}${calls ? `  ${G.call} ${calls}` : ""}`
          : `${G.call} ${calls}`;
        return {
          sign: edited ? G.edited : m.content ? " " : G.call,
          role: "assistant",
          text,
          faint: false,
          ...(edited && { gold: true }),
        };
      }
      return {
        sign: edited ? G.edited : m.role === "user" ? G.you : "·",
        role: roleOf(m),
        text: firstLine(m.content, 80),
        faint: false,
        ...(edited && { gold: true }),
      };
    }
  }
}

const BAR = 10;
const FIXED_WIDTH = 2 + 2 + 6 + 11 + 1 + 6 + 2 + BAR;

/** 表头与内容共用列宽,窄屏仍能看见数字的含义。 */
export function workbenchHeader(width: number): string {
  const previewWidth = Math.max(10, width - FIXED_WIDTH);
  return `    ${"Event".padEnd(6)}${"Content".padEnd(11 + previewWidth + 1)}${"≈tok".padStart(5)}  Relative`;
}

/** 摘要的预览:跳过开头的方括号提示行,取正文第一行。 */
function summaryPreview(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("["));
  return line ? firstLine(line, 80) : firstLine(content, 80);
}

/** 一行:光标、记号、事件号、角色、预览、token、尺。prefix 行是一条线。 */
export function workbenchLine(
  events: readonly AgentEvent[],
  r: WorkbenchRow,
  opts: { selected: boolean; width: number; maxTok: number },
): string {
  const { selected, width } = opts;
  if (r.kind === "records") {
    const range = r.upTo === r.from + 1 ? `#${r.from}` : `#${r.from}–#${r.upTo - 1}`;
    const count = r.upTo - r.from;
    const text = `⋯ ${range} · ${count} log record${count === 1 ? "" : "s"} · Enter inspect`;
    return `${selected ? selectedText(G.cursor) : " "}   ${(selected ? selectedText : c.faint)(truncateToWidth(text, width - 4, "…"))}`;
  }
  if (r.kind === "prefix") {
    const text = r.broken
      ? `same prefix through ${r.through === undefined ? "nothing" : `#${r.through}`} · text ≈${fmtTok(r.tok)}${r.reason ? ` · ${r.reason} changes text below` : ""}`
      : `same prefix through #${r.through ?? 0} vs previous input · text ≈${fmtTok(r.tok)}`;
    const side = Math.max(2, Math.floor((width - text.length - 2) / 2));
    const line = `${"┈".repeat(side)} ${text} ${"┈".repeat(Math.max(2, width - side - text.length - 2))}`;
    return (r.broken ? c.jin : c.faint)(truncateToWidth(line, width, "…"));
  }
  const d = describe(events, r);
  const cursor = selected ? selectedText(G.cursor) : " ";
  const tok = r.kind === "covered" ? "" : String(r.tok);
  const bar =
    r.kind === "covered" || r.tok === 0
      ? ""
      : "▮".repeat(
          Math.min(BAR, Math.max(1, Math.round((r.tok / Math.max(1, opts.maxTok)) * BAR))),
        );
  const num =
    r.kind === "message" || r.kind === "system"
      ? `#${r.row.event}`
      : r.kind === "dropped"
        ? `#${r.event}`
        : "";
  const previewWidth = Math.max(10, width - FIXED_WIDTH);
  const body = `${num.padEnd(5)} ${d.role.padEnd(10)} ${truncateToWidth(d.text, previewWidth, "…", true)} ${tok.padStart(5)}  ${bar}`;
  const sign = d.gold ? c.jin(d.sign) : d.faint ? c.faint(d.sign) : c.soft(d.sign);
  const tone = selected ? selectedText(body) : d.faint ? c.faint(body) : c.soft(body);
  return `${cursor} ${sign.padEnd(1)} ${tone}`;
}

/** 底部预览区:选中行的来历一行加正文开头几行。 */
export function previewLines(
  events: readonly AgentEvent[],
  wb: Workbench,
  r: WorkbenchRow,
  opts: { width: number; lines: number; busy?: string | undefined },
): string[] {
  const head = (who: string, meta: string) => `${c.soft(who)}  ${c.faint(meta)}`;
  const body = (text: string) =>
    text
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, opts.lines)
      .map((l) => c.soft(`  ${truncateToWidth(l, opts.width - 2, "…")}`));
  const out: string[] = [];
  switch (r.kind) {
    case "records":
      out.push(head(`Events #${r.from}–#${r.upTo - 1}`, "log records · not in current input"));
      for (let i = r.from; i < Math.min(r.upTo, r.from + opts.lines); i++)
        out.push(c.soft(`  #${i} ${eventSummary(events, i).text}`));
      break;
    case "system": {
      const secs = r.sections.length;
      out.push(
        head(
          `#${r.row.event} system`,
          `${secs > 0 ? `${secs} section${secs === 1 ? "" : "s"} · ` : ""}≈${r.tok} tok${r.edited ? ` · ${c.jin("edited")}` : ""} · Enter shows the sections${secs > 0 ? " and flips one for this session" : ""}`,
        ),
      );
      const difference = wb.comparison?.text.first;
      if (difference && r.row.message.role === "system" && difference.message === r.row.i - 1)
        out.push(c.jin(`  System text: ${textDifferenceLabel(difference)}`));
      out.push(...body(r.row.message.content));
      break;
    }
    case "tools":
      out.push(
        head(
          "tools",
          `${r.count} definition${r.count === 1 ? "" : "s"} · ≈${r.tok} tok in candidate · ${r.change === "same" ? "unchanged" : (r.change ?? "not compared")} · Enter opens /tools`,
        ),
      );
      out.push(...body(r.names.join("  ")));
      break;
    case "covered":
      out.push(
        head(
          `#${r.from}–#${r.upTo - 1}`,
          `${r.count} messages · ≈${fmtTok(r.tok)} tok replaced by the summary #${r.summary} · originals kept · Enter shows them`,
        ),
      );
      break;
    case "dropped": {
      const e = events[r.event];
      out.push(
        head(
          `#${r.event} ${r.role}`,
          `dropped${r.by !== undefined ? ` by event #${r.by}` : ""} · was ${r.tok} tok · the original stays in the event`,
        ),
      );
      if (e?.type === "user/message" || e?.type === "assistant/message") out.push(...body(e.text));
      break;
    }
    case "message": {
      const m = r.row.message;
      const meta: string[] = [];
      const src = events[r.row.event];
      const edits = r.row.stages.filter((s) => s.startsWith("edited"));
      if (edits.length > 0) {
        const orig =
          src?.type === "assistant/message"
            ? estimateTokens(src.text)
            : src?.type === "user/message"
              ? estimateTokens(src.text)
              : src?.type === "tool/result"
                ? estimateTokens(src.content)
                : 0;
        meta.push(
          c.jin(
            `${edits.map((s) => s.replace("edited:", "edited ")).join(" ")} · original ${orig} tok`,
          ),
        );
      }
      if (m.role === "assistant" && m.reasoning)
        meta.push(`thinking ${m.reasoningKind ?? "?"} ${estimateTokens(m.reasoning)} tok`);
      if (r.row.stages.some((s) => s.startsWith("summary"))) meta.push("written by the compaction");
      if (r.row.stages.includes("cleared"))
        meta.push("placeholder · the original stays in the event");
      if (r.row.event > wb.lastRequest) meta.push("not sent yet");
      meta.push(`≈${r.tok} tok`);
      meta.push(
        r.row.wire === undefined
          ? "position unknown"
          : r.row.wire < 0
            ? "top-level field"
            : `projected messages[${r.row.wire}]`,
      );
      if (src) meta.push(`from event ${src.type}`);
      out.push(head(`#${r.row.event} ${roleOf(m)}`, meta.join(" · ")));
      if (m.role === "assistant" && !m.content && m.toolCalls.length > 0)
        out.push(
          ...m.toolCalls.map((t) =>
            c.soft(
              `  ${G.call} ${t.name}  ${truncateToWidth(JSON.stringify(t.args), opts.width - 12, "…")}`,
            ),
          ),
        );
      else out.push(...body(m.content));
      if (m.role === "assistant" && m.content && m.toolCalls.length > 0)
        out.push(c.soft(`  ${G.call} ${m.toolCalls.map((t) => t.name).join("  ")}`));
      break;
    }
    case "prefix":
      break;
  }
  if (opts.busy) out.splice(1, 0, c.zhu(`  ${opts.busy}`));
  return out.slice(0, opts.lines + 2);
}

/** 与独立压缩页使用同一份发生前投影,不把原事件误作当时有效输入。 */
export function coveredLines(
  events: readonly AgentEvent[],
  r: Extract<WorkbenchRow, { kind: "covered" }>,
): string[] {
  const out: string[] = [
    c.faint(
      `${r.count} effective messages (≈${fmtTok(r.tok)} text tok) were replaced by summary #${r.summary}. Raw originals remain in Events; Ctrl+R → compactions compares input and summary.`,
    ),
    "",
  ];
  out.push(...compactionSourceLines(compactionChanges(events, r.summary).covered));
  return out;
}
