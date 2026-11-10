// provider 错误归一:各家 status/body 形态不同,这里统一成一个可判定"能否重试 / 是否溢出"的错误对象。

/** 保留原文,只补充规范错误码;不展开原因中的正文、地址或请求对象。 */
export function errorMessage(error: unknown): string {
  let message = "Unknown error";
  try {
    message = String(error instanceof Error ? error.message : error);
    const codes = errorCodes(error).filter((code) => !message.includes(code));
    return codes.length ? `${message} [${codes.join(", ")}]` : message;
  } catch {
    // 错误对象的转换和元数据 getter 也可能抛错;保留已经取得的原文。
    return message;
  }
}

/** 显示与网络判定读取同一条原因链,不依赖文案恰好包含错误码。 */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  // 网络错误可能包含多地址 AggregateError,也可能形成循环原因链。
  while (pending.length && seen.size < 8) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const entry = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (
      typeof entry.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(entry.code) &&
      !codes.includes(entry.code)
    )
      codes.push(entry.code);
    if (entry.cause) pending.push(entry.cause);
    if (Array.isArray(entry.errors)) pending.push(...entry.errors.slice(0, 8));
  }
  return codes;
}

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly body: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; body?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status !== undefined && retryableStatus(opts.status));
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

/** 各家与两大 SDK 一致的可重试状态码集合。 */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** 从响应头解析 retry-after(毫秒优先,其次秒或 HTTP 日期)。 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+$/.test(ms)) return Number(ms);
  const ra = headers.get("retry-after");
  if (!ra) return undefined;
  if (/^\d+$/.test(ra)) return Number(ra) * 1000;
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 网络层失败(连接拒绝、DNS、读流中断)与流提前结束都可重试。 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    return (
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|stream ended/i.test(
        err.message,
      ) ||
      errorCodes(err).some((code) =>
        /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))$/.test(
          code,
        ),
      )
    );
  }
  return false;
}

const OVERFLOW = [
  /context_length_exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /exceeds? the (?:model'?s )?(?:maximum )?context/i,
  /context window/i,
  /input is too long/i,
  /too many tokens/i,
  /model_context_window_exceeded/i,
];
const NOT_OVERFLOW = [/rate.?limit/i, /too many requests/i, /quota/i];

/**
 * 上下文溢出识别:没有跨家统一错误码,只能靠文案库 + 反例排除。
 * 必须在重试判定之前处理 —— 溢出重试永远不会成功。
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${err instanceof ProviderError ? (err.body ?? "") : ""}`;
  if (NOT_OVERFLOW.some((re) => re.test(text))) return false;
  return OVERFLOW.some((re) => re.test(text));
}

/**
 * 错误分类:每个失败都有一个名字,界面据此给出下一步。分类只看状态码、错误名与文案,不猜。
 * aborted 单列:它不是失败,是用户的决定。
 */
export type ErrorKind =
  | "auth"
  | "not_found"
  | "rate_limit"
  | "overflow"
  | "bad_request"
  | "server"
  | "network"
  | "stream"
  | "aborted"
  | "unknown";

export function classifyError(err: unknown): ErrorKind {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "AbortError") return "aborted";
  if (isContextOverflow(err)) return "overflow";
  if (err instanceof ProviderError) {
    const s = err.status;
    if (s === 401 || s === 403) return "auth";
    if (s === 404) return "not_found";
    if (s === 429) return "rate_limit";
    if (s !== undefined && s >= 500) return "server";
    if (s !== undefined && s >= 400) return "bad_request";
    if (/stream|stalled/i.test(err.message)) return "stream";
    if (/overloaded/i.test(err.message)) return "server";
    return "unknown";
  }
  if (isRetryable(err)) return "network";
  return "unknown";
}

/**
 * 供应商原话:响应体多半是 JSON,取 error.message(OpenAI / Anthropic / DeepSeek 都是这个形状);
 * 不是 JSON 就取正文前 300 字。给人看的是原话,不是我们的转述。
 */
export function providerMessage(err: unknown): string | undefined {
  if (!(err instanceof ProviderError) || !err.body) return undefined;
  const body = err.body.trim();
  try {
    const j = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
    const m = j.error?.message;
    if (m)
      return `${m}${j.error?.type || j.error?.code ? ` (${j.error?.type ?? j.error?.code})` : ""}`;
  } catch {
    // 非 JSON:落到下面
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/** 下一步该做什么。英文,与界面一致;每条都指向一个具体动作。 */
export function hintFor(
  kind: ErrorKind,
  ctx: { providerName?: string; model?: string } = {},
): string {
  const p = ctx.providerName ?? "the provider";
  switch (kind) {
    case "auth":
      return `Check the API key for ${p}: open /login, or set its apiKeyEnv variable.`;
    case "not_found":
      return `Model ${ctx.model ?? ""} was not found. Open /model to choose an available model or query ${p}.`;
    case "rate_limit":
      return "Rate limited. Wait a moment and send again, or switch model.";
    case "overflow":
      return "Context is too long. Open Ctrl+E to inspect or exclude messages; /compact can try another summary, or choose a larger model.";
    case "bad_request":
      return "The provider rejected the request body. Open Ctrl+R → wire JSON for this request and compare with the provider's docs; extraBody and effort are the usual suspects.";
    case "server":
      return "Provider-side failure. Try again later or switch model.";
    case "network":
      return "Network failure reaching the provider. Check connectivity, proxy, and baseUrl in the config.";
    case "stream":
      return "The stream stopped before the response was complete. Raise stallTimeoutMs for slow relays, or retry.";
    case "aborted":
      return "Interrupted by you.";
    default:
      return "Unclassified. The raw error is in Ctrl+R → received for this request.";
  }
}
