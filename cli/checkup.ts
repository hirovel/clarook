// 真实供应商跑过之后的对照:把内核发请求前的预测与供应商回来的实测摆在一起,再跑一组自动判据。
// 纯函数,输入是一份会话的事件数组(可选带上原始流旁路文件的覆盖情况),输出是表格行、判据与报告文本。
// 入口是 scripts/checkup.ts。判据里最要紧的是 A:没有编辑、丢弃或压缩时,上一次发出的整段消息必须是
// 这一次的前缀 —— 这是"内核不在最新消息之前插东西"在真实数据上的可证形态,也是缓存不被自己打断的保证。

import { estimateAfter } from "../src/compaction.js";
import type { UsageTotals } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import type { Message } from "../src/messages.js";
import { predictedCache, unchangedPrefix } from "./cards.js";
import { collectCompactions } from "./inspector-compactions.js";
import { fmtMs, fmtTok } from "./inspector-format.js";
import { collectRequests, messagesFor } from "./inspector-requests.js";
import { restoreSessionSetup } from "./session-setup.js";

export type CheckupRow = {
  n: number;
  reason: string;
  model: string;
  msgs: number;
  /** 发送前的估算:首次只估消息,后续通常以供应商用量为基准。 */
  est: number;
  /** 上一请求有用量,且模型、工具名和上下文没有切换;仅用于漂移启发式。 */
  comparable: boolean;
  /** 供应商实测。 */
  inTok: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  out: number | undefined;
  /** 未变消息前缀的粗估,不含工具定义,不是供应商缓存命中的上限。 */
  predicted: number;
  /** 未变前缀的消息条数,与上一次发出的条数。 */
  keep: number;
  prevLen: number;
  /** 这一请求之前发生过编辑、丢弃或压缩:前缀本来就该断。 */
  changedBefore: boolean;
  latencyMs: number | undefined;
  retries: number;
  stop: string | undefined;
  error: string | undefined;
  /** 现在从日志重投出来的条数;与请求事件记的条数不同就说明日志重建不出当时发的东西。 */
  rebuilt: number;
  /** 随请求发出的工具名,逗号相接;估算差额按它分组。 */
  tools: string;
};

export type Check = {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
};

export type Checkup = {
  rows: CheckupRow[];
  checks: Check[];
  models: string[];
  requests: number;
  compactions: number;
  toolCalls: number;
  /** 会话跨越的分钟数。 */
  minutes: number;
};

