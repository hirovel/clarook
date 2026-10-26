// 统一入口:`clarook` 开界面;`clarook once "任务"` 一次性模式;`clarook replay 文件`;`clarook sessions` 列表与清理;其余参数原样交给对应入口。
// 子命令词从 argv 里摘掉,各入口仍按自己的方式解析剩下的参数。
const [sub, ...rest] = process.argv.slice(2);
const entries: Record<string, string> = {
  tui: "./tui.js",
  once: "./run.js",
  run: "./run.js",
  replay: "./replay.js",
  sessions: "./sessions-cli.js",
};
const target = sub !== undefined && sub in entries ? entries[sub] : undefined;
if (target) {
  process.argv = [process.argv[0] as string, process.argv[1] as string, ...rest];
  await import(target);
} else {
  await import("./tui.js");
}

export {};
