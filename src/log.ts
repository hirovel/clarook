import type { AgentEvent } from "./events.js";
import { Recording } from "./recording.js";

// JSON 快照已与调用方解耦;冻结其对象和数组,读者不能悄悄修改历史。
function seal<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) seal(child);
    Object.freeze(value);
  }
  return value;
}

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
    const json = JSON.stringify(e);
    const snapshot = seal(JSON.parse(json) as AgentEvent);
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

  static load(filePath: string, opts: { attach?: boolean } = {}): EventLog {
    const log = new EventLog(opts.attach ? filePath : undefined);
    try {
      const events = (log.recording ?? new Recording(filePath)).loadEvents(opts.attach);
      log.entries = Object.freeze(events.map((event) => seal(event)));
      return log;
    } catch (error) {
      log.recording?.dispose();
      throw error;
    }
  }
}
