// 组装工作台:有限高度的导航、说明和编辑状态。不执行 Agent 策略,所有写入都走设置控制器。
import {
  type Component,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  COMPACTION_REFERENCES,
  DEFAULT_COMPACTION_SETTINGS,
  SUMMARY_TEMPLATES,
} from "../src/compaction-presets.js";
import type { Preset } from "../src/config.js";
import {
  DEFAULT_SKILL_SOURCES,
  defaultPreset,
  formatSetting,
  parseSetting,
  SETTINGS,
  type SettingDef,
  setSetting,
  settingDef,
} from "../src/settings.js";
import {
  configuredValue,
  SETUP_SECTIONS,
  type SetupScope,
  sameSetting,
  setupGuide,
  setupSnapshot,
  setupValue,
} from "../src/setup.js";
import { STATUS_WIDGETS, type StatusStyle } from "../src/status-bar.js";
import { skillSources } from "./prompt.js";
import { loadSummaryPrompt } from "./strategies.js";
import { c, G, selectedText } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { printableInput } from "./tui-format.js";
import {
  changeCompactionReference,
  type SettingChange,
  settingTiming,
  setupRead,
  sourceOf,
} from "./tui-settings.js";

type Choice = { label: string; value: unknown; note?: string };
type BrowsingMode =
  | { kind: "browse" }
  | { kind: "references" }
  | { kind: "choices"; def: SettingDef; items: Choice[] }
  | { kind: "members"; def: SettingDef; names: string[] };
type Mode =
  | BrowsingMode
  | { kind: "text"; def?: SettingDef; text: string; purpose: "value" | "save" | "source" }
  | { kind: "restore"; def: SettingDef }
  | {
      kind: "info";
      def?: SettingDef;
      promptText?: string;
      offset: number;
      from: BrowsingMode;
      index: number;
    }
  | { kind: "presets" }
  | { kind: "presetReview"; name: string; values: Preset; offset: number };

type Row = { title: string; value?: string; note?: string; def?: SettingDef; run: () => void };
export type SetupViewDeps = {
  ctx: TuiContext;
  set(def: SettingDef, value: unknown, scope: SetupScope): Promise<SettingChange>;
  open(command: string): void;
  onClose(): void;
  onChange(): void;
};

export class SetupView implements Component {
  private scope: SetupScope = "session";
  private section: number | undefined;
  private index = 0;
  private returnIndex = 0;
  private mode: Mode = { kind: "browse" };
  private query = "";
  private searching = false;
  private notice: SettingChange | undefined;
  private busy = false;
  private pageSize = 1;
  private action: string | undefined;

  constructor(private readonly deps: SetupViewDeps) {}
  invalidate(): void {}

  focus(key: string): boolean {
    const section = SETUP_SECTIONS.findIndex((s) => s.keys.includes(key));
    if (section < 0) return false;
    this.section = section;
    this.index =
      (SETUP_SECTIONS[section]?.keys.indexOf(key) ?? 0) +
      (SETUP_SECTIONS[section]?.id === "context" ? 1 : 0);
    this.mode = { kind: "browse" };
    return true;
  }

  private read(def: SettingDef): unknown {
    return setupRead(this.deps.ctx, def, this.scope);
  }

  private skillNote(name: string): string {
    if (!name) return "New installations join automatically on the next start.";
    const skill = this.deps.ctx.skills.find((s) => s.name === name);
    return skill
      ? `${skill.description || "No description"}\n${skill.path}${skill.disableModelInvocation ? "\nMarked disable-model-invocation by the skill author." : ""}`
      : "Not discovered. The saved name is kept for future starts.";
  }
  private value(def: SettingDef): string {
    if (def.key === "tools.disable") {
      const disabled = (this.read(def) as string[] | undefined) ?? [];
      const count = this.deps.ctx.tools.filter(
        (t) => t.name !== "plan" && !disabled.includes(t.name),
      ).length;
      return `${count} available`;
    }
    return setupValue(def, this.read(def));
  }

  private sourceNames(def: SettingDef): string[] {
    return [
      ...new Set([
        ...Object.keys((this.read(def) ?? {}) as object),
        ...Object.keys(DEFAULT_SKILL_SOURCES),
      ]),
    ];
  }

  private sourceNote(def: SettingDef, name: string): string {
    const sources = { ...((this.read(def) ?? {}) as Record<string, "on" | "off">) };
    sources[name] ??= "off";
    const source = skillSources(process.cwd(), { sources }).find((s) => s.name === name);
    return `${source?.path ?? name}\n${Object.hasOwn(DEFAULT_SKILL_SOURCES, name) ? "Built-in directory; follows the user or project location. Disable to exclude it." : "Custom directory. Delete removes this source from configuration only."}\nDirect <name>/SKILL.md; first discovered name wins.`;
  }

  private settingRow(def: SettingDef): Row {
    return { title: setupGuide(def).title, value: this.value(def), def, run: () => this.edit(def) };
  }

  private currentReference(): (typeof COMPACTION_REFERENCES)[number] | undefined {
    return COMPACTION_REFERENCES.find((reference) =>
      Object.keys(DEFAULT_COMPACTION_SETTINGS).every((key) => {
        const def = settingDef(key);
        return (
          def && sameSetting(this.read(def), reference.values[key as keyof typeof reference.values])
        );
      }),
    );
  }

