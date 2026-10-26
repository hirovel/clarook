// 策略槽在会话中切换:每次切换记 session/slot,下一次 turn 起生效。
// 审批槽的三种形态与审批提示组件也在这里:它是唯一需要界面参与的槽。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type ApprovalConfig,
  type ApproveDecision,
  DEFAULT_APPROVAL,
  describeApproval,
  policyApprove,
} from "../src/approval.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/compaction-presets.js";
import { DEFAULT_CONFIG_PATH, type Preset, updateConfig } from "../src/config.js";
import { now, type ToolCall } from "../src/events.js";
import { type ApprovePolicy, allowAll, queueToTurnEnd, steer } from "../src/loop.js";
import { isCompactionTrigger, parsePreservation } from "./bootstrap.js";
import { buildCompaction } from "./strategies.js";
import { c, G, selectedText } from "./theme.js";
import {
  applyToolPrompts,
  describeToolPrompts,
  isToolPromptStyle,
  STYLE_NOTES,
  styleTokens,
  TOOL_PROMPT_STYLES,
} from "./tool-prompts.js";
import type { TuiAppDeps } from "./tui-app.js";
import type { ApprovalState, TuiContext } from "./tui-context.js";
import { formatArgs, printableInput, toolCallDetail } from "./tui-format.js";
import { TextEditor } from "./tui-text-editor.js";

// ---------- 审批 ----------

type ApprovalChoice = { kind: "allow" | "deny" | "allow-session"; reason?: string };

/** 审批的四个选项,顺序固定:允许一次、允许并记住(作用域写在文案里)、拒绝并说明、拒绝。 */
type ApprovalOption = { kind: ApprovalChoice["kind"] | "reason"; label: string };

const OPTIONS: ApprovalOption[] = [
  { kind: "allow", label: "Allow once" },
  { kind: "allow-session", label: "Allow this tool for this session" },
  { kind: "reason", label: "Deny and tell the model why" },
  { kind: "deny", label: "Deny" },
];

/**
 * 审批提示:一行问题(工具、参数、为什么要问),edit/write 的 diff,四个纵向选项,一行淡色提示。
 * ↑↓ 或数字 1–4 移动,Enter 执行;Esc 视为拒绝。
 * 第三项进入输入理由,理由原样进工具结果喂回模型。
 */
export class ApprovalPrompt implements Component {
  private mode: "choose" | "reason" = "choose";
  private reason = "";
  private index = 0;
  private offset = 0;
  private reasonOffset = 0;
  private page = 1;
  private contentRows = 0;
  private contentWidth = -1;
  private content: string[] = [];

  constructor(
    private readonly call: ToolCall,
    private readonly why: string,
    private readonly onDecide: (d: ApprovalChoice) => void,
    private readonly onChange: () => void = () => {},
    private readonly height: () => number = () => 30,
  ) {}

