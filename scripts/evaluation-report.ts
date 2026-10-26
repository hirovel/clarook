// 只从实验记录派生报告，不调用模型、不选择或应用配置。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Experiment, Trial } from "./evaluation.js";

export type EvaluationReport = {
  state: string;
  error?: string;
  scope: string;
  model: string;
  effort: string;
  fingerprint: string;
  trials: Trial[];
  comparisons: ReturnType<typeof compare>;
};

type Pair = { task: string; repeat: number; baseline: Trial[]; candidate: Trial[] };
type Evidence = Record<string, { label: string; path: string }[]>;
function summarize(pairs: Pair[]) {
  const valid = pairs.flatMap((p) => {
    const a = p.baseline[0],
      b = p.candidate[0];
    return p.baseline.length === 1 &&
      p.candidate.length === 1 &&
      a &&
      b &&
      a.status !== "invalid" &&
      b.status !== "invalid"
      ? [{ a, b }]
      : [];
  });
  const unusable = (p: Pair) =>
    p.baseline.length > 1 ||
    p.candidate.length > 1 ||
    [...p.baseline, ...p.candidate].some((t) => t.status === "invalid");
  const invalid = pairs.filter(unusable).length;
  const missing = pairs.filter(
    (p) => !unusable(p) && (!p.baseline.length || !p.candidate.length),
  ).length;
  const complete = pairs.length > 0 && valid.length === pairs.length;
  const telemetry =
    complete && valid.every(({ a, b }) => a.telemetryComplete && b.telemetryComplete);
  const usage = telemetry && valid.every(({ a, b }) => a.usageComplete && b.usageComplete);
  const measure = (
    key: "requests" | "elapsedMs" | "inputTokens" | "outputTokens",
    known: boolean,
  ) => {
    const baseline = known ? valid.reduce((sum, { a }) => sum + a[key], 0) : null;
    const candidate = known ? valid.reduce((sum, { b }) => sum + b[key], 0) : null;
    const delta = baseline == null || candidate == null ? null : candidate - baseline;
    return {
      baseline,
      candidate,
      delta,
      percent: delta != null && baseline ? (delta / baseline) * 100 : null,
    };
  };
  const regressions = valid
    .filter(({ a, b }) => a.status === "pass" && b.status === "fail")
    .map(({ b }) => `${b.task}/${b.repeat}`);
  const wins = valid.filter(({ a, b }) => a.status === "fail" && b.status === "pass").length;
  const bothPass = valid.filter(({ a, b }) => a.status === "pass" && b.status === "pass").length;
  const bothFail = valid.filter(({ a, b }) => a.status === "fail" && b.status === "fail").length;
  return {
    pairs: valid.length,
    expectedPairs: pairs.length,
    missing,
    invalid,
    wins,
    regressions,
    bothPass,
    bothFail,
    verdict: invalid
      ? "invalid comparison"
      : !complete
        ? "incomplete comparison"
        : regressions.length
          ? "regressions need review"
          : bothPass === pairs.length
            ? "no quality separation"
            : "human review; no universal winner",
    metrics: {
      requests: measure("requests", telemetry),
      elapsedMs: measure("elapsedMs", complete),
      inputTokens: measure("inputTokens", usage),
      outputTokens: measure("outputTokens", usage),
    },
    next: !complete
      ? "Resolve missing or invalid pairs before comparing overall changes."
      : regressions.length
        ? "Review regressions before considering adoption; aggregate gains do not cancel them."
        : bothPass === pairs.length
          ? "Both profiles passed every planned run. Keep these cases for regression; add a different failure mode before further quality tuning."
          : wins
            ? "Inspect improvements and validate on tasks not used to choose this candidate."
            : bothFail
              ? "Shared failures remain. Inspect the artifacts and traces; a tie is not evidence of adequate capability."
              : "No observed quality gain. Keep the baseline unless a practical benefit is established.",
  };
}

export function compare(trials: Trial[], spec: Experiment) {
  return spec.candidates.map(({ id: candidate }) => {
    const pairs: Pair[] = spec.tasks.flatMap((task) =>
      Array.from({ length: spec.repetitions }, (_, i) => {
        const find = (profile: string) =>
          trials.filter((t) => t.task === task.id && t.repeat === i + 1 && t.profile === profile);
        return {
          task: task.id,
          repeat: i + 1,
          baseline: find(spec.baseline.id),
          candidate: find(candidate),
        };
      }),
    );
    return {
      candidate,
      ...summarize(pairs),
      tasks: spec.tasks.map((t) => ({
        task: t.id,
        ...summarize(pairs.filter((p) => p.task === t.id)),
      })),
    };
  });
}

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const csv = (value: unknown) => {
  const raw = value == null ? "" : String(value);
  // 表格软件不能把模型文本或错误消息当成公式执行。
  const safe = /^[\s]*[=+@-]/.test(raw) && typeof value !== "number" ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};
