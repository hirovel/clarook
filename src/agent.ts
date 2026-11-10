import { randomUUID } from "node:crypto";
import { type ContextAccess, changeContext } from "./context-edit.js";
import { now } from "./events.js";
import type { ImageInput } from "./images.js";
import type { EventLog } from "./log.js";
import { runTurn, type TurnDeps, type TurnOutcome } from "./loop.js";
import type { CompleteOptions, EffortLevel, Provider } from "./provider.js";
import { RECORDING_FULL } from "./recording.js";
import type { Tool } from "./tools.js";

export type AgentOptions = {
  log: EventLog;
  provider: Provider;
  tools: Tool[] | (() => readonly Tool[]);
  slots?: TurnDeps["slots"];
  compaction?: TurnDeps["compaction"];
  onStream?: CompleteOptions["onStream"];
  onRaw?: (line: string) => void;
  onRequest?: (body: string) => void;
  /** 强度级别,缺省不传;setEffort 会话中切换,下一请求生效。 */
  effort?: EffortLevel;
  /** 这个 agent 的名字(子 agent 用);审批提示据此标明是谁在问。 */
  agent?: string;
  facts?: TurnDeps["facts"];
  planReminder?: number;
  pending?: readonly PendingInput[];
  onPendingChange?: (pending: readonly PendingInput[]) => void;
};

/** 留言的投递方式:steer = 下一个步边界就注入(缺省);followUp = 等模型把手头的事做完再给。 */
export type DeliverAs = "steer" | "followUp";

export type PendingInput = {
  id: string;
  text: string;
  deliverAs: DeliverAs;
  paused: boolean;
  images?: ImageInput[];
};

/**
 * 薄类层:持有留言队列与 AbortController,把 runTurn 串成会话。
 * 已投递内容在事件日志里;尚未投递的输入由宿主选择是否持久化。
 */
export class Agent {
  private queue: PendingInput[] = [];
  private ac: AbortController | undefined;
  private active: Promise<TurnOutcome> | undefined;
  private activity: "model" | "local" | undefined;

  constructor(private opts: AgentOptions) {
    this.queue = (opts.pending ?? []).map((item) => ({
      ...item,
      ...(item.images && { images: item.images.map((image) => ({ ...image })) }),
      paused: true,
    }));
  }

  get pending(): readonly PendingInput[] {
    return this.queue.map((item) => ({
      ...item,
      ...(item.images && { images: item.images.map((image) => ({ ...image })) }),
    }));
  }

  private changed(): void {
    this.opts.onPendingChange?.(this.pending);
  }

  removePending(id: string): void {
    this.queue = this.queue.filter((item) => item.id !== id);
    this.changed();
  }

  editPending(id: string, text: string): void {
    const item = this.queue.find((item) => item.id === id);
    if (!item) throw new Error("This input has already been delivered");
    if (!text.trim() && !item.images?.length) throw new Error("Input cannot be empty");
    item.text = text;
    this.changed();
  }

