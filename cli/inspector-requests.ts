// 请求视图:一行一请求 → 七分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入),
// 以及事件视图的行与详情。消息按请求边界重建;HTTP 正文优先读取实录,否则明确标记为当前适配器重建。
import { truncateToWidth } from "@earendil-works/pi-tui";
import { estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import {
  compactionState,
  deriveMessages,
  editState,
  isProjected,
  type Message,
} from "../src/messages.js";
import { type Provider, parseEffort, type ToolDef } from "../src/provider.js";
import { compactionDecisionText, unchangedPrefix } from "./cards.js";
import { renderExtEvent } from "./ext-events.js";
import {
  cacheUsageLines,
  clock,
  firstLine,
  fmtMs,
  fmtTok,
  indent,
  messageTokens,
  pctOf,
  roleLabel,
} from "./inspector-format.js";
import type { RequestRecording } from "./session-records.js";
import { c, G, selectedText } from "./theme.js";
import { visibleSourceText } from "./tui-format.js";

type RequestEvent = Extract<AgentEvent, { type: "request" }>;
type AssistantEvent = Extract<AgentEvent, { type: "assistant/message" }>;
type RetryEvent = Extract<AgentEvent, { type: "retry" }>;
type RequestErrorEvent = Extract<AgentEvent, { type: "request/error" }>;
type CompactionEvent = Extract<AgentEvent, { type: "compaction" }>;

export type RequestRecord = {
  /** 从 1 起的序号。 */
  n: number;
  /** request 事件在日志中的下标。请求正文 = deriveMessages(events.slice(0, index))。 */
  index: number;
  request: RequestEvent;
  response?: AssistantEvent;
  /** 本次回复后产生的工具结果;未执行的调用也有结果,不依赖原文附件。 */
  results: Extract<AgentEvent, { type: "tool/result" }>[];
  error?: RequestErrorEvent;
  /** 摘要请求(reason=compaction)的结果:随后落盘的压缩事件。 */
  compaction?: CompactionEvent;
  retries: RetryEvent[];
  /** 上一请求收尾之后、本请求发出之前发生的事:压缩、插话注入、终止、打断、切换模型。 */
  before: AgentEvent[];
};

/** 把事件流按请求切段。纯函数。 */
export function collectRequests(events: readonly AgentEvent[]): RequestRecord[] {
  const out: RequestRecord[] = [];
  let pending: AgentEvent[] = [];
  let current: RequestRecord | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    switch (e.type) {
      case "request":
        current = {
          n: out.length + 1,
          index: i,
          request: e,
          results: [],
          retries: [],
          before: pending,
        };
        pending = [];
        out.push(current);
        break;
      case "retry":
        current?.retries.push(e);
        break;
      case "request/error":
        if (current && !current.response) current.error = e;
        break;
      case "assistant/message":
        if (current && !current.response && !current.error) current.response = e;
        break;
      case "tool/result":
        current?.results.push(e);
        break;
      case "compaction":
        // 既是摘要请求的结果,也是下一请求之前发生的决定。
        if (current?.request.reason === "compaction" && !current.compaction && !current.error) {
          current.compaction = e;
        }
        pending.push(e);
        break;
      case "decision":
      case "session/interrupt":
      case "session/recovered":
      case "session/model":
      case "session/slot":
      case "context/edit":
      case "context/drop":
        pending.push(e);
        break;
      case "ext/event":
        if (renderExtEvent(e)) pending.push(e);
        break;
      default:
        break;
    }
  }
  return out;
}

export const SECTIONS = [
  "summary",
  "decisions",
  "sent",
  "tool defs",
  "wire JSON",
  "received",
  "written",
] as const;
export type Section = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// ---------- 请求列表 ----------

