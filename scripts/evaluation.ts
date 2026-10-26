// 开发期对照实验。复用正式 once 入口；报告只提出待审核结论，不修改用户组合。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { stopProcessTree } from "../cli/process-tree.js";
import { parsePreservation } from "../cli/args.js";
import { credentialsPath } from "../src/config.js";
import { usageTotals } from "../src/cost.js";
import { EventLog } from "../src/log.js";
import { parseSetting, settingDef } from "../src/settings.js";
import { compare, writeReport } from "./evaluation-report.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const knobs: Record<string, string> = {
  toolPrompts: "--tool-prompts",
  execution: "--execution",
  preservation: "--preservation",
  compactionRatio: "--compaction-ratio",
  compactionReserve: "--compaction-reserve",
  compactionTrigger: "--compaction-trigger",
};
const text = Type.String({ minLength: 1, pattern: "\\S" });
const identifier = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const profileSchema = Type.Object(
  {
    id: identifier,
    settings: Type.Optional(Type.Record(Type.String(), Type.Union([text, Type.Number()]))),
    systemPrompt: Type.Optional(text),
  },
  { additionalProperties: false },
);
const taskSchema = Type.Object(
  {
    id: identifier,
    fixture: text,
    reference: text,
    output: text,
    tests: Type.Integer({ minimum: 1 }),
    prompt: text,
  },
  { additionalProperties: false },
);
const experimentSchema = Type.Object(
  {
    name: identifier,
    model: text,
    config: text,
    repetitions: Type.Integer({ minimum: 1 }),
    effort: Type.Optional(text),
    hypothesis: Type.Optional(text),
    baseline: profileSchema,
    candidates: Type.Array(profileSchema, { minItems: 1 }),
    tasks: Type.Array(taskSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
type Profile = Static<typeof profileSchema>;
type Task = Static<typeof taskSchema>;
export type Experiment = Static<typeof experimentSchema>;
type ProcessResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<ProcessResult>;
export type Trial = {
  task: string;
  profile: string;
  repeat: number;
  status: "pass" | "fail" | "invalid";
  detail: string;
  elapsedMs: number;
  passed: number;
  total: number;
  requests: number;
  summaries: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
  telemetryComplete: boolean;
  evidence: string;
  failureStage?: "agent" | "artifact" | "verifier";
  telemetryError?: string;
};

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function inside(parent: string, name: string): string {
  const path = resolve(parent, name);
  const rel = relative(parent, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Path must stay inside its directory: ${name}`);
  return path;
}
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not evaluation inputs: ${file}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) out[relative(dir, file)] = hash(readFileSync(file));
      else throw new Error(`Unsupported input: ${file}`);
    }
  };
  walk(dir);
  return out;
}
function profileArgs(profile: Profile): string[] {
  return Object.entries(profile.settings ?? {}).flatMap(([key, value]) => {
    const flag = knobs[key];
    const def = settingDef(key);
    if (!flag || !def) throw new Error(`Unsupported experiment setting: ${key}`);
    parseSetting(def, String(value));
    if (key === "preservation") parsePreservation(String(value));
    return [flag, String(value)];
  });
}

export function loadExperiment(file: string): Experiment {
  const spec: unknown = json(file);
  if (!Value.Check(experimentSchema, spec)) {
    const errors = [...Value.Errors(experimentSchema, spec)];
    throw new Error(
      `Invalid experiment: ${errors.map((e) => `${e.path || "/"}: ${e.message}`).join("; ")}`,
    );
  }
  const base = dirname(resolve(file));
  if (spec.effort !== undefined) {
    const def = settingDef("effort");
    if (!def) throw new Error("Missing effort setting.");
    parseSetting(def, spec.effort);
  }
  const profiles = [spec.baseline, ...spec.candidates];
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
    throw new Error("Duplicate profile id.");
  if (new Set(spec.tasks.map((t) => t.id)).size !== spec.tasks.length)
    throw new Error("Duplicate task id.");
  spec.config = resolve(base, spec.config);
  if (!existsSync(spec.config))
    throw new Error("The experiment's explicit config file is missing.");
  for (const p of profiles) {
    profileArgs(p);
    if (p.systemPrompt) {
      p.systemPrompt = resolve(base, p.systemPrompt);
      readFileSync(p.systemPrompt);
    }
  }
  for (const task of spec.tasks) {
    task.fixture = resolve(base, task.fixture);
    task.reference = resolve(base, task.reference);
    inside(task.fixture, task.output);
    tree(task.fixture);
    readFileSync(task.reference);
    if (!existsSync(join(task.fixture, "vitest.config.mjs")))
      throw new Error("Each task needs vitest.config.mjs.");
  }
  return spec;
}

// 有限 stdout 用于解析 once JSON；超限显式报错，正式 API 原文仍由会话 Recording 保存。
export const runNode: Runner = (args, cwd, env, signal) =>
  new Promise((done, reject) => {
    signal.throwIfAborted();
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      error ? reject(error) : done({ code, stdout, stderr });
    };
    const stop = (reason: string) => {
      try {
        stopProcessTree(child, process.platform !== "win32");
      } catch (e) {
        reason += `; ${String(e)}`;
      }
      finish(new Error(`${reason}; descendant termination not verified`));
    };
    const abort = () => stop("Evaluation interrupted");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024)
        stop("CLI output exceeded 4 MiB; trial is invalid");
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-16000);
    });
    child.once("error", (e) => finish(e));
    child.once("close", (code) => finish(undefined, code));
    if (signal.aborted) abort();
  });

function prepare(task: Task, cwd: string): void {
  cpSync(task.fixture, cwd, { recursive: true });
  // 测试依赖来自当前仓库，不让每轮网络安装改变评测环境。
  save(join(cwd, "package.json"), {
    type: "module",
    scripts: { test: `node "${vitest.replaceAll("\\", "/")}" run` },
  });
}
async function judge(
  task: Task,
  cwd: string,
  report: string,
  run: Runner,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const result = await run(
    [
      vitest,
      "run",
      "--config",
      join(cwd, "vitest.config.mjs"),
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    cwd,
    env,
    signal,
  );
  if (!existsSync(report))
    throw new Error(
      `Verifier did not produce a report (exit ${result.code}). ${(result.stderr || result.stdout).trim().slice(-4000)}`,
    );
  const v = json(report);
  if (
    v.numTotalTests !== task.tests ||
    !Number.isInteger(v.numPassedTests) ||
    !Number.isInteger(v.numFailedTests) ||
    v.numPassedTests + v.numFailedTests !== task.tests ||
    v.numPendingTests > 0 ||
    v.numTodoTests > 0
  )
    throw new Error(
      "Verifier count differs from the frozen task; skipped or missing tests are not a pass.",
    );
  const pass = result.code === 0 && v.success === true && v.numPassedTests === task.tests;
  return { pass, passed: v.numPassedTests as number, total: task.tests };
}

// 即使 once 失败也读取已有记录；读取失败单独报告，不能覆盖原来的失败原因。
function collectMetrics(trial: Trial, evidence: string): void {
  try {
    const directory = join(evidence, "sessions");
    const files = existsSync(directory)
      ? readdirSync(directory).filter((f) => f.endsWith(".jsonl"))
      : [];
    if (files.length !== 1)
      throw new Error(`Expected one session recording; found ${files.length}.`);
    const log = EventLog.load(join(directory, files[0]!));
    try {
      const totals = usageTotals(log.events);
      trial.requests = log.events.filter((e) => e.type === "request").length;
      trial.summaries = log.events.filter(
        (e) => e.type === "request" && e.reason === "compaction",
      ).length;
      trial.toolErrors = log.events.filter((e) => e.type === "tool/result" && e.isError).length;
      trial.inputTokens = totals.inputTokens;
      trial.outputTokens = totals.outputTokens;
      trial.telemetryComplete = true;
      trial.usageComplete =
        totals.requests === trial.requests &&
        totals.costStatus !== "missing usage" &&
        totals.costStatus !== "pending";
    } finally {
      log.recording?.dispose();
    }
  } catch (error) {
    trial.telemetryError = String(error);
  }
}

export async function evaluate(
  spec: Experiment,
  output: string,
  options: { signal?: AbortSignal; run?: Runner; progress?: (text: string) => void } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const run = options.run ?? runNode;
  const out = resolve(output);
  if (existsSync(out))
    throw new Error("Use a new output directory; previous evidence is never overwritten.");
  mkdirSync(out, { recursive: true });
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "clarook-eval-")));
  try {
    const trials: Trial[] = [];
    const profiles = [spec.baseline, ...spec.candidates];
    const sourceFingerprint = () =>
      hash(
        JSON.stringify({
          spec,
          config: hash(readFileSync(spec.config)),
          code: [
            tree(join(root, "src")),
            tree(join(root, "cli")),
            hash(readFileSync(join(root, "pnpm-lock.yaml"))),
            hash(readFileSync(join(root, "package.json"))),
            hash(readFileSync(fileURLToPath(import.meta.url))),
          ],
          tasks: spec.tasks.map((t) => ({
            files: tree(t.fixture),
            reference: hash(readFileSync(t.reference)),
          })),
          prompts: profiles.map((p) =>
            p.systemPrompt ? hash(readFileSync(p.systemPrompt)) : null,
          ),
        }),
      );
    const fingerprint = sourceFingerprint();
    const env = {
      ...process.env,
      CLAROOK_CONFIG: spec.config,
      CLAROOK_CREDENTIALS: credentialsPath(),
      CLAROOK_HOME: join(temp, "home"),
    };
    const manifest = {
      ...spec,
      fingerprint,
      harnessVersion: json(join(root, "package.json")).version,
      node: process.version,
      platform: process.platform,
      startedAt: new Date().toISOString(),
      configHash: hash(readFileSync(spec.config)),
      taskHashes: Object.fromEntries(spec.tasks.map((t) => [t.id, tree(t.fixture)])),
      scope:
        "Model- and task-scoped configuration comparison; fixtures are temporary working directories, not security sandboxes. No automatic adoption. No untouched holdout score.",
    };
    save(join(out, "manifest.json"), manifest);
    const finish = (state: string, error?: string) => {
      const report = {
        state,
        ...(error && { error }),
        scope: manifest.scope,
        model: spec.model,
        effort: spec.effort ?? "provider default",
        fingerprint,
        updatedAt: new Date().toISOString(),
        trials,
        comparisons: compare(trials, spec),
      };
      save(join(out, "report.json"), report);
      writeReport(out, report, spec);
      return report;
    };
    try {
      finish("running");
      // 正负对照先于任何付费模型请求，验证判据会拒绝骨架并接受已知实现。
      for (const task of spec.tasks) {
        const cwd = join(temp, `control-${task.id}`);
        prepare(task, cwd);
        const negative = await judge(
          task,
          cwd,
          join(out, `${task.id}-negative.json`),
          run,
          env,
          signal,
        );
        copyFileSync(task.reference, inside(cwd, task.output));
        const positive = await judge(
          task,
          cwd,
          join(out, `${task.id}-positive.json`),
          run,
          env,
          signal,
        );
        if (negative.pass || !positive.pass) throw new Error(`Verifier control failed: ${task.id}`);
      }
      for (let repeat = 1; repeat <= spec.repetitions; repeat++)
        for (const task of spec.tasks) {
          // 轮换执行顺序，减少固定先后顺序与供应商缓存热度造成的偏差。
          const offset = (repeat - 1) % profiles.length;
          const ordered = [...profiles.slice(offset), ...profiles.slice(0, offset)];
          for (const profile of ordered) {
            signal.throwIfAborted();
            if (sourceFingerprint() !== fingerprint)
              throw new Error("Experiment inputs changed during the run.");
            const label = `${task.id}-${repeat}-${profile.id}`;
            options.progress?.(label);
            const evidence = join(out, label);
            mkdirSync(evidence);
            const cwd = join(temp, label);
            prepare(task, cwd);
            const before = tree(cwd);
            const trial: Trial = {
              task: task.id,
              profile: profile.id,
              repeat,
              status: "invalid",
              detail: "",
              elapsedMs: 0,
              passed: 0,
              total: task.tests,
              requests: 0,
              summaries: 0,
              toolErrors: 0,
              inputTokens: 0,
              outputTokens: 0,
              usageComplete: false,
              telemetryComplete: false,
              evidence: label,
            };
            const started = Date.now();
            let stage: NonNullable<Trial["failureStage"]> = "agent";
            try {
              const args = [
                "--import",
                "tsx",
                join(root, "cli/run.ts"),
                "--model",
                spec.model,
                "--json",
                "--notify",
                "off",
                "--no-check-updates",
                ...profileArgs(spec.baseline),
                ...profileArgs(profile),
                ...(spec.effort ? ["--effort", spec.effort] : []),
                ...((profile.systemPrompt ?? spec.baseline.systemPrompt)
                  ? [
                      "--system-prompt",
                      (profile.systemPrompt ?? spec.baseline.systemPrompt) as string,
                    ]
                  : []),
                "--prompt",
                task.prompt,
              ];
              // --import 在临时cwd解析包；使用仓库已安装模块的绝对文件URL。
              args[1] = tsx;
              const result = await run(
                args,
                cwd,
                {
                  ...env,
                  CLAROOK_HOME: join(temp, `home-${label}`),
                  CLAROOK_SESSIONS: join(evidence, "sessions"),
                },
                signal,
              );
              trial.elapsedMs = Date.now() - started;
              writeFileSync(join(evidence, "stderr.txt"), result.stderr);
              writeFileSync(join(evidence, "reply.json"), result.stdout);
              if (result.code !== 0)
                throw new Error(
                  `Agent process exited ${result.code}; inspect stderr and recordings.`,
                );
              const reply = JSON.parse(result.stdout);
              if (reply.ok !== true || reply.outcome !== "idle")
                throw new Error(`Agent did not complete: ${reply.outcome ?? "unknown"}`);
              stage = "artifact";
              for (const [name, digest] of Object.entries(before)) {
                if (name === relative(cwd, inside(cwd, task.output))) continue;
                const path = inside(cwd, name);
                if (
                  !existsSync(path) ||
                  lstatSync(path).isSymbolicLink() ||
                  realpathSync(path) !== resolve(path) ||
                  hash(readFileSync(path)) !== digest
                )
                  throw new Error(`Protected input changed: ${name}`);
              }
              const produced = inside(cwd, task.output);
              if (!existsSync(produced)) {
                trial.status = "fail";
                throw new Error("Agent finished without the required artifact.");
              }
              if (
                !lstatSync(produced).isFile() ||
                lstatSync(produced).isSymbolicLink() ||
                realpathSync(produced) !== resolve(produced)
              )
                throw new Error("Task output is missing or not a regular file.");
              const verifyDir = join(temp, `verify-${label}`);
              prepare(task, verifyDir);
              copyFileSync(produced, inside(verifyDir, task.output));
              copyFileSync(produced, join(evidence, "output.js"));
              stage = "verifier";
              let verdict: Awaited<ReturnType<typeof judge>>;
              try {
                verdict = await judge(
                  task,
                  verifyDir,
                  join(evidence, "verifier.json"),
                  run,
                  env,
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                // 产物解析失败也会导致零用例；用同一环境的正确实现区分产物与判据故障。
                // 原产物及其报告已单独保存，不覆写异常证据，也不重跑模型。
                try {
                  copyFileSync(task.reference, inside(verifyDir, task.output));
                  const control = await judge(
                    task,
                    verifyDir,
                    join(evidence, "verifier-reference.json"),
                    run,
                    env,
                    signal,
                  );
                  if (!control.pass) throw new Error("Reference implementation failed checks.");
                } catch (controlError) {
                  throw new Error(
                    `Verifier could not grade the artifact: ${error}\nReference recheck failed: ${controlError}`,
                  );
                }
                trial.status = "fail";
                stage = "artifact";
                throw new Error(
                  `Artifact could not be graded; the reference passed in the same environment: ${error}`,
                );
              }
              trial.passed = verdict.passed;
              trial.status = verdict.pass ? "pass" : "fail";
              trial.detail = verdict.pass
                ? "Independent artifact checks passed."
                : "Artifact failed independent checks; inspect the trace before attributing the cause.";
            } catch (error) {
              trial.detail = String(error);
              trial.failureStage = stage;
            } finally {
              if (!trial.elapsedMs) trial.elapsedMs = Date.now() - started;
              collectMetrics(trial, evidence);
            }
            trials.push(trial);
            finish("running");
            signal.throwIfAborted();
          }
        }
      if (sourceFingerprint() !== fingerprint)
        throw new Error("Experiment inputs changed during the run.");
      return finish("complete");
    } catch (error) {
      finish("incomplete", String(error));
      throw error;
    }
  } finally {
    // 仅删除由本轮mkdtemp创建、仍解析到原位置的目录；运行记录已在输出目录。
    if (existsSync(temp) && realpathSync(temp) === temp)
      rmSync(temp, { recursive: true, force: true });
  }
}
