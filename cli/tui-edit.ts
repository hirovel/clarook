// 编辑上下文:改的是投影,不是历史。每个动作都是追加一条 context/edit 或 context/drop 事件,
// 原文永远留在数组里。/edit /drop /compare /restore /rewind /retry /edits /fork,以及上下文面板的动作菜单。

import {
  type ContextAccess,
  type ContextEffect,
  type ContextTarget,
  changeContext,
  contextView,
  type EditField,
} from "../src/context-edit.js";
import { errorMessage } from "../src/providers/errors.js";
import { type SystemPrompt, systemAt, systemParts, systemText } from "../src/system-prompt.js";
import { forkSession, SESSIONS_DIR } from "./bootstrap.js";
import type { CompositionRow, ContextAction } from "./inspector-composition.js";
import { c, G } from "./theme.js";
import { diffLines } from "./tools/diff.js";
import type { TuiContext } from "./tui-context.js";
import { plainDisplayText, toolCallDetail } from "./tui-format.js";
import { TextEditor } from "./tui-text-editor.js";

/** 运行与只读属于宿主,每次读视图和提交都取当前值。 */
function access(ctx: TuiContext): ContextAccess {
  return {
    running: ctx.agent.running,
    ...(ctx.deps.readOnlyReason && { readOnlyReason: ctx.deps.readOnlyReason }),
  };
}

/** 编辑的后果,保存时一并打印;缓存命中只能由供应商用量确认。 */
function consequenceLines(ctx: TuiContext, effect: ContextEffect): string[] {
  const out = [
    `edits to event #${effect.target} apply to future requests; original history stays; cache impact unconfirmed`,
  ];
  if (effect.opaqueDiscarded) out.push("this message's opaque block is no longer sent");
  if (ctx.agent.provider.fields?.protocol.startsWith("anthropic"))
    out.push(
      "Anthropic: thinking blocks after this point are no longer echoed back after context edits",
    );
  return out.map((line) => c.faint(`  · ${line}`));
}

export function editCommand(ctx: TuiContext, arg: string): string {
  const m = arg.match(/^(\d+)(?:\s+(text|reasoning|content|system))?(?:\s+([\s\S]+))?$/);
  if (!m)
    return c.faint(
      "Usage: /edit N [text|reasoning|content] [new text]; /edit N system [section-id] [new text]",
    );
  try {
    if (m[2] === "system") {
      const section = m[3]?.match(/^(\S+)(?:\s+([\s\S]+))?$/);
      return editContext(ctx, Number(m[1]), "system", section?.[2], section?.[1]);
    }
    return editContext(ctx, Number(m[1]), m[2] as EditField | undefined, m[3]?.trim() || undefined);
  } catch (error) {
    return c.zhu(errorMessage(error));
  }
}

/** 命令与菜单共用编辑器;字段、限制与实际写入由内核决定。 */
function editContext(
  ctx: TuiContext,
  selected: ContextTarget,
  field?: EditField,
  value?: string,
  section?: string,
): string {
  const view = contextView(ctx.log.events, selected, access(ctx));
  const target = view.target;
  const system =
    field === "system" ||
    (!field && target !== undefined && ctx.log.events[target]?.type === "session/start");
  if (
    system &&
    !section &&
    target !== undefined &&
    ctx.log.events[target]?.type === "session/start"
  ) {
    if (view.restrictions.edit) throw new Error(view.restrictions.edit);
    ctx.inspector.view.showSections(target);
    ctx.inspector.open({ keep: true });
    return "";
  }
  const spec = system
    ? view.fields.find((item) => item.field === "system" && item.section === section)
    : field
      ? view.fields.find((item) => item.field === field)
      : view.fields[0];
  if (system && !spec)
    throw new Error(
      `event #${target} has no system section ${section}; sections: ${view.fields
        .filter((item) => item.field === "system")
        .map((item) => item.section)
        .join(" / ")}. Use /edit N system <section-id> [new text].`,
    );
  if (target === undefined || !spec)
    throw new Error(
      view.restrictions.edit ??
        `event #${target} has no field ${field}; editable: ${view.fields
          .filter((item) => !item.readOnlyReason)
          .map((item) => item.field)
          .join(" / ")}`,
    );
  if (spec.readOnlyReason)
    throw new Error(
      view.restrictions[spec.field === "reasoning" ? "edit-reasoning" : "edit"] ??
        spec.readOnlyReason,
    );
  const apply = (text: string) => {
    const effect = changeContext(
      ctx.log,
      {
        type: "edit",
        target,
        field: spec.field,
        value: text,
        ...(spec.section && { section: spec.section }),
      },
      access(ctx),
    );
    return consequenceLines(ctx, effect).join("\n");
  };
  if (value !== undefined) return apply(value);
  ctx.dialog.open(
    new TextEditor(
      ctx,
      `Edit context · Event #${target} · ${spec.field}${spec.section ? ` · ${spec.section}` : ""}`,
      "Changes future requests. Original stays in history.",
      spec.current,
      apply,
    ),
  );
  return "";
}