  render(width = 120): string[] {
    const inner = Math.max(1, width - 2);
    if (this.mode === "choose" && this.contentWidth !== inner) {
      const detail =
        toolCallDetail(this.call.name, this.call.args, "full") ||
        JSON.stringify(this.call.args, null, 2);
      this.content = [
        c.faint(this.why),
        ...(visibleWidth(this.call.name) > inner - 2 ? [c.soft(this.call.name)] : []),
        c.soft(formatArgs(this.call.args)),
        ...(detail ? detail.split("\n") : []),
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      this.contentWidth = inner;
    }
    const all =
      this.mode === "reason"
        ? wrapTextWithAnsi(`${c.soft("reason:")} ${c.ink(this.reason)}${c.faint("▏")}`, inner)
        : this.content;
    const layout = (actions: string[]) => {
      const rows = actions.flatMap((line) => wrapTextWithAnsi(line, inner));
      this.contentRows = all.length;
      // 身份、分隔与操作先占预算;内容超长时再为分页读数留一行。
      const room = Math.max(1, this.height() - rows.length - 2);
      this.page = Math.max(1, room - Number(all.length > room));
      const offset = Math.min(
        this.mode === "reason" ? this.reasonOffset : this.offset,
        Math.max(0, all.length - this.page),
      );
      if (this.mode === "reason") this.reasonOffset = offset;
      else this.offset = offset;
      return [
        truncateToWidth(`${c.zhu("?")} ${c.bold(c.ink(this.call.name))}`, inner, "…"),
        ...all.slice(offset, offset + this.page),
        ...(all.length > this.page
          ? [
              truncateToWidth(
                c.faint(
                  `PgUp/PgDn ${this.mode === "reason" ? "reason" : "details"} · ${offset + 1}-${Math.min(all.length, offset + this.page)}/${all.length}`,
                ),
                inner,
                "…",
              ),
            ]
          : []),
        "",
        ...rows,
      ].map((line) => ` ${line}`);
    };
    if (this.mode === "reason") {
      return layout([c.faint("  Enter deny with this reason · Esc back")]);
    }
    const options = OPTIONS;
    const labelWidth = Math.max(...options.map((o) => o.label.length));
    // 窄屏不补齐短选项;尾部空格会把按键提示挤到下一行,耗尽详情和操作区域。
    const aligned = labelWidth + 16 <= inner;
    const rows = options.map((o, i) => {
      const cursor = i === this.index ? selectedText(G.cursor) : " ";
      const label = aligned ? o.label.padEnd(labelWidth) : o.label;
      const text = i === this.index ? selectedText(label) : c.ink(label);
      return `  ${cursor} ${c.faint(`${i + 1}.`)} ${text}${o.kind === "deny" ? c.faint("  Esc") : ""}`;
    });
    return layout([...rows, c.faint("  ↑↓ or 1–4 choose · Enter confirm · Esc deny")]);
  }

  private choose(o: ApprovalOption): void {
    if (o.kind === "reason") {
      this.mode = "reason";
      this.onChange();
      return;
    }
    this.onDecide({ kind: o.kind });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const offset = Math.max(
        0,
        Math.min(
          Math.max(0, this.contentRows - this.page),
          (this.mode === "reason" ? this.reasonOffset : this.offset) +
            (matchesKey(data, "pageUp") ? -this.page : this.page),
        ),
      );
      if (this.mode === "reason") this.reasonOffset = offset;
      else this.offset = offset;
      this.onChange();
      return;
    }
    if (this.mode === "reason") {
      const before = this.reason;
      if (matchesKey(data, Key.enter)) {
        const reason = this.reason.trim();
        this.onDecide({ kind: "deny", ...(reason && { reason }) });
      } else if (matchesKey(data, Key.escape)) {
        this.mode = "choose";
        this.reason = "";
        this.reasonOffset = 0;
      } else if (matchesKey(data, Key.backspace) || data === "\b")
        this.reason = Array.from(this.reason).slice(0, -1).join("");
      else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~"))
        this.reason += printableInput(data);
      // 编辑仍发生在末尾;分页查看不会改文本,继续输入时才回到末尾。
      if (this.mode === "reason" && this.reason !== before)
        this.reasonOffset = Number.POSITIVE_INFINITY;
      this.onChange();
      return;
    }
    const options = OPTIONS;
    if (matchesKey(data, Key.up)) this.index = (this.index + 3) % 4;
    else if (matchesKey(data, Key.down)) this.index = (this.index + 1) % 4;
    else if (/^[1-4]$/.test(data)) this.index = Number(data) - 1;
    else if (matchesKey(data, Key.enter)) {
      this.choose(options[this.index] as ApprovalOption);
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.onDecide({ kind: "deny" });
      return;
    }
    this.onChange();
  }

  invalidate(): void {}
}

/** 审批状态的启动形态:deps.approve 是 all / ask / 规则对象。 */
export function initialApproval(approve: TuiAppDeps["approve"]): ApprovalState {
  return {
    cfg: structuredClone(typeof approve === "object" ? approve : DEFAULT_APPROVAL),
    mode: approve === undefined ? "all" : typeof approve === "string" ? approve : "policy",
    alwaysAllow: new Set(),
    overlay: undefined,
    prompt: undefined,
  };
}