function listParts(rec: RequestRecord): { head: string; tail: string } {
  const head = `#${rec.n}`.padEnd(4);
  const model = rec.request.model;
  const sent = `${rec.request.messages} msgs  ≈${fmtTok(rec.request.estimatedTokens)}`;
  let tail: string;
  if (rec.response) {
    const u = rec.response.usage;
    const measured = u
      ? `→ ${fmtTok(u.inputTokens)}${u.cacheReadTokens !== undefined ? ` (cache ${fmtTok(u.cacheReadTokens)})` : ""}  +${fmtTok(u.outputTokens)}`
      : "→ no usage";
    tail = `${measured}  ${fmtMs(rec.response.latencyMs)}  ${rec.response.stopReason}`;
  } else if (rec.compaction) {
    const u = rec.compaction.usage;
    tail = `→ ${u ? `${fmtTok(u.inputTokens)}  +${fmtTok(u.outputTokens)}` : "no usage"}  ${fmtMs(rec.compaction.latencyMs)}  summary ${rec.compaction.summary?.length ?? 0} chars`;
  } else if (rec.error) {
    tail = c.zhu(`✗ ${rec.error.status ?? ""} ${firstLine(rec.error.error)}`.trim());
  } else {
    tail = rec.request.reason === "compaction" ? "… no result" : "… in progress";
  }
  const retry = rec.retries.length > 0 ? `  retries ${rec.retries.length}` : "";
  // 请求种类放在前面:一眼分出正常步、压缩摘要、溢出重发;行尾被截断也不丢这个信息。
  const kind =
    rec.request.reason === "overflow-retry"
      ? "overflow retry  "
      : rec.request.reason === "compaction"
        ? "compaction  "
        : "";
  return {
    head: `${head} ${clock(rec.request.at)}  ${model}  ${kind}${sent}`,
    tail: `${tail}${retry}`,
  };
}

export function listRow(rec: RequestRecord, selected: boolean): string {
  const { head, tail } = listParts(rec);
  const body = `${head}  ${tail}`;
  return `${selected ? selectedText(G.cursor) : " "} ${selected ? selectedText(body) : c.soft(body)}`;
}

/** 窄屏的第二行专门留给结果,避免缓存、输出和停止原因被右侧截断。 */
export function narrowListRows(rec: RequestRecord, selected: boolean): string[] {
  const { head, tail } = listParts(rec);
  const tone = selected ? selectedText : c.soft;
  return [`${selected ? selectedText(G.cursor) : " "} ${tone(head)}`, `  ${tone(tail)}`];
}

// ---------- 请求详情的七个分区 ----------

/** 只概括当前请求边界内的事实,不把工具结果冒充本次模型已经看到的内容。 */
export function exchangeLines(
  events: readonly AgentEvent[],
  rec: RequestRecord,
  messages: Message[],
  previous: Message[] | undefined,
  recording: RequestRecording | undefined,
): string[] {
  const next = events.findIndex((e, i) => i > rec.index && e.type === "request");
  const after = events.slice(rec.index + 1, next < 0 ? events.length : next);
  const unknown =
    rec.results.filter((e) => e.outcome === "unknown").length +
    after.filter((e) => e.type === "tool/unresolved").length;
  const keep = unchangedPrefix(previous, messages);
  return [
    c.bold(c.ink("Round trip")),
    c.ink(
      `Input: ${messages.length} ${recording?.input ? "saved messages" : "messages from the log"} · ${rec.request.tools.length} tools`,
    ),
    c.soft(
      previous
        ? `vs #${rec.n - 1}: ${keep}/${previous.length} previous messages kept as prefix · ${messages.length - keep} following messages`
        : "First request: no earlier input to compare",
    ),
    c.ink(
      `Response: ${rec.error ? "request failed" : rec.response ? `${rec.response.stopReason} · ${rec.response.toolCalls.length} tool calls` : rec.compaction ? "compaction result recorded" : "no result recorded yet"}`,
    ),
    c.soft(
      `After response: ${rec.results.length} tool results · ${unknown} unknown · ${next < 0 ? "no next request recorded" : `next input is #${rec.n + 1}`}`,
    ),
    ...cacheUsageLines(rec.response?.usage ?? rec.compaction?.usage).map(c.soft),
    c.faint(
      `HTTP body: ${recording?.attempts?.length ? `${recording.attempts.length} attempt(s) recorded before dispatch; open 5 to read` : "not captured; 5 shows reconstruction when possible"}`,
    ),
    c.faint(
      `HTTP responses: ${recording?.attempts?.length ? `${recording.attempts.length} attempt(s) recorded` : "not available here"}`,
    ),
    ...(recording?.error ? [c.zhu(recording.error)] : []),
    ...(recording?.attempts?.map((a) =>
      c.soft(
        `Attempt ${a.n}: ${a.status === undefined ? "no HTTP response" : `HTTP ${a.status}`} · capture ${a.state}`,
      ),
    ) ?? []),
    c.soft("3 input · 4 tools · 5 HTTP body · 6 response · 7 recorded events"),
  ];
}

