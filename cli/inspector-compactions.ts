import { estimateTokens, messageTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import { composeContext, type Message, type Provenance } from "../src/messages.js";
import { clock, fmtMs, fmtTok, indent, roleLabel } from "./inspector-format.js";
import { c, G, selectedText } from "./theme.js";
import { visibleSourceText } from "./tui-format.js";

type CompactionEvent = Extract<AgentEvent, { type: "compaction" }>;

export const COMPACTION_SECTIONS = ["compare", "original", "summary", "cleared"] as const;
export type CompactionSection = 1 | 2 | 3 | 4;

// ---------- 压缩对照:哪一大段变成了什么 ----------

type CompactionSource = Provenance & { message: Message };

type CompactionChanges = {
  covered: CompactionSource[];
  coveredTokens: number;
  cleared: CompactionSource[];
  clearedTokens: number;
};

export type CompactionRecord = {
  n: number;
  /** compaction 事件的下标。 */
  index: number;
  event: CompactionEvent;
  summaryTokens: number;
};

/** 压缩发生前的有效内容;后置编辑不能改写历史对照,原事件另在 Events 阅读。 */
export function compactionChanges(events: readonly AgentEvent[], index: number): CompactionChanges {
  const event = events[index];
  const covered: CompactionSource[] = [];
  const cleared: CompactionSource[] = [];
  if (event?.type === "compaction") {
    const before = composeContext(events, index);
    // 核心可保留覆盖范围内的执行事实;阅读层只列实际被替换的来源,不复制豁免规则。
    const retained =
      event.summary === undefined
        ? undefined
        : new Set(composeContext(events, index + 1).provenance.map((source) => source.event));
    const clear = new Set(event.cleared);
    for (const [i, message] of before.messages.entries()) {
      const source = before.provenance[i];
      if (!source) continue;
      const row = { ...source, message };
      if (retained && !retained.has(source.event)) covered.push(row);
      if (message.role === "tool" && clear.has(source.event)) cleared.push(row);
    }
  }
  const tokens = (sources: CompactionSource[]) =>
    sources.reduce((n, source) => n + messageTokens(source.message), 0);
  return { covered, coveredTokens: tokens(covered), cleared, clearedTokens: tokens(cleared) };
}

/** 把每次压缩与当时被替换的有效输入配对。 */
export function collectCompactions(events: readonly AgentEvent[]): CompactionRecord[] {
  const out: CompactionRecord[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e?.type !== "compaction") continue;
    out.push({
      n: out.length + 1,
      index: i,
      event: e,
      summaryTokens: e.summary ? estimateTokens(e.summary) : 0,
    });
  }
  return out;
}

export function compactionRow(
  events: readonly AgentEvent[],
  record: CompactionRecord,
  selected: boolean,
): string {
  const rec = { ...record, ...compactionChanges(events, record.index) };
  const e = rec.event;
  const parts: string[] = [];
  if (rec.covered.length > 0) {
    const ratio =
      rec.coveredTokens > 0 ? Math.round((rec.summaryTokens / rec.coveredTokens) * 100) : 0;
    parts.push(
      `input (${rec.covered.length} messages · ${fmtTok(rec.coveredTokens)} tok) → summary ${fmtTok(rec.summaryTokens)} tok · ${ratio}%`,
    );
  }
  if (rec.cleared.length > 0) {
    parts.push(`cleared ${rec.cleared.length} tool results (${fmtTok(rec.clearedTokens)} tok)`);
  }
  const body = `${`#${rec.n}`.padEnd(4)} ${visibleSourceText(clock(e.at))}  ${visibleSourceText(e.strategy ?? "unnamed strategy")}  ${parts.join("  ")}`;
  return `${selected ? selectedText(G.cursor) : " "} ${selected ? selectedText(body) : c.soft(body)}`;
}

/** 两处压缩阅读共用有效消息的显示;控制字符可见,不交给终端执行。 */
export function compactionSourceLines(sources: readonly CompactionSource[]): string[] {
  const lines: string[] = [];
  for (const { event, message, stages } of sources) {
    lines.push(
      `${c.ink(`#${event}`)} ${c.ink(visibleSourceText(roleLabel(message)))}  ${c.soft(`${messageTokens(message)} tok`)}${stages.length ? c.faint(` · ${stages.join(" → ")}`) : ""}`,
    );
    if (message.role === "assistant" && message.reasoning)
      lines.push(...indent(visibleSourceText(message.reasoning)).map((l) => c.faint(c.italic(l))));
    lines.push(...indent(visibleSourceText(message.content)).map((l) => c.ink(l)));
    if (message.role === "assistant")
      for (const call of message.toolCalls)
        lines.push(
          c.soft(
            `    » ${visibleSourceText(call.name)} ${visibleSourceText(JSON.stringify(call.args))}`,
          ),
        );
    lines.push("");
  }
  return lines;
}