function dropContext(ctx: TuiContext, target: ContextTarget, note?: string): string {
  const effect = changeContext(
    ctx.log,
    { type: "drop", target, ...(note && { note }) },
    access(ctx),
  );
  return consequenceLines(ctx, effect).join("\n");
}

export function dropCommand(ctx: TuiContext, arg: string): string {
  const m = arg.match(/^(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) return c.faint("Usage: /edit drop N [note]");
  try {
    return dropContext(ctx, Number(m[1]), m[2]?.trim());
  } catch (error) {
    return c.zhu(errorMessage(error));
  }
}

/** 文档比较保留段身份、来源和关闭正文,显示文本不冒充模型输入计数。 */
function systemDocument(prompt: SystemPrompt): string {
  const sections = systemParts(prompt);
  if (!sections.length) return "(empty system document)";
  return sections
    .map((section) =>
      [
        `Section: ${JSON.stringify(section.id)}`,
        `Name: ${JSON.stringify(section.name)}`,
        `State: ${section.enabled ? "on" : "off"}`,
        `Source: ${section.source === undefined ? "(none)" : JSON.stringify(section.source)}`,
        "Text:",
        section.text
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      ].join("\n"),
    )
    .join("\n\n");
}

/** /compare N:比较事实独立于当前可编辑字段,删除段仍保留在原文一侧。 */
export function compareCommand(ctx: TuiContext, arg: string): string {
  const target = Number(arg);
  const view = contextView(ctx.log.events, target, access(ctx));
  if (!Number.isInteger(target) || !ctx.log.events[target])
    return c.faint(
      "Usage: /edit compare N  (an edited user, assistant, tool-result or system event)",
    );
  if (!view.comparisons.length)
    return c.faint(
      view.restrictions.compare ?? `event #${target} has no edits; nothing to compare`,
    );
  const out: string[] = [];
  for (const comparison of view.comparisons) {
    if (comparison.field === "system") {
      out.push(
        c.soft(`· System document comparison · event #${target} · all section text and metadata`),
      );
      const lines = diffLines(
        systemDocument(comparison.original),
        systemDocument(comparison.current),
      );
      if (lines.every((line) => line.kind === " ")) out.push(c.faint("    (identical)"));
      // 完整文档不能像工具预览一样折叠未变行,否则关闭段正文仍会丢失。
      for (const line of lines) {
        const text = `    ${line.kind} ${plainDisplayText(line.text)}`;
        out.push(
          line.kind === "+" ? c.green(text) : line.kind === "-" ? c.zhu(text) : c.faint(text),
        );
      }
      continue;
    }
    const { field, original: before, current: value } = comparison;
    out.push(
      c.soft(
        `· #${target}.${field}  original ${before.length} chars → current ${value.length} chars`,
      ),
    );
    out.push(
      (toolCallDetail("edit", { oldText: before, newText: value }) || c.faint("(identical)"))
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
  return out.join("\n");
}

function restoreContext(ctx: TuiContext, target: ContextTarget): string {
  const effect = changeContext(ctx.log, { type: "restore", target }, access(ctx));
  return [
    c.soft(
      `· restored event #${effect.target} (${effect.fields.join(", ")}) · recorded as another edit, nothing deleted`,
    ),
    ...consequenceLines(ctx, effect),
  ].join("\n");
}

/** /restore N:恢复原值仍追加事实。 */
export function restoreCommand(ctx: TuiContext, arg: string): string {
  const target = Number(arg);
  if (!Number.isInteger(target)) return c.faint("Usage: /edit restore N");
  try {
    return restoreContext(ctx, target);
  } catch (error) {
    return c.zhu(errorMessage(error));
  }
}

function rewindContext(ctx: TuiContext, target: ContextTarget): string {
  const effect = changeContext(ctx.log, { type: "rewind", target }, access(ctx));
  return [
    c.soft(
      `· rewound to event #${effect.target}: dropped ${effect.dropped.length} message${effect.dropped.length === 1 ? "" : "s"} after it (tool results go with their calls)`,
    ),
    c.faint(
      "  · nothing is deleted; the next request starts from here · send your next message to use this context",
    ),
  ].join("\n");
}

/** /rewind N:实际排除目标由内核根据当前投影确定。 */
export function rewindCommand(ctx: TuiContext, arg: string): string {
  const target = Number(arg);
  if (!Number.isInteger(target))
    return c.faint("Usage: /edit rewind N  (drops every message after event N)");
  try {
    return rewindContext(ctx, target);
  } catch (error) {
    return c.zhu(errorMessage(error));
  }
}

/** /retry:编辑之后立刻看效果。丢弃以事件落盘,发送卡会标出编辑点。 */
export async function retryStep(ctx: TuiContext): Promise<void> {
  const { agent } = ctx;
  const reason = contextView(ctx.log.events, undefined, access(ctx)).restrictions.retry;
  if (reason) {
    ctx.note(c.zhu(reason));
    return;
  }
  ctx.showLoader("retrying");
  try {
    const pending = agent.retry(access(ctx));
    ctx.updateStatus();
    const outcome = await pending;
    if (typeof outcome === "object") ctx.note(c.soft(`· loop stopped: ${outcome.stopped}`));
  } catch (err) {
    ctx.note(c.zhu(`✗ ${errorMessage(err)}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

export function editsList(ctx: TuiContext): string {
  const rows = ctx.log.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "context/edit" || e.type === "context/drop");
  if (rows.length === 0)
    return c.faint("No edits. /edit N changes a message, /edit drop N drops one");
  return rows
    .map(({ e, i }) =>
      e.type === "context/edit"
        ? `  ${c.ink(`#${i}`)} ${c.ink(`edit #${e.target}.${e.field}`)} ${c.faint(`${(e.field === "system" ? systemText(e.value) : e.value).length} chars ${e.at.slice(11, 19)}`)}`
        : `  ${c.ink(`#${i}`)} ${c.ink(`drop #${(e as { target: number }).target}`)} ${c.faint(e.at.slice(11, 19))}`,
    )
    .join("\n");
}

/** /fork:复制事件前缀到新文件。事件即真相,分叉就是复制前缀,原文件不动。 */
export function forkCommand(ctx: TuiContext, arg: string): string {
  const { log } = ctx;
  let upTo: number;
  if (arg) {
    upTo = Number(arg);
    if (!Number.isInteger(upTo) || upTo < 1)
      return c.zhu("Usage: /fork or /fork N (first N events)");
  } else {
    const lastUser = [...log.events].reverse().findIndex((e) => e.type === "user/message");
    upTo = lastUser < 0 ? log.events.length : log.events.length - 1 - lastUser;
    if (upTo < 1) return c.faint("nothing to fork yet");
  }
  const r = forkSession(log.events, upTo, ctx.deps.sessionsDir ?? SESSIONS_DIR, log.recording);
  return `${c.soft(`· forked: first ${r.events} events → ${r.file}`)}\n${c.faint(`  pnpm tui -- --resume ${r.file}   continues from there; this session is untouched`)}`;
}

/** 段编辑与开关都交给同一上下文 module,不从全文还原段身份。 */
export function systemSectionAction(
  ctx: TuiContext,
  target: number,
  section: string,
  action: "toggle" | "edit" | "add",
): void {
  try {
    if (action === "add") {
      const view = contextView(ctx.log.events, target, access(ctx));
      if (view.restrictions.edit) throw new Error(view.restrictions.edit);
      ctx.inspector.close();
      if (view.fields.some((item) => item.section === "custom")) {
        ctx.note(editContext(ctx, target, "system", undefined, "custom"));
        return;
      }
      ctx.dialog.open(
        new TextEditor(
          ctx,
          `Edit context · Event #${target} · system · custom`,
          "Adds personal instructions to this session's next input.",
          "",
          (text) =>
            consequenceLines(
              ctx,
              changeContext(
                ctx.log,
                {
                  type: "replace-section",
                  target,
                  id: "custom",
                  section: { id: "custom", name: "Custom", text, enabled: true },
                },
                access(ctx),
              ),
            ).join("\n"),
        ),
      );
      return;
    }
    if (action === "edit") {
      ctx.inspector.close();
      ctx.note(editContext(ctx, target, "system", undefined, section));
      return;
    }
    changeContext(ctx.log, { type: "toggle-section", target, section }, access(ctx));
    const state = contextView(ctx.log.events, target).fields.find(
      (item) => item.section === section,
    );
    ctx.note(
      [
        c.soft(
          `${G.edited} system prompt · ${state?.name ?? section} ${state?.enabled ? "on" : "off"} · ≈${Math.ceil(systemText(systemAt(ctx.log.events)).length / 4)} tok`,
        ),
        c.faint("  · recorded as an edit; the next request uses the enabled sections"),
        c.faint("  · /settings prompt.sections makes it the start value for every session"),
      ].join("\n"),
    );
  } catch (error) {
    ctx.note(c.zhu(errorMessage(error)));
  }
}

/** 上下文面板(Ctrl+E)复用编辑流程;其余动作沿用已有命令。 */
export async function contextAction(
  ctx: TuiContext,
  action: ContextAction,
  row: CompositionRow,
): Promise<void> {
  if (action === "view") return;
  ctx.inspector.close();
  const target = { message: row.i - 1 };
  try {
    switch (action) {
      case "edit":
        ctx.note(editContext(ctx, target));
        break;
      case "edit-reasoning":
        ctx.note(editContext(ctx, target, "reasoning"));
        break;
      case "compare":
        ctx.note(compareCommand(ctx, String(row.event)));
        break;
      case "restore":
        ctx.note(restoreContext(ctx, target));
        break;
      case "drop":
        ctx.note(dropContext(ctx, target));
        break;
      case "rewind":
        ctx.note(rewindContext(ctx, target));
        break;
      case "retry":
        await retryStep(ctx);
        break;
      case "toggle-section":
        ctx.inspector.view.showSections(row.event);
        ctx.inspector.open({ keep: true });
        break;
      case "fork":
        ctx.note(forkCommand(ctx, String(row.event + 1)));
        break;
    }
  } catch (error) {
    ctx.note(c.zhu(errorMessage(error)));
  }
}