  private summary(i: number): string {
    const section = SETUP_SECTIONS[i];
    if (!section) return "";
    const value = (key: string) => {
      const def = settingDef(key);
      return def ? this.value(def) : "";
    };
    switch (section.id) {
      case "model":
        return `${value("model")} · effort ${value("effort")}`;
      case "instructions":
        return `Skills ${value("prompt.skills.mode")} · memory ${value("prompt.memory")}`;
      case "tools":
        return `${this.scope === "session" ? `${this.deps.ctx.defs().length} offered` : value("tools.disable")} · delegation ${value("subagent")}`;
      case "context":
        return `${this.currentReference()?.label ?? "Custom"} · ${value("compaction")} · keep ${value("preservation")}`;
      case "execution":
        return `${value("approve")} · ${value("execution")}`;
      case "display":
        return `${value("statusStyle")} · ${value("statusWidgets")}`;
      case "recording":
        return `Input saving ${value("saveInputs")}`;
      default:
        return "";
    }
  }

  private rows(): Row[] {
    const { ctx } = this.deps;
    const m = this.mode;
    if (m.kind === "references")
      return COMPACTION_REFERENCES.map((reference) => ({
        title: reference.label,
        value: this.currentReference()?.id === reference.id ? "Current" : "",
        note: reference.summary,
        run: () => {
          void this.run(async () => {
            const result = await changeCompactionReference(ctx, reference.values, this.scope);
            if (result.ok) {
              this.mode = { kind: "browse" };
              this.index = this.returnIndex;
            }
            return result;
          });
        },
      }));
    if (m.kind === "choices")
      return m.items.map((item) => ({
        title: item.label,
        value: sameSetting(item.value, this.read(m.def))
          ? this.scope === "session"
            ? "Current"
            : "Saved"
          : sameSetting(item.value, m.def.builtin)
            ? "Recommended"
            : "",
        ...(item.note && { note: item.note }),
        run: () => {
          void this.commit(m.def, item.value, true);
        },
      }));
    if (m.kind === "members") {
      const current = this.read(m.def);
      const skillRange = m.def.key === "prompt.skills.include";
      const sourceRange = m.def.key === "prompt.skills.sources";
      const rows: Row[] = m.names.map((name) => {
        const skill = skillRange ? ctx.skills.find((s) => s.name === name) : undefined;
        const manualOnly = skill?.disableModelInvocation;
        const all = skillRange && name === "";
        const listed =
          (skillRange && current === "all") || (Array.isArray(current) && current.includes(name));
        const enabled = m.def.key === "tools.disable" ? !listed : listed;
        return {
          title: all
            ? "All (including new skills)"
            : m.def.key === "statusWidgets"
              ? (STATUS_WIDGETS.find((widget) => widget.id === name)?.name ?? name)
              : name,
          value: sourceRange
            ? (current as Record<string, string> | undefined)?.[name] === "on"
              ? "Enabled [x]"
              : "Disabled [ ]"
            : m.def.type === "map"
              ? ((current as Record<string, string> | undefined)?.[name] ?? "head")
              : manualOnly
                ? "Manual only"
                : all
                  ? current === "all"
                    ? "[x]"
                    : "[ ]"
                  : m.def.key === "statusWidgets"
                    ? enabled
                      ? "Shown [x]"
                      : "Hidden [ ]"
                    : enabled
                      ? "Enabled [x]"
                      : "Disabled [ ]",
          ...(skillRange && { note: this.skillNote(name) }),
          ...(m.def.key === "statusWidgets" && {
            note: STATUS_WIDGETS.find((widget) => widget.id === name)?.note ?? "Status reading",
          }),
          run: () => {
            if (manualOnly) {
              this.notice = {
                ok: false,
                message: "This skill is marked manual-only. Use /name to invoke it.",
              };
              return;
            }
            if (all) {
              void this.commit(m.def, current === "all" ? [] : "all", false);
              return;
            }
            if (m.def.type === "map") {
              const values = m.def.values?.map((v) => v.label) ?? [];
              const old =
                (current as Record<string, string> | undefined)?.[name] ??
                (sourceRange ? "off" : "head");
              void this.commit(
                m.def,
                {
                  ...((current as Record<string, string>) ?? {}),
                  [name]: values[(values.indexOf(old) + 1) % values.length],
                },
                false,
              );
            } else {
              const old =
                skillRange && current === "all"
                  ? ctx.skills.filter((s) => !s.disableModelInvocation).map((s) => s.name)
                  : ((current as string[] | undefined) ?? []);
              const next = listed ? old.filter((v) => v !== name) : [...old, name];
              // 保持用户既有的段顺序;重新启用的段追加到尾部。空列表就是空列表,不能恢复成缺省全开。
              void this.commit(m.def, next, false);
            }
          },
        };
      });
      if (sourceRange)
        rows.push({
          title: "Add directory",
          value: "+",
          run: () => this.startText("source", m.def),
        });
      return rows;
    }
    if (m.kind === "presets")
      return [
        {
          title: "Recommended",
          value: "Built-in starting point",
          run: () => this.reviewPreset("recommended", defaultPreset()),
        },
        ...(ctx.deps.settings?.listPresets?.() ?? []).map((p) => ({
          title: p.name,
          value: "Custom preset",
          run: () => this.reviewPreset(p.name, p.values),
        })),
      ];
    if (m.kind === "presetReview" || m.kind === "restore")
      return [
        {
          title: m.kind === "restore" ? "Restore recommended value" : "Use for saved defaults",
          run: () => {
            if (m.kind === "restore") void this.commit(m.def, structuredClone(m.def.builtin), true);
            else
              void this.run(async () => {
                if (!ctx.deps.settings?.usePreset)
                  throw new Error("Loading presets is not available here.");
                await ctx.deps.settings.usePreset(m.name);
                this.scope = "defaults";
                this.mode = { kind: "browse" };
                this.section = undefined;
                this.index = 0;
                return {
                  ok: true,
                  message: `${m.name} saved as defaults. Restart to use it; this session is unchanged. Explicit flags and --preset still take priority.`,
                };
              });
          },
        },
      ];
    if (m.kind === "text") return [];
    if (m.kind === "info") return [];
    if (this.searching || this.query) {
      const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      return SETTINGS.filter((def) =>
        terms.every((term) =>
          `${def.key} ${setupGuide(def).title} ${def.note}`.toLowerCase().includes(term),
        ),
      ).map((def) => this.settingRow(def));
    }
    if (this.section === undefined)
      return [
        ...SETUP_SECTIONS.map((section, i) => ({
          title: section.title,
          value: this.summary(i),
          note: section.description,
          run: () => {
            this.section = i;
            this.index = 0;
          },
        })),
        {
          title: "Save as preset",
          value: this.scope === "session" ? "From this session" : "From saved defaults",
          run: () => this.startText("save"),
        },
        {
          title: "Load preset",
          value: "For future starts",
          run: () => {
            this.mode = { kind: "presets" };
            this.index = 0;
          },
        },
      ];
    const section = SETUP_SECTIONS[this.section];
    if (!section) return [];
    return [
      ...(section.id === "context"
        ? [
            {
              title: "Reference composition",
              value: this.currentReference()?.label ?? "Custom",
              note: "Choose a complete starting composition, then adjust its parts below.",
              run: () => {
                this.returnIndex = this.index;
                this.mode = { kind: "references" };
                this.index = Math.max(
                  0,
                  COMPACTION_REFERENCES.findIndex(
                    (reference) => reference.id === this.currentReference()?.id,
                  ),
                );
              },
            },
          ]
        : []),
      ...section.keys.flatMap((key) => {
        const def = settingDef(key);
        return def ? [this.settingRow(def)] : [];
      }),
      ...(section.action
        ? [
            {
              title: section.action.label,
              value: "Current session",
              run: () => {
                this.deps.onClose();
                this.deps.open(section.action?.command ?? "/settings");
              },
            },
          ]
        : []),
    ];
  }

