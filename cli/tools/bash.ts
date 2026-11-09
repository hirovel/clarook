// bash 工具:Windows 找 Git Bash,打断杀进程树。
// 截断策略可换:默认保尾,自定义策略经 createBashTool 注入。
// 每条命令从构造目录开始;cd 只影响本条命令,不从输出恢复运行状态。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolOutput } from "../../src/exchange.js";
import type { ToolContext } from "../../src/tools.js";
import { defineTool, described, ToolOutcomeUnknownError } from "../../src/tools.js";
import { stopProcessTree } from "../process-tree.js";
import { keepTail, type TruncationPolicy } from "./truncate.js";

/** 缺省超时与模型可见的输出尾部预算。完整原文流式写入 Recording。 */
export const DEFAULT_TIMEOUT_S = 120;
const PREVIEW_BYTES = 50 * 1024;

/** 用户命令从显式目录开始,不读取或改变模型工具实例的工作目录。 */
export async function executeUserShell(
  command: string,
  cwd: string,
  ctx: ToolContext,
  onPreview?: (text: string) => void,
): Promise<{ content: string; isError: boolean; status: string }> {
  const shell = findBash();
  if (!shell) throw new Error("bash not found. Install Git for Windows or set CLAROOK_SHELL.");
  const truncate = keepTail();
  const result = await run(shell, command, ctx.signal, {
    cwd,
    timeoutMs: DEFAULT_TIMEOUT_S * 1000,
    truncate,
    closeInput: true,
    ...(onPreview && { onPreview }),
    ...(ctx.output && { output: ctx.output }),
  });
  const status = `Exit code: ${result.exitCode}`;
  return {
    content: `${result.output || "(no output)"}\n[${status}]`,
    isError: result.exitCode !== 0,
    status,
  };
}

export function createBashTool(
  opts: {
    truncate?: TruncationPolicy;
    defaultTimeoutS?: number;
    /** 每次调用的工作目录;缺省构造时的进程目录。 */
    cwd?: string;
  } = {},
) {
  const truncate = opts.truncate ?? keepTail();
  const defaultTimeout = opts.defaultTimeoutS ?? DEFAULT_TIMEOUT_S;
  const cwd = opts.cwd ?? process.cwd();
  return defineTool({
    name: "bash",
    ...described({
      core:
        "Run a bash command; returns stdout and stderr combined. Each call starts in the configured working directory; " +
        "cd applies only to that call. Use cd and the command together to work in another directory. " +
        `Default timeout ${defaultTimeout} s; raise the timeout parameter for long tasks. ` +
        "Long results show the last 50 KiB and a path to the complete captured output; output size does not stop the command.",
      guidance:
        "For reading and searching files prefer read, grep and glob; use bash for builds, tests, git and other commands. " +
        "Quote paths that contain spaces.",
      rules:
        "NEVER use bash to read or search files (cat, head, grep, find, ls); use read, grep and glob.",
    }),
    parameters: Type.Object({
      command: Type.String({ description: "bash command to run" }),
      timeout: Type.Optional(
        Type.Number({
          description: `timeout in seconds, default ${defaultTimeout}; 0 = unlimited`,
        }),
      ),
    }),
    async execute(args, ctx) {
      const shell = findBash();
      if (!shell) {
        throw new Error(
          "bash not found. Options: 1. install Git for Windows; 2. set CLAROOK_SHELL to a bash executable.",
        );
      }
      const timeoutS = args.timeout ?? defaultTimeout;
      const recording = ctx.output;
      const r = await run(shell, args.command, ctx.signal, {
        timeoutMs: timeoutS > 0 ? timeoutS * 1000 : 0,
        cwd,
        truncate,
        ...(recording && { output: recording }),
      });
      if (r.exitCode !== 0) throw new Error(`${r.output}\ncommand exited with code ${r.exitCode}`);
      return r.output || "(no output)";
    },
  });
}

function applyTruncation(
  output: string,
  truncate: TruncationPolicy,
  capture: {
    path: string | undefined;
    omitted: boolean;
    bytes: number;
    missingFrom: number | undefined;
    exitCode: number;
  },
): string {
  const t = truncate(output);
  if (!t.truncated && !capture.omitted && capture.missingFrom === undefined)
    return t.text.trimEnd();
  // 仅截断展示;无 Recording 的直接调用只在需要时写临时原文。
  const fullPath = capture.path ?? join(mkdtempSync(join(tmpdir(), "kernel-bash-")), "output.txt");
  if (!capture.path) writeFileSync(fullPath, output, "utf8");
  const range = capture.omitted
    ? `showing last ${Buffer.byteLength(t.text, "utf8")} of ${capture.bytes} captured bytes`
    : t.truncated
      ? (t.note ?? "output truncated")
      : "output shown in full";
  const location =
    capture.missingFrom === undefined
      ? `Full output: ${fullPath}`
      : `Recording incomplete from byte ${capture.missingFrom}; available prefix: ${fullPath}`;
  return `${t.text.trimEnd()}\n[${range}. ${capture.exitCode === 0 ? "Exit code: 0. " : ""}${location}]`;
}

