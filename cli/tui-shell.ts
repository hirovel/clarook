// 用户终端入口:只解释前缀,不展开技能、附件或 @路径。执行和原始输出沿既有管线。
import { randomUUID } from "node:crypto";
import { now } from "../src/events.js";
import { openOutput } from "../src/exchange.js";
import { ToolOutcomeUnknownError } from "../src/tools.js";
import { c } from "./theme.js";
import { DEFAULT_TIMEOUT_S, executeUserShell } from "./tools/bash.js";
import { Block } from "./tui-block.js";
import type { TuiContext } from "./tui-context.js";
import { plainDisplayText } from "./tui-format.js";
import { confirm } from "./tui-menu.js";

export function shellInput(
  text: string,
): { command: string; excludeFromContext: boolean } | undefined {
  const value = text.trimStart();
  const mark = value[0];
  if (mark !== "!" && mark !== "！") return;
  const excludeFromContext = value.startsWith(mark + mark);
  return { command: value.slice(excludeFromContext ? 2 : 1).trim(), excludeFromContext };
}

/** 前缀是模式与范围的唯一来源;Esc 只为当前编辑中的草稿明确选择聊天。 */
export function shellDraft(ctx: TuiContext, text = ctx.editor.getExpandedText()) {
  if (ctx.view.shellAsText && text.trim() === ctx.editor.getExpandedText().trim()) return;
  return shellInput(text);
}

export function toggleShellScope(ctx: TuiContext): void {
  const draft = ctx.editor.getExpandedText().trimStart();
  const input = shellDraft(ctx, draft);
  if (!input) return;
  const content = draft.slice(input.excludeFromContext ? 2 : 1);
  ctx.editor.setText(`${input.excludeFromContext ? "!" : "!!"}${content}`);
  ctx.tui.requestRender();
}

/** /shell 只准备输入,不执行;面板入口保留现有草稿,参数覆盖须明确确认。 */
export async function enterShell(ctx: TuiContext, arg: string): Promise<void> {
  if (ctx.inputReading) {
    ctx.note(c.soft("Preparing paste; enter Shell after it appears."));
    return;
  }
  const draft = ctx.editor.getExpandedText();
  const fromCommand = /^\s*\/shell(?:\s|$)/.test(draft);
  if (arg && draft && !fromCommand) {
    if (!(await confirm(ctx, "Replace the current draft?", "Prepare this shell command"))) return;
    if (ctx.editor.getExpandedText() !== draft || ctx.inputReading) {
      ctx.note(c.soft("Draft changed while choosing. Kept it; choose Shell again."));
      return;
    }
  }
  const content = arg || (fromCommand ? "" : draft);
  ctx.view.shellAsText = false;
  ctx.editor.setText(shellInput(content) ? content : `!${content}`);
  ctx.tui.requestRender();
}

export function shellScope(excluded: boolean): string {
  return excluded ? "Excluded from model context" : "Included in next context";
}

export async function runUserShell(
  ctx: TuiContext,
  input: NonNullable<ReturnType<typeof shellInput>>,
): Promise<void> {
  if (!input.command) {
    ctx.note(
      c.soft(
        "Type !command to include its result in context, or !!command for local only. No API request.",
      ),
    );
    return;
  }
  if (ctx.agent.running) {
    ctx.note(c.soft("Work is running. Wait or press Esc first; this command is kept, not queued."));
    return;
  }
  const cwd = ctx.cwd;
  const id = randomUUID();
  const draft = shellInput(ctx.editor.getExpandedText());
  const fromEditor =
    draft?.command === input.command && draft.excludeFromContext === input.excludeFromContext;
  const preview = new Block("", { truncate: true });
  ctx.showLoader("User shell");
  try {
    const pending = ctx.agent.runLocal(async (signal) => {
      const output = openOutput(ctx.log, "User shell original output");
      const start = Date.now();
      ctx.log.append({
        type: "ext/event",
        at: now(),
        source: "shell",
        kind: "start",
        payload: {
          id,
          command: input.command,
          cwd,
          excludeFromContext: input.excludeFromContext,
          ...(output && { output: output.ref }),
        },
      });
      if (fromEditor) {
        ctx.editor.setText("");
        ctx.deps.inputs?.setDraft("", ctx.draftImages);
      }
      ctx.transcript.addChild(preview);
      let result: { content: string; isError: boolean; status: string; outcome?: "unknown" };
      try {
        await ctx.log.checkpoint(signal);
        signal.throwIfAborted();
        result = await executeUserShell(
          input.command,
          cwd,
          { signal, ...(output && { output }) },
          (text) => {
            const lines = plainDisplayText(text).split("\n");
            preview.setText(
              c.soft(
                lines
                  .slice(-5)
                  .map((line) => `  ${line}`)
                  .join("\n"),
              ),
            );
            ctx.tui.requestRender();
          },
        );
      } catch (error) {
        result = {
          content: (error as Error).message,
          isError: true,
          status: error instanceof ToolOutcomeUnknownError ? "Result unknown" : "Execution error",
          ...(error instanceof ToolOutcomeUnknownError && { outcome: "unknown" as const }),
        };
      } finally {
        ctx.transcript.removeChild(preview);
      }
      ctx.log.append({
        type: "user/shell",
        at: now(),
        id,
        command: input.command,
        cwd,
        excludeFromContext: input.excludeFromContext,
        ...result,
        durationMs: Date.now() - start,
      });
    });
    ctx.updateStatus();
    await pending;
  } catch (error) {
    ctx.note(c.zhu(`User shell: ${(error as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

export const SHELL_HELP = `!command: include command and result in the next context; !!command: show and save without adding to context. /shell prepares Shell input. Halfwidth ! and fullwidth ！ prefixes both work, including pasted commands. Shift+Tab switches scope; idle Esc keeps the text and returns to chat. Enter runs while idle, without an API request. Esc interrupts running work; timeout ${DEFAULT_TIMEOUT_S}s. Each command starts fresh from the project directory; cd applies only to that command. Interactive programs requiring terminal input are not supported.`;