export function compactionLines(
  events: readonly AgentEvent[],
  record: CompactionRecord,
  section: CompactionSection,
): string[] {
  const rec = { ...record, ...compactionChanges(events, record.index) };
  const e = rec.event;
  switch (section) {
    case 1: {
      const row = (k: string, v: string) =>
        `${c.soft(k.padEnd(12))} ${c.ink(visibleSourceText(v))}`;
      const lines = [row("time", e.at), row("strategy", e.strategy ?? "unnamed")];
      if (rec.covered.length > 0) {
        const ratio = rec.coveredTokens > 0 ? rec.summaryTokens / rec.coveredTokens : 0;
        lines.push(
          row(
            "covers",
            `input positions #${e.coversFrom ?? 1} to #${(e.coversUpTo ?? 0) - 1}, ${rec.covered.length} messages`,
          ),
          row("original", `${rec.coveredTokens} tok`),
          row("summary", `${rec.summaryTokens} tok`),
          row("ratio", `${Math.round(ratio * 100)}% (summary / original)`),
        );
      }
      if (rec.cleared.length > 0) {
        lines.push(
          row(
            "cleared",
            `${rec.cleared.length} tool results, ${rec.clearedTokens} tok, replaced by placeholders in the projection`,
          ),
        );
      }
      if (e.tokensBefore !== undefined) lines.push(row("before", `${e.tokensBefore} tok`));
      if (e.usage)
        lines.push(
          row(
            "summary request",
            `${e.usage.inputTokens}→${e.usage.outputTokens} tok · ${fmtMs(e.latencyMs)}`,
          ),
        );
      lines.push("");
      if (rec.covered.length > 0) {
        const max = Math.max(rec.coveredTokens, rec.summaryTokens, 1);
        const bar = (n: number) => "█".repeat(Math.max(1, Math.round((n / max) * 30))).padEnd(30);
        lines.push(
          `${c.soft("original")} ${c.faint(bar(rec.coveredTokens))} ${c.faint(`${rec.coveredTokens} tok`)}`,
        );
        lines.push(
          `${c.soft("summary ")} ${c.faint(bar(rec.summaryTokens))} ${c.faint(`${rec.summaryTokens} tok`)}`,
        );
        lines.push("");
      }
      lines.push(
        c.faint(
          "Section 2 is context before this compaction, 3 summary, 4 results before clearing. Pipeline stages can change the summary request; inspect that request separately. Raw originals remain in Events.",
        ),
      );
      return lines;
    }
    case 2: {
      if (rec.covered.length === 0)
        return [
          c.faint(
            e.summary === undefined
              ? "This compaction has no summary (clear only)."
              : "No effective messages in this covered range.",
          ),
        ];
      const lines = [
        c.faint(
          `Context before this compaction: ${rec.covered.length} effective messages replaced, ${rec.coveredTokens} text tok.`,
        ),
        c.faint(
          "Pipeline stages can change the summary request; inspect that request separately. Raw originals remain in Events.",
        ),
        "",
      ];
      lines.push(...compactionSourceLines(rec.covered));
      return lines;
    }
    case 3: {
      if (e.summary === undefined) return [c.faint("This compaction has no summary.")];
      return [
        c.faint(
          `Summary, ${rec.summaryTokens} tok; enters every later request as one user message.`,
        ),
        "",
        ...indent(visibleSourceText(e.summary), "").map((l) => c.ink(l)),
      ];
    }
    case 4: {
      if (rec.cleared.length === 0) return [c.faint("This compaction cleared no tool results.")];
      const lines = [
        c.faint(
          `The ${rec.cleared.length} effective tool results before clearing, ${rec.clearedTokens} text tok. Raw originals remain in Events.`,
        ),
        "",
      ];
      lines.push(...compactionSourceLines(rec.cleared));
      return lines;
    }
  }
}
