// 延续组装工作台的行式布局:来源、值和操作分开,长列表不挤走底部动作。
import {
  type Component,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { errorMessage } from "../src/providers/errors.js";
import { pendingUserShells, unresolvedCalls } from "../src/recovery.js";
import {
  formatSetting,
  getSetting,
  parseSetting,
  type SettingDef,
  setSetting,
} from "../src/settings.js";
import { SETUP_SECTIONS } from "../src/setup.js";
import { type SessionSetup, WORK_SETTINGS } from "./session-setup.js";
import { c, editorTheme, G, selectedText } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { cleanPasteText, printableInput } from "./tui-format.js";
import { ListPicker } from "./tui-login.js";

export type ExitState = {
  phase: "stopping" | "cleanup";
  force: () => void;
  failure?: string;
  retry?: () => void;
  error?: string;
};

/** 退出期间保持独立焦点,只展示日志能证明的状态,不推断外部任务已停止。 */
export function exitReview(ctx: TuiContext, state: ExitState): Component {
  let offset = 0;
  let page = 1;
  let total = 0;
  let selected = "Keep waiting";
  const actions = () => [
    { label: "Keep waiting", run: () => {} },
    ...(state.retry ? [{ label: "Retry saving and continue shutdown", run: state.retry }] : []),
    { label: state.error ? "Retry force exit" : "Force exit", run: state.force },
  ];
  return {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const calls = unresolvedCalls(ctx.log.events).filter(
        (item) => !item.recovery && !item.result,
      );
      const shells = [...pendingUserShells(ctx.log.events).values()];
      const body = [
        ...(state.failure
          ? [
              "A fatal error stopped this session. No new work can be submitted.",
              state.failure.split("\n")[0] ?? state.failure,
              "Exit code: 70",
              "",
            ]
          : []),
        ...(state.error ? [`Cannot exit: ${state.error}`, ""] : []),
        ...[ctx.log, ...ctx.children.views.map((v) => v.info.log)].flatMap((log) =>
          log.recording?.error
            ? [
                `Saving failed: ${log.recording.error}`,
                "Waiting to save session records. Ctrl+S retries; force exit may lose unsaved data.",
                "",
              ]
            : [],
        ),
        state.phase === "cleanup"
          ? "Waiting for extensions and connections to release resources."
          : "Cancellation requested. Waiting for the current turn to finish.",
        "",
        ...(calls.length || shells.length
          ? [
              "Calls without results",
              ...calls.map(({ call }) => `${call.name} · ${call.id}\n${JSON.stringify(call.args)}`),
              ...shells.map(
                (event) =>
                  `User shell · ${event.payload.excludeFromContext ? "Local only" : "Included in next context"}\n${String(event.payload.command)}`,
              ),
            ]
          : [
              state.phase === "stopping"
                ? "No tool results pending; waiting for the model or turn to settle."
                : "The turn has ended.",
            ]),
        "",
        ctx.deps.inputs?.saving
          ? "Input saving on · drafts and queued messages will be saved."
          : "Input saving off · unsaved inputs will be lost.",
        "Force exit ends clarook. External work may continue. Missing results stay unknown; unrecorded output may be lost.",
        ...(state.failure
          ? ["", "Failure details", state.failure, "", `Session log: ${ctx.model.info.sessionFile}`]
          : []),
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      total = body.length;
      const choices = actions();
      if (!choices.some((a) => a.label === selected)) selected = "Keep waiting";
      const actionLines = choices.flatMap((a) =>
        wrapTextWithAnsi(
          a.label === selected ? selectedText(`${G.cursor} ${a.label}`) : c.soft(`  ${a.label}`),
          inner,
        ),
      );
      // 用最大位置宽度预留提示,再填实际页数,避免首帧显示旧布局的页尾。
      const hint = "↑↓ choose · Enter select · PgUp/PgDn details";
      const hintRows = wrapTextWithAnsi(`${hint} · ${total}/${total}`, inner).length;
      page = Math.max(1, ctx.deps.terminal.rows - actionLines.length - hintRows - 3);
      offset = Math.min(offset, Math.max(0, total - page));
      const footer = [
        ...actionLines,
        ...wrapTextWithAnsi(c.faint(`${hint} · ${Math.min(offset + page, total)}/${total}`), inner),
      ];
      const visible = body.slice(offset, offset + page);
      const title = `${state.failure ? "Fatal error" : "Exiting"} · ${state.phase === "stopping" ? "stopping work" : "releasing resources"}`;
      return [
        ` ${state.failure ? c.zhu(c.bold(title)) : c.bold(title)}`,
        "",
        ...visible.map((line) => ` ${c.soft(line)}`),
        // 占满退出工作区,避免露出已无法使用的历史操作提示;动作固定在底部。
        ...Array<string>(Math.max(0, page - visible.length)).fill(""),
        "",
        ...footer.map((line) => ` ${line}`),
      ];
    },
    handleInput(data) {
      const choices = actions();
      const index = Math.max(
        0,
        choices.findIndex((a) => a.label === selected),
      );
      if (matchesKey(data, Key.up))
        selected = choices[Math.max(0, index - 1)]?.label ?? "Keep waiting";
      else if (matchesKey(data, Key.down))
        selected = choices[Math.min(choices.length - 1, index + 1)]?.label ?? "Keep waiting";
      else if (matchesKey(data, Key.home)) selected = "Keep waiting";
      else if (matchesKey(data, Key.end)) selected = choices.at(-1)?.label ?? "Keep waiting";
      else if (matchesKey(data, Key.enter)) choices[index]?.run();
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
      else if (matchesKey(data, Key.pageDown))
        offset = Math.min(Math.max(0, total - page), offset + page);
      ctx.tui.requestRender();
    },
  };
}

/** 队列只在明确继续时恢复投递;编辑使用主输入框同一套多行编辑器。 */
export class PendingInputsView implements Component {
  private selected: string | undefined;
  private editing: { id: string; editor: Editor } | undefined;
  private message = "";
  private hasFocus = false;
  private actions: ListPicker | undefined;
  constructor(
    private readonly ctx: TuiContext,
    private readonly resume: () => void,
  ) {
    this.selected = ctx.agent.pending[0]?.id;
  }
  invalidate(): void {
    this.editing?.editor.invalidate();
  }
  get editingText(): boolean {
    return this.editing !== undefined;
  }
  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.editing) this.editing.editor.focused = value;
  }
  render(width: number): string[] {
    if (this.actions) return this.actions.render(width);
    const items = this.ctx.agent.pending;
    if (!items.some((p) => p.id === this.selected)) this.selected = items[0]?.id;
    const inner = Math.max(1, width - 2);
    const line = (text: string) => ` ${truncateToWidth(text, inner)}`;
    const paused = items.filter((p) => p.paused).length;
    const header = [
      line(c.bold("Pending inputs")),
      line(
        c.faint(
          `${paused} paused · ${items.length - paused} queued · local saving ${this.ctx.deps.inputs?.saving ? "on" : "off"}`,
        ),
      ),
      "",
    ];
    if (this.editing)
      return [
        ...header,
        line("Edit message · delivery mode stays the same"),
        ...this.editing.editor.render(width),
        line(c.zhu(this.message)),
        line(c.faint("Enter save · Shift+Enter newline · Esc cancel edit")),
      ];
    const page = Math.max(1, Math.floor((this.ctx.deps.terminal.rows - 10) / 2));
    const index = Math.max(
      0,
      items.findIndex((p) => p.id === this.selected),
    );
    const start = Math.max(0, index - page + 1);
    const selected = items[index];
    const preview = selected
      ? wrapTextWithAnsi(selected.text.replace(/\t/g, "  "), inner).slice(0, page)
      : [];
    return [
      ...header,
      ...(items.length
        ? items
            .slice(start, start + page)
            .map((p, offset) =>
              line(
                (p.id === this.selected ? selectedText : c.faint)(
                  `${p.id === this.selected ? G.cursor : " "} ${start + offset + 1}. [${p.paused ? "paused" : "queued"}] ${p.deliverAs === "followUp" ? "follow-up" : "steering"}${p.images?.length ? ` · ${p.images.length} image(s)` : ""} · ${p.text.split("\n")[0]}`,
                ),
              ),
            )
        : [line("No pending messages.")]),
      "",
      ...preview.map(line),
      "",
      ...wrapTextWithAnsi(
        this.ctx.deps.inputs?.error
          ? `Not saved: ${this.ctx.deps.inputs.error}`
          : this.message ||
              (!items.length
                ? "Your draft stays in the main input. Esc returns to it."
                : paused
                  ? "Paused messages wait for your explicit continuation."
                  : "Queued messages follow the current delivery policy."),
        inner,
      )
        .slice(0, 2)
        .map((s) => line(this.ctx.deps.inputs?.error ? c.zhu(s) : c.soft(s))),
      line(c.faint("↑↓ select · Enter actions · Esc back")),
    ];
  }
  handleInput(data: string): void {
    try {
      if (this.actions) this.actions.handleInput(data);
      else if (this.editing) {
        if (matchesKey(data, Key.escape)) {
          this.editing = undefined;
          this.message = "";
        } else if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~"))
          this.editing.editor.handleInput(`\x1b[200~${cleanPasteText(data.slice(6, -6))}\x1b[201~`);
        else this.editing.editor.handleInput(data);
      } else if (matchesKey(data, Key.escape)) this.ctx.dialog.close();
      else {
        const items = this.ctx.agent.pending;
        const index = Math.max(
          0,
          items.findIndex((p) => p.id === this.selected),
        );
        this.selected = items[index]?.id;
        if (matchesKey(data, Key.up)) this.selected = items[Math.max(0, index - 1)]?.id;
        else if (matchesKey(data, Key.down))
          this.selected = items[Math.min(items.length - 1, index + 1)]?.id;
        else if (matchesKey(data, Key.enter)) {
          const item = items.find((p) => p.id === this.selected);
          this.actions = new ListPicker(
            "Pending input actions",
            [
              { label: "Edit selected message", disabled: !item },
              { label: "Remove selected message", disabled: !item },
              { label: "Continue all pending messages", disabled: !items.length },
              { label: "Retry saving inputs" },
            ],
            "↑↓ choose · Enter select · Esc back",
            (row) => {
              this.actions = undefined;
              if (row.label === "Edit selected message" && item) {
                const editor = new Editor(this.ctx.tui, editorTheme, { paddingX: 1 });
                editor.focused = this.hasFocus;
                editor.setText(item.text);
                editor.onSubmit = (text) => {
                  // 组件先清空再回调;消息已投递等失败时保留尚未应用的编辑。
                  editor.setText(text);
                  this.ctx.agent.editPending(item.id, text);
                  this.editing = undefined;
                  this.message = "Message updated.";
                };
                this.editing = { id: item.id, editor };
                this.message = "";
              } else if (row.label === "Remove selected message" && item) {
                this.ctx.agent.removePending(item.id);
                this.message = "Message removed.";
              } else if (row.label === "Continue all pending messages") this.resume();
              else if (row.label === "Retry saving inputs") {
                this.ctx.deps.inputs?.flush();
                this.message = this.ctx.deps.inputs?.saving
                  ? "Saved locally."
                  : "Local saving is off. Change saveInputs in /settings.";
              }
              this.ctx.tui.requestRender();
            },
            () => {
              this.actions = undefined;
              this.ctx.tui.requestRender();
            },
            () => this.ctx.tui.requestRender(),
            () => this.ctx.deps.terminal.rows,
          );
        }
      }
    } catch (error) {
      this.message = errorMessage(error);
    }
    this.ctx.tui.requestRender();
  }
}

