import { join } from "node:path";
import { now } from "./events.js";
import type { EventLog } from "./log.js";
import type { Message } from "./messages.js";
import type { AssistantTurn, CompleteOptions, Provider, ToolDef } from "./provider.js";
import { classifyError, errorMessage, ProviderError, providerMessage } from "./providers/errors.js";
import type { HttpRecorder } from "./providers/http.js";
import type { ContentRef } from "./recording.js";

/** 调用者交付已追加请求的固定下标;这里负责请求与记录,不从后续可变尾部推断身份。 */
export async function completeRecorded(
  log: EventLog,
  request: number,
  provider: Provider,
  messages: Message[],
  tools: ToolDef[],
  opts: CompleteOptions = {},
): Promise<AssistantTurn> {
  try {
    if (log.recording) {
      const input = log.recording.open("Adapter input: messages and tools");
      input.write(JSON.stringify({ messages, tools }));
      await log.checkpoint(opts.signal);
      recordEvent(log, "request/input", { request, input: { ...input.ref, bytes: input.bytes } });
    }
    await log.checkpoint(opts.signal);
    opts.signal?.throwIfAborted();
    const record = exchangeRecorder(log, request, opts.signal);
    return await provider.complete(messages, tools, {
      ...opts,
      ...(record && { record }),
      onRetry: (info) => {
        opts.onRetry?.(info);
        const status = info.error instanceof ProviderError ? info.error.status : undefined;
        log.append({
          type: "retry",
          at: now(),
          attempt: info.attempt,
          delayMs: info.delayMs,
          error: errorMessage(info.error),
          ...(status !== undefined && { status }),
        });
      },
    });
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const provider = providerMessage(err);
    const body = err instanceof ProviderError ? err.body?.slice(0, 4096) : undefined;
    log.append({
      type: "request/error",
      at: now(),
      error: errorMessage(err),
      ...(status !== undefined && { status }),
      kind: classifyError(err),
      ...(provider && { provider }),
      ...(body && { body }),
    });
    throw err;
  }
}

export function recordEvent(log: EventLog, kind: string, payload: Record<string, unknown>): void {
  log.append({ type: "ext/event", at: now(), source: "recording", kind, payload });
}

export function exchangeRecorder(
  log: EventLog,
  request: number,
  signal?: AbortSignal,
): HttpRecorder | undefined {
  const store = log.recording;
  if (!store) return undefined;
  let attempt = 0;
  return async (body) => {
    const n = ++attempt;
    const sent = store.open("HTTP request JSON");
    sent.write(body);
    const received = store.open("HTTP response body");
    await store.checkpoint(signal);
    recordEvent(log, "http/start", {
      request,
      attempt: n,
      sent: { ...sent.ref, bytes: sent.bytes },
      received: received.ref,
    });
    await log.checkpoint(signal);
    return {
      response(status, contentType) {
        recordEvent(log, "http/response", { request, attempt: n, status, contentType });
      },
      async chunk(data) {
        received.write(data);
        // 网络读取不等待保存恢复;缺口由正文引用明确标记。
      },
      async end(state, error) {
        // 收尾保留收到的字节数和缺口;写盘失败不阻断完成事件。
        await store.checkpoint();
        recordEvent(log, "http/end", {
          request,
          attempt: n,
          state,
          bytes: received.bytes,
          ...(received.ref.missingFrom !== undefined && { missingFrom: received.ref.missingFrom }),
          ...(error && { error }),
        });
        await log.checkpoint();
      },
    };
  };
}

export type ToolOutput = {
  write(data: string | Uint8Array): void;
  readonly ref: ContentRef;
  readonly path: string;
  readonly written: boolean;
  readonly bytes: number;
};
export function toolOutput(log: EventLog, callId: string, name: string): ToolOutput | undefined {
  const output = openOutput(log, `${name} original output`);
  if (output) recordEvent(log, "tool/output", { callId, output: output.ref });
  return output;
}

/** 输出捕获与所属事件分开,用户命令不应被请求检视器当成模型工具结果。 */
export function openOutput(log: EventLog, label: string): ToolOutput | undefined {
  const store = log.recording;
  if (!store) return undefined;
  const output = store.open(label);
  let written = false;
  return {
    ref: output.ref,
    path: join(store.directory, output.ref.file),
    get bytes() {
      return output.bytes;
    },
    get written() {
      return written;
    },
    write(data) {
      written = true;
      output.write(data);
    },
  };
}