/** 问一次就是一次;选择本会话放行才把工具加进临时名单。拒绝以错误结果回喂模型。 */
export function askApproval(
  ctx: TuiContext,
  call: ToolCall,
  why = "asked for every call",
  signal?: AbortSignal,
): Promise<ApproveDecision> {
  const a = ctx.approval;
  if (signal?.aborted) return Promise.resolve(false);
  if (a.alwaysAllow.has(call.name)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision?: ApprovalChoice) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (a.prompt === prompt) {
        a.overlay?.hide();
        a.overlay = undefined;
        a.prompt = undefined;
        ctx.updateStatus();
        ctx.tui.setFocus(ctx.editor);
      }
      if (!decision) {
        ctx.note(c.faint(`· approve: cancelled ${call.name}; not executed`));
        resolve(false);
        return;
      }
      if (decision.kind === "allow-session") {
        a.alwaysAllow.add(call.name);
        // 同时写进规则,/approve 能看到本会话放行了什么。
        a.cfg.allow = a.cfg.allow ?? [];
        if (!a.cfg.allow.includes(call.name)) a.cfg.allow.push(call.name);
      }
      const allowed = decision.kind !== "deny";
      ctx.note(
        allowed
          ? c.faint(
              `· approve: allowed ${call.name}${decision.kind === "allow-session" ? " (not asked again this session)" : ""}`,
            )
          : c.zhu(`· approve: denied ${call.name}${decision.reason ? `: ${decision.reason}` : ""}`),
      );
      resolve(
        allowed ? true : { allowed: false, ...(decision.reason && { reason: decision.reason }) },
      );
    };
    const onAbort = () => finish();
    const prompt = new ApprovalPrompt(
      call,
      why,
      finish,
      () => ctx.tui.requestRender(),
      () => ctx.deps.terminal.rows,
    );
    a.prompt = prompt;
    a.overlay = ctx.tui.showOverlay(prompt, { width: "100%", anchor: "bottom-left" });
    signal?.addEventListener("abort", onAbort, { once: true });
    ctx.updateStatus();
    ctx.notify(`approval needed: ${call.name}`);
  });
}

/** 审批槽的三种形态:all 不问;ask 每个调用都问;policy 按规则裁决,ask 的才问。 */
export function approveImpl(ctx: TuiContext): ApprovePolicy {
  const a = ctx.approval;
  if (a.mode === "all") return allowAll;
  const label = (why: string, origin?: { agent: string }) =>
    origin ? `${origin.agent} · ${why}` : why;
  if (a.mode === "ask")
    return (call, origin, signal) =>
      askApproval(ctx, call, label("asked for every call", origin), signal);
  return policyApprove(a.cfg, (call, why, origin, signal) =>
    askApproval(ctx, call, label(why, origin), signal),
  );
}

export function approveValue(a: ApprovalState): string {
  return a.mode === "policy" ? `policy: ${describeApproval(a.cfg)}` : a.mode;
}

// ---------- 槽的当前形态与切换 ----------

/** 槽的原始配置值;展示说明不参与保存和恢复。 */
export function initialSlotState(
  deps: TuiAppDeps,
  approval: ApprovalState,
): Record<string, string> {
  return {
    compaction: deps.compactionName ?? "llm",
    preservation: deps.preservationSpec ?? "",
    execution: deps.slots?.execution ?? "sequential",
    steering:
      deps.slots?.steering === queueToTurnEnd ? "turn" : deps.slots?.steering ? "custom" : "step",
    approve: approveValue(approval),
    toolPrompts: describeToolPrompts(deps.toolPrompts),
  };
}

export function recordSlot(ctx: TuiContext, slot: string, value: string): void {
  // 触发时机由 compaction.trigger 持有,不另存一份运行值。
  if (slot !== "compactionTrigger") ctx.slots.state[slot] = value;
  ctx.log.append({ type: "session/slot", at: now(), slot, value });
}

/** 组合名称由这些实际值匹配;不另存一份会影响运行的预设状态。 */
export function currentCompactionSettings(ctx: TuiContext): Preset {
  const initial = { ...DEFAULT_COMPACTION_SETTINGS, ...ctx.setupBase };
  return {
    compaction: ctx.slots.state.compaction ?? initial.compaction,
    compactionTrigger: ctx.compaction.trigger ?? initial.compactionTrigger,
    compactionReserve: ctx.compaction.reserveTokens ?? initial.compactionReserve,
    compactionRatio: ctx.compaction.ratio ?? initial.compactionRatio,
    preservation:
      ctx.slots.state.preservation ||
      initial.preservation ||
      DEFAULT_COMPACTION_SETTINGS.preservation,
    compactionPrompt: ctx.slots.state.compactionPrompt ?? initial.compactionPrompt,
    compactionMaxTokens:
      ctx.slots.state.compactionMaxTokens === undefined
        ? initial.compactionMaxTokens
        : Number(ctx.slots.state.compactionMaxTokens),
    compactionAcceptance: ctx.compaction.acceptance ?? initial.compactionAcceptance,
  };
}