export function summaryLines(rec: RequestRecord, messages: Message[]): string[] {
  const r = rec.request;
  const u = rec.response?.usage ?? rec.compaction?.usage;
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
  const row = (k: string, v: string) => `${c.soft(k.padEnd(12))} ${c.ink(v)}`;
  const REASONS = {
    turn: "turn",
    "overflow-retry": "resend after overflow compaction",
    compaction:
      "summary request from the compaction strategy (the context is sent in exchange for a summary)",
  } as const;
  const lines = [
    row("time", `${r.at}`),
    row("model", r.model),
    row("reason", REASONS[r.reason]),
    row("effort", r.effort ?? "not set (omitted; provider default)"),
    ...(r.maxTokens !== undefined
      ? [row("output limit", `${r.maxTokens} tokens (this request)`)]
      : []),
    row(
      "sent",
      `${r.messages} messages · ${r.tools.length} tools · estimated ${r.estimatedTokens} tok`,
    ),
    row(
      "estimate",
      "Last usage plus new messages when available; otherwise messages only. Current tool definitions and provider framing are excluded until the provider reports input usage.",
    ),
  ];
  if (rec.compaction?.strategy) lines.push(row("strategy", rec.compaction.strategy));
  if (r.threshold !== undefined) {
    const room = r.threshold - r.estimatedTokens;
    lines.push(
      row(
        "threshold",
        room > 0
          ? `threshold ${r.threshold}, ${room} tok to go (${pctOf(room, r.threshold)})`
          : `threshold ${r.threshold}, over by ${-room} tok; recorded compaction actions are in 2 decisions`,
      ),
    );
  }
  if (u) {
    const drift = r.estimatedTokens > 0 ? u.inputTokens / r.estimatedTokens : 0;
    lines.push(
      row(
        "measured in",
        `${u.inputTokens} tok (${Math.round(drift * 100)}% of estimate)${u.cacheReadTokens !== undefined ? ` · cache hit ${u.cacheReadTokens} tok (${pctOf(u.cacheReadTokens, u.inputTokens)})` : ""}`,
      ),
    );
    lines.push(
      row(
        "measured out",
        `${u.outputTokens} tok${u.reasoningTokens !== undefined ? ` · reasoning ${u.reasoningTokens}` : ""}`,
      ),
    );
  }
  if (rec.response) {
    lines.push(row("stop reason", rec.response.stopReason));
    lines.push(row("latency", fmtMs(rec.response.latencyMs)));
    lines.push(row("tool calls", `${rec.response.toolCalls.length}`));
  }
  if (rec.error)
    lines.push(row("failed", c.zhu(`${rec.error.status ?? ""} ${rec.error.error}`.trim())));
  lines.push(row("retries", rec.retries.length === 0 ? "none" : `${rec.retries.length}`));
  lines.push("");
  lines.push(c.soft("share by role (estimated)"));
  const byRole = new Map<string, number>();
  for (const m of messages) {
    const k = m.role === "tool" ? `tool result ${m.name}` : m.role;
    byRole.set(k, (byRole.get(k) ?? 0) + messageTokens(m));
  }
  for (const [k, v] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(Math.max(1, Math.round((v / Math.max(1, total)) * 24))).padEnd(24);
    lines.push(`${c.faint(bar)} ${pctOf(v, total).padStart(4)}  ${c.soft(`${v} tok · ${k}`)}`);
  }
  return lines;
}

