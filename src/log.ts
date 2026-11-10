import type { AgentEvent } from "./events.js";
import { freezeJson, jsonSnapshot } from "./json-snapshot.js";
import { errorMessage } from "./providers/errors.js";
import { Recording } from "./recording.js";

/** 一份追加式事实数组。编辑通过事件改变投影;文件格式与恢复完全归 Recording。 */
export class EventLog {
  private entries: readonly AgentEvent[] = Object.freeze([]);
  private listeners = new Set<(e: AgentEvent, index: number) => void>();
  readonly recording?: Recording;

  constructor(filePath?: string, recordingBufferBytes?: number) {
    if (filePath) {
      this.recording = new Recording(filePath, recordingBufferBytes);
      this.recording.claim();
      this.recording.onGap = (ref) =>
        this.append({
          type: "ext/event",
          at: new Date().toISOString(),
          source: "recording",
          kind: "body/gap",
          payload: { ref },
        });
    }
  }

  /** 借出的数组固定在读取时的版本;后续事实通过重新读取获得。 */
  get events(): readonly AgentEvent[] {
    return this.entries;
  }

  get path(): string | undefined {
    return this.recording?.journal;
  }

  append(e: AgentEvent): number {
    // 内存与磁盘使用同一份 JSON 内容,原始对象的后续变化不会改写已捕获事实。
    const { json, value: snapshot } = jsonSnapshot(e);
    const previous = this.entries;
    const index = previous.length;
    // 保存状态观察者也能追加事实,观察前必须已提交当前事件及其固定身份。
    this.entries = Object.freeze([...previous, snapshot]);
    try {
      this.recording?.appendEvent(json);
    } catch (error) {
      // Recording 仅在入队前同步拒收;I/O 失败保持为积压状态,不走回退。
      this.entries = previous;
      throw error;
    }
    for (const fn of this.listeners) {
      try {
        fn(snapshot, index);
      } catch (err) {
        // 观察者错误交给宿主,不能打断写入队列或其余观察者。
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return index;
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    await this.recording?.checkpoint(signal);
  }

  subscribe(fn: (e: AgentEvent, index: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 新实例在返回前一次安装既有历史;逐事件捕获JSON,不广播初始化的中间版本。 */
  static create(
    initialEvents: readonly AgentEvent[],
    opts: { filePath?: string; sourceRecording?: Recording } = {},
  ): EventLog {
    const captured = Array.from(initialEvents, (event) => jsonSnapshot(event));
    const events = captured.map((snapshot) => snapshot.value);
    const log = new EventLog(opts.filePath);
    // 取锁或拒绝旧资源失败时不能进入discard,这些路径不属于新候选。
    log.recording?.claimNew();
    try {
      log.recording?.copyAttachments(events, opts.sourceRecording);
      log.entries = Object.freeze(events);
      for (const snapshot of captured) log.recording?.appendEvent(snapshot.json);
      return log;
    } catch (error) {
      try {
        log.recording?.discard();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Session creation and cleanup failed: ${errorMessage(error)}; ${errorMessage(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  static load(filePath: string, opts: { attach?: boolean } = {}): EventLog {
    const log = new EventLog(opts.attach ? filePath : undefined);
    try {
      const events = (log.recording ?? new Recording(filePath)).loadEvents(opts.attach);
      log.entries = Object.freeze(events.map((event) => freezeJson(event)));
      return log;
    } catch (error) {
      log.recording?.dispose();
      throw error;
    }
  }
}