/** 设置与命令共用实际修改;失败抛异常,不把显示文案当作结果协议。 */
export async function applySlotValue(ctx: TuiContext, slot: string, value: string): Promise<void> {
  if (ctx.agent.running) throw new Error("Cannot switch a slot while running; press Esc first.");
  switch (slot) {
    case "compaction":
    case "compactionPrompt":
    case "compactionMaxTokens":
    case "compactionAcceptance": {
      const next = await buildCompaction(
        {
          ...currentCompactionSettings(ctx),
          [slot]: slot === "compactionMaxTokens" ? Number(value) : value,
        },
        ctx.compaction.window,
      );
      if (ctx.agent.running)
        throw new Error("Cannot switch a slot while running; press Esc first.");
      delete ctx.compaction.preservation;
      Object.assign(ctx.compaction, next);
      break;
    }
    case "compactionTrigger":
      if (!isCompactionTrigger(value)) throw new Error("Unknown compaction trigger");
      ctx.compaction.trigger = value;
      break;
    case "preservation":
      ctx.compaction.preservation = parsePreservation(value, ctx.compaction.window).policy;
      break;
    case "execution":
      if (value !== "sequential" && value !== "parallel")
        throw new Error("Unknown execution strategy");
      ctx.agent.setSlot("execution", value);
      break;
    case "steering":
      if (value !== "step" && value !== "turn") throw new Error("Unknown steering strategy");
      ctx.agent.setSlot("steering", value === "step" ? steer : queueToTurnEnd);
      break;
    case "approve":
      if (value !== "all" && value !== "ask" && value !== "policy")
        throw new Error("Unknown approval mode");
      ctx.approval.mode = value;
      ctx.agent.setSlot("approve", approveImpl(ctx));
      value = approveValue(ctx.approval);
      break;
    case "toolPrompts":
      setToolPromptStyle(ctx, value);
      return;
    default:
      throw new Error(`Unknown slot ${slot}`);
  }
  recordSlot(ctx, slot, value);
}

function setToolPromptStyle(ctx: TuiContext, value: string): string[] {
  if (!isToolPromptStyle(value)) throw new Error("Unknown tool prompt style");
  ctx.slots.toolPrompts.style = value;
  const changed = applyToolPrompts(ctx.tools, ctx.slots.toolPrompts);
  recordSlot(ctx, "toolPrompts", describeToolPrompts(ctx.slots.toolPrompts));
  return changed;
}

function slotDescription(ctx: TuiContext, slot: string, value: string): string {
  if (slot === "compaction") return `${value} · trigger ${ctx.compaction.trigger ?? "threshold"}`;
  if (slot === "preservation")
    return parsePreservation(
      value || DEFAULT_COMPACTION_SETTINGS.preservation,
      ctx.compaction.window,
    ).label;
  return value;
}

/** /slots:当前每个槽的实现。全部是可切换的;切换记事件。 */
export function slotsList(ctx: TuiContext): string {
  const rows = Object.entries(ctx.slots.state).map(
    ([k, val]) => `  ${c.ink(k.padEnd(13))} ${c.ink(slotDescription(ctx, k, val))}`,
  );
  return [
    `${c.soft("Slots")}  ${c.faint("switch with /compaction /preservation /execution /steering /approve /toolprompts; each switch is a session/slot event")}`,
    ...rows,
    `  ${c.ink("termination".padEnd(13))} ${c.ink(ctx.deps.slots?.termination ? "custom" : "untilIdle")}  ${c.faint("(--max-steps N at startup)")}`,
  ].join("\n");
}

const done = (slot: string, value: string, when = "takes effect from the next turn") =>
  `${c.soft(`· ${slot} → ${value}`)}  ${c.faint(when)}`;

