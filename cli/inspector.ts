// 检视器:对事件数组的几种投影,全部只读(上下文工作台的动作交回界面层落成事件)。
//   请求视图  一行一请求 → 七分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入)   inspector-requests
//   事件视图  同一条流,每种事件一句人读的话;筛选页签;详情三页(排版 / JSON / 在投影里怎么了)   inspector-events
//   压缩对照  每次压缩:被覆盖的那一大段原文 ↔ 它变成的摘要,带 token 与压缩比                 inspector-compactions
//   工作台    Ctrl+E:下一次请求的正文按发送顺序一列,token 尺、缓存线、底部预览;Enter 出动作     inspector-workbench
//   会话切换  通过可见操作切换主会话与子 agent 会话,以上视图作用在选中的数组上
// 行数爆炸由视口与按键控制,不靠删内容:任何一字节都能翻到。
// 本文件只剩覆盖层组件 RequestInspector:模式、选中、滚动、按键、行缓存;各视图的行由上面的模块算。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import { editState, type Message } from "../src/messages.js";
import type { Provider, ToolDef } from "../src/provider.js";
import { BodyBrowser } from "./body-browser.js";
import { inputBlocks, receivedBlocks, recordingErrorBlock } from "./inspector-bodies.js";
import {
  COMPACTION_SECTIONS,
  type CompactionRecord,
  type CompactionSection,
  collectCompactions,
  compactionLines,
  compactionRow,
} from "./inspector-compactions.js";
import {
  type ActionItem,
  actionsFor,
  type CompositionRow,
  type ContextAction,
  compositionLines,
  compositionRows,
  consequenceOf,
} from "./inspector-composition.js";
import {
  EVENT_FILTERS,
  EVENT_SECTIONS,
  type EventFilter,
  type EventSection,
  eventLine,
  eventSummary,
  eventViewLines,
  filteredIndices,
  projectionLines,
} from "./inspector-events.js";
import {
  cacheUsageLines,
  clock,
  fmtTok,
  messageTokens,
  pctOf,
  roleLabel,
} from "./inspector-format.js";
import {
  collectRequests,
  decisionLines,
  eventLines,
  exchangeLines,
  listRow,
  messagesFor,
  narrowListRows,
  type RequestRecord,
  SECTIONS,
  type Section,
  sentLines,
  summaryLines,
  toolLines,
  wireLines,
  writtenLines,
} from "./inspector-requests.js";
import {
  coveredLines,
  previewLines,
  selectable,
  type Workbench,
  type WorkbenchRow,
  workbench,
  workbenchHeader,
  workbenchLine,
} from "./inspector-workbench.js";
import { type SectionState, sectionStates } from "./prompt-sections.js";
import type { RecordingSection, RequestRecording } from "./session-records.js";
import { c, G, selectedText } from "./theme.js";

export type SessionSource = {
  name: string;
  events: readonly AgentEvent[];
  recordingDirectory?: string;
  recordingFor?: (index: number, section?: RecordingSection) => RequestRecording | undefined;
};

export type InspectorDeps = {
  /** 主会话的事件。 */
  events: () => readonly AgentEvent[];
  /** 全部会话(主 + 子)。不给则只有主会话。 */
  sessions?: () => SessionSource[];
  /** 主会话某次请求当时的 provider;拿不到就退回内核层视图。 */
  providerFor: (requestIndex: number) => Provider | undefined;
  /** 当前 provider:子会话或恢复的会话在模型名相同时用它重建线路正文。 */
  currentProvider?: () => Provider | undefined;
  tools: () => ToolDef[];
  /** 可用行数(终端高度)。 */
  rows: () => number;
  /** 上一次正常请求发出的消息:工作台据此画缓存线。 */
  lastSent?: () => Message[] | undefined;
  /** 上下文窗口:工作台头行的占比。 */
  contextWindow?: () => number;
  /** 模型正在跑:工作台只看不改。 */
  running?: () => boolean;
  /** 当前宿主会话不能编辑的原因;只读检视仍可用。 */
  readOnlyReason?: () => string | undefined;
  /** 工作台里选中一条消息并选了动作。view 由检视器自己处理,其余交给界面落到命令上。 */
  onAction?: (action: ContextAction, row: CompositionRow) => void;
  /** 工作台的 system 行:翻一段(界面层追加 context/edit)。 */
  onSection?: (name: string) => void;
  /** 工作台的 tools 行:开 /tools 选单(界面层关掉检视器再开)。 */
  onTools?: () => void;
  onClose: () => void;
  requestRender: () => void;
};

// ---------- 组件 ----------

type Mode =
  | "list"
  | "detail"
  | "events"
  | "event"
  | "records"
  | "record"
  | "compactions"
  | "compaction"
  | "composition"
  | "actions"
  | "message"
  | "sections"
  | "covered";

/** 工作台底部预览区的行数(来历一行加正文四行)。 */
const PREVIEW_LINES = 5;

function lastIndexWhere<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";

export class RequestInspector implements Component {
  private mode: Mode = "list";
  private sessionIndex = 0;
  private selected = 0;
  private eventSelected = 0;
  private eventFilter: EventFilter = 1;
  private eventSection: EventSection = 1;
  private compactionSelected = 0;
  private section: Section = 1;
  private compactionSection: CompactionSection = 1;
  private scroll = 0;
  private bodies = new BodyBrowser();
  private bodyEvidence = "";
  private lastViewport = 10;
  private sectionSelected = 0;
  /** 运行中按了会改上下文的键:在预览区说一句,不开动作单。 */
  private busyNote: string | undefined;
  private recCache:
    | { events: readonly AgentEvent[]; len: number; recs: RequestRecord[] }
    | undefined;
  private wbCache:
    | { events: readonly AgentEvent[]; len: number; key: string; wb: Workbench }
    | undefined;
  /** 已按宽度换行的分区内容缓存;键含会话与事件数,日志一变自然失效。生产级会话动辄上千事件,不能每个按键都重算。 */
  private lineCache = new Map<string, string[]>();

  constructor(private deps: InspectorDeps) {}

  /** 打开时回到主会话的请求列表并选中最新一条。 */
  reset(): void {
    this.mode = "list";
    this.sessionIndex = 0;
    this.section = 1;
    this.scroll = 0;
    this.selected = Math.max(0, this.records().length - 1);
  }

  /** 直接进入事件视图(/inspect events)。 */
  showEvents(): void {
    this.mode = "events";
    this.scroll = 0;
    const idx = filteredIndices(this.events(), this.eventFilter);
    this.eventSelected = idx.at(-1) ?? 0;
  }

  /** 直接进入压缩对照(/inspect compactions)。 */
  showCompactions(): void {
    this.mode = "compactions";
    this.scroll = 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
  }

  private messageSelected = 0;
  private actionSelected: ContextAction = "view";