export function decisionLines(rec: RequestRecord): string[] {
  const lines: string[] = [];
  const auto = rec.request.threshold;
  if (auto !== undefined) {
    lines.push(
      rec.request.estimatedTokens > auto
        ? `${c.soft("·")} recorded threshold: estimated ${rec.request.estimatedTokens} > ${auto}; above threshold`
        : `${c.faint("·")} recorded threshold: estimated ${rec.request.estimatedTokens} ≤ ${auto}; below threshold`,
    );
  } else {
    lines.push(`${c.faint("·")} no threshold recorded for this request`);
  }
  for (const e of rec.before) {
    switch (e.type) {
      case "compaction": {
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`summary covers events ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`cleared ${e.cleared.length} tool results`);
        if (e.tokensBefore !== undefined) parts.push(`${e.tokensBefore} tok before`);
        if (e.usage)
          parts.push(`summary request ${e.usage.inputTokens}→${e.usage.outputTokens} tok`);
        lines.push(
          `${c.jin("≈")} compaction${e.strategy ? ` (${e.strategy})` : ""}: ${parts.join(", ")}`,
        );
        break;
      }
      case "decision":
        lines.push(
          e.slot === "steering"
            ? `${c.soft("·")} steering injected ${e.injected} (${e.boundary} boundary)`
            : e.slot === "execution"
              ? `${c.soft("·")} parallel execution of ${e.parallel} calls: ${e.tools.join(", ")}`
              : e.slot === "plan"
                ? `${c.soft("·")} plan restated at step ${e.steps} (${e.reason === "compacted" ? "after compaction" : "not updated for a while"})`
                : e.slot === "facts"
                  ? `${c.soft("·")} fact injected: ${e.note}`
                  : e.slot === "compaction"
                    ? `${c.soft("·")} ${compactionDecisionText(e)}`
                    : `${c.soft("·")} termination stopped the loop at step ${e.steps}: ${e.reason}`,
        );
        break;
      case "session/interrupt":
        lines.push(`${c.zhu("·")} interrupted by the user`);
        break;
      case "session/recovered":
        lines.push(
          `${c.zhu("·")} recovered: dropped ${e.droppedBytes} bytes of a half-written line at the end of the log`,
        );
        break;
      case "ext/event": {
        const r = renderExtEvent(e);
        if (r) lines.push(c[r.tone](r.text));
        break;
      }
      case "session/model":
        lines.push(`${c.soft("·")} model switched to ${e.model}`);
        break;
      case "session/slot":
        lines.push(`${c.soft("·")} slot ${e.slot} → ${e.value}`);
        break;
      case "context/edit":
        lines.push(
          `${c.zhu("·")} the user edited event #${e.target}.${e.field} (${e.value.length} chars${e.note ? `; ${e.note}` : ""})`,
        );
        break;
      case "context/drop":
        lines.push(
          `${c.zhu("·")} the user dropped event #${e.target}${e.note ? ` (${e.note})` : ""}`,
        );
        break;
      default:
        break;
    }
  }
  for (const r of rec.retries) {
    lines.push(
      `${c.zhu("·")} retry ${r.attempt}: ${r.status ?? ""} ${firstLine(r.error)}, waited ${fmtMs(r.delayMs)}`,
    );
  }
  if (rec.error) lines.push(`${c.zhu("✗")} failed: ${rec.error.status ?? ""} ${rec.error.error}`);
  if (rec.response?.stopReason === "length")
    lines.push(
      `${c.soft("·")} output truncated: tool calls in this step are not executed; the model is asked to resend`,
    );
  if (rec.response?.stopReason === "aborted")
    lines.push(`${c.zhu("·")} response interrupted: the partial text is in the log`);
  lines.push("");
  lines.push(
    c.faint("Recorded decisions for this request; this is not a complete execution recording."),
  );
  return lines;
}

export type PromptSectionMeta = { name: string; source?: string; chars: number };