async function compactionSlot(ctx: TuiContext, v: string): Promise<string> {
  if (!v)
    return c.faint(
      `compaction is ${ctx.slots.state.compaction}. Usage: /compaction llm|clear|pipeline|./strategy.mjs (strategy) · /compaction threshold|manual|remind (trigger)`,
    );
  if (isCompactionTrigger(v)) {
    await applySlotValue(ctx, "compactionTrigger", v);
    return done(
      "compaction",
      `trigger ${v}`,
      v === "threshold"
        ? "compacts automatically when usage passes the threshold"
        : v === "manual"
          ? "no automatic compaction; /compact when you decide (overflow still compacts once)"
          : "no automatic compaction; the status bar says when you are past the threshold",
    );
  }
  await applySlotValue(ctx, "compaction", v);
  return done("compaction", v, "used by the next auto or manual compaction");
}

async function preservationSlot(ctx: TuiContext, v: string): Promise<string> {
  const usage = c.faint(
    `preservation is ${ctx.slots.state.preservation}. Usage: /preservation tokens 20000 | ratio 0.3`,
  );
  if (!v) return usage;
  try {
    await applySlotValue(ctx, "preservation", v);
  } catch (err) {
    const msg = (err as Error).message;
    return msg.startsWith("preservation must be")
      ? usage
      : c.zhu(msg.replace(/^preservation /, ""));
  }
  return done("preservation", v, "used by the next compaction");
}

async function executionSlot(ctx: TuiContext, v: string): Promise<string> {
  if (v !== "sequential" && v !== "parallel")
    return c.faint(
      `execution is ${ctx.slots.state.execution}. Usage: /execution sequential|parallel`,
    );
  await applySlotValue(ctx, "execution", v);
  return done("execution", v);
}

async function steeringSlot(ctx: TuiContext, v: string): Promise<string> {
  if (v !== "step" && v !== "turn")
    return c.faint(
      `steering is ${ctx.slots.state.steering}. Usage: /steering step|turn  (step = inject queued messages at the next step; turn = only when the model stops calling tools)`,
    );
  await applySlotValue(ctx, "steering", v);
  return done("steering", v);
}

async function approveSlot(ctx: TuiContext, v: string): Promise<string> {
  const a = ctx.approval;
  const sub = v.match(/^\S+/)?.[0] ?? "";
  const rule = v.slice(sub.length).trim();
  const show = () =>
    [
      `${c.soft("approve")} ${c.ink(a.mode)}${a.mode === "policy" ? `  ${c.faint(describeApproval(a.cfg))}` : ""}`,
      c.faint(
        "Usage: /approve all|ask|policy · /approve allow <rule> · /approve deny <rule> · /approve forget <rule> · /approve outside ask|allow|deny",
      ),
      c.faint(
        "rule = tool or tool:pattern; bash patterns match the command (bash:git *), path tools match the path (edit:src/**)",
      ),
    ].join("\n");
  const apply = async (label: string) => {
    await applySlotValue(ctx, "approve", a.mode);
    return done("approve", label, "applies to the next tool call");
  };
  if (!sub) return show();
  if (sub === "all" || sub === "ask" || sub === "policy") {
    a.mode = sub;
    return apply(sub);
  }
  if (sub === "allow" || sub === "deny") {
    if (!rule) return c.zhu(`Usage: /approve ${sub} <rule>`);
    const list = a.cfg[sub] ?? [];
    a.cfg[sub] = list;
    if (!list.includes(rule)) list.push(rule);
    a.mode = "policy";
    return apply(`${sub} ${rule}`);
  }
  if (sub === "forget") {
    if (!rule) return c.zhu("Usage: /approve forget <rule>");
    a.cfg.allow = (a.cfg.allow ?? []).filter((r) => r !== rule);
    a.cfg.deny = (a.cfg.deny ?? []).filter((r) => r !== rule);
    a.alwaysAllow.delete(rule);
    recordSlot(ctx, "approve", approveValue(a));
    return done("approve", `forget ${rule}`, "applies to the next tool call");
  }
  if (sub === "outside") {
    if (rule !== "ask" && rule !== "allow" && rule !== "deny")
      return c.zhu("Usage: /approve outside ask|allow|deny");
    a.cfg.outsideCwd = rule;
    a.mode = "policy";
    return apply(`outside cwd ${rule}`);
  }
  return show();
}

