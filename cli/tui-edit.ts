// 编辑上下文:改的是投影,不是历史。每个动作都是追加一条 context/edit 或 context/drop 事件,
// 原文永远留在数组里。/edit /drop /compare /restore /rewind /retry /edits /fork,以及上下文面板的动作菜单。
import { now } from "../src/events.js";
import { composeContext, contextFields, type EditField, editState } from "../src/messages.js";
import { errorMessage } from "../src/providers/errors.js";
import { forkSession, SESSIONS_DIR } from "./bootstrap.js";
import {
  type CompositionRow,
  type ContextAction,
  contextEditRestriction,
  contextRewindRestriction,
  rewindRestriction,
} from "./inspector-composition.js";
import { sectionStates, systemWithSections } from "./prompt-sections.js";
import { c, G } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { toolCallDetail } from "./tui-format.js";
import { TextEditor } from "./tui-text-editor.js";

const BUSY = "cannot edit while running; press Esc first";

/** 编辑的后果,保存时一并打印;缓存命中只能由供应商用量确认。 */
function editConsequences(ctx: TuiContext, target: number): string[] {
  const out = [
    `edits to event #${target} apply to future requests; original history stays; cache impact unconfirmed`,
  ];
  const e = ctx.log.events[target];
  if (e?.type === "assistant/message" && e.opaque !== undefined)
    out.push("this message's opaque block is no longer sent");
  if (ctx.agent.provider.fields?.protocol.startsWith("anthropic")) {
    out.push(
      "Anthropic: thinking blocks after this point are no longer echoed back after context edits",
    );
  }
  return out;
}

const consequenceLines = (ctx: TuiContext, target: number) =>
  editConsequences(ctx, target).map((s) => c.faint(`  · ${s}`));

export function editCommand(ctx: TuiContext, arg: string): string {
  if (ctx.agent.running) return c.zhu(BUSY);
  const m = arg.match(/^(\d+)(?:\s+(text|reasoning|content|system))?(?:\s+([\s\S]+))?$/);
  if (!m)
    return c.faint(
      "Usage: /edit N [text|reasoning|content|system] [new text]; omit text to edit here",
    );
  return editContext(ctx, Number(m[1]), m[2] as EditField | undefined, m[3]?.trim() || undefined);
}

/** 菜单直接传目标与字段;只有打字命令需要先解析字符串。 */
function editContext(ctx: TuiContext, target: number, field?: EditField, value?: string): string {
  const { log, agent } = ctx;
  if (ctx.deps.readOnlyReason) return c.zhu(ctx.deps.readOnlyReason);
  if (agent.running) return c.zhu(BUSY);
  const event = log.events[target];
  if (!event)
    return c.zhu(`no event #${target} (${log.events.length} events; Ctrl+E shows event numbers)`);
  const restriction = contextEditRestriction(composeContext(log.events), target);
  if (restriction) return c.zhu(restriction);
  const fields = contextFields(event, editState(log.events).edits.get(target));
  if (fields.length === 0)
    return c.zhu(`event #${target} is ${event.type}; it never reaches the model, nothing to edit`);
  const spec = field ? fields.find((f) => f.field === field) : fields[0];
  if (!spec)
    return c.zhu(
      `event #${target} has no field ${field}; editable: ${fields
        .filter((f) => !f.readOnlyReason)
        .map((f) => f.field)
        .join(" / ")}`,
    );
  if (spec.readOnlyReason) return c.zhu(`event #${target} ${spec.readOnlyReason}`);
  const apply = (value: string) => {
    if (ctx.deps.readOnlyReason) throw new Error(ctx.deps.readOnlyReason);
    if (agent.running) throw new Error(BUSY);
    const restriction = contextEditRestriction(composeContext(log.events), target);
    if (restriction) throw new Error(restriction);
    log.append({ type: "context/edit", at: now(), target, field: spec.field, value });
    return consequenceLines(ctx, target).join("\n");
  };
  if (value === undefined) {
    ctx.dialog.open(
      new TextEditor(
        ctx,
        `Edit context · Event #${target} · ${spec.field}`,
        "Changes future requests. Original stays in history.",
        spec.current,
        apply,
      ),
    );
    return "";
  }
  return apply(value);
}