export function sentLines(
  messages: Message[],
  folded: boolean,
  sections?: PromptSectionMeta[],
  previous?: Message[],
  recorded = false,
): string[] {
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
  const lines: string[] = [
    c.soft(
      recorded
        ? "Saved adapter input. Actual HTTP formatting is in 5 wire JSON."
        : "Input reconstructed from recorded events. Provider formatting is shown in 5 wire JSON.",
    ),
    c.faint(
      `${messages.length} messages, estimated ${total} tok. ${folded ? "body previews" : "full bodies"}`,
    ),
    "",
  ];
  const keep = unchangedPrefix(previous, messages);
  messages.forEach((m, i) => {
    const tok = messageTokens(m);
    lines.push(
      `${c.ink(`[${i + 1}] ${roleLabel(m)}`)}  ${c.soft(`~${tok} tok · ${pctOf(tok, total)}${previous ? (i < keep ? " · unchanged prefix" : " · after prefix") : ""}`)}${m.edited ? c.jin("  ✎ edited (original in the events view)") : ""}`,
    );
    lines.push(...messageBodyLines(m, folded, sections));
    lines.push("");
  });
  return lines;
}

/** 输入正文的单一格式器;列表和文本回放共用。 */
export function messageBodyLines(
  m: Message,
  folded: boolean,
  sections?: PromptSectionMeta[],
): string[] {
  const lines: string[] = [];
  const content = visibleSourceText(m.content);
  if (m.role === "user" && m.images?.length)
    lines.push(
      ...m.images.map((image, i) =>
        c.soft(
          `Image ${i + 1}: ${visibleSourceText(image.name ?? image.mimeType)} · ${Math.floor((image.data.length * 3) / 4)} bytes · full data in HTTP JSON`,
        ),
      ),
    );
  // 系统提示词按段拆开:角色、环境、项目指令各占多少。
  if (m.role === "system" && sections && sections.length > 0) {
    lines.push(c.faint("    Initial system-section metadata (may differ after edits):"));
    const chars = sections.reduce((n, s) => n + s.chars, 0);
    for (const s of sections) {
      lines.push(
        c.faint(
          `    ├ ${visibleSourceText(s.name)}  ${Math.ceil(s.chars / 4)} tok · ${pctOf(s.chars, chars)}${s.source ? `  ${visibleSourceText(s.source)}` : ""}`,
        ),
      );
    }
  }
  if (m.role === "assistant" && m.reasoning) {
    const reasoning = visibleSourceText(m.reasoning);
    lines.push(
      c.soft(
        m.reasoningKind === "summary"
          ? "    Thinking summary (display only; provider data below carries state)"
          : "    Thinking text (adapter decides how it is sent)",
      ),
    );
    lines.push(
      ...(folded
        ? [c.faint(`    thinking ${firstLine(reasoning)}`)]
        : indent(reasoning).map((l) => c.faint(c.italic(l)))),
    );
  }
  if (m.role === "assistant" && m.opaque !== undefined) {
    const value = JSON.stringify(m.opaque, null, 2);
    lines.push(c.soft(`    Provider data · ${value.length} chars`));
    if (!folded) lines.push(...indent(visibleSourceText(value)).map((l) => c.faint(l)));
  }
  if (m.content) {
    lines.push(
      ...(folded
        ? [c.ink(`    ${truncateToWidth(firstLine(content), 120, "…")}`)]
        : indent(content).map((l) => c.ink(l))),
    );
  }
  if (m.role === "assistant") {
    for (const tc of m.toolCalls) {
      const args = visibleSourceText(JSON.stringify(tc.args));
      lines.push(
        c.soft(
          `    » ${visibleSourceText(tc.name)} ${folded ? truncateToWidth(args, 100, "…") : args}  ${c.faint(visibleSourceText(tc.id))}`,
        ),
      );
    }
  }
  return lines;
}

