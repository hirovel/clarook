// SSE 读流:按空行分帧、逐行旁路(trace)、停滞超时;供应商适配器再解释 data 中的 JSON。
// 网络层的三种失败在这里归一成 ProviderError:停滞(可重试)、烂 JSON(不可重试)、打断(交给调用方判定)。
import { errorMessage, isRetryable, ProviderError } from "./errors.js";

export const DEFAULT_STALL_MS = 90_000;

export class StreamStall extends ProviderError {
  constructor(ms: number) {
    super(`stream stalled: no bytes received for ${ms}ms`, { retryable: true });
    this.name = "StreamStall";
  }
}

export type SseOptions = {
  /** 每收到一行(含空行之外的所有行)回调一次,未解析。 */
  onRaw?: (line: string) => void;
  /** 连续这么久没有字节就判停滞;0 = 不限。 */
  stallTimeoutMs?: number;
  /** 停滞时调用,用来撤销底层请求。 */
  onStall?: () => void;
};

/** 只解释 SSE 分帧;同一事件的 data 行以换行拼接,未收到空行的尾部不派发。 */
export async function* sseData(
  body: AsyncIterable<Uint8Array>,
  opts: SseOptions = {},
): AsyncGenerator<string> {
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const decoder = new TextDecoder();
  const it = body[Symbol.asyncIterator]();
  try {
    let line = "";
    let skipLf = false;
    let data: string[] = [];
    while (true) {
      const step = await nextChunk(it, stallMs, opts.onStall);
      if (step.done) break;
      const text = decoder.decode(step.value, { stream: true });
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (skipLf) {
          skipLf = false;
          if (char === "\n") {
            start = i + 1;
            continue;
          }
        }
        if (char !== "\r" && char !== "\n") continue;
        line += text.slice(start, i);
        start = i + 1;
        skipLf = char === "\r";
        if (opts.onRaw && line.trim()) opts.onRaw(line);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line === "data") {
          data.push("");
        } else if (line.startsWith("data:")) {
          // SSE 字段只去掉冒号后的一个空格,其余空白属于载荷。
          data.push(line.slice(line[5] === " " ? 6 : 5));
        }
        line = "";
      }
      line += text.slice(start);
    }
    line += decoder.decode();
    if (opts.onRaw && line.trim()) opts.onRaw(line);
  } finally {
    await it.return?.();
  }
}

/** 逐个产出完整事件的 JSON 载荷;空 data 与 [DONE] 跳过。 */
export async function* sseEvents(
  body: AsyncIterable<Uint8Array>,
  opts: SseOptions = {},
): AsyncGenerator<unknown> {
  for await (const data of sseData(body, opts)) {
    if (!data.trim() || data.trim() === "[DONE]") continue;
    yield parseData(data);
  }
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    // 完整事件仍解析不了:不猜、不跳过。原文随错误一起进日志。
    throw new ProviderError(`provider stream: invalid JSON data event ${data.slice(0, 200)}`, {
      retryable: false,
      body: data,
    });
  }
}

async function nextChunk(
  it: AsyncIterator<Uint8Array>,
  stallMs: number,
  onStall: (() => void) | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (stallMs <= 0) return it.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onStall?.();
      reject(new StreamStall(stallMs));
    }, stallMs);
  });
  try {
    return await Promise.race([it.next(), stall]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 已向界面输出内容后,停滞、断连或流内错误都不能自动重试(会重复输出)。 */
export function streamError(err: unknown, streamed: boolean): unknown {
  if (streamed && isRetryable(err)) {
    const error = new ProviderError(
      err instanceof StreamStall
        ? err.message
        : `provider stream interrupted: ${errorMessage(err)}`,
      { retryable: false, ...(err instanceof ProviderError && err.body && { body: err.body }) },
    );
    error.cause = err;
    return error;
  }
  return err;
}
