// 零 key 演示:起本机假模型,再用 examples/config.demo.json 跑一次性模式或界面。
// 用法:pnpm demo            一次性模式跑一个任务并打印事件流
//       pnpm demo tui        打开界面(Ctrl+R 看检视器)
//       pnpm demo once "任务" [其它选项]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [mode = "once", ...rest] = process.argv.slice(2);
const port = 4111;

const server = spawn(process.execPath, [join(root, "scripts", "fake-model.mjs"), String(port)], {
  stdio: ["ignore", "inherit", "inherit"],
});
await new Promise((r) => setTimeout(r, 400));

const env = { ...process.env, CLAROOK_CONFIG: join(root, "examples", "config.demo.json") };
// 直接用 node 跑 tsx 的入口,不经 .cmd 与 shell,参数原样传递。
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const args =
  mode === "tui"
    ? [join(root, "cli", "tui.ts"), ...rest]
    : [
        join(root, "cli", "run.ts"),
        ...(rest.length > 0 ? rest : ["看看这个目录里有什么,读一下 README", "--events"]),
      ];
const child = spawn(process.execPath, [tsx, ...args], { stdio: "inherit", env });
child.on("close", (code) => {
  server.kill();
  process.exit(code ?? 0);
});