export function toolLines(
  defs: ToolDef[],
  names = defs.map((d) => d.name),
  recording?: RequestRecording,
): string[] {
  if (recording?.bodies.length)
    return recording.bodies.flatMap((body, i) => {
      try {
        const payload = JSON.parse(body) as { tools?: unknown };
        return [
          c.bold(c.ink(`Captured tools · HTTP attempt ${i + 1}`)),
          ...visibleSourceText(JSON.stringify(payload.tools ?? null, null, 2))
            .split("\n")
            .map((l) => c.ink(l)),
          c.faint("Provider format; complete body in 5 wire JSON."),
          "",
        ];
      } catch {
        return [c.zhu("Captured body is not readable JSON; see 5 wire JSON.")];
      }
    });
  if (names.length === 0) return [c.faint("No tool names recorded for this request.")];
  const missing = names.filter((name) => !defs.some((d) => d.name === name));
  const lines: string[] = [
    c.soft(`Recorded tool names: ${visibleSourceText(names.join(", "))}`),
    recording?.input
      ? c.soft("Definitions saved with this request's adapter input.")
      : c.jin("Historical definitions were not captured. Current definitions below may differ."),
    ...(missing.length
      ? [c.zhu(`Unavailable definitions: ${visibleSourceText(missing.join(", "))}`)]
      : []),
    c.faint(
      `${defs.length} current tool definitions, estimated ${defs.reduce((n, d) => n + estimateTokens(JSON.stringify(d)), 0)} tok.`,
    ),
    "",
  ];
  for (const d of defs) {
    lines.push(
      `${c.ink(visibleSourceText(d.name))}  ${c.soft(`${estimateTokens(JSON.stringify(d))} tok`)}`,
    );
    lines.push(
      ...indent(visibleSourceText(d.description || "(no description)")).map((l) => c.ink(l)),
    );
    lines.push(
      ...indent(visibleSourceText(JSON.stringify(d.parameters, null, 2))).map((l) => c.faint(l)),
    );
    lines.push("");
  }
  return lines;
}

export function wireLines(
  provider: Provider | undefined,
  messages: Message[],
  defs: ToolDef[],
  effort?: string,
  recording?: RequestRecording,
  missing: string[] = [],
  maxTokens?: number,
): string[] {
  const warnings = recording?.error ? [c.zhu(recording.error)] : [];
  if (recording?.bodies.length)
    return [
      c.soft("Captured before HTTP dispatch; delivery is not proven. No auth headers captured."),
      ...warnings,
      ...recording.bodies.flatMap((body, i) => {
        let json = body;
        try {
          json = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          /* 原文仍可查看。 */
        }
        return [
          "",
          c.bold(c.ink(`HTTP attempt ${i + 1} · ${body.length} chars · formatted for viewing`)),
          ...visibleSourceText(json)
            .split("\n")
            .map((l) => c.ink(l)),
        ];
      }),
    ];
  if (missing.length)
    return [
      ...warnings,
      c.zhu(`Cannot reconstruct: unavailable tool definitions: ${missing.join(", ")}`),
      c.faint("3 sent still shows messages reconstructed from the log."),
    ];
  if (!provider?.wire) {
    return [
      ...warnings,
      c.faint(
        "This provider has no wire(); the wire body cannot be rebuilt. The sent section shows the kernel projection.",
      ),
    ];
  }
  const level = effort ? parseEffort(effort) : undefined;
  const body = provider.wire(messages, defs, {
    ...(level && { effort: level }),
    ...(maxTokens !== undefined && { maxTokens }),
  });
  const json = JSON.stringify(body, null, 2);
  return [
    ...warnings,
    c.faint(`Reconstructed preview · ${json.length} chars · not a captured HTTP body.`),
    c.jin(
      "Uses available provider settings and current tool definitions; historical values may differ.",
    ),
    "",
    ...visibleSourceText(json)
      .split("\n")
      .map((l) => c.ink(l)),
  ];
}

// ---------- 请求正文重建与写入视图 ----------

/**
 * 某次请求实际发出的消息。正常步 = 请求之前全部事件的投影;
 * 策略自己发的请求(压缩摘要)记了 body:前缀投影 + 策略追加的尾部消息,同样逐字节可重建。
 */
