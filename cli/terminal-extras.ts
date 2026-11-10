// 终端的几项现代能力,全是转义序列,不依赖引擎:
// OSC 8 超链接(路径可点击)、OSC 52 写剪贴板、OSC 9 / 777 桌面通知加铃、焦点事件(CSI ?1004)、OSC 133 提示标记(按步跳转)。
// 不支持的终端会静默忽略这些序列。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Terminal } from "@earendil-works/pi-tui";

const BEL = "\x07";

/** 把文本包成 OSC 8 超链接;用 BEL 收尾,和预览转换器与 xterm 都兼容。 */
export function osc8(text: string, url: string): string {
  return `\x1b]8;;${url}${BEL}${text}\x1b]8;;${BEL}`;
}

/** 文件路径的 file:// 地址;相对路径按工作目录解析。 */
export function fileUrl(path: string, cwd = process.cwd()): string {
  return pathToFileURL(resolve(cwd, path)).href;
}

/** 写系统剪贴板(OSC 52)。终端要允许剪贴板写入;不允许就什么都不发生。 */
export function copySequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}${BEL}`;
}

/** 桌面通知:OSC 9(iTerm2、Windows Terminal 等)、OSC 777(rxvt、WezTerm 等),再加一声铃。 */
export function notifySequence(title: string, body: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符与分号会截断 OSC 串,必须换掉
  const safe = (s: string) => s.replace(/[\x00-\x1f;]/g, " ");
  return `\x1b]9;${safe(`${title}: ${body}`)}${BEL}\x1b]777;notify;${safe(title)};${safe(body)}${BEL}${BEL}`;
}

/** 焦点事件:开了之后终端在得焦/失焦时发 CSI I / CSI O。 */
export const FOCUS_ON = "\x1b[?1004h";
export const FOCUS_OFF = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

/**
 * 在终端层记焦点:输入进引擎之前先看一眼 CSI I / CSI O。备用屏引擎自己也吃这两个序列(用来收拾鼠标选区),
 * 所以不能靠引擎的输入监听;包一层终端,与引擎无关。序列照常往下传。
 */
export function withFocusTracking(
  terminal: Terminal,
  onFocus: (focused: boolean) => void,
): Terminal {
  return new Proxy(terminal, {
    get(target, prop) {
      if (prop === "start") {
        return (onInput: (data: string) => void, onResize: () => void) =>
          target.start((data) => {
            if (data === FOCUS_IN) onFocus(true);
            else if (data === FOCUS_OUT) onFocus(false);
            onInput(data);
          }, onResize);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

/** OSC 133;A:一步的开头。备用屏的 Ctrl+↑ / Ctrl+↓ 按它跳。 */
export const PROMPT_MARK = `\x1b]133;A${BEL}`;

/** 用系统默认程序打开一个地址(备用屏里点击链接时)。 */
export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    // 地址直传系统处理器,不交 shell 解释;启动失败异步报告,也不能终止聊天。
    spawn(cmd, args, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // 打不开就算了;界面不因此出错。
  }
}