export type ResponseCoverage = { lines: number; requests: number[] };

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export function analyze(events: readonly AgentEvent[], recording?: ResponseCoverage): Checkup {
  const records = collectRequests(events);
  const compactions = collectCompactions(events);
  const rows: CheckupRow[] = [];
  let lastSent: Message[] | undefined;
  for (const rec of records) {
    const previous = records[rec.n - 2];
    const messages = messagesFor(events, rec);
    const keep = unchangedPrefix(lastSent, messages);
    // 新图片的供应商视觉用量无法由本地文字估算推得;下一轮已有实测基准,仍可比较。
    const newImage = messages.slice(keep).some((m) => m.role === "user" && m.images?.length);
    const usage = rec.response?.usage ?? rec.compaction?.usage;
    // 策略自己发的请求(摘要)不是纯投影:请求事件记了差异部分,按它重建。
    const rebuilt = messages.length;
    rows.push({
      n: rec.n,
      reason: rec.request.reason,
      model: rec.request.model,
      msgs: rec.request.messages,
      est: rec.request.estimatedTokens,
      comparable: Boolean(
        previous?.response?.usage &&
          previous.request.reason === "turn" &&
          rec.request.reason === "turn" &&
          !previous.request.body &&
          !rec.request.body &&
          previous.request.model === rec.request.model &&
          JSON.stringify(previous.request.tools) === JSON.stringify(rec.request.tools) &&
          !newImage &&
          !rec.before.some(
            (e) =>
              e.type === "compaction" ||
              e.type === "context/edit" ||
              e.type === "context/drop" ||
              e.type === "session/model" ||
              e.type === "session/slot",
          ),
      ),
      inTok: usage?.inputTokens,
      cacheRead: usage?.cacheReadTokens,
      cacheWrite: usage?.cacheWriteTokens,
      out: usage?.outputTokens,
      predicted: lastSent ? predictedCache(lastSent, messages, keep) : 0,
      keep,
      prevLen: lastSent?.length ?? 0,
      changedBefore: rec.before.some(
        (e) => e.type === "context/edit" || e.type === "context/drop" || e.type === "compaction",
      ),
      latencyMs: rec.response?.latencyMs ?? rec.compaction?.latencyMs,
      retries: rec.retries.length,
      stop: rec.response?.stopReason,
      error: rec.error ? `${rec.error.kind ?? ""} ${rec.error.status ?? ""}`.trim() : undefined,
      rebuilt,
      tools: rec.request.tools.join(","),
    });
    // 与界面同一条规则:摘要请求不更新"上一次发出的消息"。
    if (rec.request.reason !== "compaction") lastSent = messages;
  }

  const checks: Check[] = [];
  const add = (id: string, title: string, status: Check["status"], detail: string) =>
    checks.push({ id, title, status, detail });

  // A 前缀不变量:没有编辑、丢弃或压缩时,上一次发出的整段消息必须是这一次的前缀。
  {
    const eligible = rows.filter((r) => r.prevLen > 0 && !r.changedBefore && r.reason === "turn");
    const broken = eligible.filter((r) => r.keep < r.prevLen);
    add(
      "A",
      "prefix invariant: nothing is inserted before the newest message",
      eligible.length === 0 ? "skip" : broken.length === 0 ? "pass" : "fail",
      eligible.length === 0
        ? "no consecutive plain turns to compare"
        : broken.length === 0
          ? `${eligible.length} turns kept the whole previous body as their prefix`
          : `requests ${broken.map((r) => `#${r.n} (kept ${r.keep} of ${r.prevLen})`).join(", ")} recomputed without an edit, drop or compaction`,
    );
  }

  // B 日志能重建发出去的东西:请求事件记的消息条数,必须等于现在从日志重投出来的条数。
  {
    const off = rows.filter((r) => r.rebuilt !== r.msgs);
    add(
      "B",
      "request message counts match log reconstruction",
      rows.length === 0 ? "skip" : off.length === 0 ? "pass" : "fail",
      rows.length === 0
        ? "no requests"
        : off.length === 0
          ? `${rows.length} requests rebuild to the same message count they were sent with`
          : `requests ${off.map((r) => `#${r.n} (sent ${r.msgs}, rebuilds to ${r.rebuilt})`).join(", ")} cannot be rebuilt from the log`,
    );
  }

  // C 仅比较已有用量基准的连续普通请求。差额是启发式信号,不是请求丢失的证明。
  {
    const groups = new Map<string, CheckupRow[]>();
    for (const r of rows) {
      if (r.inTok === undefined || !r.comparable) continue;
      const key = JSON.stringify([r.model, r.tools]);
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const outliers: string[] = [];
    const notes: string[] = [];
    let judged = 0;
    for (const g of groups.values()) {
      const tools = g[0]?.tools ?? "";
      const m = median(g.map((r) => (r.inTok as number) - r.est));
      if (g.length < 3) {
        notes.push(
          `${g.length} request${g.length === 1 ? "" : "s"} with ${tools.split(",").filter(Boolean).length} tools: gap ≈${fmtTok(Math.round(m))} (too few to judge)`,
        );
        continue;
      }
      const count = tools.split(",").filter(Boolean).length;
      judged += g.length;
      notes.push(
        `${g.length} comparable requests (${g[0]?.model}, ${count} tool names): gap ≈${fmtTok(Math.round(m))}`,
      );
      for (const r of g) {
        const gap = (r.inTok as number) - r.est;
        if (Math.abs(gap - m) > Math.max(500, Math.abs(m) * 0.3)) {
          outliers.push(`#${r.n} (gap ${fmtTok(gap)} vs ≈${fmtTok(Math.round(m))})`);
        }
      }
    }
    add(
      "C",
      "token estimate drift: heuristic for comparable requests",
      judged === 0 ? "skip" : outliers.length === 0 ? "pass" : "fail",
      `${notes.join(" · ") || "no comparable usage"} · ${rows.filter((r) => !r.comparable || r.inTok === undefined).length} excluded (initial, changed, custom, new image or missing usage)${outliers.length > 0 ? ` · off: ${outliers.join(", ")}` : ""}`,
    );
  }

  // D 工具定义和供应商格式也参与缓存;消息粗估不能当缓存上限,只核对用量自身的一致性。
  {
    const reported = rows.filter((r) => r.cacheRead !== undefined && r.inTok !== undefined);
    const invalid = reported.filter(
      (r) =>
        !Number.isFinite(r.cacheRead) ||
        (r.cacheRead as number) < 0 ||
        (r.cacheRead as number) > (r.inTok as number),
    );
    const hits = reported.filter((r) => (r.cacheRead as number) > 0);
    add(
      "D",
      "reported cache reads are within measured input",
      reported.length === 0 ? "skip" : invalid.length ? "fail" : "pass",
      reported.length === 0
        ? "no paired cache-read and input usage reported"
        : invalid.length > 0
          ? `requests ${invalid.map((r) => `#${r.n}`).join(", ")} have invalid cache-read usage`
          : `${hits.length} of ${reported.length} requests report cache hits; message-prefix estimates exclude tools and provider formatting, and do not guarantee hits`,
    );
  }

  // E 在压缩事件的两侧用同一投影口径比较;相邻请求之间可能新增大量工具结果。
  {
    const pairs = compactions.map((cmp) => {
      const prefix = events.slice(0, cmp.index);
      const before = estimateAfter(prefix);
      const after = estimateAfter(events.slice(0, cmp.index + 1));
      if (after < before) return { before, after, status: "pass", note: "" };
      // 不能用今天的默认值推断旧会话的决定；摘要增长与框架故障分开。
      const acceptance = restoreSessionSetup(prefix, {}).setup.values.compactionAcceptance;
      if (!cmp.event.summary?.trim() || acceptance === "smaller" || acceptance === "reduced")
        return { before, after, status: "fail", note: " (no drop)" };
      return acceptance === "complete"
        ? { before, after, status: "pass", note: " (no drop; complete permits this)" }
        : { before, after, status: "skip", note: " (no drop; application condition not recorded)" };
    });
    add(
      "E",
      "compaction growth matches its recorded application condition",
      pairs.some((p) => p.status === "fail")
        ? "fail"
        : pairs.length === 0 || pairs.some((p) => p.status === "skip")
          ? "skip"
          : "pass",
      pairs.length === 0
        ? "no compaction"
        : pairs.map((p) => `${fmtTok(p.before)} → ${fmtTok(p.after)}${p.note}`).join(" · "),
    );
  }

  // F 失败之后是否出现过成功请求;不把会话结束当成恢复。
  {
    const failed = rows.filter((r) => r.error);
    const unrecovered = failed.filter((r) => !rows.some((x) => x.n > r.n && x.stop && !x.error));
    add(
      "F",
      "failed requests have a later successful request",
      failed.length === 0 ? "skip" : unrecovered.length === 0 ? "pass" : "fail",
      failed.length === 0
        ? "no request failed"
        : `${failed.length} failed (${[...new Set(failed.map((r) => r.error))].join(", ")})${unrecovered.length > 0 ? `, ${unrecovered.map((r) => `#${r.n}`).join(", ")} never recovered` : ""}`,
    );
  }

  // G 只报告错误率信号,不能单凭结果推断是模型、参数还是执行环境导致。
  const toolResults = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool/result" }> => e.type === "tool/result",
  );
  {
    const rate =
      toolResults.length === 0
        ? 0
        : toolResults.filter((e) => e.isError).length / toolResults.length;
    const byTool = new Map<string, { n: number; bad: number; ms: number[] }>();
    for (const e of toolResults) {
      const b = byTool.get(e.name) ?? { n: 0, bad: 0, ms: [] };
      b.n += 1;
      if (e.isError) b.bad += 1;
      if (e.durationMs !== undefined) b.ms.push(e.durationMs);
      byTool.set(e.name, b);
    }
    add(
      "G",
      "tool-result error rate is at most 30% (heuristic)",
      toolResults.length === 0 ? "skip" : rate <= 0.3 ? "pass" : "fail",
      toolResults.length === 0
        ? "no tool was called"
        : [...byTool]
            .map(
              ([name, b]) =>
                `${name} ${b.n}${b.bad > 0 ? ` (${b.bad} failed)` : ""}${b.ms.length > 0 ? ` ${fmtMs(Math.round(median(b.ms)))}` : ""}`,
            )
            .join(" · "),
    );
  }

  // H 没有思考文本不等于丢失。只查明确的全文记录矛盾,接收日志不能证明实际线路回传。
  {
    const assistants = events.filter(
      (e): e is Extract<AgentEvent, { type: "assistant/message" }> =>
        e.type === "assistant/message",
    );
    const full = assistants.filter((e) => e.reasoningKind === "full");
    const missing = full.filter((e) => !e.reasoning && (e.usage?.reasoningTokens ?? 0) > 0);
    const recorded = full.filter((e) => e.reasoning);
    const zero = assistants.filter((e) => !e.reasoning && e.usage?.reasoningTokens === 0);
    add(
      "H",
      "full-thinking records agree with explicit reasoning usage",
      missing.length ? "fail" : recorded.length + zero.length ? "pass" : "skip",
      `${recorded.length} full-text replies recorded · ${zero.length} explicitly report zero thinking · ${missing.length} full-thinking replies report tokens but lack text · other replies are unverifiable; outbound thinking is not verified by this log`,
    );
  }

  // I 原始响应:会话附件 是否覆盖每次请求。
  const traced = new Set(recording?.requests);
  const covered = records.filter((r) => traced.has(r.index)).length;
  add(
    "I",
    "raw stream recorded",
    recording === undefined ? "skip" : covered === records.length ? "pass" : "fail",
    recording === undefined
      ? "no recorded HTTP responses found; older sessions or custom providers may lack captures"
      : `${recording.lines} lines covering ${covered} of ${records.length} requests`,
  );

  const firstAt = events[0]?.at;
  const lastAt = events.at(-1)?.at;
  return {
    rows,
    checks,
    models: [...new Set(rows.map((r) => r.model))],
    requests: records.length,
    compactions: compactions.length,
    toolCalls: toolResults.length,
    minutes:
      firstAt && lastAt ? (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 60000 : 0,
  };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padEnd = (s: string | number, n: number) => String(s).padEnd(n);

/** 报告文本。不带颜色:这份输出是要贴回对话里看的。 */
export function reportLines(
  file: string,
  eventCount: number,
  c: Checkup,
  totals: UsageTotals,
): string[] {
  const out: string[] = [
    "",
    file,
    `${eventCount} events · ${c.requests} requests · ${c.compactions} compactions · ${c.toolCalls} tool calls · ${c.models.join(", ")} · ${c.minutes.toFixed(1)} min`,
    `${fmtTok(totals.inputTokens)} in (${fmtTok(totals.cacheReadTokens)} cached${totals.cacheWriteTokens > 0 ? `, ${fmtTok(totals.cacheWriteTokens)} written` : ""}) · ${fmtTok(totals.outputTokens)} out`,
    "",
    "  #  reason          msgs    est  measured    gap   cache (prefix ≈)   out  latency  stop",
    `  ${"─".repeat(88)}`,
  ];
  for (const r of c.rows) {
    const gap = r.inTok === undefined ? "—" : fmtTok(r.inTok - r.est);
    const cache =
      r.cacheRead === undefined
        ? `— (${fmtTok(r.predicted)})`
        : `${fmtTok(r.cacheRead)} (${fmtTok(r.predicted)})`;
    const prefix = r.prevLen > 0 && r.keep < r.prevLen ? `  prefix ${r.keep}/${r.prevLen}` : "";
    out.push(
      `  ${pad(r.n, 2)}  ${padEnd(r.reason, 14)} ${pad(r.msgs, 4)} ${pad(fmtTok(r.est), 6)} ${pad(r.inTok === undefined ? "—" : fmtTok(r.inTok), 9)} ${pad(gap, 6)} ${pad(cache, 19)} ${pad(r.out === undefined ? "—" : fmtTok(r.out), 4)} ${pad(fmtMs(r.latencyMs), 8)}  ${r.error ? `✗ ${r.error}` : (r.stop ?? "—")}${r.retries > 0 ? `  retries ${r.retries}` : ""}${prefix}`,
    );
  }
  out.push(
    "",
    "  est: initial message estimate or usage-based estimate; prefix ≈ excludes tools and provider formatting.",
    "",
  );
  for (const k of c.checks) {
    out.push(
      `  ${k.status === "pass" ? "PASS" : k.status === "fail" ? "FAIL" : "····"}  ${k.id}  ${k.title}`,
    );
    out.push(`        ${k.detail}`);
  }
  const failed = c.checks.filter((k) => k.status === "fail").length;
  out.push(
    "",
    `${c.checks.filter((k) => k.status === "pass").length} passed · ${failed} failed · ${c.checks.filter((k) => k.status === "skip").length} skipped (not applicable or insufficient evidence)`,
    "",
  );
  return out;
}