  /** 直接定位到第 n 次请求的某个分区(/inspect raw N → 接收分区)。没有该请求返回 false。 */
  showRequest(n: number, section: Section): boolean {
    this.sessionIndex = 0;
    const idx = this.records().findIndex((r) => r.n === n);
    if (idx < 0) return false;
    this.selected = idx;
    this.section = section;
    this.mode = "detail";
    this.scroll = 0;
    return true;
  }

  /** 直接进入工作台(Ctrl+E)。at = 事件下标:光标落在从它起的第一条消息上;不给就落在最后一条。 */
  showComposition(at?: number): void {
    this.mode = "composition";
    this.scroll = 0;
    this.busyNote = undefined;
    const rows = this.workbench().rows;
    let pick = -1;
    if (at !== undefined) {
      pick = rows.findIndex(
        (r) => (r.kind === "message" || r.kind === "system") && r.row.event >= at,
      );
    }
    if (pick < 0) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.kind === "message" || rows[i]?.kind === "system") {
          pick = i;
          break;
        }
      }
    }
    this.messageSelected = Math.max(0, pick);
  }

  composition(): ReturnType<typeof compositionRows> {
    return compositionRows(
      this.events(),
      this.events() === this.deps.events() ? this.deps.currentProvider?.() : undefined,
    );
  }

  /** 工作台的行:按会话、事件数与工具集缓存,同一状态下按键不重算。 */
  workbench(): Workbench {
    const events = this.events();
    const main = events === this.deps.events();
    const tools = main ? this.deps.tools() : [];
    const lastSent = main ? this.deps.lastSent?.() : undefined;
    const key = `${this.sessionIndex}:${tools.map((t) => t.name).join(",")}:${lastSent?.length ?? -1}`;
    if (
      this.wbCache?.events !== events ||
      this.wbCache.len !== events.length ||
      this.wbCache.key !== key
    ) {
      const wb = workbench({
        events,
        provider: main ? this.deps.currentProvider?.() : undefined,
        tools,
        lastSent,
      });
      // 子任务下一次派发会重新组装工具;不能把主会话工具冒充子配置。
      if (!main) wb.rows = wb.rows.filter((row) => row.kind !== "tools");
      this.wbCache = { events, len: events.length, key, wb };
    }
    return this.wbCache.wb;
  }

  /** 工作台当前选中的行。 */
  private selectedRow(): WorkbenchRow | undefined {
    return this.workbench().rows[this.messageSelected];
  }

  /** 日志仍在追加时按正在查看的事件定位,不复用可能已移动的屏幕行。 */
  private recordGroup(): Extract<WorkbenchRow, { kind: "records" }> | undefined {
    const rows = this.workbench().rows;
    const index = rows.findIndex(
      (r) => r.kind === "records" && this.eventSelected >= r.from && this.eventSelected < r.upTo,
    );
    const row = rows[index];
    if (row?.kind !== "records") return undefined;
    this.messageSelected = index;
    return row;
  }

  get isDetail(): boolean {
    return this.mode === "detail";
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get currentSession(): number {
    return this.sessionIndex;
  }

  sessions(): SessionSource[] {
    const list = this.deps.sessions?.() ?? [];
    return list.length > 0 ? list : [{ name: "main", events: this.deps.events() }];
  }

  /** 当前选中会话的事件数组。 */
  events(): readonly AgentEvent[] {
    const list = this.sessions();
    const s = list[Math.min(this.sessionIndex, list.length - 1)];
    return s ? s.events : this.deps.events();
  }

  records(): RequestRecord[] {
    const events = this.events();
    if (this.recCache?.events !== events || this.recCache.len !== events.length) {
      this.recCache = { events, len: events.length, recs: collectRequests(events) };
    }
    return this.recCache.recs;
  }

  compactions(): CompactionRecord[] {
    return collectCompactions(this.events());
  }

  invalidate(): void {
    this.lineCache.clear();
  }

  private switchSession(direction: -1 | 1): void {
    const n = this.sessions().length;
    if (n <= 1) return;
    this.sessionIndex = (this.sessionIndex + direction + n) % n;
    this.selected = Math.max(0, this.records().length - 1);
    this.eventSelected = filteredIndices(this.events(), this.eventFilter).at(-1) ?? 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
    this.scroll = 0;
  }

  /** 事件视图:在通过筛选的下标里移动 step 步(负数向上);request 为真时只在 request 之间跳。 */
  private moveEvent(step: number, request = false): void {
    const idx = filteredIndices(this.events(), this.eventFilter).filter(
      (i) => !request || this.events()[i]?.type === "request",
    );
    if (idx.length === 0) return;
    let pos = idx.indexOf(this.eventSelected);
    if (pos < 0) {
      // 当前项不在筛选里(如切了筛选):向移动方向找最近的一项。
      pos =
        step < 0
          ? idx.findIndex((i) => i > this.eventSelected)
          : lastIndexWhere(idx, (i) => i < this.eventSelected);
      if (pos < 0) pos = step < 0 ? idx.length : -1;
    }
    const next = Math.min(idx.length - 1, Math.max(0, pos + step));
    this.eventSelected = idx[next] as number;
  }

  /** 工作台:在可停的行之间移动。 */
  private moveRow(step: number): void {
    const rows = this.workbench().rows;
    let i = this.messageSelected;
    const dir = step < 0 ? -1 : 1;
    let left = Math.abs(step);
    while (left > 0) {
      let j = i + dir;
      while (j >= 0 && j < rows.length && !selectable(rows[j] as WorkbenchRow)) j += dir;
      if (j < 0 || j >= rows.length) break;
      i = j;
      left--;
    }
    this.messageSelected = i;
    this.busyNote = undefined;
  }

  private prepareBodies(rec: RequestRecord | undefined): boolean {
    if (!rec) return false;
    const events = this.events();
    const saved = this.sessions()[this.sessionIndex]?.recordingFor?.(
      rec.index,
      this.section === 3 ? "input" : "received",
    );
    const start = events.find((e) => e.type === "session/start");
    this.bodyEvidence =
      this.section === 3
        ? saved?.input
          ? saved.unsaved
            ? "captured input · not saved"
            : "saved adapter input"
          : "reconstructed from events"
        : "response and tool evidence";
    const prior = this.records()[rec.n - 2];
    const priorInput =
      prior && this.section === 3
        ? this.sessions()[this.sessionIndex]?.recordingFor?.(prior.index, "input")?.input
        : undefined;
    const previous =
      prior && this.section === 3
        ? (priorInput?.messages ?? messagesFor(events, prior))
        : undefined;
    if (this.section === 3) {
      const toolChange = !prior
        ? "first request"
        : saved?.input && priorInput
          ? JSON.stringify(saved.input.tools) === JSON.stringify(priorInput.tools)
            ? "unchanged"
            : "changed"
          : "comparison unavailable (definitions not recorded)";
      this.bodyEvidence += `\nTool definitions: ${toolChange}`;
    }
    const blocks =
      this.section === 3
        ? inputBlocks(
            saved?.input?.messages ?? messagesFor(events, rec),
            start?.type === "session/start" ? start.sections : undefined,
            previous,
          )
        : receivedBlocks(rec, saved);
    if (this.section === 3 && blocks[0]) {
      const changed = rec.before.filter(
        (e) => e.type === "context/edit" || e.type === "context/drop" || e.type === "compaction",
      );
      if (changed.length)
        blocks[0].meta += ` · ${[...new Set(changed.map((e) => e.type))].join(", ")} before this request; 2 decisions`;
    }
    if (this.section === 3 && saved?.error) blocks.unshift(recordingErrorBlock(saved.error));
    this.bodies.set(`${this.sessionIndex}:${rec.index}:${this.section}`, blocks);
    return true;
  }

  private busy(): boolean {
    return this.deps.running?.() ?? false;
  }

  private contextReadOnlyReason(): string | undefined {
    if (this.events() !== this.deps.events()) return "Read-only · Sub-session context.";
    return (
      this.deps.readOnlyReason?.() ??
      (this.busy()
        ? "Context is read-only while running; close this view and use /stop to interrupt."
        : undefined)
    );
  }

  private contextActions(row: CompositionRow, total: number): ActionItem[] {
    const items = actionsFor(this.events(), row, total);
    // 渲染与按键执行共用筛选,菜单打开后运行状态改变也不能执行过期动作。
    if (this.events() !== this.deps.events() || this.busy())
      return items.filter((item) => item.action === "view");
    if (this.deps.readOnlyReason?.())
      return items.filter((item) => ["view", "compare", "fork"].includes(item.action));
    return items;
  }

  /** 提示词段:切得回来就带开关;切不回来只列元数据。 */
  private sections(): { states: SectionState[] | undefined; names: string[] } {
    const events = this.events();
    const states = sectionStates(events);
    const start = events.find((e) => e.type === "session/start");
    const names = start?.type === "session/start" ? (start.sections ?? []).map((s) => s.name) : [];
    return { states, names };
  }

  handleInput(data: string): void {
    const recs = this.records();
    const events = this.events();
    const comps = this.compactions();
    const page = Math.max(1, this.lastViewport - 1);
    const tab = data === "\t";
    if (
      ["list", "events", "composition", "compactions"].includes(this.mode) &&
      this.sessions().length > 1 &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right))
    ) {
      this.switchSession(matchesKey(data, Key.left) ? -1 : 1);
      if (this.mode === "composition") this.showComposition();
      this.deps.requestRender();
      return;
    }
    const clampSel = (v: number, len: number) => Math.min(Math.max(0, len - 1), Math.max(0, v));
    const scrollKeys = (): boolean => {
      if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, Key.down)) this.scroll += 1;
      else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, Key.pageDown)) this.scroll += page;
      else if (matchesKey(data, Key.home)) this.scroll = 0;
      else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
      else return false;
      return true;
    };
    switch (this.mode) {
      case "list":
        if (matchesKey(data, Key.escape)) this.deps.onClose();
        else if (tab) this.showEvents();
        else if (matchesKey(data, Key.up)) this.selected = clampSel(this.selected - 1, recs.length);
        else if (matchesKey(data, Key.down))
          this.selected = clampSel(this.selected + 1, recs.length);
        else if (matchesKey(data, Key.pageUp))
          this.selected = clampSel(this.selected - page, recs.length);
        else if (matchesKey(data, Key.pageDown))
          this.selected = clampSel(this.selected + page, recs.length);
        else if (matchesKey(data, Key.home)) this.selected = 0;
        else if (matchesKey(data, Key.end)) this.selected = Math.max(0, recs.length - 1);
        else if (matchesKey(data, Key.enter) && recs.length > 0) {
          this.mode = "detail";
          this.scroll = 0;
        }
        break;
      case "detail":
        if (matchesKey(data, Key.escape)) {
          this.mode = "list";
          this.scroll = 0;
        } else if (
          (this.section === 3 || this.section === 6) &&
          this.prepareBodies(recs[this.selected]) &&
          this.bodies.handleInput(data)
        ) {
          // 选择与展开仅属于当前正文视图。
        } else if (scrollKeys()) {
          // 已处理
        } else if (matchesKey(data, Key.left)) this.switchSection(-1);
        else if (matchesKey(data, Key.right)) this.switchSection(1);
        else if (/^[1-7]$/.test(data)) {
          this.section = Number(data) as Section;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.selected = clampSel(this.selected + (data === "]" ? 1 : -1), recs.length);
          this.scroll = 0;
        }
        break;
      case "events":
        if (matchesKey(data, Key.escape)) this.deps.onClose();
        else if (tab) this.showCompactions();
        else if (data === CTRL_UP) this.moveEvent(-1, true);
        else if (data === CTRL_DOWN) this.moveEvent(1, true);
        else if (matchesKey(data, Key.up)) this.moveEvent(-1);
        else if (matchesKey(data, Key.down)) this.moveEvent(1);
        else if (matchesKey(data, Key.pageUp)) this.moveEvent(-page);
        else if (matchesKey(data, Key.pageDown)) this.moveEvent(page);
        else if (matchesKey(data, Key.home))
          this.eventSelected = filteredIndices(events, this.eventFilter)[0] ?? 0;
        else if (matchesKey(data, Key.end))
          this.eventSelected = filteredIndices(events, this.eventFilter).at(-1) ?? 0;
        else if (/^[1-5]$/.test(data)) {
          this.eventFilter = Number(data) as EventFilter;
          const idx = filteredIndices(events, this.eventFilter);
          if (!idx.includes(this.eventSelected)) {
            const at = lastIndexWhere(idx, (i) => i <= this.eventSelected);
            this.eventSelected = (at >= 0 ? idx[at] : idx[0]) ?? 0;
          }
        } else if (matchesKey(data, Key.enter) && events.length > 0) {
          this.mode = "event";
          this.scroll = 0;
        }
        break;
      case "records": {
        const group = this.recordGroup();
        if (group?.kind !== "records") {
          this.mode = "composition";
          break;
        }
        const move = (step: number) => {
          this.eventSelected = Math.max(
            group.from,
            Math.min(group.upTo - 1, this.eventSelected + step),
          );
        };
        if (matchesKey(data, Key.escape)) this.mode = "composition";
        else if (matchesKey(data, Key.up)) move(-1);
        else if (matchesKey(data, Key.down)) move(1);
        else if (matchesKey(data, Key.pageUp)) move(-page);
        else if (matchesKey(data, Key.pageDown)) move(page);
        else if (matchesKey(data, Key.home)) this.eventSelected = group.from;
        else if (matchesKey(data, Key.end)) this.eventSelected = group.upTo - 1;
        else if (matchesKey(data, Key.enter)) {
          this.mode = "record";
          this.eventSection = 1;
          this.scroll = 0;
        }
        break;
      }
      case "event":
      case "record":
        if (matchesKey(data, Key.escape)) {
          this.mode = this.mode === "record" ? "records" : "events";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (/^[1-3]$/.test(data)) {
          this.eventSection = Number(data) as EventSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.left)) {
          this.eventSection = (this.eventSection === 1 ? 3 : this.eventSection - 1) as EventSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.right)) {
          this.eventSection = (this.eventSection === 3 ? 1 : this.eventSection + 1) as EventSection;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          const row = this.mode === "record" ? this.recordGroup() : undefined;
          if (this.mode === "record" && row?.kind === "records")
            this.eventSelected = Math.max(
              row.from,
              Math.min(row.upTo - 1, this.eventSelected + (data === "]" ? 1 : -1)),
            );
          else this.moveEvent(data === "]" ? 1 : -1);
          this.scroll = 0;
        }
        break;
      case "composition": {
        const row = this.selectedRow();
        if (matchesKey(data, Key.escape)) this.deps.onClose();
        else if (tab) {
          this.mode = "list";
          this.scroll = 0;
        } else if (matchesKey(data, Key.up)) this.moveRow(-1);
        else if (matchesKey(data, Key.down)) this.moveRow(1);
        else if (matchesKey(data, Key.pageUp)) this.moveRow(-page);
        else if (matchesKey(data, Key.pageDown)) this.moveRow(page);
        else if (matchesKey(data, Key.home)) {
          this.messageSelected = 0;
          this.moveRow(0);
        } else if (matchesKey(data, Key.end)) {
          this.messageSelected = this.workbench().rows.length - 1;
          this.moveRow(0);
        } else if (matchesKey(data, Key.enter) && row) this.enterRow(row);
        break;
      }
      case "actions": {
        const row = this.selectedRow();
        const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
        const total = this.composition().rows.length;
        const items = r ? this.contextActions(r, total) : [];
        const previous = this.actionSelected;
        const selected = Math.max(
          0,
          items.findIndex((item) => item.action === previous),
        );
        if (matchesKey(data, Key.escape)) this.mode = "composition";
        else if (matchesKey(data, Key.up))
          this.actionSelected = items[clampSel(selected - 1, items.length)]?.action ?? "view";
        else if (matchesKey(data, Key.down))
          this.actionSelected = items[clampSel(selected + 1, items.length)]?.action ?? "view";
        else if (/^[1-9]$/.test(data) && Number(data) <= items.length)
          this.actionSelected = items[Number(data) - 1]?.action ?? "view";
        else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
        else if (matchesKey(data, Key.pageDown)) this.scroll += page;
        else if (matchesKey(data, Key.enter) && r) {
          const item = items.find((item) => item.action === this.actionSelected);
          if (item?.action === "view") {
            this.mode = "message";
            this.scroll = 0;
          } else if (item) {
            this.mode = "composition";
            this.deps.onAction?.(item.action, r);
          }
        }
        if (previous !== this.actionSelected) this.scroll = 0;
        break;
      }
      case "message": {
        if (matchesKey(data, Key.escape)) {
          this.mode = "composition";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (data === "[" || data === "]") {
          this.moveRow(data === "]" ? 1 : -1);
          const row = this.selectedRow();
          if (row?.kind !== "message" && row?.kind !== "system") this.mode = "composition";
          this.scroll = 0;
        }
        break;
      }
      case "sections": {
        const { states, names } = this.sections();
        const n = states?.length ?? names.length;
        if (matchesKey(data, Key.escape)) this.mode = "composition";
        else if (matchesKey(data, Key.up))
          this.sectionSelected = clampSel(this.sectionSelected - 1, n);
        else if (matchesKey(data, Key.down))
          this.sectionSelected = clampSel(this.sectionSelected + 1, n);
        else if (matchesKey(data, Key.pageUp))
          this.sectionSelected = clampSel(this.sectionSelected - page, n);
        else if (matchesKey(data, Key.pageDown))
          this.sectionSelected = clampSel(this.sectionSelected + page, n);
        else if (matchesKey(data, Key.home)) this.sectionSelected = 0;
        else if (matchesKey(data, Key.end)) this.sectionSelected = Math.max(0, n - 1);
        else if (/^[1-9]$/.test(data) && Number(data) <= n) this.sectionSelected = Number(data) - 1;
        else if (matchesKey(data, Key.enter) && states) {
          const s = states[this.sectionSelected];
          const reason = this.contextReadOnlyReason();
          if (reason) this.busyNote = reason;
          else if (s) this.deps.onSection?.(s.name);
        }
        break;
      }
      case "covered":
        if (matchesKey(data, Key.escape)) {
          this.mode = "composition";
          this.scroll = 0;
        } else scrollKeys();
        break;
      case "compactions":
        if (matchesKey(data, Key.escape)) this.deps.onClose();
        else if (tab) this.showComposition();
        else if (matchesKey(data, Key.up))
          this.compactionSelected = clampSel(this.compactionSelected - 1, comps.length);
        else if (matchesKey(data, Key.down))
          this.compactionSelected = clampSel(this.compactionSelected + 1, comps.length);
        else if (matchesKey(data, Key.pageUp))
          this.compactionSelected = clampSel(this.compactionSelected - page, comps.length);
        else if (matchesKey(data, Key.pageDown))
          this.compactionSelected = clampSel(this.compactionSelected + page, comps.length);
        else if (matchesKey(data, Key.home)) this.compactionSelected = 0;
        else if (matchesKey(data, Key.end)) this.compactionSelected = Math.max(0, comps.length - 1);
        else if (matchesKey(data, Key.enter) && comps.length > 0) {
          this.mode = "compaction";
          this.compactionSection = 1;
          this.scroll = 0;
        }
        break;
      case "compaction":
        if (matchesKey(data, Key.escape)) {
          this.mode = "compactions";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (/^[1-4]$/.test(data)) {
          this.compactionSection = Number(data) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.left)) {
          this.compactionSection = (
            this.compactionSection === 1 ? 4 : this.compactionSection - 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.right)) {
          this.compactionSection = (
            this.compactionSection === 4 ? 1 : this.compactionSection + 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.compactionSelected = clampSel(
            this.compactionSelected + (data === "]" ? 1 : -1),
            comps.length,
          );
          this.scroll = 0;
        }
        break;
    }
    this.deps.requestRender();
  }

  /** 工作台里按 Enter:按行的种类分派。 */
  private enterRow(row: WorkbenchRow): void {
    switch (row.kind) {
      case "records":
        this.mode = "records";
        this.eventSelected = row.from;
        this.eventSection = 1;
        this.scroll = 0;
        return;
      case "message":
        if (row.row.stages.some((s) => s.startsWith("summary"))) {
          const comps = this.compactions();
          const k = comps.findIndex((cmp) => cmp.index === row.row.event);
          if (k >= 0) {
            this.compactionSelected = k;
            this.compactionSection = 1;
            this.mode = "compaction";
            this.scroll = 0;
            return;
          }
        }
        this.mode = "actions";
        this.actionSelected = "view";
        this.scroll = 0;
        return;
      case "system":
        if (this.contextReadOnlyReason()) {
          this.mode = "message";
          this.scroll = 0;
          return;
        }
        this.mode = "sections";
        this.sectionSelected = 0;
        this.busyNote = undefined;
        return;
      case "tools":
        if (this.contextReadOnlyReason()) this.busyNote = this.contextReadOnlyReason();
        else this.deps.onTools?.();
        return;
      case "covered":
        this.mode = "covered";
        this.scroll = 0;
        return;
      case "dropped":
      case "prefix":
        return;
    }
  }

  private switchSection(step: number): void {
    const next = this.section + step;
    this.section = (next < 1 ? 7 : next > 7 ? 1 : next) as Section;
    this.scroll = 0;
  }

  private providerFor(requestIndex: number): Provider | undefined {
    if (this.sessionIndex === 0) return this.deps.providerFor(requestIndex);
    const e = this.events()[requestIndex];
    const cur = this.deps.currentProvider?.();
    return e?.type === "request" && cur && e.model === cur.model ? cur : undefined;
  }

  /** 当前分区的完整内容行(未按视口裁切),测试与预览用。 */
  sectionLines(rec: RequestRecord, section: Section): string[] {
    const events = this.events();
    const recording = this.sessions()[this.sessionIndex]?.recordingFor?.(
      rec.index,
      section === 5 ? "wire" : section === 1 ? "summary" : "input",
    );
    const messages = recording?.input?.messages ?? messagesFor(events, rec);
    const available = new Map(this.deps.tools().map((d) => [d.name, d]));
    const defs =
      recording?.input?.tools ?? rec.request.tools.flatMap((name) => available.get(name) ?? []);
    const missing = rec.request.tools.filter((name) => !defs.some((d) => d.name === name));
    const previous = this.records()[rec.n - 2];
    const prior = previous
      ? (this.sessions()[this.sessionIndex]?.recordingFor?.(previous.index, "input")?.input
          ?.messages ?? messagesFor(events, previous))
      : undefined;
    switch (section) {
      case 1:
        return [
          ...exchangeLines(events, rec, messages, prior, recording),
          "",
          ...summaryLines(rec, messages),
        ];
      case 2:
        return decisionLines(rec);
      case 3: {
        const start = events.find((e) => e.type === "session/start");
        const sections = start?.type === "session/start" ? start.sections : undefined;
        return [
          ...(recording?.error ? [c.zhu(recording.error)] : []),
          ...sentLines(messages, false, sections, prior, Boolean(recording?.input)),
        ];
      }
      case 4:
        return toolLines(defs, rec.request.tools, recording);
      case 5:
        return wireLines(
          this.providerFor(rec.index),
          messages,
          defs,
          rec.request.effort,
          recording,
          missing,
          rec.request.maxTokens,
        );
      case 6:
        return []; // 正文浏览器负责此分区。
      case 7: {
        const recs = this.records();
        const next = recs.find((r) => r.index > rec.index);
        return writtenLines(events, rec, next ? next.index : events.length);
      }
    }
  }

  private cached(key: string, build: () => string[]): string[] {
    const hit = this.lineCache.get(key);
    if (hit) return hit;
    if (this.lineCache.size > 64) this.lineCache.clear();
    const lines = build();
    this.lineCache.set(key, lines);
    return lines;
  }

  /** 会话选择器:多于一个会话时显示在列表类视图的头部。 */
  private sessionLine(): string | undefined {
    const list = this.sessions();
    if (list.length <= 1) return undefined;
    const items = list.map((s, i) =>
      i === this.sessionIndex ? selectedText(`${G.cursor} ${s.name}`) : c.faint(`  ${s.name}`),
    );
    return `${items.join("   ")}   ${c.faint("←/→ select session")}`;
  }

  /** 页签行:[1 name] 2 name 3 name。 */
  private tabs(
    names: readonly string[],
    current: number,
    width = Number.POSITIVE_INFINITY,
  ): string {
    const full = names
      .map((name, i) => {
        const n = i + 1;
        return n === current ? selectedText(`[${n} ${name}]`) : c.soft(` ${n} ${name} `);
      })
      .join(" ");
    return visibleWidth(full) <= width
      ? full
      : `${selectedText(`[${current} ${names[current - 1]}]`)} ${c.faint(`· ${current}/${names.length} · ←→ or 1–${names.length}`)}`;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const inner = w - 2;
    const rows = Math.max(8, this.deps.rows());
    const events = this.events();
    const rule = c.faint("─".repeat(inner));
    const pad = (s: string) => ` ${truncateToWidth(s, inner, "…", true)} `;
    const fill = (body: string[], viewport: number) => {
      while (body.length < viewport) body.push(pad(""));
      return body;
    };
    const windowStart = (sel: number, total: number, viewport: number) =>
      Math.max(0, Math.min(sel - Math.floor(viewport / 2), total - viewport));
    const sessionLine = this.sessionLine();
    const focusLine = pad(c.jin("Inspector · Ctrl+R returns to draft"));
    const withSession = (head: string[]) => [
      head[0] as string,
      focusLine,
      ...(sessionLine ? [pad(sessionLine)] : []),
      ...head.slice(1),
    ];
    const cacheKey = (k: string) => `${this.sessionIndex}:${events.length}:${inner}:${k}`;
    const controls = (hint: string) => wrapTextWithAnsi(c.faint(hint), inner).map(pad);

    if (this.mode === "list") {
      const recs = this.records();
      const narrow = w < 90;
      const title = `${c.bold(c.ink("Requests"))}  ${c.soft(`${recs.length} requests`)}  ${c.faint(narrow ? "two lines per request" : "one line per API request · Tab: events · compactions · context")}`;
      const columns = c.faint(
        narrow
          ? "  #    time      model · sent / result · cache · stop"
          : "  #    time      model  sent (msgs · est. tok)  → measured (cache)  +out  latency  stop",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        ...controls(
          "Enter details · Esc close · ↑↓ select · PgUp/PgDn page · Tab views · ←/→ session",
        ),
      ];
      const viewport = rows - head.length - foot.length;
      const pageItems = narrow ? Math.max(1, Math.floor(viewport / 2)) : viewport;
      this.lastViewport = pageItems;
      let body: string[];
      if (recs.length === 0) body = [pad(c.faint("No requests yet. Send a message first."))];
      else {
        const start = windowStart(this.selected, recs.length, pageItems);
        body = recs
          .slice(start, start + pageItems)
          .flatMap((r, i) =>
            (narrow
              ? narrowListRows(r, start + i === this.selected)
              : [listRow(r, start + i === this.selected)]
            ).map(pad),
          );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "events") {
      const idx = filteredIndices(events, this.eventFilter);
      const title = `${c.bold(c.ink("Events"))}  ${c.soft(`${events.length} events · recorded session history`)}   ${this.tabs(EVENT_FILTERS, this.eventFilter)}`;
      const columns = c.faint(
        "   #     time      type             what                                                   ≈tok  model sees",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        ...controls(
          "Enter details · Esc close · ↑↓ move · PgUp/PgDn page · 1–5 filter · Ctrl+↑↓ request · Tab compactions · ←/→ session",
        ),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      // 请求前空一行:条目里 undefined 就是空行。
      const entries: (number | undefined)[] = [];
      for (const i of idx) {
        if (events[i]?.type === "request" && entries.length > 0) entries.push(undefined);
        entries.push(i);
      }
      let body: string[];
      if (entries.length === 0) body = [pad(c.faint("no events match this filter"))];
      else {
        const selPos = Math.max(0, entries.indexOf(this.eventSelected));
        const start = windowStart(selPos, entries.length, viewport);
        body = entries
          .slice(start, start + viewport)
          .map((i) =>
            i === undefined
              ? pad("")
              : pad(eventLine(events, i, { selected: i === this.eventSelected, width: inner })),
          );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "records") {
      const group = this.recordGroup();
      if (group?.kind !== "records") {
        this.mode = "composition";
        return this.render(width);
      }
      this.eventSelected = Math.max(group.from, Math.min(group.upTo - 1, this.eventSelected));
      const head = [
        pad(c.bold(c.ink(`Log records #${group.from}–#${group.upTo - 1}`))),
        pad(c.soft("Not extra model messages · Enter inspects one")),
        pad(rule),
      ];
      const foot = [
        pad(rule),
        ...controls("Enter details · Esc context · ↑↓ select · PgUp/PgDn page"),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      const offset = windowStart(
        this.eventSelected - group.from,
        group.upTo - group.from,
        viewport,
      );
      const body: string[] = [];
      for (
        let i = group.from + offset;
        i < Math.min(group.upTo, group.from + offset + viewport);
        i++
      ) {
        const e = events[i];
        if (!e) continue;
        const kind = e.type === "ext/event" ? e.kind : e.type;
        const summary = eventSummary(events, i).text;
        const duplicate = e.type === "ext/event" && summary === `${e.source} · ${e.kind}`;
        const text = `#${i}  ${kind}${duplicate ? "" : ` · ${summary}`}`;
        body.push(
          pad(i === this.eventSelected ? selectedText(`${G.cursor} ${text}`) : `  ${c.soft(text)}`),
        );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "event" || this.mode === "record") {
      const e = events[this.eventSelected];
      const idx = filteredIndices(events, this.eventFilter);
      const pos = idx.indexOf(this.eventSelected);
      const group = this.mode === "record" ? this.recordGroup() : undefined;
      if (this.mode === "record" && !group) {
        this.mode = "composition";
        return this.render(width);
      }
      const position =
        group?.kind === "records"
          ? `${this.eventSelected - group.from + 1}/${group.upTo - group.from}`
          : `${pos + 1}/${idx.length}`;
      const kind = e?.type === "ext/event" ? `${e.source}/${e.kind}` : (e?.type ?? "");
      const title = `${c.bold(c.ink(`Event #${this.eventSelected}`))}  ${c.ink(kind)}  ${group ? "" : c.faint(e ? clock(e.at) : "")}  ${c.faint(`(${position})`)}`;
      const head = [
        pad(title),
        pad(
          group
            ? c.soft("Log record · not in current input")
            : c.jin("Inspector · Ctrl+R returns to draft"),
        ),
        pad(this.tabs(EVENT_SECTIONS, this.eventSection, inner)),
        pad(rule),
      ];
      const content = this.cached(
        cacheKey(`event:${this.eventSelected}:${this.eventSection}`),
        () => {
          const lines =
            this.eventSection === 1
              ? eventViewLines(
                  events,
                  this.eventSelected,
                  this.sessions()[this.sessionIndex]?.recordingDirectory,
                )
              : this.eventSection === 2
                ? eventLines(events, this.eventSelected)
                : projectionLines(events, this.eventSelected, this.deps.currentProvider?.());
          return lines.flatMap((l) => wrapTextWithAnsi(l, inner));
        },
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · 1–3 section · [ ] prev/next event · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compactions") {
      const comps = this.compactions();
      const title = `${c.bold(c.ink("Compactions"))}  ${c.soft(`${comps.length} compactions`)}  ${c.faint("what became what; the original always stays in the array")}`;
      const columns = c.faint(
        "  #    time      strategy  original (events · tok) → summary tok · ratio  cleared",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        ...controls(
          "Enter details · Esc close · ↑↓ select · PgUp/PgDn page · Tab context · ←/→ session",
        ),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (comps.length === 0)
        body = [
          pad(
            c.faint(
              "No compactions yet. Come back after the context nears the threshold, or /compact.",
            ),
          ),
        ];
      else {
        const start = windowStart(this.compactionSelected, comps.length, viewport);
        body = comps
          .slice(start, start + viewport)
          .map((r, i) => pad(compactionRow(r, start + i === this.compactionSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "composition") {
      const wb = this.workbench();
      const hasImages = wb.rows.some(
        (r) =>
          r.kind === "message" && r.row.message.role === "user" && !!r.row.message.images?.length,
      );
      const main = events === this.deps.events();
      const window = main ? this.deps.contextWindow?.() : undefined;
      const size = `≈${fmtTok(wb.total)}${hasImages ? " text tok" : " tok"}${window ? ` of ${fmtTok(window)} · ${pctOf(wb.total, window)}${hasImages ? " text only" : ""}` : ""}`;
      const row = this.selectedRow();
      const reason = this.busyNote ?? this.contextReadOnlyReason();
      let action = "Enter actions";
      switch (row?.kind) {
        case "system":
          action = reason ? "Enter view" : "Enter sections";
          break;
        case "tools":
          action = reason ? "Read-only" : "Enter tools";
          break;
        case "covered":
          action = "Enter originals";
          break;
        case "dropped":
          action = "Original in Events";
          break;
        case "records":
          action = "Enter inspect log";
          break;
      }
      const hints = controls(
        inner < 48
          ? `${action} · Esc close`
          : `${action} · Esc close · ↑↓ select · PgUp/PgDn page · Tab requests${this.sessions().length > 1 ? " · ←/→ session" : ""}`,
      );
      // 至少保留一个列表行、一个预览行和分隔线;短窗口先省略可在请求详情阅读的统计。
      const headLimit = Math.max(1, rows - hints.length - 3);
      const head = [
        pad(c.bold(c.ink(main ? "Context · Next request" : "Context · Sub-session"))),
        ...(reason
          ? [
              pad(
                c.jin(
                  this.busy() && !this.busyNote
                    ? "Context is read-only while running · Esc returns to transcript"
                    : reason,
                ),
              ),
            ]
          : []),
        ...(hasImages ? [pad(c.jin("Image tokens unknown before next request · text only"))] : []),
        pad(c.soft(`Next input estimate: ${size}`)),
        pad(c.faint("⋯ Log rows explain event gaps; not extra input")),
        ...(sessionLine ? [pad(sessionLine)] : []),
      ].slice(0, headLimit);
      const last = this.records().at(-1);
      const measured = last?.response?.usage ?? last?.compaction?.usage;
      const stats = last
        ? [
            measured
              ? `Last API #${last.n}: ${fmtTok(measured.inputTokens)} input tok measured by provider`
              : `Last API #${last.n}: input usage not reported`,
            ...cacheUsageLines(measured, inner),
          ]
            .flatMap((line) => wrapTextWithAnsi(c.soft(line), inner))
            .map(pad)
        : [pad(c.faint("No API request yet"))];
      if (rows >= 24 && head.length + stats.length + 2 <= headLimit) head.push(...stats);
      else if (last && head.length + 3 <= headLimit)
        head.push(pad(c.faint(`Last API #${last.n} · Tab requests for measured usage`)));
      if (head.length < headLimit) head.push(pad(c.faint(workbenchHeader(inner))));
      if (head.length < headLimit) head.push(pad(rule));
      const maxTok = wb.rows.reduce(
        (m, r) =>
          r.kind === "message" || r.kind === "system" || r.kind === "tools"
            ? Math.max(m, r.tok)
            : m,
        1,
      );
      const previewHeight = Math.min(
        PREVIEW_LINES,
        Math.max(1, rows - head.length - hints.length - 1 - Math.min(3, wb.rows.length)),
      );
      const preview = row
        ? previewLines(events, wb, row, {
            width: inner,
            lines: previewHeight - 1,
          })
        : [];
      const foot = [
        pad(rule),
        ...fill(preview.slice(0, previewHeight).map(pad), previewHeight),
        ...hints,
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (wb.rows.length === 0) body = [pad(c.faint("no messages yet"))];
      else {
        const start = windowStart(this.messageSelected, wb.rows.length, viewport);
        body = wb.rows.slice(start, start + viewport).map((r, i) =>
          pad(
            workbenchLine(events, r, {
              selected: start + i === this.messageSelected,
              width: inner,
              maxTok,
            }),
          ),
        );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "actions") {
      const row = this.selectedRow();
      const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const crows = this.composition().rows;
      const items = this.contextActions(r, crows.length);
      const sel = Math.max(
        0,
        items.findIndex((item) => item.action === this.actionSelected),
      );
      this.actionSelected = items[sel]?.action ?? "view";
      const m = r.message;
      const edited = editState(events).edits.has(r.event);
      const title = `${c.bold(c.ink(`#${r.event} ${roleLabel(m)}`))}  ${c.soft(`≈${messageTokens(m)} tok${edited ? ` · ${c.jin("edited")}` : ""}${r.stages.includes("unknown-result") ? " · result unknown" : ""}`)}`;
      const head = rows < 12 ? [pad(title), pad(rule)] : [pad(title), focusLine, pad(rule)];
      const chosen = items[sel] as ActionItem;
      const foot = [
        pad(rule),
        ...wrapTextWithAnsi(
          c.faint(
            rows < 12
              ? "↑↓ choose · Enter · Esc"
              : "↑↓ or 1–9 choose · Enter do it · PgUp/PgDn details · Esc back",
          ),
          inner,
        ).map(pad),
      ];
      const available = Math.max(3, rows - head.length - foot.length);
      const listHeight = Math.min(items.length, Math.max(1, Math.floor(available / 2)));
      const start = windowStart(sel, items.length, listHeight);
      const list = items.slice(start, start + listHeight).map((item, i) => {
        const index = start + i;
        return pad(
          index === sel
            ? selectedText(`${G.cursor} ${index + 1}  ${item.label}`)
            : `  ${c.soft(`${index + 1}  ${item.label}`)}`,
        );
      });
      const reason = this.contextReadOnlyReason();
      const details = [
        ...(reason ? [c.jin(reason)] : []),
        ...consequenceOf(chosen.action, r, crows, events, this.deps.currentProvider?.())
          .split("\n")
          .map((line, i) => (i === 0 ? c.ink(line) : c.soft(line))),
        c.faint(chosen.hint),
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      const viewport = Math.max(1, available - listHeight - 1);
      this.lastViewport = viewport;
      this.scroll = Math.min(this.scroll, Math.max(0, details.length - viewport));
      return [
        ...head,
        ...list,
        pad(
          c.soft(
            `Details ${this.scroll + 1}-${Math.min(details.length, this.scroll + viewport)}/${details.length}`,
          ),
        ),
        ...fill(details.slice(this.scroll, this.scroll + viewport).map(pad), viewport),
        ...foot,
      ];
    }

    if (this.mode === "message") {
      const row = this.selectedRow();
      const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const crows = this.composition().rows;
      const title = `${c.bold(c.ink(`#${r.event} ${roleLabel(r.message)}`))}  ${c.faint(`message ${r.i} of ${crows.length}`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const content = this.cached(cacheKey(`message:${r.event}:${r.i}`), () =>
        compositionLines(events, r).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · [ ] prev/next message · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "sections") {
      const { states, names } = this.sections();
      const start = events.find((e) => e.type === "session/start");
      const metas = start?.type === "session/start" ? (start.sections ?? []) : [];
      const total = metas.reduce((n, s) => n + Math.ceil(s.chars / 4), 0);
      const title = `${c.bold(c.ink("System prompt"))}  ${c.soft(`${metas.length} sections · ≈${total} tok`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const list =
        states ?? names.map((name) => ({ name, on: true, text: "", chars: 0, source: undefined }));
      const foot = [
        pad(rule),
        ...controls(
          states
            ? "Enter toggle · Esc back · ↑↓ or 1–9 choose · PgUp/PgDn page"
            : "Esc back · ↑↓ choose · PgUp/PgDn page",
        ),
      ];
      const reason = this.busyNote ?? this.contextReadOnlyReason();
      const details = (
        reason
          ? wrapTextWithAnsi(c.jin(reason), inner)
          : states
            ? wrapTextWithAnsi(
                c.faint(
                  "Changes this session's next input · /settings prompt.sections saves defaults",
                ),
                inner,
              )
            : wrapTextWithAnsi(
                c.faint("Read-only · Section text not recorded in this session"),
                inner,
              )
      ).map(pad);
      const available = Math.max(1, rows - head.length - foot.length);
      const detailHeight = Math.min(details.length, Math.max(0, available - 1));
      const viewport = available - detailHeight;
      this.lastViewport = viewport;
      const offset = windowStart(this.sectionSelected, list.length, viewport);
      const body: string[] = [];
      list.slice(offset, offset + viewport).forEach((s, k) => {
        const i = offset + k;
        const meta = metas[i];
        const tok = Math.ceil((meta?.chars ?? s.chars) / 4);
        const first =
          s.text
            .split("\n")
            .find((l) => l.trim())
            ?.trim() ??
          meta?.source ??
          "";
        const state = states ? (s.on ? "on " : "off") : "   ";
        const line = `${i + 1}  ${s.name.padEnd(22)} ${state}  ${`≈${tok}`.padStart(6)}   ${truncateToWidth(first, Math.max(10, inner - 44), "…")}`;
        body.push(
          pad(
            i === this.sectionSelected
              ? `  ${selectedText(`${G.cursor} ${line}`)}`
              : `    ${s.on ? c.soft(line) : c.faint(line)}`,
          ),
        );
      });
      if (list.length === 0) body.push(pad(c.faint("no section metadata in this session")));
      return [...head, ...fill(body, viewport), ...details.slice(0, detailHeight), ...foot];
    }

    if (this.mode === "covered") {
      const row = this.selectedRow();
      if (row?.kind !== "covered") {
        this.mode = "composition";
        return this.render(width);
      }
      const title = `${c.bold(c.ink(`Covered #${row.from}–#${row.upTo - 1}`))}  ${c.soft(`${row.count} messages · ≈${fmtTok(row.tok)} tok`)}  ${c.faint(`replaced by the summary #${row.summary}`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const content = this.cached(cacheKey(`covered:${row.from}:${row.upTo}`), () =>
        coveredLines(events, row).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compaction") {
      const comps = this.compactions();
      const rec = comps[this.compactionSelected];
      if (!rec) {
        this.mode = "compactions";
        return this.render(width);
      }
      const tabs = this.tabs(COMPACTION_SECTIONS, this.compactionSection);
      const title = `${c.bold(c.ink(`Compaction #${rec.n}`))}  ${c.ink(rec.event.strategy ?? "")}  ${c.faint(clock(rec.event.at))}  ${c.faint(`(${this.compactionSelected + 1}/${comps.length})`)}`;
      const head = [pad(title), focusLine, pad(tabs), pad(rule)];
      const content = this.cached(
        cacheKey(`compaction:${rec.index}:${this.compactionSection}`),
        () =>
          compactionLines(events, rec, this.compactionSection).flatMap((l) =>
            wrapTextWithAnsi(l, inner),
          ),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn · ←→ 1-4 section · [ ] compaction · Esc back",
        rows,
        pad,
        rule,
      );
    }

    const recs = this.records();
    const rec = recs[this.selected];
    if (!rec) {
      this.mode = "list";
      return this.render(width);
    }
    const tabs = this.tabs(SECTIONS, this.section, inner);
    const title = `${c.bold(c.ink(`Request #${rec.n}`))}  ${c.ink(rec.request.model)}  ${c.faint(clock(rec.request.at))}  ${c.faint(`(${this.selected + 1}/${recs.length})`)}`;
    const head = [pad(title), focusLine, pad(tabs), pad(rule)];
    if ((this.section === 3 || this.section === 6) && this.prepareBodies(rec)) {
      const body = this.bodies.render(inner);
      const action = `↑↓ block · Enter ${body.action} · PgUp/Dn read`;
      const context = body.context
        ? truncateToWidth(
            visibleWidth(`${body.position} · ${body.context}`) <= inner
              ? `${body.position} · ${body.context}`
              : body.context,
            inner,
            "…",
          )
        : `${body.position} · ${this.bodyEvidence}`;
      const evidence = wrapTextWithAnsi(c.soft(context), inner).map(pad);
      const cache =
        this.section === 3
          ? cacheUsageLines(rec.response?.usage ?? rec.compaction?.usage, inner)
              .flatMap((line) => wrapTextWithAnsi(c.soft(line), inner))
              .map(pad)
          : [];
      // 先给身份、选中目标、两行正文及真实换行后的操作提示留位置。
      // 次要信息按优先级整组加入,渲染时仍保持原来的阅读顺序。
      const footerHeight = wrapTextWithAnsi(c.soft(action), inner).length + 1;
      let room = Math.max(0, rows - footerHeight - 4);
      const takeRows = (lines: string[]): string[] => {
        if (lines.length > room) return [];
        room -= lines.length;
        return lines;
      };
      const sectionHead = takeRows([pad(tabs)]);
      const origin = takeRows(evidence.slice(0, 1));
      const definitions = takeRows(evidence.slice(1));
      const measured = takeRows(cache.slice(0, 1));
      const scale = takeRows(cache.slice(1));
      const separator = takeRows([pad(rule)]);
      const focus = takeRows([focusLine]);
      const bodyHead = [
        pad(title),
        ...focus,
        ...sectionHead,
        ...origin,
        ...definitions,
        ...measured,
        ...scale,
        pad(
          c.ink(
            `Selected · ${body.selected} · ${body.action === "collapse" ? "expanded" : "collapsed"}`,
          ),
        ),
        ...separator,
      ];
      const viewport = Math.max(1, rows - bodyHead.length - 2);
      if (
        body.focus !== undefined &&
        (body.focus < this.scroll || body.focus >= this.scroll + viewport - 2)
      )
        this.scroll = body.focus;
      return this.scrollable(bodyHead, body.lines, action, rows, pad, rule, true);
    }
    const build = () =>
      this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner));
    // 旁路流在请求完成前持续变化,不一定追加内核事件。仅正在查看的实录分区跳过缓存。
    const streaming =
      !rec.response && !rec.error && !rec.compaction && [1, 4, 5, 6].includes(this.section);
    const content = streaming
      ? build()
      : this.cached(cacheKey(`detail:${rec.index}:${this.section}`), build);
    return this.scrollable(
      head,
      content,
      width < 90
        ? "↑↓ read · [ ] request · Esc back"
        : "↑↓ scroll · PgUp/PgDn · ←→ 1-7 section · [ ] request · Esc back",
      rows,
      pad,
      rule,
    );
  }

  /** 带位置提示的视口:头部固定,内容按 scroll 裁切,尾部显示第几行到第几行。 */
  private scrollable(
    head: string[],
    content: string[],
    hint: string,
    rows: number,
    pad: (s: string) => string,
    rule: string,
    controlsFirst = false,
  ): string[] {
    const hints = hint.split(" · ");
    const back = hints.find((part) => part.startsWith("Esc")) ?? "Esc back";
    const keys = wrapTextWithAnsi(
      c.soft(hints.filter((part) => part !== back).join(" · ")),
      visibleWidth(rule),
    ).map(pad);
    const viewport = Math.max(1, rows - head.length - keys.length - 1);
    this.lastViewport = viewport;
    const maxScroll = Math.max(0, content.length - viewport);
    this.scroll = Math.min(this.scroll, maxScroll);
    const slice = content.slice(this.scroll, this.scroll + viewport);
    while (slice.length < viewport) slice.push("");
    const pos =
      content.length <= viewport
        ? `${content.length} lines`
        : `lines ${this.scroll + 1}-${Math.min(content.length, this.scroll + viewport)} of ${content.length}`;
    // 返回入口常驻,其余按键换行,不让位置计数截掉操作说明。
    const foot = [
      pad(c.faint(`${back}${controlsFirst ? " · [ ] request" : ""} · ${pos}`)),
      ...keys,
    ];
    return [...head, ...slice.map(pad), ...foot];
  }
}