  /** 可见动作只属于当前焦点;不混入设置值或保存到配置。 */
  private actions(): Row[] {
    const m = this.mode;
    if (
      m.kind !== "browse" &&
      m.kind !== "choices" &&
      m.kind !== "members" &&
      m.kind !== "references"
    )
      return [];
    if (this.searching && m.kind === "browse") return [];
    const def = "def" in m ? m.def : this.rows()[this.index]?.def;
    if (m.kind === "references")
      return [
        {
          title: "Details",
          run: () => {
            this.mode = { kind: "info", offset: 0, from: m, index: this.index };
          },
        },
      ];
    if (!def) return [];
    return [
      ...(m.kind === "choices" && ["number", "text"].includes(def.type)
        ? [{ title: "Custom value", run: () => this.startText("value", def) }]
        : []),
      {
        title: "Details",
        run: () => {
          this.returnIndex = m.kind === "browse" ? this.index : this.returnIndex;
          const info: Extract<Mode, { kind: "info" }> = {
            kind: "info",
            def,
            offset: 0,
            from: m,
            index: this.index,
          };
          const value = String(m.kind === "choices" ? m.items[this.index]?.value : this.read(def));
          if (def.key === "compactionPrompt" && !Object.hasOwn(SUMMARY_TEMPLATES, value)) {
            void this.run(async () => {
              info.promptText = await loadSummaryPrompt(value);
              this.mode = info;
              return {
                ok: true,
                message:
                  "Preview reads the current file. Reapply this setting to load file changes.",
              };
            });
          } else this.mode = info;
        },
      },
      ...(m.kind === "browse"
        ? [
            {
              title: "Restore recommended",
              run: () => {
                this.returnIndex = this.index;
                this.mode = { kind: "restore", def };
                this.index = 0;
              },
            },
          ]
        : []),
    ];
  }

  private edit(def: SettingDef): void {
    this.returnIndex = this.index;
    this.notice = undefined;
    if (this.scope === "session" && def.scope === "next start") {
      this.notice = { ok: false, message: settingTiming(this.deps.ctx, def, this.scope) };
      return;
    }
    this.index = 0;
    if (def.type === "list" || def.type === "map") {
      const configured =
        def.type === "map"
          ? Object.keys((this.read(def) ?? {}) as object)
          : Array.isArray(this.read(def))
            ? (this.read(def) as string[])
            : [];
      const names =
        def.key === "prompt.skills.sources"
          ? this.sourceNames(def)
          : def.key === "prompt.skills.include"
            ? ["", ...new Set([...this.deps.ctx.skills.map((s) => s.name), ...configured])]
            : def.key === "mcpReconnect"
              ? [
                  ...new Set([
                    ...(this.deps.ctx.deps.mcp?.statuses().map((server) => server.name) ?? []),
                    ...configured,
                  ]),
                ]
              : def.items
                ? [...def.items]
                : [
                    ...new Set([
                      ...this.deps.ctx.tools
                        .filter((t) => def.key !== "tools.disable" || t.name !== "plan")
                        .map((t) => t.name),
                      ...configured,
                    ]),
                  ];
      this.mode = { kind: "members", def, names };
      return;
    }
    const values =
      def.key === "model"
        ? (this.deps.ctx.deps.settings?.listModels() ?? []).map((label) => ({
            label,
            note: "Configured model",
          }))
        : (def.values ?? []);
    const items: Choice[] = values.map((v) => {
      const value =
        def.type === "bool" ? v.label === "on" : def.type === "number" ? Number(v.label) : v.label;
      return { label: setupValue(def, value), value, ...(v.note && { note: v.note }) };
    });
    if (def.builtin === undefined)
      items.unshift({
        label: setupValue(def, undefined),
        value: undefined,
        note: "Use the built-in starting point",
      });
    const cur = this.read(def);
    if (!items.some((item) => sameSetting(item.value, cur)))
      items.unshift({ label: setupValue(def, cur), value: cur, note: "Your current value" });
    this.index = Math.max(
      0,
      items.findIndex((item) => sameSetting(item.value, cur)),
    );
    this.mode = { kind: "choices", def, items };
  }