export function messagesFor(
  events: readonly AgentEvent[],
  rec: Pick<RequestRecord, "index" | "request">,
): Message[] {
  const b = rec.request.body;
  if (b) return [...deriveMessages(events.slice(0, b.prefixEvents)), ...(b.tail as Message[])];
  return deriveMessages(events.slice(0, rec.index));
}

const SHAPES = new Set(["compaction", "context/edit", "context/drop"]);

function visibility(e: AgentEvent): string {
  if (isProjected(e)) return "model-visible";
  if (SHAPES.has(e.type)) return "shapes projection";
  return "people only";
}

function jsonLines(e: AgentEvent, pad: string): string[] {
  return visibleSourceText(JSON.stringify(e, null, 2))
    .split("\n")
    .map((l) => pad + l);
}

/** 第 7 分区:这次请求之后追加进日志的事件,原样 JSON。 */
export function writtenLines(
  events: readonly AgentEvent[],
  rec: RequestRecord,
  until: number,
): string[] {
  const lines: string[] = [
    c.faint(
      `Events appended after request #${rec.n} (indices ${rec.index + 1} to ${until - 1}), recorded JSON.`,
    ),
    "",
  ];
  if (until <= rec.index + 1) {
    lines.push(c.faint("(none yet)"));
    return lines;
  }
  for (let i = rec.index + 1; i < until; i++) {
    const e = events[i];
    if (!e) continue;
    lines.push(
      `${c.ink(`#${i}`)} ${c.ink(e.type)}  ${c.soft(`${JSON.stringify(e).length} chars · ${visibility(e)}`)}`,
    );
    lines.push(...jsonLines(e, "    ").map((l) => c.faint(l)));
    lines.push("");
  }
  return lines;
}

/** 事件视图的一行:下标、时间、类型、大小、可见性、压缩状态。 */
export function eventRow(events: readonly AgentEvent[], i: number, selected: boolean): string {
  const e = events[i];
  if (!e) return "";
  const state = compactionState(events);
  const ed = editState(events);
  let flag = "";
  if (ed.dropped.has(i)) flag = "  dropped";
  else if (ed.edits.has(i)) flag = `  edited (${Object.keys(ed.edits.get(i) ?? {}).join(",")})`;
  else if (e.type === "tool/result" && state.cleared.has(i)) flag = "  cleared → placeholder";
  else if (state.summary && i >= state.coversFrom && i < state.coversUpTo)
    flag = "  covered by summary";
  const size = JSON.stringify(e).length;
  const body = `${`#${i}`.padEnd(5)} ${clock(e.at)}  ${e.type.padEnd(18)} ${String(size).padStart(7)} chars  ${visibility(e)}${flag}`;
  const mark = selected ? selectedText(G.cursor) : " ";
  const tone = selected ? selectedText(body) : isProjected(e) ? c.soft(body) : c.faint(body);
  return `${mark} ${tone}`;
}

/** 单条事件的原样 JSON 视图。 */
export function eventLines(events: readonly AgentEvent[], i: number): string[] {
  const e = events[i];
  if (!e) return [c.faint("(no such event)")];
  const state = compactionState(events);
  const ed = editState(events);
  const notes: string[] = [visibility(e)];
  if (ed.dropped.has(i)) notes.push("dropped from the projection (original kept here)");
  else if (ed.edits.has(i)) {
    notes.push(
      `field ${Object.keys(ed.edits.get(i) ?? {}).join(",")} replaced by the edited value in the projection (original kept here; see the later context/edit event)`,
    );
  } else if (e.type === "tool/result" && state.cleared.has(i)) {
    notes.push("replaced by a placeholder in the projection (original kept here)");
  } else if (state.summary && i >= state.coversFrom && i < state.coversUpTo) {
    notes.push("replaced by the summary in the projection (original kept here)");
  }
  return [
    c.faint(`${JSON.stringify(e).length} chars · ${notes.join(" · ")}`),
    "",
    ...jsonLines(e, "").map((l) => c.ink(l)),
  ];
}
