// TUI 入口只解析参数并启动会话控制器;资源与切换不再散落在全局闭包中。
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { errorMessage } from "../src/providers/errors.js";
import { bootstrap, DEFAULT_CONFIG_PATH, parseCommonArgs, USAGE } from "./bootstrap.js";
import { startTuiSession } from "./tui-session.js";
import { checkForUpdate, UPDATE_COMMAND } from "./update-check.js";

let controller: Awaited<ReturnType<typeof startTuiSession>> | undefined;
let terminal: ProcessTerminal | undefined;
let exitCode = 0;
let fatalDetail: string | undefined;
const updateCheck = new AbortController();
const detailOf = (error: unknown) => (error as Error)?.stack ?? String(error);
const exit = () => {
  updateCheck.abort();
  if (fatalDetail) {
    console.error(`\n${fatalDetail}`);
    if (controller) console.error(`session log: ${controller.file()}`);
  }
  process.exit(exitCode);
};
const emergency = (error: unknown) => {
  updateCheck.abort();
  const errors = [`Shutdown failed: ${detailOf(error)}`];
  const attempt = (label: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      errors.push(`${label}: ${detailOf(error)}`);
    }
  };
  attempt("Cancellation failed", () => controller?.app().agent.interrupt());
  attempt("Input saving failed", () => controller?.app().flushInputs());
  attempt("Interface cleanup failed", () => controller?.app().stop());
  // 引擎或保存代码已经失效时,直接恢复终端模式,不再依赖一次 UI 渲染。
  attempt("Terminal modes could not be restored", () =>
    terminal?.write(
      "\x1b[?2026l\x1b[?2031l\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[0m\x1b[?25h",
    ),
  );
  attempt("Terminal input could not be restored", () => terminal?.stop());
  console.error(
    `\n${errors.join("\n")}\nExternal work may continue. Missing results remain unknown.`,
  );
  exit();
};
const crash = (kind: string) => (error: unknown) => {
  updateCheck.abort();
  exitCode = 70;
  const detail = `${kind}: ${detailOf(error)}`;
  if (fatalDetail) {
    emergency(detail);
    return;
  }
  fatalDetail = detail;
  if (!controller) {
    emergency("Session initialization did not complete.");
    return;
  }
  try {
    void controller.close(detail).then(exit, emergency);
  } catch (error) {
    emergency(error);
  }
};
process.on("uncaughtException", crash("uncaught exception"));
process.on("unhandledRejection", crash("unhandled promise rejection"));
try {
  let args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const boot = bootstrap();
  args = boot.resolve(args);
  if (boot.configCreated) console.log(`config template created: ${DEFAULT_CONFIG_PATH}`);
  controller = await startTuiSession({
    boot,
    args,
    terminal: () => {
      terminal = new ProcessTerminal();
      return terminal;
    },
    onExit: exit,
  });
  if (args.checkUpdates ?? true) {
    void checkForUpdate({ signal: updateCheck.signal }).then((release) => {
      if (release && !updateCheck.signal.aborted)
        controller
          ?.app()
          .note(
            `Update available · ${release.current} → ${release.latest}\nExit Clarook, then run:\n${UPDATE_COMMAND}\n/settings checkUpdates to configure · /help update for instructions`,
          );
    });
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exit(2);
}