function findBash(): string | null {
  if (process.env.CLAROOK_SHELL) return process.env.CLAROOK_SHELL;
  if (process.platform !== "win32") return "bash";
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) return gitBash;
  const where = spawnSync("where.exe", ["bash.exe"], { encoding: "utf8" });
  const found = where.stdout?.split(/\r?\n/)[0]?.trim();
  return found || null;
}

type RunResult = {
  output: string;
  exitCode: number;
};

function run(
  shell: string,
  command: string,
  signal: AbortSignal,
  limits: {
    timeoutMs: number;
    cwd: string;
    truncate: TruncationPolicy;
    output?: ToolOutput;
    onPreview?: (text: string) => void;
    closeInput?: boolean;
  },
): Promise<RunResult> {
  if (signal.aborted) return Promise.reject(new Error("command interrupted before starting"));
  return new Promise((resolvePromise, rejectPromise) => {
    // POSIX 下 detached 开进程组,打断时整组杀掉;Windows 用 taskkill /T 杀进程树。
    const child = spawn(shell, ["-c", command], {
      cwd: limits.cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    if (limits.closeInput) child.stdin.end();
    let tail = Buffer.alloc(0);
    let bytes = 0;
    let omitted = false;
    let outputPath: string | undefined;
    let outputFd: number | undefined;
    let captureError: Error | undefined;
    let aborted = false;
    let timedOut = false;
    let killed = false;
    let killError: Error | undefined;

    const formatOutput = (exitCode: number) => {
      let start = 0;
      while (start < tail.length && ((tail[start] as number) & 0xc0) === 0x80) start++;
      const raw = tail.subarray(start).toString("utf8");
      let shown = raw;
      try {
        shown = applyTruncation(raw, limits.truncate, {
          path: limits.output?.path ?? outputPath,
          omitted,
          bytes,
          missingFrom: limits.output?.ref.missingFrom,
          exitCode,
        });
      } catch (error) {
        if (!killed) throw error;
        // 展示策略或临时落盘失败也不能阻止取消完成。
        shown += `\n[Output preview failed: ${(error as Error).message}]`;
      }
      return shown;
    };

    const killTree = () => {
      if (killed) return;
      killed = true;
      let stopDetail: string | undefined;
      try {
        stopProcessTree(child, process.platform !== "win32");
      } catch (error) {
        stopDetail = (error as Error).message;
      }
      // 后代可能脱离进程组并继续持管道;停止请求后结束本地等待。
      // 未核实全部后代退出,统一报告 unknown,只保留此前收到的输出。
      const reason = aborted
        ? "command interrupted"
        : timedOut
          ? `command did not finish within ${limits.timeoutMs / 1000} s`
          : (captureError?.message ?? "command stop requested");
      cleanup();
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onData);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      killError = new ToolOutcomeUnknownError(
        `${reason}; ${stopDetail ?? "stop requested; local wait ended; descendant termination not verified"}. Output so far:\n${formatOutput(-1)}`,
      );
      rejectPromise(killError);
    };
    const onData = (d: Buffer) => {
      if (killed || captureError) return;
      try {
        limits.output?.write(d);
        const combined = Buffer.concat([tail, d]);
        if (!limits.output) {
          if (outputFd !== undefined) writeFileSync(outputFd, d);
          else if (combined.length > PREVIEW_BYTES) {
            outputPath = join(mkdtempSync(join(tmpdir(), "kernel-bash-")), "output.txt");
            outputFd = openSync(outputPath, "w");
            writeFileSync(outputFd, combined);
          }
        }
        omitted ||= combined.length > PREVIEW_BYTES;
        tail = combined.subarray(Math.max(0, combined.length - PREVIEW_BYTES));
        bytes += d.length;
        if (limits.onPreview) {
          let start = 0;
          while (start < tail.length && ((tail[start] as number) & 0xc0) === 0x80) start++;
          // 实时预览可以不含尾部尚未收齐的 UTF-8 字符;原始捕获始终先收到完整字节。
          limits.onPreview(new TextDecoder().decode(tail.subarray(start), { stream: true }));
        }
      } catch (error) {
        captureError = new Error(
          `command output could not be captured: ${(error as Error).message}`,
        );
        killTree();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer =
      limits.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, limits.timeoutMs)
        : undefined;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (outputFd !== undefined) {
        try {
          closeSync(outputFd);
        } catch (error) {
          captureError ??= new Error(
            `command output could not be closed: ${(error as Error).message}`,
          );
        }
        outputFd = undefined;
      }
    };
    child.on("error", (err) => {
      cleanup();
      rejectPromise(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (killError) return;
      if (captureError) return rejectPromise(captureError);
      const exitCode = code ?? -1;
      try {
        resolvePromise({ output: formatOutput(exitCode), exitCode });
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}
