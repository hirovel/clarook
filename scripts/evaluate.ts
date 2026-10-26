import { evaluate, loadExperiment } from "./evaluation.js";
import { rebuildReport } from "./evaluation-report.js";

const [command, file, output] = process.argv.slice(2);
if (
  !file ||
  !["validate", "run", "report"].includes(command ?? "") ||
  (command === "run" && !output)
) {
  console.error(
    "Usage: pnpm evaluate validate <experiment.json> | run <experiment.json> <new-output-directory> | report <result-directory>",
  );
  process.exitCode = 2;
} else if (command === "report") {
  try {
    rebuildReport(file);
    console.log(`Report: ${file}/report.html (no API calls)`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
} else {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const spec = loadExperiment(file);
    const trials = spec.tasks.length * spec.repetitions * (1 + spec.candidates.length);
    console.log(`${spec.name}: ${spec.model}; ${trials} task runs. No automatic adoption.`);
    if (command === "run") {
      const result = await evaluate(spec, output as string, {
        signal: abort.signal,
        progress: (text) => console.log(text),
      });
      console.log(`Report: ${output}/report.html`);
      if (result.trials.some((t) => t.status === "invalid")) process.exitCode = 2;
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
