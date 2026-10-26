// `clarook sessions`:列出会话目录,或按时间 / 条数清理。不加 --yes 只打印将要删什么。
// 用法:clarook sessions [--dir D]
//       clarook sessions prune (--older-than 30d | --keep 20) [--dir D] [--yes]
import { loadConfig } from "../src/config.js";
import { SESSIONS_DIR, sessionsDir } from "./bootstrap.js";
import { listSessions, parseAge, pruneSessions, sessionRows } from "./sessions.js";

const argv = process.argv.slice(2);
const USAGE_SESSIONS = `Usage
  clarook sessions [--dir D]                                 list session files, newest first
  clarook sessions prune --older-than 30d [--dir D] [--yes]  delete sessions started more than 30 days ago (12h = hours)
  clarook sessions prune --keep 20 [--dir D] [--yes]         keep only the 20 most recent
  Without --yes, prune only prints what it would delete. Trace files and .mcp folders go with their session.`;

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
  return v;
}

try {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE_SESSIONS);
    process.exit(0);
  }
  const configuredDir = (): string => {
    try {
      return sessionsDir(loadConfig().config);
    } catch {
      return sessionsDir();
    }
  };
  const dir: string = flag("--dir") ?? configuredDir() ?? SESSIONS_DIR;
  const sub = argv[0];
  if (sub === "prune") {
    const older = flag("--older-than");
    const keep = flag("--keep");
    if (older === undefined && keep === undefined)
      throw new Error("prune needs --older-than <age> or --keep <n>");
    const apply = argv.includes("--yes");
    const r = pruneSessions(dir, {
      ...(older !== undefined && { olderThanDays: parseAge(older) }),
      ...(keep !== undefined && { keep: Number(keep) }),
      apply,
    });
    if (r.removed.length === 0) {
      console.log(`nothing to prune in ${dir}/ (${r.kept} sessions kept)`);
    } else {
      for (const line of sessionRows(r.removed)) console.log(`  ${line}`);
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      console.log(
        apply
          ? `deleted ${r.removed.length} sessions (${mb} MB) from ${dir}/; ${r.kept} kept`
          : `would delete ${r.removed.length} sessions (${mb} MB) from ${dir}/; ${r.kept} kept. Add --yes to delete.`,
      );
    }
  } else if (sub === undefined || sub === "list" || sub.startsWith("--")) {
    const list = listSessions(dir);
    if (list.length === 0) {
      console.log(`no sessions in ${dir}/`);
    } else {
      console.log(`${list.length} sessions in ${dir}/ (newest first)`);
      for (const line of sessionRows(list, 120)) console.log(`  ${line}`);
      console.log("resume one with: clarook --resume <file>");
    }
  } else {
    throw new Error(`unknown sessions command "${sub}"\n${USAGE_SESSIONS}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
