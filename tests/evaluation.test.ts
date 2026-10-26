import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, loadExperiment, type Runner, runNode } from "../scripts/evaluation.js";
import { compare, rebuildReport, renderReport } from "../scripts/evaluation-report.js";
import { testDirectory } from "./helpers/setup.js";

function fixture() {
  const root = testDirectory("evaluation-");
  const task = join(root, "task");
  mkdirSync(task);
  writeFileSync(join(task, "answer.js"), "bad");
  writeFileSync(join(task, "vitest.config.mjs"), "export default {};");
  writeFileSync(join(task, "protected.txt"), "fixed specification");
  writeFileSync(join(root, "reference.js"), "good");
  writeFileSync(join(root, "config.json"), "{}");
  const file = join(root, "experiment.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "test",
      model: "test/model-a",
      config: "config.json",
      repetitions: 2,
      baseline: { id: "base", settings: { toolPrompts: "explain" } },
      candidates: [{ id: "brief", settings: { toolPrompts: "brief" } }],
      tasks: [
        {
          id: "task",
          fixture: "task",
          reference: "reference.js",
          output: "answer.js",
          tests: 1,
          prompt: "Complete the task.",
        },
      ],
    }),
  );
  return { root, file };
}

describe("supervised evaluation", () => {
  it("checks isolated artifacts, rotates comparison order, and reports regressions without adopting a profile", async () => {
    const { root, file } = fixture();
    const spec = JSON.parse(readFileSync(file, "utf8"));
    spec.candidates.push({ id: "tamper", settings: { toolPrompts: "rules" } });
    writeFileSync(file, JSON.stringify(spec));
    const calls: string[] = [];
    const run: Runner = async (args, cwd, env) => {
      const verifier = args.find((a) => a.startsWith("--outputFile="));
      if (verifier) {
        const good = readFileSync(join(cwd, "answer.js"), "utf8") === "good";
        writeFileSync(
          verifier.slice("--outputFile=".length),
          JSON.stringify({
            numTotalTests: 1,
            numPassedTests: good ? 1 : 0,
            numFailedTests: good ? 0 : 1,
            success: good,
          }),
        );
        return { code: good ? 0 : 1, stdout: "", stderr: "" };
      }
      expect(readFileSync(join(cwd, "answer.js"), "utf8")).toBe("bad");
      const brief = args.includes("brief");
      const tamper = args.includes("rules");
      calls.push(tamper ? "tamper" : brief ? "brief" : "base");
      writeFileSync(join(cwd, "answer.js"), brief ? "bad" : "good");
      if (brief && calls.filter((c) => c === "brief").length === 2) rmSync(join(cwd, "answer.js"));
      if (tamper) writeFileSync(join(cwd, "protected.txt"), "changed requirements");
      const sessions = env.CLAROOK_SESSIONS as string;
      mkdirSync(sessions, { recursive: true });
      const session = join(sessions, "test.jsonl");
      const at = "2026-10-10T00:00:00Z";
      writeFileSync(
        session,
        `${[
          { type: "session/start", at, model: "model-a", system: "s" },
          {
            type: "request",
            at,
            model: "model-a",
            messages: 1,
            tools: [],
            estimatedTokens: 1,
            reason: "turn",
          },
          {
            type: "assistant/message",
            at,
            text: "done",
            toolCalls: [],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      return {
        code: tamper && calls.filter((c) => c === "tamper").length === 2 ? 1 : 0,
        stdout: JSON.stringify({ ok: true, outcome: "idle", sessionFile: session }),
        stderr: "",
      };
    };
    const report = await evaluate(loadExperiment(file), join(root, "results"), { run });
    expect(calls).toEqual(["base", "brief", "tamper", "brief", "tamper", "base"]);
    expect(report.model).toBe("test/model-a");
    expect(report.trials.map((t) => t.status)).toEqual([
      "pass",
      "fail",
      "invalid",
      "fail",
      "invalid",
      "pass",
    ]);
    expect(report.trials[2]?.detail).toContain("Protected input changed");
    expect(report.trials[3]?.detail).toContain("without the required artifact");
    expect(report.trials[3]?.failureStage).toBe("artifact");
    expect(report.trials[4]?.failureStage).toBe("agent");
    expect(report.trials[4]?.telemetryComplete).toBe(true);
    expect(report.trials[4]?.requests).toBe(1);
    expect(report.comparisons[1]?.verdict).toBe("invalid comparison");
    expect(report.comparisons[0]?.regressions).toEqual(["task/1", "task/2"]);
    expect(report.comparisons[0]?.verdict).toBe("regressions need review");
    expect(readFileSync(join(root, "task/answer.js"), "utf8")).toBe("bad");
    const incomplete = report.trials.map((t) => ({ ...t, usageComplete: false }));
    const experiment = loadExperiment(file);
    expect(compare(incomplete, experiment)[0]?.metrics.inputTokens.delta).toBeNull();
    const partial = compare(report.trials.slice(0, 1), experiment)[0];
    expect(partial?.pairs).toBe(0);
    expect(partial?.expectedPairs).toBe(2);
    expect(partial?.verdict).toBe("incomplete comparison");
    expect(partial?.missing).toBe(2);
    expect(partial?.metrics.elapsedMs.delta).toBeNull();
    expect(compare([], experiment)[0]?.metrics.inputTokens.delta).toBeNull();
    const saturated = compare(
      report.trials.map((t) => ({ ...t, status: "pass" as const })),
      experiment,
    )[0];
    expect(saturated?.bothPass).toBe(2);
    expect(saturated?.verdict).toBe("no quality separation");
    expect(saturated?.metrics.inputTokens.percent).toBe(0);
    expect(saturated?.tasks[0]?.pairs).toBe(2);
    const sharedFailure = compare(
      report.trials.map((t) => ({ ...t, status: "fail" as const })),
      experiment,
    )[0];
    expect(sharedFailure?.bothFail).toBe(2);
    expect(sharedFailure?.next).toContain("Shared failures");
    const unsafe = {
      ...report,
      trials: report.trials.map((t) => ({
        ...t,
        detail: '=HYPERLINK("bad")<script>alert(1)</script>',
        usageComplete: false,
      })),
    };
    const rendered = renderReport(unsafe, experiment);
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.csv).toContain("'=HYPERLINK");
    expect(rendered.csv).toContain('"",""');
    const saved = readFileSync(join(root, "results/report.json"), "utf8");
    rebuildReport(join(root, "results"));
    expect(readFileSync(join(root, "results/report.json"), "utf8")).toBe(saved);
    expect(readFileSync(join(root, "results/report.html"), "utf8")).toContain("Paired differences");
    await expect(evaluate(loadExperiment(file), join(root, "results"), { run })).rejects.toThrow(
      "new output",
    );
  });

  it("refuses empty verifier success before any model call and rejects unsupported candidate mechanisms", async () => {
    const { root, file } = fixture();
    let modelCalls = 0;
    const run: Runner = async (args) => {
      const output = args.find((a) => a.startsWith("--outputFile="));
      if (!output) modelCalls++;
      else
        writeFileSync(
          output.slice("--outputFile=".length),
          JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, success: true }),
        );
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(evaluate(loadExperiment(file), join(root, "invalid"), { run })).rejects.toThrow(
      "Verifier count",
    );
    expect(modelCalls).toBe(0);
    const report = JSON.parse(readFileSync(join(root, "invalid/report.json"), "utf8"));
    expect(report.state).toBe("incomplete");
    const spec = JSON.parse(readFileSync(file, "utf8"));
    spec.candidates[0].settings = { model: "different-model" };
    writeFileSync(file, JSON.stringify(spec));
    expect(() => loadExperiment(file)).toThrow("Unsupported experiment setting");
    spec.candidates[0] = { id: "brief", settings: {}, modle: "typo" };
    writeFileSync(file, JSON.stringify(spec));
    expect(() => loadExperiment(file)).toThrow("/candidates/0/modle");
  });

  it("preserves UTF-8 split across process output chunks", async () => {
    const { root } = fixture();
    const result = await runNode(
      [
        "-e",
        "const b=Buffer.from('中文');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},20)",
      ],
      root,
      process.env,
      new AbortController().signal,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("中文");
  });

  it("counts an unparseable artifact as failure only when the reference still passes", async () => {
    const { root, file } = fixture();
    const spec = JSON.parse(readFileSync(file, "utf8"));
    spec.repetitions = 1;
    writeFileSync(file, JSON.stringify(spec));
    writeFileSync(join(root, "task/answer.js"), "export const answer = 0;");
    writeFileSync(join(root, "reference.js"), "export const answer = 42;");
    writeFileSync(
      join(root, "task/answer.test.js"),
      "import { answer } from './answer.js'; test('answer', () => expect(answer).toBe(42));",
    );
    writeFileSync(
      join(root, "task/vitest.config.mjs"),
      "export default { test: { globals: true, include: ['*.test.js'], maxWorkers: 1 } };",
    );
    let modelCalls = 0;
    const run: Runner = async (args, cwd, env, signal) => {
      if (args.some((arg) => arg.startsWith("--outputFile="))) {
        // 模拟对照完成后判分环境不可用；不能把这种零用例归为产物错误。
        if (cwd.endsWith("verify-task-1-brief"))
          return { code: 2, stdout: "", stderr: "Verifier unavailable" };
        return runNode(args, cwd, env, signal);
      }
      modelCalls++;
      writeFileSync(join(cwd, "answer.js"), "export const = ;");
      return { code: 0, stdout: JSON.stringify({ ok: true, outcome: "idle" }), stderr: "" };
    };
    const output = join(root, "results");
    const report = await evaluate(loadExperiment(file), output, { run });
    expect(modelCalls).toBe(2);
    expect(report.trials[0]).toMatchObject({ status: "fail", failureStage: "artifact" });
    expect(report.trials[0]?.detail).toContain("reference passed");
    expect(report.trials[1]).toMatchObject({ status: "invalid", failureStage: "verifier" });
    expect(report.trials[1]?.detail).toContain("Reference recheck failed");
    expect(report.trials[1]?.detail).toContain("Verifier unavailable");
    expect(readFileSync(join(output, "task-1-base/output.js"), "utf8")).toBe("export const = ;");
    const original = JSON.parse(readFileSync(join(output, "task-1-base/verifier.json"), "utf8"));
    const reference = JSON.parse(
      readFileSync(join(output, "task-1-base/verifier-reference.json"), "utf8"),
    );
    expect(original.numTotalTests).toBe(0);
    expect(original.testResults[0].message).toMatch(/Parse failure|Unexpected token/);
    expect(reference.numPassedTests).toBe(1);
    expect(readFileSync(join(output, "report.html"), "utf8")).toContain(
      "task-1-base/verifier-reference.json",
    );
  }, 15000);
});