  private startText(purpose: "value" | "save" | "source", def?: SettingDef): void {
    this.notice = undefined;
    this.mode = {
      kind: "text",
      purpose,
      ...(def && { def }),
      text: purpose === "value" && def ? String(this.read(def) ?? "") : "",
    };
  }

  private reviewPreset(name: string, values: Preset): void {
    this.mode = { kind: "presetReview", name, values, offset: 0 };
    this.index = 0;
  }

  private async run(action: () => Promise<SettingChange>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.deps.onChange();
    try {
      this.notice = await action();
    } catch (err) {
      this.notice = { ok: false, message: (err as Error).message };
    } finally {
      this.busy = false;
      this.deps.onChange();
    }
  }

  private async commit(def: SettingDef, value: unknown, back: boolean): Promise<void> {
    const scope = this.scope;
    await this.run(async () => {
      const result = await this.deps.set(def, value, scope);
      if (result.ok && back) {
        this.mode = { kind: "browse" };
        this.index = this.returnIndex;
      }
      return result;
    });
  }

  private submitText(): void {
    const m = this.mode;
    if (m.kind !== "text") return;
    if (m.purpose === "source" && m.def) {
      const def = m.def;
      void this.run(async () => {
        const name = m.text.trim();
        if (!name) throw new Error("Enter a directory path.");
        const result = await this.deps.set(
          def,
          { ...((this.read(def) ?? {}) as object), [name]: "on" },
          this.scope,
        );
        if (result.ok) {
          const names = this.sourceNames(def);
          this.mode = { kind: "members", def, names };
          this.index = names.indexOf(name);
        }
        return result;
      });
      return;
    }
    if (m.purpose === "value" && m.def) {
      try {
        void this.commit(m.def, parseSetting(m.def, m.text), true);
      } catch (err) {
        this.notice = { ok: false, message: (err as Error).message };
      }
      return;
    }
    void this.run(async () => {
      const name = m.text.trim();
      const settings = this.deps.ctx.deps.settings;
      if (!settings?.savePreset) throw new Error("Saving presets is not available here.");
      const values = setupSnapshot(SETTINGS, (def) => this.read(def));
      // 模型只记录名字;凭据始终留在登录入口。
      const model =
        this.scope === "session"
          ? `${this.deps.ctx.model.info.providerName}/${this.deps.ctx.model.info.model}`
          : settings.settingLayers?.().defaults?.model;
      if (model && !model.startsWith("none/")) values.model = model;
      else if (String(values.model).startsWith("none/")) values.model = null;
      await settings.savePreset(name, values);
      this.mode = { kind: "browse" };
      this.section = undefined;
      this.index = 7;
      return {
        ok: true,
        message: `Preset ${name} saved. Load it here for future starts, or launch clarook --preset ${name}.`,
      };
    });
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const m = this.mode;
    const actions = this.actions();
    if (matchesKey(data, Key.escape) && this.action) {
      this.action = undefined;
      this.deps.onChange();
      return;
    }
    if (actions.length && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      const index = actions.findIndex((a) => a.title === this.action);
      const next = matchesKey(data, Key.right)
        ? (index + 1) % actions.length
        : index < 0
          ? actions.length - 1
          : (index + actions.length - 1) % actions.length;
      this.action = actions[next]?.title;
      this.deps.onChange();
      return;
    }
    if (this.action && matchesKey(data, Key.enter)) {
      const action = actions.find((a) => a.title === this.action);
      this.action = undefined;
      action?.run();
      this.deps.onChange();
      return;
    }
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.home) ||
      matchesKey(data, Key.end) ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.pageDown) ||
      /^[1-9]$/.test(data)
    )
      this.action = undefined;
    if (matchesKey(data, Key.escape)) {
      this.notice = undefined;
      if (m.kind === "info") {
        this.mode = m.from;
        this.index = m.index;
      } else if (m.kind === "text" && m.purpose === "source" && m.def) {
        this.mode = { kind: "members", def: m.def, names: this.sourceNames(m.def) };
        this.index = this.sourceNames(m.def).length;
      } else if (m.kind !== "browse") {
        this.mode = { kind: "browse" };
        this.index = this.returnIndex;
      } else if (this.searching || this.query) {
        this.searching = false;
        this.query = "";
        this.index = 0;
      } else if (this.section !== undefined) {
        this.index = this.section;
        this.section = undefined;
      } else this.deps.onClose();
      this.deps.onChange();
      return;
    }
    if (m.kind === "text") {
      if (matchesKey(data, Key.enter)) this.submitText();
      else if (matchesKey(data, Key.backspace) || data === "\b")
        m.text = Array.from(m.text).slice(0, -1).join("");
      else if (matchesKey(data, Key.ctrl("u"))) m.text = "";
      else m.text += printableInput(data);
      this.deps.onChange();
      return;
    }
    if (
      m.kind === "members" &&
      m.def.key === "prompt.skills.sources" &&
      matchesKey(data, Key.delete)
    ) {
      const name = m.names[this.index];
      if (name && !Object.hasOwn(DEFAULT_SKILL_SOURCES, name)) {
        const next = { ...((this.read(m.def) ?? {}) as Record<string, string>) };
        delete next[name];
        void this.run(async () => {
          const result = await this.deps.set(m.def, next, this.scope);
          if (result.ok) m.names = this.sourceNames(m.def);
          return result;
        });
      } else
        this.notice = {
          ok: false,
          message: "Built-in sources can be disabled. Only custom directories can be removed.",
        };
      this.deps.onChange();
      return;
    }
    if (m.kind === "info") {
      if (matchesKey(data, Key.up)) m.offset = Math.max(0, m.offset - 1);
      else if (matchesKey(data, Key.down)) m.offset += 1;
      else if (matchesKey(data, Key.pageDown)) m.offset += 6;
      else if (matchesKey(data, Key.pageUp)) m.offset = Math.max(0, m.offset - 6);
      this.deps.onChange();
      return;
    }
    if (
      m.kind === "presetReview" &&
      (matchesKey(data, Key.up) ||
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.pageUp) ||
        matchesKey(data, Key.pageDown))
    ) {
      const delta = matchesKey(data, Key.up)
        ? -1
        : matchesKey(data, Key.pageUp)
          ? -6
          : matchesKey(data, Key.pageDown)
            ? 6
            : 1;
      m.offset = Math.max(0, m.offset + delta);
      this.deps.onChange();
      return;
    }
    if (matchesKey(data, Key.tab) && m.kind === "browse") {
      this.scope = this.scope === "session" ? "defaults" : "session";
      this.notice = undefined;
    } else if (m.kind === "browse" && data === "/") {
      this.searching = true;
      this.query = "";
      this.index = 0;
    } else if (
      this.searching &&
      m.kind === "browse" &&
      !matchesKey(data, Key.enter) &&
      !matchesKey(data, Key.up) &&
      !matchesKey(data, Key.down)
    ) {
      if (matchesKey(data, Key.backspace) || data === "\b")
        this.query = Array.from(this.query).slice(0, -1).join("");
      else this.query += printableInput(data);
      this.index = 0;
    } else {
      const rows = this.rows();
      if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, Key.down))
        this.index = Math.min(Math.max(0, rows.length - 1), this.index + 1);
      else if (matchesKey(data, Key.home)) this.index = 0;
      else if (matchesKey(data, Key.end)) this.index = Math.max(0, rows.length - 1);
      else if (matchesKey(data, Key.pageUp)) this.index = Math.max(0, this.index - this.pageSize);
      else if (matchesKey(data, Key.pageDown))
        this.index = Math.min(Math.max(0, rows.length - 1), this.index + this.pageSize);
      else if (/^[1-9]$/.test(data) && rows.length >= Number(data)) this.index = Number(data) - 1;
      else if (matchesKey(data, Key.enter)) rows[this.index]?.run();
    }
    this.deps.onChange();
  }

  private templateDetail(value: string, fileText?: string): string[] {
    const template = Object.hasOwn(SUMMARY_TEMPLATES, value)
      ? SUMMARY_TEMPLATES[value as keyof typeof SUMMARY_TEMPLATES]
      : undefined;
    const lines = (text: string) => text.split("\n").map((line) => c.soft(line));
    if (template)
      return [
        "",
        c.bold(c.ink("Prompt sent to summarizer")),
        ...lines(template.instructions),
        "",
        c.bold(c.ink("Summary format (model instructions)")),
        ...(template.format ? lines(template.format) : [c.soft("No fixed headings.")]),
      ];
    return [
      "",
      c.bold(c.ink("Prompt sent to summarizer")),
      c.faint(`File: ${value}`),
      c.faint("Current file preview; reapply the setting to load file changes."),
      ...(fileText === undefined
        ? [c.soft("Open Details to read the complete file. Loading does not call the model.")]
        : lines(fileText)),
    ];
  }

  private detail(row: Row | undefined, compact = false, previewWidth = 70): string[] {
    const m = this.mode;
    const { ctx } = this.deps;
    const browsing = m.kind === "info" ? m.from : m;
    const index = m.kind === "info" ? m.index : this.index;
    if (browsing.kind === "references") {
      const reference = COMPACTION_REFERENCES[index];
      if (!reference) return [];
      return [
        c.bold(c.ink(reference.label)),
        c.jin(reference.summary),
        "",
        ...Object.entries(reference.values).map(([key, value]) => {
          const def = settingDef(key);
          return c.soft(
            `${def ? setupGuide(def).title : key}: ${def ? setupValue(def, value) : String(value)}`,
          );
        }),
        "",
        c.jin(
          this.scope === "defaults"
            ? "Applies to saved defaults only; current session stays unchanged."
            : "Applies while idle, to the next compaction check. No request sent.",
        ),
        c.soft("You can change each part afterwards. Original history stays available."),
        ...this.templateDetail(reference.values.compactionPrompt),
        "",
        c.bold(c.ink("Reference and differences")),
        ...(reference.source ? [c.faint(reference.source)] : []),
        ...reference.differences.map((line) => c.soft(line)),
      ];
    }
    const def = "def" in m ? m.def : row?.def;
    if (def) {
      const guide = setupGuide(def);
      const current = setupRead(ctx, def, "session");
      const saved = setupRead(ctx, def, "defaults");
      const choice = browsing.kind === "choices" ? browsing.items[index] : undefined;
      const memberName = browsing.kind === "members" ? browsing.names[index] : undefined;
      const member =
        memberName === ""
          ? "All (including new skills)"
          : def.key === "statusWidgets"
            ? (STATUS_WIDGETS.find((widget) => widget.id === memberName)?.name ?? memberName)
            : memberName;
      const memberNote =
        memberName === undefined
          ? undefined
          : def.key === "prompt.skills.include"
            ? this.skillNote(memberName)
            : def.key === "prompt.skills.sources"
              ? this.sourceNote(def, memberName)
              : def.key === "statusWidgets"
                ? STATUS_WIDGETS.find((widget) => widget.id === memberName)?.note
                : undefined;
      const statusPreview =
        def.key === "statusStyle" || def.key === "statusWidgets"
          ? [
              c.bold(c.jin("Live preview")),
              ...ctx.status.render(previewWidth, {
                style: (def.key === "statusStyle" && choice
                  ? choice.value
                  : setupRead(
                      ctx,
                      settingDef("statusStyle") as SettingDef,
                      this.scope,
                    )) as StatusStyle,
                widgets: setupRead(
                  ctx,
                  settingDef("statusWidgets") as SettingDef,
                  this.scope,
                ) as string[],
              }),
              c.faint("─".repeat(Math.max(0, Math.min(30, previewWidth - 2)))),
            ]
          : [];
      const valueText = (value: unknown) => {
        const label = setupValue(def, value);
        const raw = formatSetting(def, value);
        return compact || label === raw ? label : `${label} (${raw})`;
      };
      const state = [
        c.soft(`Current: ${valueText(current)}`),
        c.soft(`Saved default: ${valueText(saved)}`),
      ];
      const skillPlacement = !def.key.startsWith("prompt.skills.")
        ? []
        : def.key === "prompt.skills.sources"
          ? [
              "Discovery: manual commands and automatic catalogs.",
              "Already loaded instructions stay in history.",
            ]
          : setupRead(ctx, settingDef("prompt.skills.mode") as SettingDef, this.scope) !== "auto"
            ? [
                "Manual mode: no catalog added; range inactive.",
                "/name sends instructions + request as a user message.",
              ]
            : setupRead(ctx, settingDef("prompt.skills.load") as SettingDef, this.scope) === "tool"
              ? [
                  "Catalog target: skill tool definition, not system.",
                  "Names + descriptions; instructions arrive in its result.",
                ]
              : [
                  "Catalog target: system prompt / Skills section.",
                  "Names + descriptions + paths; instructions arrive in a read result.",
                ];
      // 完整说明与紧凑预览使用同一候选;进入详情只保存临时导航位置。
      return [
        ...(choice
          ? [
              c.bold(c.jin("Highlighted choice")),
              c.ink(choice.label),
              c.soft(choice.note ?? guide.effect),
            ]
          : member
            ? [c.bold(c.jin("Highlighted item")), c.ink(member)]
            : [c.bold(c.ink(guide.title))]),
        ...(!choice && !member ? state : []),
        ...skillPlacement.map((line) => c.jin(line)),
        ...(memberNote ? [c.soft(memberNote)] : []),
        ...statusPreview,
        ...(def.key === "compactionPrompt"
          ? this.templateDetail(
              String(choice?.value ?? this.read(def)),
              m.kind === "info" ? m.promptText : undefined,
            )
          : []),
        c.jin(`Applies: ${settingTiming(ctx, def, this.scope)}`),
        ...(choice || member ? [c.faint("── Current state ──"), ...state] : []),
        ...(!compact
          ? [
              "",
              c.faint(`Current value: ${sourceOf(ctx, def, current)}`),
              c.faint(`Key: ${def.key}`),
              "",
              c.bold(c.ink("Effect & tradeoff")),
              c.soft(guide.effect),
              "",
              c.soft(`Recommended: ${setupValue(def, def.builtin)}`),
              c.faint(guide.reason),
              ...(guide.example ? ["", c.bold(c.ink("Example")), c.soft(guide.example)] : []),
            ]
          : choice
            ? []
            : ["", c.soft(guide.effect)]),
      ];
    }
    if (
      this.section !== undefined &&
      SETUP_SECTIONS[this.section]?.id === "context" &&
      this.index === 0
    )
      return [
        c.bold(c.ink("Reference composition")),
        c.soft(`Current: ${this.currentReference()?.label ?? "Custom"}`),
        "",
        c.soft(
          "Choose a reference composition to preview its trigger, preservation and actual summary instructions. Each part remains editable.",
        ),
        c.faint(
          "Only context settings change. Model, tools and conversation history stay unchanged.",
        ),
      ];
    if (m.kind === "presetReview") {
      const target = (def: SettingDef) =>
        configuredValue(def, m.values) ??
        (def.key === "model" ? ctx.deps.settings?.defaultModel?.() : undefined);
      const changed = SETTINGS.filter(
        (def) => !sameSetting(setupRead(ctx, def, "defaults"), target(def)),
      );
      let additional = m.values;
      for (const def of SETTINGS) additional = setSetting(additional, def.key, undefined);
      return [
        c.bold(c.ink(`Load ${m.name}`)),
        "",
        c.soft(`${changed.length} registered settings differ from saved defaults.`),
        c.soft(
          "Replaces registered defaults with this preset over the built-in starting values. Other saved configuration is retained. This session stays unchanged.",
        ),
        "",
        ...changed.map((def) =>
          c.soft(`${setupGuide(def).title}: ${setupValue(def, target(def))}`),
        ),
        ...(Object.keys(additional).length
          ? ["", c.soft(`Additional preset configuration: ${JSON.stringify(additional)}`)]
          : []),
        "",
        c.faint("Restart to use it. Explicit flags and --preset still take priority."),
      ];
    }
    if (m.kind === "presets")
      return [
        c.bold(c.ink("Reusable setups")),
        "",
        c.soft("Choose a preset to review its changes before replacing saved defaults."),
        "",
        c.faint(
          "The current session keeps its model and settings. Presets contain configuration, never API keys.",
        ),
        ...((ctx.deps.settings?.listPresets?.().length ?? 0) === 0
          ? ["", c.soft("No custom presets yet. Save one from the overview.")]
          : []),
      ];
    if (m.kind === "text")
      return [
        c.bold(c.ink("Save your setup")),
        "",
        c.soft(
          `Capture ${this.scope === "session" ? "current settings and the current model" : "saved default settings"} as a named preset.`,
        ),
        c.faint("Use letters, digits, hyphens or underscores. Existing names are not overwritten."),
        "",
        c.faint(
          "Saves the registered settings and model name. Provider connections, custom extension code and credentials remain configured separately.",
        ),
      ];
    if (this.section === undefined && this.index < SETUP_SECTIONS.length) {
      const section = SETUP_SECTIONS[this.index];
      return [
        c.bold(c.ink(section?.title ?? "Agent setup")),
        "",
        c.soft(section?.description ?? ""),
        "",
        ...(section?.keys ?? []).flatMap((key) => {
          const d = settingDef(key);
          return d ? [c.soft(`${setupGuide(d).title}: ${this.value(d)}`)] : [];
        }),
        "",
        c.faint(
          "Enter to inspect and change this part. Each setting explains its effect and recommended starting value.",
        ),
      ];
    }
    return [
      c.bold(c.ink(row?.title ?? "Agent setup")),
      "",
      c.soft(
        "Start with the built-in recommendations, then replace the parts that fit your work differently.",
      ),
      "",
      c.faint(
        "Tab switches between this session and saved defaults. Saving defaults does not change an in-flight task.",
      ),
      "",
      c.faint("/ searches every setting. R on a setting previews restoring its recommendation."),
    ];
  }

  render(width: number): string[] {
    const { ctx } = this.deps;
    const height = Math.max(8, ctx.deps.terminal.rows - 2);
    const inner = Math.max(1, width - 4);
    const pad = (line: string) => truncateToWidth(`  ${line}`, Math.max(1, width), "", true);
    const wrap = (lines: string[], w: number) =>
      lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, w)) : [""]));
    const rows = this.rows();
    this.index = Math.max(0, Math.min(this.index, Math.max(0, rows.length - 1)));
    const m = this.mode;
    const section = this.section === undefined ? undefined : SETUP_SECTIONS[this.section];
    const trail = this.searching
      ? "Search"
      : m.kind === "references" || (m.kind === "info" && m.from.kind === "references")
        ? "Reference composition"
        : m.kind === "presets" || m.kind === "presetReview"
          ? "Presets"
          : "def" in m && m.def
            ? setupGuide(m.def).title
            : section?.title;
    const head = [
      pad(
        `${c.bold(c.ink("Agent setup"))}${trail ? c.soft(` / ${trail}`) : c.faint("  /settings")}`,
      ),
      ...wrap(
        [
          m.kind === "presets" || m.kind === "presetReview"
            ? c.jin("Saved defaults · preview only until you confirm")
            : `${this.scope === "session" ? c.bold(c.jin("[This session]")) : c.soft("This session")}   ${this.scope === "defaults" ? c.bold(c.jin("[Saved defaults]")) : c.soft("Saved defaults")}  ${m.kind === "browse" ? c.faint("Tab to switch") : ""}`,
        ],
        inner,
      ).map(pad),
      pad(
        c.faint(
          this.scope === "session" && m.kind !== "presets" && m.kind !== "presetReview"
            ? `${ctx.model.info.model} · ${ctx.agent.running ? "Running" : "Idle"} · temporary changes`
            : "Future starts only · current session stays unchanged",
        ),
      ),
      pad(c.faint("─".repeat(inner))),
    ];
    if (this.searching) head.push(pad(`${c.soft("Search / ")}${c.ink(this.query)}${c.jin("▏")}`));
    if (m.kind === "text") {
      const label = truncateToWidth(
        m.purpose === "save" ? "Preset name: " : m.purpose === "source" ? "Directory: " : "Value: ",
        Math.max(0, inner - 1),
        "",
      );
      const room = Math.max(0, inner - visibleWidth(label) - 1);
      const textWidth = visibleWidth(m.text);
      // 单行输入始终在末尾编辑;按终端列取可见后缀,保留完整值与输入标记。
      const text =
        textWidth > room
          ? room > 0
            ? `…${sliceByColumn(m.text, textWidth - room + 1, room - 1, true)}`
            : ""
          : m.text;
      head.push(pad(`${c.soft(label)}${c.ink(text)}${c.jin("▏")}`));
    }
    const actions = this.actions();
    const hint = this.action
      ? `Enter ${this.action.toLowerCase()} · ←→ actions · ↑↓ list · Esc list`
      : m.kind === "text"
        ? `Enter ${m.purpose === "source" ? "add" : "save"} · Ctrl+U clear · Esc back`
        : m.kind === "info"
          ? "↑↓ scroll · PgUp/PgDn · Esc back"
          : m.kind === "presetReview"
            ? "↑↓ scroll review · Enter use defaults · Esc cancel"
            : m.kind === "choices" || m.kind === "references"
              ? "↑↓ choose · Enter apply · ←→ actions · Esc back"
              : m.kind === "members"
                ? `↑↓ move · Enter ${m.def.type === "map" && m.def.key !== "prompt.skills.sources" ? "cycle" : "toggle"}${m.def.key === "prompt.skills.sources" ? " · Del remove" : ""} · ←→ actions · Esc back`
                : m.kind === "browse"
                  ? `↑↓ move · Enter open · / search${actions.length ? " · ←→ actions" : ""} · Esc back`
                  : "↑↓ move · Enter select · Esc back";
    const notice = this.notice
      ? wrap([`${this.notice.ok ? "✓" : "!"} ${this.notice.message}`], inner)
          .slice(0, 3)
          .map((l) => pad(this.notice?.ok ? c.soft(l) : c.zhu(l)))
      : [];
    const footer = [
      ...notice,
      pad(c.faint("─".repeat(inner))),
      ...(actions.length
        ? wrap(
            [
              actions
                .map((a) =>
                  a.title === this.action
                    ? selectedText(`${G.cursor} ${a.title}`)
                    : c.soft(`[${a.title}]`),
                )
                .join("  "),
            ],
            inner,
          ).map(pad)
        : []),
      ...wrap([this.busy ? "Applying…" : hint], inner).map((line) => pad(c.faint(line))),
    ];
    const room = Math.max(1, height - head.length - footer.length);
    if (m.kind === "info") {
      const info = wrap(this.detail(undefined, false, inner), inner);
      m.offset = Math.max(0, Math.min(m.offset, Math.max(0, info.length - room)));
      return [...head, ...info.slice(m.offset, m.offset + room).map(pad), ...footer];
    }
    const wide = width >= 100 && m.kind !== "text";
    const home =
      m.kind === "browse" && !this.searching && !this.query && this.section === undefined;
    const rowHeight = home ? 3 : 1;
    const listWidth = wide ? Math.floor(inner * 0.45) : inner;
    const activeDef = "def" in m ? m.def : rows[this.index]?.def;
    const details = wrap(
      this.detail(rows[this.index], !wide, wide ? inner - listWidth - 3 : inner),
      wide ? inner - listWidth - 3 : inner,
    );
    if (m.kind === "presetReview") {
      const available = wide ? room : Math.max(1, room - 2);
      m.offset = Math.min(m.offset, Math.max(0, details.length - available));
      details.splice(0, m.offset);
    }
    const capacity = wide
      ? room
      : m.kind === "text"
        ? 0
        : Math.min(
            Math.max(
              1,
              Math.floor(
                room *
                  (m.kind === "members" && m.def.key === "statusWidgets"
                    ? 0.55
                    : activeDef
                      ? 0.3
                      : 0.55),
              ),
            ),
            Math.max(rows.length * rowHeight, 1),
          );
    // 首页每项占三行;导航仍按设置项移动,视口按实际终端行计算。
    const visible = Math.max(
      1,
      Math.floor((capacity - (rows.length * rowHeight > capacity ? 1 : 0)) / rowHeight),
    );
    // 翻页跟随已显示的项数;只保存当前视口的临时读数。
    this.pageSize = visible;
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(visible / 2), rows.length - visible),
    );
    const list = rows.slice(start, start + visible).flatMap((row, offset) => {
      const selected = start + offset === this.index && !this.action;
      if (home) {
        const title = `${selected ? G.cursor : " "} ${row.title}`;
        return [
          truncateToWidth(selected ? selectedText(title) : c.soft(title), listWidth, "…", true),
          truncateToWidth(c.soft(`  ${row.value ?? ""}`), listWidth, "…", true),
          c.faint("─".repeat(listWidth)),
        ];
      }
      const titleWidth = Math.max(8, Math.min(29, Math.floor(listWidth * 0.58)));
      const title = truncateToWidth(row.title, titleWidth, "…", true);
      const value = row.value ? ` ${row.value}` : "";
      const line = `${selected ? G.cursor : " "} ${title}${value}`;
      return truncateToWidth(selected ? selectedText(line) : c.soft(line), listWidth, "…", true);
    });
    if (rows.length === 0 && m.kind !== "text")
      list.push(c.soft("No matching settings. Esc clears the search."));
    if (rows.length > visible)
      list.push(
        c.faint(
          `${start + 1}–${Math.min(rows.length, start + visible)} of ${rows.length} · PgUp/PgDn`,
        ),
      );
    const body: string[] = [];
    const clippedDetails = (available: number) => {
      const lines = details.slice(0, available);
      if ((activeDef || m.kind === "references") && details.length > available && available > 0)
        lines[available - 1] = c.faint(
          actions.some((a) => a.title === "Details") ? "… [Details] shows full text" : "…",
        );
      return lines;
    };
    if (wide) {
      const shown = clippedDetails(room);
      for (let i = 0; i < room; i++)
        body.push(
          pad(
            `${truncateToWidth(list[i] ?? "", listWidth, "", true)} ${c.faint("│")} ${shown[i] ?? ""}`,
          ),
        );
    } else {
      const content =
        m.kind === "text"
          ? details
          : [
              ...list,
              c.faint("─".repeat(inner)),
              ...clippedDetails(Math.max(0, room - list.length - 1)),
            ];
      for (let i = 0; i < room; i++) body.push(pad(content[i] ?? ""));
    }
    return [...head, ...body, ...footer].slice(0, height);
  }
}