const SETUP_FIELD_ORDER = SETUP_SECTIONS.flatMap((section) => section.keys);

export class SessionSetupReview implements Component {
  private setup: SessionSetup;
  private index = 0;
  private editing: string | undefined;
  private error = "";
  private page = 1;
  private readonly edited = new Set<string>();
  private readonly fields: SettingDef[] = [
    // 展示顺序归界面;恢复所需字段独立来自设置登记表。
    ...[...WORK_SETTINGS].sort((a, b) => {
      const left = SETUP_FIELD_ORDER.indexOf(a.key);
      const right = SETUP_FIELD_ORDER.indexOf(b.key);
      return (
        (left < 0 ? SETUP_FIELD_ORDER.length : left) -
        (right < 0 ? SETUP_FIELD_ORDER.length : right)
      );
    }),
    {
      key: "extensions",
      group: "tools",
      type: "list",
      builtin: [],
      scope: "next start",
      note: "Extension module paths",
    },
    {
      key: "approval",
      group: "strategy",
      type: "text",
      builtin: {},
      scope: "now",
      note: "Approval rules as JSON; used when approve is policy",
    },
  ];
  constructor(
    setup: SessionSetup,
    private readonly missing: string[],
    private readonly rows: () => number,
    private readonly done: (value?: SessionSetup) => void,
    private readonly change: () => void,
  ) {
    this.setup = structuredClone(setup);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.page = Math.max(1, this.rows() - 8);
    const start = Math.max(0, this.index - this.page + 1);
    const selected = this.fields[this.index];
    const lines = this.fields.slice(start, start + this.page).map((field, offset) => {
      const source = this.edited.has(field.key)
        ? "edited"
        : this.missing.includes(field.key)
          ? "defaults"
          : "selected";
      const value = getSetting(this.setup.values, field.key);
      const line = `${start + offset === this.index ? G.cursor : " "} [${source}] ${field.key}: ${field.key === "approval" ? (value === undefined ? "not set (inactive)" : JSON.stringify(value)) : formatSetting(field, value)}`;
      return ` ${truncateToWidth(start + offset === this.index ? selectedText(line) : c.faint(line), inner)}`;
    });
    if (start + this.page > this.fields.length) {
      lines.push(
        ` ${truncateToWidth(this.index === this.fields.length ? selectedText(`${G.cursor} Continue with this setup`) : c.ink("  Continue with this setup"), inner)}`,
      );
    }
    let editLine = `${selected?.key ?? ""} > ${this.editing ?? ""}▏`;
    if (this.editing !== undefined) {
      const chars = [...editLine];
      while (chars.length && visibleWidth(chars.join("")) > inner - 1) chars.shift();
      editLine = chars.length < [...editLine].length ? `…${chars.join("")}` : editLine;
    }
    return [
      c.bold(" Review session setup"),
      ` ${c.faint(this.missing.length ? `${this.missing.length} missing values proposed from saved defaults` : "Review or adjust before continuing")}`,
      "",
      ...lines,
      "",
      ` ${truncateToWidth(this.editing !== undefined ? editLine : (selected?.note ?? "Start using the reviewed configuration."), inner)}`,
      ` ${truncateToWidth(this.error ? c.zhu(this.error) : c.faint(this.editing !== undefined ? "Enter apply · Esc cancel edit" : "↑↓ select · Enter choose · End continue · Esc back"), inner)}`,
    ];
  }
  handleInput(data: string): void {
    const field = this.fields[this.index];
    if (this.editing !== undefined && field) {
      if (matchesKey(data, Key.escape)) {
        this.editing = undefined;
        this.error = "";
      } else if (matchesKey(data, Key.enter)) {
        try {
          const value =
            field.key === "approval" ? JSON.parse(this.editing) : parseSetting(field, this.editing);
          if (
            field.key === "approval" &&
            (!value || typeof value !== "object" || Array.isArray(value))
          )
            throw new Error("Approval rules must be a JSON object");
          this.setup.values = setSetting(
            this.setup.values,
            field.key,
            value ?? (field.type === "list" ? [] : null),
          );
          this.editing = undefined;
          this.error = "";
          this.edited.add(field.key);
        } catch (error) {
          this.error = errorMessage(error);
        }
      } else if (matchesKey(data, Key.ctrl("u"))) this.editing = "";
      else if (matchesKey(data, Key.backspace))
        this.editing = [...this.editing].slice(0, -1).join("");
      else this.editing += printableInput(data);
    } else if (matchesKey(data, Key.escape)) this.done();
    else if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, Key.down)) this.index = Math.min(this.fields.length, this.index + 1);
    else if (matchesKey(data, Key.home)) this.index = 0;
    else if (matchesKey(data, Key.end)) this.index = this.fields.length;
    else if (matchesKey(data, Key.pageUp)) this.index = Math.max(0, this.index - this.page);
    else if (matchesKey(data, Key.pageDown))
      this.index = Math.min(this.fields.length, this.index + this.page);
    else if (matchesKey(data, Key.enter)) {
      if (!field) this.done(this.setup);
      else {
        const value = getSetting(this.setup.values, field.key);
        this.editing =
          field.key === "approval"
            ? JSON.stringify(value ?? {})
            : value === undefined || value === null
              ? "none"
              : Array.isArray(value)
                ? value.join(" ")
                : String(value);
        this.error = field.values ? `Options: ${field.values.map((v) => v.label).join(" / ")}` : "";
      }
    }
    this.change();
  }
}

export function textReview(
  title: string,
  text: string,
  rows: () => number,
  close: () => void,
  change: () => void,
): Component {
  let offset = 0;
  let page = 1;
  let total = 0;
  return {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
      total = lines.length;
      page = Math.max(1, rows() - 4);
      offset = Math.min(offset, Math.max(0, total - page));
      return [
        ` ${truncateToWidth(c.bold(title), inner)}`,
        "",
        ...lines.slice(offset, offset + page).map((line) => ` ${line}`),
        ` ${c.faint(`PgUp/PgDn scroll · Esc back · ${Math.min(offset + page, total)}/${total}`)}`,
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) close();
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
      else if (matchesKey(data, Key.pageDown))
        offset = Math.min(Math.max(0, total - page), offset + page);
      else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
      else if (matchesKey(data, Key.down)) offset = Math.min(Math.max(0, total - page), offset + 1);
      change();
    },
  };
}
