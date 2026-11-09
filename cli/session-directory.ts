import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { EventLog } from "../src/log.js";
import { errorMessage } from "../src/providers/errors.js";
import { directoryAt, recordSessionDirectory } from "../src/session-directory.js";

export type DirectoryIssue = {
  kind: "unrecorded" | "unavailable";
  recorded?: string;
  suggested: string;
  detail?: string;
};

/** 只检查用户明确给出的目录;保留符号链接路径,不猜项目根。 */
export function sessionDirectoryError(cwd: string): string | undefined {
  try {
    if (!statSync(cwd).isDirectory()) return `Not a directory: ${cwd}`;
  } catch (error) {
    return `Directory is unavailable: ${cwd}: ${errorMessage(error)}`;
  }
  return undefined;
}

/** 目录事实等目标准备完成后提交,取消与准备失败都不改原绑定。 */
export async function prepareSessionDirectory(
  log: EventLog,
  options: {
    entryCwd: string;
    directory?: string;
    chooseDirectory?: (issue: DirectoryIssue) => Promise<string | undefined>;
  },
): Promise<{ cwd: string; commit(): void } | undefined> {
  const recorded = directoryAt(log.events);
  let candidate = options.directory?.trim() ?? recorded?.cwd;
  let suggested = options.directory ?? options.entryCwd;
  for (;;) {
    const cwd = candidate === undefined ? undefined : resolve(options.entryCwd, candidate);
    const detail =
      candidate === ""
        ? "Enter a directory path."
        : cwd === undefined
          ? undefined
          : sessionDirectoryError(cwd);
    if (cwd !== undefined && detail === undefined) {
      let committed = false;
      return {
        cwd,
        commit() {
          if (committed) return;
          if (directoryAt(log.events) !== recorded)
            throw new Error(
              "Session directory changed during preparation; prepare the session again.",
            );
          recordSessionDirectory(log, cwd);
          committed = true;
        },
      };
    }
    const issue: DirectoryIssue = {
      kind: cwd === undefined ? "unrecorded" : "unavailable",
      ...(recorded && { recorded: recorded.cwd }),
      suggested: resolve(options.entryCwd, suggested),
      ...(detail && { detail }),
    };
    if (!options.chooseDirectory) {
      const reason = detail ?? "This session has no recorded directory.";
      throw new Error(
        `${reason} Bind a directory with clarook sessions directory <file> <directory>, then resume the session.`,
      );
    }
    const selected = await options.chooseDirectory(issue);
    if (selected === undefined) return undefined;
    candidate = selected.trim();
    suggested = candidate;
  }
}