const fmt = (value: number | null) =>
  value == null ? "unknown" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function renderReport(report: EvaluationReport, spec: Experiment, artifacts: Evidence = {}) {
  const profiles = [spec.baseline, ...spec.candidates];
  const expected = spec.tasks.length * spec.repetitions;
  const summaries = profiles.map(({ id }) => {
    const trials = report.trials.filter((t) => t.profile === id);
    const valid = trials.filter((t) => t.status !== "invalid");
    const values = valid.map((t) => t.elapsedMs / 1000);
    return {
      id,
      trials,
      valid,
      values,
      pass: trials.filter((t) => t.status === "pass").length,
      fail: trials.filter((t) => t.status === "fail").length,
      invalid: trials.filter((t) => t.status === "invalid").length,
    };
  });
  const maxTime = Math.max(1, ...summaries.flatMap((s) => s.values));
  const timeChart = summaries
    .map(
      (s, row) => `<text x="12" y="${32 + row * 40}">${escape(s.id)}</text>
    <line x1="120" x2="500" y1="${28 + row * 40}" y2="${28 + row * 40}" stroke="#344555"/>
    ${s.values.map((v, i) => `<circle cx="${120 + (v / maxTime) * 380}" cy="${28 + row * 40 + ((i % 3) - 1) * 5}" r="4" fill="${row ? "#e9b66b" : "#7ecfc2"}"><title>${escape(`${s.id}: ${v.toFixed(2)} seconds`)}</title></circle>`).join("")}
    <text x="590" y="${32 + row * 40}" text-anchor="end">${fmt(median(s.values))} s</text>`,
    )
    .join("");
  const summaryRows = summaries
    .map(
      (s) =>
        `<tr><th>${escape(s.id)}</th><td>${s.pass}/${expected}</td><td>${s.fail}</td><td>${s.invalid}</td><td>${expected - s.trials.length}</td><td>${fmt(median(s.values))}</td></tr>`,
    )
    .join("");
  const pairRows = report.comparisons
    .map(
      (c) =>
        `<tr><th>${escape(c.candidate)}</th><td>${c.pairs}/${c.expectedPairs}</td><td>${c.wins}</td><td>${c.regressions.length}</td><td>${c.bothPass}</td><td>${c.bothFail}</td><td>${c.missing}</td><td>${c.invalid}</td></tr>`,
    )
    .join("");
  const metrics = [
    { key: "inputTokens", label: "Input tokens", divisor: 1 },
    { key: "outputTokens", label: "Output tokens", divisor: 1 },
    { key: "requests", label: "API requests", divisor: 1 },
    { key: "elapsedMs", label: "Agent seconds", divisor: 1000 },
  ] as const;
  const metricRows = report.comparisons
    .flatMap((c) =>
      metrics.map(({ key, label, divisor }) => {
        const m = c.metrics[key];
        const value = (n: number | null) => fmt(n == null ? null : n / divisor);
        return `<tr><th>${escape(c.candidate)}</th><td>${label}</td><td>${value(m.baseline)}</td><td>${value(m.candidate)}</td><td>${value(m.delta)}</td><td>${m.percent == null ? "unknown" : `${fmt(m.percent)}%`}</td></tr>`;
      }),
    )
    .join("");
  const taskRows = report.comparisons
    .flatMap((c) =>
      c.tasks.map(
        (t) =>
          `<tr><th>${escape(t.task)}</th><td>${escape(c.candidate)}</td><td>${t.pairs}/${t.expectedPairs}</td><td>${t.wins} / ${t.regressions.length}</td><td>${fmt(t.metrics.inputTokens.delta)}</td><td>${fmt(t.metrics.outputTokens.delta)}</td><td>${fmt(t.metrics.elapsedMs.delta == null ? null : t.metrics.elapsedMs.delta / 1000)}</td></tr>`,
      ),
    )
    .join("");
  const matrix = spec.tasks
    .map(
      (task) =>
        `<tr><th>${escape(task.id)}</th>${profiles
          .map(
            (p) =>
              `<td>${Array.from({ length: spec.repetitions }, (_, i) => {
                const t = report.trials.find(
                  (t) => t.task === task.id && t.profile === p.id && t.repeat === i + 1,
                );
                return `<span class="badge ${t?.status ?? "pending"}">R${i + 1} ${t?.status ?? "pending"}</span>`;
              }).join(" ")}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const header = [
    "Task",
    "Profile",
    "Repeat",
    "Outcome",
    "Passed tests",
    "Total tests",
    "Requests",
    "Agent seconds",
    "Input tokens",
    "Output tokens",
    "Summary requests",
    "Tool errors",
    "Telemetry complete",
    "Usage complete",
    "Failure stage",
    "Telemetry error",
    "Evidence",
    "Detail",
  ];
  const rows = report.trials.map((t) => [
    t.task,
    t.profile,
    t.repeat,
    t.status,
    t.status === "invalid" ? null : t.passed,
    t.total,
    t.telemetryComplete ? t.requests : null,
    t.elapsedMs / 1000,
    t.usageComplete ? t.inputTokens : null,
    t.usageComplete ? t.outputTokens : null,
    t.telemetryComplete ? t.summaries : null,
    t.telemetryComplete ? t.toolErrors : null,
    t.telemetryComplete,
    t.usageComplete,
    t.failureStage ?? "",
    t.telemetryError ?? "",
    t.evidence,
    t.detail,
  ]);
  const detailRows = report.trials
    .map((t) => {
      const links = (artifacts[t.evidence] ?? [])
        .map(
          (a) =>
            `<a href="${escape(a.path.split("/").map(encodeURIComponent).join("/"))}">${escape(a.label)}</a>`,
        )
        .join(" · ");
      return `<tr data-outcome="${escape(t.status)}" data-task="${escape(t.task)}" data-profile="${escape(t.profile)}">
    <th>${escape(t.task)}</th><td>${escape(t.profile)}</td><td>${t.repeat}</td><td><span class="badge ${escape(t.status)}">${escape(t.status)}</span></td><td>${t.status === "invalid" ? "unscored" : `${t.passed}/${t.total}`}</td><td>${fmt(t.elapsedMs / 1000)}</td>
    <td><details><summary>Review evidence</summary><p>${escape(t.detail)}</p><p>${links || "No evidence files recorded."}</p>
    <dl><dt>API requests / summary requests / tool errors</dt><dd>${t.telemetryComplete ? `${t.requests} / ${t.summaries} / ${t.toolErrors}` : "unknown"}</dd>
    <dt>Input / output tokens</dt><dd>${t.usageComplete ? `${fmt(t.inputTokens)} / ${fmt(t.outputTokens)}` : "unknown: usage incomplete"}</dd>
    ${t.failureStage ? `<dt>Failure stage</dt><dd>${escape(t.failureStage)}</dd>` : ""}
    ${t.telemetryError ? `<dt>Recording diagnostic</dt><dd>${escape(t.telemetryError)}</dd>` : ""}</dl></details></td></tr>`;
    })
    .join("");
  const markdown = [
    `# ${spec.name}`,
    "",
    `State: ${report.state}; model: ${report.model}; effort: ${report.effort}.`,
    "",
    report.scope,
    `Distinct tasks: ${spec.tasks.length}; repeats per task/profile: ${spec.repetitions}. Repeated runs do not add task diversity.`,
    ...(spec.hypothesis ? [`Hypothesis: ${spec.hypothesis}`] : []),
    "",
    "| Profile | Pass / planned | Fail | Invalid | Pending | Median seconds |",
    "|---|---:|---:|---:|---:|---:|",
    ...summaries.map(
      (s) =>
        `| ${s.id} | ${s.pass}/${expected} | ${s.fail} | ${s.invalid} | ${expected - s.trials.length} | ${fmt(median(s.values))} |`,
    ),
    "",
    ...report.comparisons.flatMap((c) => [
      `${c.candidate}: ${c.verdict}; paired ${c.pairs}/${c.expectedPairs}; wins ${c.wins}; regressions ${c.regressions.join(", ") || "none"}; both pass ${c.bothPass}; both fail ${c.bothFail}.`,
      c.next,
      ...metrics.map(({ key, label, divisor }) => {
        const m = c.metrics[key];
        return `${label}: baseline ${fmt(m.baseline == null ? null : m.baseline / divisor)}, candidate ${fmt(m.candidate == null ? null : m.candidate / divisor)}, difference ${fmt(m.delta == null ? null : m.delta / divisor)} (${m.percent == null ? "unknown" : `${fmt(m.percent)}%`}).`;
      }),
      "",
    ]),
    "Open report.html for charts and evidence links; report.csv contains individual trials. No automatic adoption.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(spec.name)} · Clarook evaluation</title>
  <style>body{margin:0;background:#10171e;color:#e3eaf0;font:15px/1.55 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:36px 24px}h1{font-size:34px;margin:8px 0}h2{font-size:21px;margin:32px 0 12px}.muted,p{color:#a9bbc9}.eyebrow{color:#7ecfc2;font-size:12px;letter-spacing:.16em}a{color:#8eddd0}.panel{background:#18232d;border:1px solid #344555;border-radius:10px;padding:18px;margin:16px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;text-align:left;font-size:13px}th,td{padding:10px;border-bottom:1px solid #344555;vertical-align:top}th{white-space:nowrap}td{min-width:65px}.badge{display:inline-block;white-space:nowrap;padding:3px 7px;margin:3px;border-radius:4px;background:#243240}.pass{color:#9ce3c3}.fail{color:#ffb2a6}.invalid{color:#f1cc83}.pending{color:#a9bbc9}svg{max-width:720px;width:100%}svg text{fill:#c8d6e1;font:12px system-ui}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}details{margin-top:16px}code{overflow-wrap:anywhere}select{background:#243240;color:#e3eaf0;padding:7px;border:1px solid #506576}@media(max-width:800px){.grid{display:block}main{padding:20px 12px}}</style>
  <main><div class="eyebrow">CLAROOK / PAIRED EVALUATION</div><h1>${escape(spec.name)}</h1><p>${escape(report.model)} · ${escape(report.effort)} · <strong>${escape(report.state)}</strong> · ${report.trials.length}/${expected * profiles.length} runs recorded</p>
  <p>${spec.tasks.length} distinct tasks · ${spec.repetitions} repeats per task/profile. Candidate − baseline. Repeats measure variation within these tasks, not general capability.</p>
  ${spec.hypothesis ? `<div class="panel"><strong>Experiment hypothesis</strong><p>${escape(spec.hypothesis)}</p></div>` : ""}
  <nav><a href="#quality">Quality</a> · <a href="#resources">Resources</a> · <a href="#tasks">Task differences</a> · <a href="#ledger">Evidence</a> · <a href="#configuration">Configuration</a></nav>
  ${report.error ? `<div class="panel fail">${escape(report.error)}</div>` : ""}
  <div class="panel scroll"><table><thead><tr><th>Profile</th><th>Pass / planned</th><th>Fail</th><th>Invalid</th><th>Pending</th><th>Median seconds</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
  <div class="grid"><section><h2>Repeated task outcomes</h2><div class="scroll"><table><thead><tr><th>Task</th>${profiles.map((p) => `<th>${escape(p.id)}</th>`).join("")}</tr></thead><tbody>${matrix}</tbody></table></div><p>Each badge is an independent fresh run. Repetitions do not add new task diversity.</p></section>
  <section><h2>Agent duration distribution</h2><svg role="img" aria-label="Individual valid run durations, in seconds" viewBox="0 0 610 ${profiles.length * 40 + 34}">${timeChart}<text x="120" y="${profiles.length * 40 + 24}">0 seconds</text><text x="500" text-anchor="end" y="${profiles.length * 40 + 24}">${fmt(maxTime)} seconds</text></svg><p>One dot per valid run; right labels are medians. Includes process startup, API and tools; excludes the independent verifier. Not model-only latency.</p></section></div>
  <h2 id="quality">Paired differences</h2><p>A pair is the same task and repeat index, not a shared random seed. Wins and regressions compare task outcomes.</p><div class="scroll"><table><thead><tr><th>Candidate</th><th>Valid / planned</th><th>Wins</th><th>Regressions</th><th>Both pass</th><th>Both fail</th><th>Missing</th><th>Invalid</th></tr></thead><tbody>${pairRows}</tbody></table></div>
  ${report.comparisons.map((c) => `<p><strong>${escape(c.candidate)}: ${escape(c.verdict)}.</strong> ${escape(c.next)}</p>`).join("")}
  <h2 id="resources">Resource observations</h2><div class="scroll"><table><thead><tr><th>Candidate</th><th>Metric</th><th>Baseline total</th><th>Candidate total</th><th>Difference</th><th>Relative change</th></tr></thead><tbody>${metricRows}</tbody></table></div>
  <p>Differences require all planned valid pairs. Unknown usage is never zero. Tokens are summed across requests, including repeated context. Provider cache and network conditions are not controlled; duration is descriptive, not a speed claim. No price or statistical significance is inferred.</p>
  <h2 id="tasks">Where differences occur</h2><div class="scroll"><table><thead><tr><th>Task</th><th>Candidate</th><th>Valid pairs</th><th>Wins / regressions</th><th>Δ input tokens</th><th>Δ output tokens</th><th>Δ seconds</th></tr></thead><tbody>${taskRows}</tbody></table></div>
  <h2 id="ledger">Trial ledger</h2><p>Pass: artifact meets checks. Fail: a scored task failure. Invalid: no trustworthy task score. Inspect the failure stage before attributing a cause.</p>
  <label>Outcome <select data-filter="outcome"><option value="">All outcomes</option><option>pass</option><option>fail</option><option>invalid</option></select></label>
  <label>Task <select data-filter="task"><option value="">All tasks</option>${spec.tasks.map((t) => `<option>${escape(t.id)}</option>`).join("")}</select></label>
  <label>Profile <select data-filter="profile"><option value="">All profiles</option>${profiles.map((p) => `<option>${escape(p.id)}</option>`).join("")}</select></label>
  <p id="visible-count" aria-live="polite">${report.trials.length} trials shown</p><p><a href="report.csv">Detailed CSV</a> · <a href="report.json">Recorded JSON</a> · <a href="manifest.json">Manifest</a></p>
  <div class="scroll"><table><thead><tr><th>Task</th><th>Profile</th><th>Repeat</th><th>Outcome</th><th>Tests</th><th>Seconds</th><th>Details</th></tr></thead><tbody id="trials">${detailRows}</tbody></table></div>
  <h2 id="configuration">Configuration and limitations</h2><p>${escape(report.scope)}</p><p>These tasks are used for development, not an untouched final test. Choosing a model-specific configuration is a local decision; no universal optimum is claimed. Stop tuning saturated cases unless there is a new failure hypothesis or a practical resource target.</p>
  <details><summary>Explicit settings and task instructions</summary><p>Candidate settings override baseline settings; unspecified values still come from the recorded run configuration. Request recordings contain the actual model input.</p><p>Fingerprint: <code>${escape(report.fingerprint)}</code></p><pre>${escape(JSON.stringify({ model: spec.model, effort: spec.effort ?? "provider default", config: spec.config, baseline: spec.baseline, candidates: spec.candidates, tasks: spec.tasks }, null, 2))}</pre></details>
  </main><script>const filters=[...document.querySelectorAll('[data-filter]')];function filterRows(){let shown=0;for(const row of document.querySelectorAll('#trials tr')){row.hidden=!filters.every(f=>!f.value||row.dataset[f.dataset.filter]===f.value);if(!row.hidden)shown++;}document.getElementById('visible-count').textContent=shown+' trials shown';}for(const filter of filters)filter.addEventListener('change',filterRows);</script></html>`;
  return {
    html,
    markdown,
    csv: [header, ...rows].map((row) => row.map(csv).join(",")).join("\r\n"),
  };
}

export function writeReport(output: string, report: EvaluationReport, spec: Experiment): void {
  const artifacts: Evidence = {};
  for (const t of report.trials) {
    if (!/^[a-z0-9-]+$/.test(t.evidence)) continue;
    const files = [
      ["Reply", "reply.json"],
      ["Artifact", "output.js"],
      ["Verifier", "verifier.json"],
      ["Reference recheck", "verifier-reference.json"],
      ["Stderr", "stderr.txt"],
    ];
    const links = files.flatMap(([label, file]) =>
      label && file && existsSync(join(output, t.evidence, file))
        ? [{ label, path: `${t.evidence}/${file}` }]
        : [],
    );
    artifacts[t.evidence] = links;
    const directory = join(output, t.evidence, "sessions");
    if (!existsSync(directory)) continue;
    const sessions = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
    if (sessions.length === 1)
      links.push({ label: "Session", path: `${t.evidence}/sessions/${sessions[0]}` });
  }
  const rendered = renderReport(report, spec, artifacts);
  writeFileSync(join(output, "report.html"), rendered.html);
  writeFileSync(join(output, "report.csv"), `\uFEFF${rendered.csv}`);
  writeFileSync(join(output, "report.md"), rendered.markdown);
}

export function rebuildReport(output: string): void {
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8")) as EvaluationReport;
  const spec = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as Experiment;
  // 复算派生比较，不改动保存的原始试验结果。
  writeReport(output, { ...report, comparisons: compare(report.trials, spec) }, spec);
}
