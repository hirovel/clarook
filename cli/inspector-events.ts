// 事件视图:同一条流,每种事件一句人读的话。类型词退到淡色一列,右侧一列写这件事现在在模型眼里的状态
// (sent · kernel · covered · cleared · dropped · edited);request 是章节,前面空一行。
// 筛选是数字页签;详情先给按字段排版的一页,JSON 在第二页,第三页写它在投影里后来怎么了。全部纯函数。
import { join } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { estimateTokens, eventTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import {
  CLEARED_PLACEHOLDER,
  compactionState,
  composeContext,
  editState,
  isProjected,
} from "../src/messages.js";
import type { Provider } from "../src/provider.js";
import { directoryAt } from "../src/session-directory.js";
import { systemParts, systemText } from "../src/system-prompt.js";
import { compactionDecisionText } from "./cards.js";
import { renderExtEvent } from "./ext-events.js";
import { clock, firstLine, fmtMs, fmtTok, indent, pctOf } from "./inspector-format.js";
import { c, G, selectedText } from "./theme.js";

export const EVENT_FILTERS = ["all", "conversation", "kernel", "changes", "extensions"] as const;
export type EventFilter = 1 | 2 | 3 | 4 | 5;

const CONVERSATION = new Set([
  "user/message",
  "assistant/message",
  "tool/result",
  "tool/unresolved",
  "session/start",
  "session/directory",
]);
const KERNEL = new Set([
  "tool/arguments",
  "request",
  "request/error",
  "retry",
  "decision",
  "session/slot",
  "session/model",
  "session/directory",
  "session/interrupt",
  "session/recovered",
  "tools/snapshot",
]);
const CHANGES = new Set([
  "context/edit",
  "context/drop",
  "compaction",
  "tools/snapshot",
  "session/directory",
]);

export function eventPasses(e: AgentEvent, filter: EventFilter): boolean {
  switch (filter) {
    case 1:
      return true;
    case 2:
      return CONVERSATION.has(e.type);
    case 3:
      return KERNEL.has(e.type);
    case 4:
      return CHANGES.has(e.type);
    case 5:
      return e.type === "ext/event";
  }
}

/** 通过筛选的事件下标。 */
export function filteredIndices(events: readonly AgentEvent[], filter: EventFilter): number[] {
  const out: number[] = [];
  events.forEach((e, i) => {
    if (eventPasses(e, filter)) out.push(i);
  });
  return out;
}

export const EVENT_SECTIONS = ["view", "json", "projection"] as const;
export type EventSection = 1 | 2 | 3;

/** 这条事件现在在模型眼里的状态。 */
export function modelSees(
  events: readonly AgentEvent[],
  i: number,
): { text: string; changed: boolean } {
  const e = events[i];
  if (!e) return { text: "", changed: false };
  if (!isProjected(e)) return { text: "kernel", changed: false };
  const ed = editState(events);
  const state = compactionState(events);
  if (ed.dropped.has(i)) return { text: "dropped", changed: true };
  if (e.type === "tool/unresolved" && !composeContext(events).provenance.some((p) => p.event === i))
    return { text: "not in context", changed: true };
  if (e.type === "tool/result" && state.cleared.has(i)) return { text: "cleared", changed: true };
  const covered =
    e.type === "session/directory"
      ? composeContext(events).omitted.some((item) => item.event === i && item.reason === "covered")
      : state.summary && i >= state.coversFrom && i < state.coversUpTo;
  if (covered) return { text: "covered", changed: true };
  if (ed.edits.has(i))
    return { text: `edited ${Object.keys(ed.edits.get(i) ?? {}).join(" ")}`, changed: true };
  const lastRequest = events.reduce((last, x, k) => (x.type === "request" ? k : last), -1);
  if (i > lastRequest && e.type !== "session/start")
    return { text: "not sent yet", changed: false };
  return { text: "sent", changed: false };
}

/** 一句人读的话与记号。 */
export function eventSummary(
  events: readonly AgentEvent[],
  i: number,
): { sign: string; text: string; tok: number | undefined } {
  const e = events[i] as AgentEvent;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  switch (e.type) {
    case "session/directory":
      return {
        sign: G.note,
        text: `session directory · ${e.cwd}${e === directoryAt(events) ? " · current" : " · historical"}`,
        tok: eventTokens(e),
      };
    case "session/start":
      return {
        sign: G.note,
        text: `system prompt · ${e.model} · ${systemParts(e.system).length} sections`,
        tok: eventTokens(e),
      };
    case "user/message":
      return { sign: G.you, text: firstLine(e.text) || "(empty)", tok: eventTokens(e) };
    case "user/shell":
      return {
        sign: G.you,
        text: `User shell · ${e.excludeFromContext ? "Local only" : "Included in next context"} · ${e.status}: ${firstLine(e.command)}`,
        tok: e.excludeFromContext ? undefined : eventTokens(e),
      };
    case "assistant/message": {
      const calls = e.toolCalls.map((t) => t.name).join(" ");
      const parts: string[] = [];
      // 没有正文时记号列已经是 »,正文里不再重复一个。
      if (e.text) {
        parts.push(firstLine(e.text));
        if (calls) parts.push(`${G.call} ${calls}`);
      } else if (calls) parts.push(calls);
      if (e.reasoning) parts.push(`thinking ${estimateTokens(e.reasoning)}`);
      if (e.stopReason === "aborted") parts.push("interrupted");
      if (e.stopReason === "length") parts.push("cut by the output limit");
      return {
        sign: e.text ? " " : G.call,
        text: parts.join(" · ") || "(empty)",
        tok: eventTokens(e),
      };
    }
    case "tool/arguments":
      return {
        sign: G.note,
        text: `${e.name} · prepared arguments · call from #${e.callEvent} · execution not implied`,
        tok: undefined,
      };
    case "tool/result": {
      const lines = e.content.split("\n").length;
      const size =
        e.content === CLEARED_PLACEHOLDER
          ? "placeholder"
          : e.content.length >= 1000
            ? `${fmtTok(e.content.length)} chars`
            : `${plural(lines, "line")}`;
      return {
        sign: G.body,
        text: `${e.outcome === "unknown" ? "?" : e.isError ? G.err : G.ok} ${e.name} · ${e.isError ? firstLine(e.content) : size}${e.durationMs !== undefined ? ` · ${fmtMs(e.durationMs)}` : ""}`,
        tok: eventTokens(e),
      };
    }
    case "tools/snapshot":
      return {
        sign: G.note,
        text: `tool definitions · ${plural(e.tools.length, "tool")}${e.tools.length ? ` · ${e.tools.map((tool) => tool.name).join(" ")}` : ""}`,
        tok: undefined,
      };
    case "request": {
      // 类型列已经写着 request,正常步不再重复一遍;只有压缩与溢出重发要点名。
      const kind =
        e.reason === "compaction"
          ? "summary request · "
          : e.reason === "overflow-retry"
            ? "overflow retry · "
            : "";
      const next = events
        .slice(i + 1)
        .find((x) => x.type === "assistant/message" || x.type === "request");
      const resp = next?.type === "assistant/message" ? next : undefined;
      const u = resp?.usage;
      const cache =
        u?.cacheReadTokens !== undefined && u.inputTokens > 0
          ? ` · cache ${pctOf(u.cacheReadTokens, u.inputTokens)}`
          : "";
      return {
        sign: "→",
        text: `${kind}${e.model} · ${plural(e.messages, "msg")} · ≈${fmtTok(e.estimatedTokens)} tok${cache}${resp?.latencyMs !== undefined ? ` · ${fmtMs(resp.latencyMs)}` : ""}${e.effort ? ` · effort ${e.effort}` : ""}`,
        tok: undefined,
      };
    }
    case "retry":
      return {
        sign: "↻",
        text: `${e.status ?? ""} ${firstLine(e.error)} · waited ${fmtMs(e.delayMs)} · attempt ${e.attempt}`.trim(),
        tok: undefined,
      };
    case "request/error":
      return {
        sign: G.err,
        text: `${e.status ?? ""} ${e.kind ?? ""} · ${firstLine(e.provider ?? e.error)}`
          .replace(/\s+/g, " ")
          .trim(),
        tok: undefined,
      };
    case "compaction": {
      const parts: string[] = [e.strategy ?? "compaction"];
      if (e.summary && e.coversUpTo !== undefined) {
        const from = e.coversFrom ?? 1;
        const n = events.slice(from, e.coversUpTo).filter(isProjected).length;
        const stok = estimateTokens(e.summary);
        parts.push(
          `#${from}–#${e.coversUpTo - 1} (${plural(n, "message")}${e.tokensBefore !== undefined ? `, ${fmtTok(e.tokensBefore)} tok` : ""}) → summary ${stok} tok${e.tokensBefore ? ` · ${pctOf(stok, e.tokensBefore)}` : ""}`,
        );
      }
      if (e.cleared && e.cleared.length > 0)
        parts.push(`cleared ${plural(e.cleared.length, "result")}`);
      return {
        sign: G.compact,
        text: parts.join(" · "),
        tok: e.summary ? estimateTokens(e.summary) : undefined,
      };
    }
    case "context/edit": {
      const t = events[e.target];
      const before =
        e.field === "reasoning" && t?.type === "assistant/message"
          ? estimateTokens(t.reasoning ?? "")
          : t?.type === "assistant/message"
            ? estimateTokens(t.text)
            : t?.type === "user/message"
              ? estimateTokens(t.text)
              : t?.type === "user/shell"
                ? eventTokens(t)
                : t?.type === "tool/result"
                  ? estimateTokens(t.content)
                  : t?.type === "session/start"
                    ? estimateTokens(systemText(t.system))
                    : 0;
      return {
        sign: G.edited,
        text: `#${e.target}.${e.field} · ${before} → ${estimateTokens(e.field === "system" ? systemText(e.value) : e.value)} tok${e.note ? ` · ${e.note}` : ""}`,
        tok: undefined,
      };
    }
    case "context/drop": {
      const t = events[e.target];
      const who =
        t?.type === "user/message"
          ? "user"
          : t?.type === "assistant/message"
            ? "assistant"
            : (t?.type ?? "");
      return {
        sign: "–",
        text: `dropped #${e.target} ${who}${e.note ? ` · ${e.note}` : ""}`,
        tok: undefined,
      };
    }
    case "decision": {
      let text: string;
      switch (e.slot) {
        case "steering":
          text = `steering · ${plural(e.injected, "queued message")} injected at the ${e.boundary} boundary`;
          break;
        case "termination":
          text = `stopped after ${plural(e.steps, "step")} · ${e.reason}`;
          break;
        case "plan":
          text =
            e.reason === "compacted"
              ? "plan restated after the compaction"
              : `plan restated · ${e.steps} steps without an update`;
          break;
        case "facts":
          text = "date changed · one line appended";
          break;
        case "execution":
          text = `${e.parallel} tool calls ran in parallel · ${e.tools.join(" ")}`;
          break;
        case "compaction":
          text = compactionDecisionText(e);
          break;
      }
      return { sign: G.ask, text, tok: undefined };
    }
    case "session/slot":
      return { sign: "⚙", text: `${e.slot} → ${e.value}`, tok: undefined };
    case "session/model":
      return { sign: "⚙", text: `model → ${e.model}`, tok: undefined };
    case "session/interrupt":
      return { sign: G.err, text: "interrupted (Esc)", tok: undefined };
    case "session/exit":
      return { sign: G.ask, text: `force exit requested · ${e.phase}`, tok: undefined };
    case "tool/unresolved":
      return {
        sign: G.ask,
        text: `${e.name} · result unknown · call from #${e.callEvent}`,
        tok: eventTokens(e),
      };
    case "session/recovered":
      return {
        sign: G.ask,
        text: `recovered · ${e.droppedBytes} half-written bytes dropped`,
        tok: undefined,
      };
    case "ext/event": {
      const r = renderExtEvent(e);
      return {
        sign: "⋯",
        text: r ? r.text.replace(/^[◇·]\s*/, "") : `${e.source} · ${e.kind}`,
        tok: undefined,
      };
    }
  }
}

/** 一行:下标、时间、类型、一句话、token、模型眼里的状态。 */
export function eventLine(
  events: readonly AgentEvent[],
  i: number,
  opts: { selected: boolean; width: number },
): string {
  const e = events[i] as AgentEvent;
  const s = eventSummary(events, i);
  const sees = modelSees(events, i);
  const cursor = opts.selected ? selectedText(G.cursor) : " ";
  // request 是章节:靠上面的空行与正文色区分,不靠缩进 —— 缩进会把右边每一列都错开。
  const isRequest = e.type === "request";
  const fixed = 2 + 6 + 10 + 17 + 2 + 6 + 2 + 13;
  const w = Math.max(10, opts.width - fixed);
  // 第四个参数按显示宽度补齐:宽字符(中日韩)一个字占两列,按码元补会把右边的列顶歪。
  const what = truncateToWidth(`${s.sign} ${s.text}`, w, "…", true);
  const body = `${`#${i}`.padEnd(5)} ${clock(e.at)}  ${e.type.padEnd(16)} ${what} ${(s.tok === undefined ? "" : String(s.tok)).padStart(5)}`;
  const seesText = sees.changed ? c.jin(sees.text) : c.faint(sees.text);
  const tone = opts.selected
    ? selectedText(body)
    : isRequest
      ? c.ink(body)
      : isProjected(e)
        ? c.soft(body)
        : c.faint(body);
  return `${cursor}   ${tone}  ${seesText}`;
}

/** 详情第一页:按字段排版。 */
export function eventViewLines(
  events: readonly AgentEvent[],
  i: number,
  recordingDirectory?: string,
): string[] {
  const e = events[i] as AgentEvent;
  const row = (k: string, v: string) => `${c.soft(k.padEnd(12))} ${c.ink(v)}`;
  const block = (title: string, text: string, tone: (s: string) => string = c.soft) => [
    "",
    c.bold(c.soft(title)),
    ...indent(text).map(tone),
  ];
  const out: string[] = [];
  switch (e.type) {
    case "session/directory":
      out.push(row("directory", e.cwd));
      out.push(row("binding", e === directoryAt(events) ? "current" : "historical"));
      out.push(row("source", "session/directory · read-only · /session directory to change"));
      out.push(...block("environment", e.environment));
      break;
    case "session/start":
      out.push(row("model", e.model));
      for (const section of systemParts(e.system)) {
        out.push(
          row(
            "section",
            `${section.name} [${section.id}] · ${section.enabled ? "on" : "off"}${section.source ? ` · ${section.source}` : ""}`,
          ),
        );
        out.push(...block("system prompt", section.text));
      }
      break;
    case "user/message":
      out.push(row("tokens", `≈${eventTokens(e)}`));
      out.push(...block("content", e.text));
      break;
    case "assistant/message":
      out.push(row("stop", e.stopReason));
      if (e.usage)
        out.push(
          row(
            "usage",
            `in ${e.usage.inputTokens}${e.usage.cacheReadTokens !== undefined ? ` (cache ${e.usage.cacheReadTokens})` : ""} · out ${e.usage.outputTokens}${e.usage.reasoningTokens !== undefined ? ` (thinking ${e.usage.reasoningTokens})` : ""}`,
          ),
        );
      if (e.latencyMs !== undefined) out.push(row("latency", fmtMs(e.latencyMs)));
      if (e.reasoning)
        out.push(
          ...block(`thinking (${e.reasoningKind ?? "?"})`, e.reasoning, (s) =>
            c.faint(c.italic(s)),
          ),
        );
      out.push(...block("content", e.text || "(empty)"));
      if (e.toolCalls.length > 0)
        out.push(
          ...block(
            `tool calls ${e.toolCalls.length}`,
            e.toolCalls
              .map((t) => `${G.call} ${t.name} ${JSON.stringify(t.args)}  ${t.id}`)
              .join("\n"),
          ),
        );
      if (e.opaque !== undefined)
        out.push(
          "",
          c.faint(
            `opaque: ${(e.opaque as { kind?: string }).kind ?? "?"} · saved provider data; replay depends on input eligibility`,
          ),
        );
      if (e.extras) out.push(...block("extras", JSON.stringify(e.extras, null, 2), c.faint));
      break;
    case "tool/arguments":
      out.push(row("tool", `${e.name} · ${e.callId} · call event #${e.callEvent}`));
      out.push(row("state", "prepared for approval; execution not implied"));
      out.push(...block("prepared arguments", JSON.stringify(e.args, null, 2)));
      break;
    case "tool/result":
      out.push(
        row(
          "tool",
          `${e.name} · ${e.outcome === "unknown" ? "result unknown" : e.isError ? "error" : "ok"}${e.durationMs !== undefined ? ` · ${fmtMs(e.durationMs)}` : ""}`,
        ),
      );
      out.push(row("call", e.callId));
      out.push(row("size", `${e.content.length} chars · ≈${eventTokens(e)} tok`));
      out.push(...block("content", e.content));
      break;
    case "tools/snapshot":
      out.push(row("tools", e.tools.map((tool) => tool.name).join(" ") || "(none)"));
      out.push(...block("definitions", JSON.stringify(e.tools, null, 2)));
      break;
    case "request":
      out.push(row("reason", e.reason));
      out.push(row("model", e.model));
      out.push(
        row(
          "messages",
          `${e.messages} · ≈${fmtTok(e.estimatedTokens)} tok${e.threshold !== undefined ? ` · threshold ${fmtTok(e.threshold)}` : ""}`,
        ),
      );
      out.push(row("tools", e.tools.join(" ") || "(none)"));
      if (e.effort) out.push(row("effort", e.effort));
      if (e.body)
        out.push(
          row(
            "body",
            `the projection of the first ${e.body.prefixEvents} events plus ${e.body.tail.length} strategy messages`,
          ),
        );
      out.push(
        "",
        c.faint("the full body is in Ctrl+R → the request's sent and wire JSON sections"),
      );
      break;
    case "retry":
      out.push(row("attempt", String(e.attempt)));
      out.push(row("waited", fmtMs(e.delayMs)));
      out.push(row("status", String(e.status ?? "")));
      out.push(...block("error", e.error));
      break;
    case "request/error":
      out.push(row("kind", e.kind ?? "?"));
      out.push(row("status", String(e.status ?? "")));
      out.push(...block("error", e.error));
      if (e.provider) out.push(...block("provider said", e.provider));
      if (e.body) out.push(...block("body", e.body, c.faint));
      break;
    case "compaction": {
      out.push(row("strategy", e.strategy ?? "?"));
      if (e.summary && e.coversUpTo !== undefined) {
        const from = e.coversFrom ?? 1;
        const n = events.slice(from, e.coversUpTo).filter(isProjected).length;
        out.push(
          row(
            "covers",
            `#${from} – #${e.coversUpTo - 1} · ${n} messages${e.tokensBefore !== undefined ? ` · ≈${fmtTok(e.tokensBefore)} tok` : ""}`,
          ),
        );
        out.push(
          row(
            "summary",
            `≈${estimateTokens(e.summary)} tok${e.tokensBefore ? ` · ${pctOf(estimateTokens(e.summary), e.tokensBefore)} of the original` : ""}`,
          ),
        );
      }
      if (e.cleared && e.cleared.length > 0)
        out.push(row("cleared", e.cleared.map((k) => `#${k}`).join(" ")));
      if (e.usage)
        out.push(
          row(
            "request",
            `${e.usage.inputTokens} in · ${e.usage.outputTokens} out${e.latencyMs !== undefined ? ` · ${fmtMs(e.latencyMs)}` : ""}`,
          ),
        );
      if (e.summary) out.push(...block("summary", e.summary));
      break;
    }
    case "context/edit":
      out.push(row("target", `#${e.target} · ${events[e.target]?.type ?? "?"}`));
      out.push(row("field", e.field));
      if (e.note) out.push(row("note", e.note));
      if (e.field === "system") {
        for (const section of systemParts(e.value))
          out.push(
            ...block(
              `${section.name} [${section.id}] · ${section.enabled ? "on" : "off"}`,
              section.text,
            ),
          );
      } else out.push(...block("new value", e.value));
      break;
    case "context/drop":
      out.push(row("target", `#${e.target} · ${events[e.target]?.type ?? "?"}`));
      if (e.note) out.push(row("note", e.note));
      break;
    case "decision":
      out.push(row("slot", e.slot));
      out.push(row("what", eventSummary(events, i).text));
      break;
    case "session/slot":
      out.push(row("slot", e.slot));
      out.push(row("value", e.value));
      break;
    case "session/model":
      out.push(row("model", e.model));
      break;
    case "session/interrupt":
      out.push(
        row(
          "what",
          "the running turn was interrupted; the half-written reply, if any, is the next assistant message",
        ),
      );
      break;
    case "session/recovered":
      out.push(row("dropped", `${e.droppedBytes} bytes`));
      out.push(...block("preview", e.preview, c.faint));
      break;
    case "tool/unresolved":
      out.push(row("tool", `${e.name} · ${e.callId} · call event #${e.callEvent}`));
      out.push(...block("unknown", e.content));
      break;
    case "session/exit":
      out.push(row("action", "force exit requested"), row("phase", e.phase));
      if (e.error) out.push(...block("error", e.error));
      out.push(row("outcome", "External work may continue; this is not a completion record."));
      break;
    case "ext/event":
      out.push(row("source", e.source));
      out.push(row("kind", e.kind));
      if (e.source === "mcp" && e.kind === "rpc") {
        const ref = e.payload.bodyRef as
          | { file?: string; bytes?: number; missingFrom?: number }
          | undefined;
        if (ref?.file && /^[a-f0-9-]+\.body$/.test(ref.file) && recordingDirectory) {
          out.push(row("full body", join(recordingDirectory, ref.file)));
          if (ref.missingFrom !== undefined)
            out.push(row("recording", `incomplete after ${ref.missingFrom} bytes`));
        }
      }
      out.push(...block("payload", JSON.stringify(e.payload, null, 2), c.faint));
      break;
  }
  out.unshift(`${c.soft("at".padEnd(12))} ${c.ink(e.at)}`);
  return out;
}

/** 详情第三页:这条事件在投影里后来怎么了。 */
export function projectionLines(
  events: readonly AgentEvent[],
  i: number,
  provider?: Provider,
): string[] {
  const e = events[i] as AgentEvent;
  const out: string[] = [];
  const sees = modelSees(events, i);
  if (!isProjected(e)) {
    out.push(c.ink("This event never reaches the model."));
    if (e.type === "compaction" && e.coversUpTo !== undefined) {
      const comp = composeContext(events);
      const at = comp.provenance.findIndex((p) => p.event === i);
      out.push("");
      out.push(
        c.soft(
          `Its summary is injected at position ${at + 1} of the projection as a user message and replaces events #${e.coversFrom ?? 1} to #${e.coversUpTo - 1}.`,
        ),
      );
      if (e.cleared && e.cleared.length > 0)
        out.push(
          c.soft(
            `Tool results ${e.cleared.map((k) => `#${k}`).join(", ")} are replaced by a placeholder.`,
          ),
        );
    } else if (e.type === "context/edit") {
      out.push(
        "",
        c.soft(
          `It replaces the ${e.field} of event #${e.target} in the projection. The original stays in that event.`,
        ),
      );
      const later = events.findIndex(
        (x, k) =>
          k > i && x.type === "context/edit" && x.target === e.target && x.field === e.field,
      );
      if (later >= 0) out.push(c.faint(`Superseded by the edit at #${later}.`));
    } else if (e.type === "context/drop") {
      out.push(
        "",
        c.soft(
          `Event #${e.target} leaves the projection; a dropped assistant message takes its tool results with it.`,
        ),
      );
    } else if (e.type === "request") {
      out.push(
        "",
        c.soft(
          "Its body is the projection of every event before it; Ctrl+R rebuilds it byte for byte.",
        ),
      );
    }
    return out;
  }
  const comp = composeContext(events);
  const k = comp.provenance.findIndex((p) => p.event === i);
  out.push(`${c.soft("now".padEnd(12))} ${sees.changed ? c.jin(sees.text) : c.ink(sees.text)}`);
  if (k >= 0) {
    const wire = provider?.wireMap?.(comp.messages)?.[k];
    out.push(
      `${c.soft("position".padEnd(12))} ${c.ink(`${k + 1} of ${comp.messages.length}${wire === undefined ? "" : wire < 0 ? " · top-level field" : ` · messages[${wire}]`}`)}`,
    );
    const stages = comp.provenance[k]?.stages ?? [];
    out.push(
      `${c.soft("stages".padEnd(12))} ${c.ink(stages.length > 0 ? stages.join(" → ") : "verbatim from the event")}`,
    );
  } else {
    const ed = editState(events);
    const state = compactionState(events);
    if (ed.dropped.has(i)) {
      const by = events.findIndex((x) => x.type === "context/drop" && x.target === i);
      out.push(
        `${c.soft("since".padEnd(12))} ${c.ink(`event #${by}${(events[by] as { note?: string } | undefined)?.note ? ` · ${(events[by] as { note?: string }).note}` : ""}`)}`,
      );
    } else if (state.summary && i >= state.coversFrom && i < state.coversUpTo) {
      const comp2 = events.findIndex(
        (x) => x.type === "compaction" && x.coversUpTo === state.coversUpTo,
      );
      out.push(
        `${c.soft("since".padEnd(12))} ${c.ink(`compaction #${comp2} · replaced by its summary`)}`,
      );
    }
  }
  if (e.type === "tool/result" && compactionState(events).cleared.has(i))
    out.push(
      `${c.soft("was".padEnd(12))} ${c.ink(`≈${eventTokens(e)} tok · now a ${estimateTokens(CLEARED_PLACEHOLDER)}-token placeholder`)}`,
    );
  const edits = events
    .map((x, k2) => ({ x, k: k2 }))
    .filter(({ x }) => x.type === "context/edit" && x.target === i);
  for (const { x, k: k2 } of edits)
    if (x.type === "context/edit")
      out.push(
        `${c.soft("edit".padEnd(12))} ${c.ink(`#${k2} · ${x.field} · ${estimateTokens(x.field === "system" ? systemText(x.value) : x.value)} tok${x.note ? ` · ${x.note}` : ""}`)}`,
      );
  out.push("", c.faint("The event itself never changes; Ctrl+E shows the projection it feeds."));
  return out;
}