export function dropCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const m = arg.match(/^(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) return c.faint("Usage: /edit drop N [note]");
  const target = Number(m[1]);
  const e = log.events[target];
  if (!e) return c.zhu(`no event #${target}`);
  const restriction = contextEditRestriction(composeContext(log.events), target);
  if (restriction) return c.zhu(restriction);
  if (
    e.type !== "user/message" &&
    e.type !== "assistant/message" &&
    !(e.type === "user/shell" && !e.excludeFromContext)
  ) {
    return c.zhu(
      `only user or assistant messages can be dropped (with their tool results); #${target} is ${e.type}`,
    );
  }
  const note = m[2]?.trim();
  log.append({ type: "context/drop", at: now(), target, ...(note && { note }) });
  return consequenceLines(ctx, target).join("\n");
}

/** /compare N:编辑过的字段,原文与现值的行级 diff。 */
export function compareCommand(ctx: TuiContext, arg: string): string {
  const target = Number(arg);
  const cur = editState(ctx.log.events).edits.get(target) ?? {};
  const specs = contextFields(ctx.log.events[target], cur);
  if (!Number.isInteger(target) || specs.length === 0)
    return c.faint(
      "Usage: /edit compare N  (an edited user, assistant, tool-result or system event)",
    );
  const fields = specs.filter((f) => cur[f.field] !== undefined);
  if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to compare`);
  const out: string[] = [];
  for (const { field, original: before, current: value } of fields) {
    out.push(
      c.soft(
        `· #${target}.${field}  original ${before.length} chars → current ${value.length} chars`,
      ),
    );
    out.push(
      (toolCallDetail("edit", { oldText: before, newText: value }) || c.faint("(identical)"))
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
  return out.join("\n");
}

/** /restore N:把编辑过的字段改回原值。记成又一次编辑;事件数组只增不删。 */
export function restoreCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const target = Number(arg);
  const restriction = contextEditRestriction(composeContext(log.events), target);
  if (restriction) return c.zhu(restriction);
  const cur = editState(log.events).edits.get(target) ?? {};
  const specs = contextFields(log.events[target], cur);
  if (!Number.isInteger(target) || specs.length === 0) return c.faint("Usage: /edit restore N");
  const fields = specs.filter((f) => cur[f.field] !== undefined);
  if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to restore`);
  for (const { field, original } of fields) {
    log.append({
      type: "context/edit",
      at: now(),
      target,
      field,
      value: original,
      note: "restore",
    });
  }
  return [
    c.soft(
      `· restored event #${target} (${fields.map((f) => f.field).join(", ")}) · recorded as another edit, nothing deleted`,
    ),
    ...consequenceLines(ctx, target),
  ].join("\n");
}

/** /rewind N:丢弃事件 N 之后的每条用户与助手消息(工具结果随调用一起走)。下一请求从 N 起。 */
export function rewindCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const target = Number(arg);
  if (!Number.isInteger(target) || !log.events[target])
    return c.faint("Usage: /edit rewind N  (drops every message after event N)");
  const restriction = rewindRestriction(log.events, target);
  if (restriction) return c.zhu(restriction);
  const dropped = editState(log.events).dropped;
  const victims = log.events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e, i }) =>
        i > target &&
        (e.type === "user/message" ||
          e.type === "assistant/message" ||
          (e.type === "user/shell" && !e.excludeFromContext)) &&
        !dropped.has(i),
    );
  if (victims.length === 0) return c.faint(`nothing after event #${target} to drop`);
  for (const { i } of victims)
    log.append({ type: "context/drop", at: now(), target: i, note: `rewind to #${target}` });
  return [
    c.soft(
      `· rewound to event #${target}: dropped ${victims.length} message${victims.length === 1 ? "" : "s"} after it (tool results go with their calls)`,
    ),
    c.faint(
      "  · nothing is deleted; the next request starts from here · send your next message to use this context",
    ),
  ].join("\n");
}