/** 工具描述风格槽:列表、切换、逐条编辑、写回配置。切换与编辑都原地改 tools 的描述。 */
function toolPromptsSlot(ctx: TuiContext, v: string): string {
  const cfg = ctx.slots.toolPrompts;
  const { tools } = ctx;
  const [sub, name] = v.split(/\s+/, 2);
  if (!sub) {
    const rows = TOOL_PROMPT_STYLES.map((st) => {
      const tok = styleTokens(tools, { ...cfg, style: st });
      const mark = st === cfg.style ? c.ink("●") : c.faint("○");
      return `  ${mark} ${c.ink(st.padEnd(8))} ${c.soft(String(tok).padStart(5))} ${c.faint("tok")}  ${c.faint(STYLE_NOTES[st])}`;
    });
    const edited = Object.keys(cfg.descriptions ?? {});
    return [
      `${c.soft("Tool prompts")}  ${c.faint("one description per tool in three layers (core, guidance, rules); the level picks how many the model sees")}`,
      ...rows,
      c.faint(
        edited.length > 0
          ? `  edited by you: ${edited.join(" ")}  (reset <tool> to drop; save to keep across sessions)`
          : "  edit <tool> edits the description here; save writes style and edits to ~/.clarook/config.json",
      ),
    ].join("\n");
  }
  if (isToolPromptStyle(sub)) {
    const changed = setToolPromptStyle(ctx, sub);
    return done(
      "toolPrompts",
      `${sub} (${styleTokens(tools, cfg)} tok)`,
      changed.length > 0
        ? `${changed.length} descriptions changed; takes effect from the next request`
        : "no description changed",
    );
  }
  if (sub === "edit" || sub === "reset") {
    const t = tools.find((x) => x.name === name);
    if (!name || !t) return c.zhu(`no tool named ${name ?? "?"}; see /tools`);
    const apply = () => {
      applyToolPrompts(tools, cfg);
      recordSlot(ctx, "toolPrompts", describeToolPrompts(cfg));
      return done(
        "toolPrompts",
        `${sub} ${name} (${Math.ceil(t.description.length / 4)} tok)`,
        "takes effect from the next request; /tools shows the first line, Ctrl+R → tool definitions the full text",
      );
    };
    if (sub === "reset") {
      if (!cfg.descriptions || !(name in cfg.descriptions))
        return c.faint(`· ${name} is not edited`);
      delete cfg.descriptions[name];
    } else {
      ctx.dialog.open(
        new TextEditor(
          ctx,
          `Edit tool description · ${name}`,
          "Changes future requests. Use save to keep as a default.",
          t.description,
          (text) => {
            cfg.descriptions = { ...cfg.descriptions, [name]: text };
            return apply();
          },
        ),
      );
      return "";
    }
    return apply();
  }
  if (sub === "save") {
    const descriptions = cfg.descriptions ?? {};
    updateConfig((current) => ({
      ...current,
      toolPrompts: {
        style: cfg.style ?? "explain",
        ...(Object.keys(descriptions).length > 0 && { descriptions }),
      },
    }));

    return done("toolPrompts", "saved", `toolPrompts written to ${DEFAULT_CONFIG_PATH}`);
  }
  return c.zhu("Usage: /toolprompts brief|explain|rules | edit <tool> | reset <tool> | save");
}

/** 一个槽命令:返回要打到屏幕上的文本。运行中拒绝切换。 */
export async function slotCommand(ctx: TuiContext, slot: string, arg: string): Promise<string> {
  if (ctx.agent.running) return c.zhu("Cannot switch a slot while running; press Esc first.");
  const v = arg.trim();
  switch (slot) {
    case "compaction":
      return compactionSlot(ctx, v);
    case "preservation":
      return preservationSlot(ctx, v);
    case "execution":
      return executionSlot(ctx, v);
    case "steering":
      return steeringSlot(ctx, v);
    case "approve":
      return approveSlot(ctx, v);
    case "toolPrompts":
      return toolPromptsSlot(ctx, v);
    default:
      return c.zhu(`unknown slot ${slot}`);
  }
}

export type { ApprovalConfig };