  async continuePending(): Promise<TurnOutcome | undefined> {
    if (this.localRunning) throw new Error("User shell is running; wait or press Esc first");
    if (!this.queue.length) return;
    if (this.stopping) throw new Error("cannot continue pending while stopping; wait for idle");
    this.ensureStorage();
    if (this.active) {
      for (const item of this.queue) item.paused = false;
      this.changed();
      return this.active;
    }
    const first = this.queue[0];
    if (!first) return;
    return this.run(() => {
      // 先解除已有留言的暂停;投递回调中的取消或新输入不能被后续批量改写。
      for (const item of this.queue) item.paused = false;
      this.opts.log.append({
        type: "user/message",
        at: now(),
        text: first.text,
        inputId: first.id,
        ...(first.images?.length && { images: first.images }),
      });
    });
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  get localRunning(): boolean {
    return this.activity === "local";
  }

  get stopping(): boolean {
    return this.running && (this.ac?.signal.aborted ?? false);
  }

  get storagePaused(): boolean {
    return this.opts.log.recording?.full ?? false;
  }

  private ensureStorage(): void {
    if (!this.storagePaused) return;
    this.opts.log.recording?.flush();
    if (this.storagePaused)
      throw new Error("Recording buffer full; saving must recover before new work can start");
  }

  async waitForIdle(): Promise<void> {
    await this.active;
  }

  /** 等待注入的留言条数(UI 状态栏用)。 */
  get queued(): number {
    return this.queue.length;
  }

  get provider(): Provider {
    return this.opts.provider;
  }

  get tools(): readonly Tool[] {
    return typeof this.opts.tools === "function" ? this.opts.tools() : this.opts.tools;
  }

  get effort(): EffortLevel | undefined {
    return this.opts.effort;
  }

  /** 切换强度级别;undefined = 恢复不传。每条 request 事件都记着当时的级别,不另记事件。 */
  setEffort(level: EffortLevel | undefined): void {
    if (level === undefined) delete this.opts.effort;
    else this.opts.effort = level;
  }

  /** 当前策略槽实现(界面显示用)。 */
  get slots(): NonNullable<TurnDeps["slots"]> {
    return this.opts.slots ?? {};
  }

  /**
   * 会话中切换一个策略槽:runTurn 开跑时取槽实现,所以下一次 turn 起生效。
   * undefined = 恢复内置缺省。事件(session/slot)由调用方记,因为只有调用方知道实现的名字。
   */
  setSlot<K extends keyof NonNullable<TurnDeps["slots"]>>(
    name: K,
    impl: NonNullable<TurnDeps["slots"]>[K] | undefined,
  ): void {
    const slots = { ...this.opts.slots };
    if (impl === undefined) delete slots[name];
    else slots[name] = impl;
    this.opts.slots = slots;
  }

  /** 下一请求读取工具集;进行中的请求保留它发出时的工具版本。 */
  setTools(tools: AgentOptions["tools"]): void {
    this.opts.tools = tools;
  }

  /** 会话中改事实附注与计划复述的设置(/settings);下一次 turn 起生效。 */
  configure(next: { facts?: TurnDeps["facts"]; planReminder?: number }): void {
    if (next.facts !== undefined) this.opts.facts = next.facts;
    if (next.planReminder !== undefined) this.opts.planReminder = next.planReminder;
  }

  get facts(): TurnDeps["facts"] | undefined {
    return this.opts.facts;
  }

  get planReminder(): number | undefined {
    return this.opts.planReminder;
  }

  /** 空闲时切换模型并记录事实;运行中的 turn 保留其启动时捕获的模型。 */
  setProvider(provider: Provider): void {
    if (this.running) throw new Error("cannot switch models while running; press Esc first");
    this.opts.provider = provider;
    this.opts.log.append({ type: "session/model", at: now(), model: provider.model });
  }

  /**
   * 空闲时:入日志并开跑。运行中:进留言队列,注入时点由 steering 槽与投递方式共同决定:
   * steer 在步边界排空,followUp 只在 turn 边界(模型不再调工具时)排空。
   */
  async prompt(
    text: string,
    opts: { deliverAs?: DeliverAs; inputId?: string; images?: ImageInput[] } = {},
  ): Promise<TurnOutcome> {
    if (this.localRunning) throw new Error("User shell is running; wait or press Esc first");
    this.ensureStorage();
    const log = this.opts.log;
    const inputId = opts.inputId;
    const images = opts.images?.length ? structuredClone(opts.images) : undefined;
    if (this.active) {
      this.queue.push({
        id: inputId ?? randomUUID(),
        text,
        deliverAs: opts.deliverAs ?? "steer",
        paused: this.stopping,
        ...(images && { images }),
      });
      this.changed();
      return this.active;
    }
    return this.run(() => {
      // 空闲队列只含恢复或上一轮收尾暂停的留言,必须显式继续。
      this.changed();
      log.append({
        type: "user/message",
        at: now(),
        text,
        ...(inputId && { inputId }),
        ...(images && { images }),
      });
    });
  }

  /**
   * 重跑一步:丢掉最后一条(仍在投影里的)助手消息及其工具结果,不加新用户消息,
   * 从当前投影再发一次请求。编辑上下文之后立刻看效果的入口。丢弃以 context/drop 事件落盘,原文不动。
   */
  async retry(access: ContextAccess = {}): Promise<TurnOutcome> {
    this.ensureStorage();
    const contextAccess = { ...access, running: this.running || access.running === true };
    return this.run(() => changeContext(this.opts.log, { type: "retry" }, contextAccess));
  }

  /** 手动压缩也占用同一个运行周期:Esc、退出等待和排队输入与普通 turn 一致。 */
  async compact(instructions = ""): Promise<TurnOutcome> {
    if (this.active) throw new Error("cannot compact while running; interrupt first");
    if (!this.opts.compaction) throw new Error("Compaction is not configured");
    this.ensureStorage();
    return this.run(undefined, instructions);
  }

  private async run(initialize?: () => void, manualCompaction?: string): Promise<TurnOutcome> {
    const log = this.opts.log;
    return this.runActivity(
      "model",
      (signal) =>
        runTurn({
          log,
          provider: this.opts.provider,
          tools: () => this.tools,
          signal,
          drainQueue: (boundary) => {
            const take = (q: PendingInput) =>
              !q.paused && (boundary === "turn" || q.deliverAs === "steer");
            return this.queue.filter(take).map((q) => ({
              text: q.text,
              inputId: q.id,
              ...(q.images?.length && { images: q.images }),
            }));
          },
          ...(this.opts.slots && { slots: this.opts.slots }),
          ...(this.opts.compaction && { compaction: this.opts.compaction }),
          ...(manualCompaction !== undefined && { manualCompaction }),
          ...(this.opts.onStream && { onStream: this.opts.onStream }),
          ...(this.opts.onRaw && { onRaw: this.opts.onRaw }),
          ...(this.opts.onRequest && { onRequest: this.opts.onRequest }),
          effort: () => this.opts.effort,
          ...(this.opts.agent && { agent: this.opts.agent }),
          ...(this.opts.facts && { facts: this.opts.facts }),
          ...(this.opts.planReminder !== undefined && { planReminder: this.opts.planReminder }),
        }),
      initialize,
    );
  }

  /** 用户本地操作不请求模型、不消费留言;取消、保存与退出等待复用普通运行周期。 */
  async runLocal(operation: (signal: AbortSignal) => Promise<void>): Promise<TurnOutcome> {
    this.ensureStorage();
    return this.runActivity("local", async (signal) => {
      await operation(signal);
      return signal.aborted ? "aborted" : "idle";
    });
  }

  private runActivity(
    kind: "model" | "local",
    operation: (signal: AbortSignal) => Promise<TurnOutcome>,
    initialize?: () => void,
  ): Promise<TurnOutcome> {
    if (this.active) throw new Error("Work is running; wait or press Esc first");
    const log = this.opts.log;
    const controller = new AbortController();
    this.ac = controller;
    this.activity = kind;
    const stopIfFull = () => {
      if (!log.recording?.full || controller.signal.aborted) return;
      for (const item of this.queue) item.paused = true;
      controller.abort(RECORDING_FULL);
      this.changed();
    };
    let stopWatching: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 同步接纳输入供宿主确认;观察回调前已有活动周期,模型请求仍异步启动。
    this.active = ready
      .then(() => operation(controller.signal))
      .finally(async () => {
        try {
          if (controller.signal.reason === RECORDING_FULL)
            log.append({
              type: "ext/event",
              at: now(),
              source: "recording",
              kind: "buffer/full",
              payload: { pendingBytes: log.recording?.pendingBytes },
            });
          await log.checkpoint();
        } finally {
          stopWatching?.();
          unsubscribe?.();
          // 终结时尚未投递的留言一律等待明确继续,不夹带进下一条新问题。
          for (const item of this.queue) item.paused = true;
          this.active = undefined;
          this.ac = undefined;
          this.activity = undefined;
          this.changed();
        }
      });
    try {
      stopWatching = log.recording?.subscribe(stopIfFull);
      stopIfFull();
      unsubscribe = log.subscribe((event) => {
        if (event.type !== "user/message" || !event.inputId) return;
        this.queue = this.queue.filter((item) => item.id !== event.inputId);
        this.changed();
      });
      initialize?.();
      resolveReady();
    } catch (error) {
      rejectReady(error);
    }
    return this.active;
  }

  /** 即时打断:interrupt 事件只给人看,模型看到的是打断的后果。 */
  interrupt(): void {
    if (!this.running || this.ac?.signal.aborted) return;
    for (const item of this.queue) item.paused = true;
    // 先提交取消状态,回调重入直接返回;通知或记录失败也不能撤销取消。
    this.ac?.abort();
    this.changed();
    this.opts.log.append({ type: "session/interrupt", at: now() });
  }
}