/** /retry:编辑之后立刻看效果。丢弃以事件落盘,发送卡会标出编辑点。 */
export async function retryStep(ctx: TuiContext): Promise<void> {
  const { agent } = ctx;
  if (agent.running) {
    ctx.note(c.zhu("cannot retry while running; press Esc first"));
    return;
  }
  ctx.showLoader("retrying");
  try {
    const pending = agent.retry();
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
        ? `  ${c.ink(`#${i}`)} ${c.ink(`edit #${e.target}.${e.field}`)} ${c.faint(`${e.value.length} chars ${e.at.slice(11, 19)}`)}`
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

/**
 * 工作台的 system 行:翻一段。新的系统提示词 = 开着的段按原顺序以空行相接,记成对事件 #0 的一次编辑;
 * 原文留在事件里,再翻回来就是又一次编辑。切不回段(旧日志)时说明原因。
 */
export function flipSection(ctx: TuiContext, name: string): void {
  if (ctx.deps.readOnlyReason) {
    ctx.note(c.zhu(ctx.deps.readOnlyReason));
    return;
  }
  const { log, agent } = ctx;
  if (agent.running) {
    ctx.note(c.zhu(BUSY));
    return;
  }
  const states = sectionStates(log.events);
  const target = log.events.findIndex((e) => e.type === "session/start");
  if (!states || target < 0) {
    ctx.note(
      c.zhu(
        "Section text cannot be reconstructed. Use /edit 0 system for the full text, or /session to rebuild from current/defaults.",
      ),
    );
    return;
  }
  const s = states.find((x) => x.name === name);
  if (!s) return;
  const value = systemWithSections(states, name);
  const on = states.filter((x) => (x.name === name ? !x.on : x.on)).map((x) => x.name);
  log.append({
    type: "context/edit",
    at: now(),
    target,
    field: "system",
    value,
    note: `sections: ${on.join(", ") || "(none)"}`,
  });
  ctx.note(
    [
      c.soft(
        `${G.edited} system prompt · ${name} ${s.on ? "off" : "on"} · ≈${Math.ceil(value.length / 4)} tok`,
      ),
      c.faint(
        "  · recorded as an edit of event #0; the cached prefix is recomputed from the top on the next request",
      ),
      c.faint("  · /settings prompt.sections makes it the start value for every session"),
    ].join("\n"),
  );
}

/** 上下文面板(Ctrl+E)复用编辑流程;其余动作沿用已有命令。 */
export async function contextAction(
  ctx: TuiContext,
  action: ContextAction,
  row: CompositionRow,
): Promise<void> {
  if (action === "view") return;
  if (ctx.deps.readOnlyReason && action !== "compare" && action !== "fork") {
    ctx.note(c.zhu(ctx.deps.readOnlyReason));
    return;
  }
  ctx.inspector.close();
  const target = row.event;
  switch (action) {
    case "edit":
      ctx.note(editContext(ctx, target));
      break;
    case "edit-reasoning":
      ctx.note(editContext(ctx, target, "reasoning"));
      break;
    case "compare":
      ctx.note(compareCommand(ctx, String(target)));
      break;
    case "restore":
      ctx.note(restoreCommand(ctx, String(target)));
      break;
    case "drop":
      ctx.note(dropCommand(ctx, String(target)));
      break;
    case "rewind": {
      const restriction = contextRewindRestriction(ctx.log.events, row);
      ctx.note(restriction ? c.zhu(restriction) : rewindCommand(ctx, String(target)));
      break;
    }
    case "retry":
      await retryStep(ctx);
      break;
    case "fork":
      ctx.note(forkCommand(ctx, String(target + 1)));
      break;
  }
}
