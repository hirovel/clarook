// fetch 工具:抓一个 URL,按 Content-Type 分流成可读文本。URL、字节上限、超时与重定向受控,
// 不用小模型摘要:模型看到的就是页面,结果按 read 同一套截断策略分页。
// 会话内缓存 15 分钟(分页续读不重下);GitHub blob 改写成 raw;Cloudflare 403 用浏览器 UA 重试一次。
import { Type } from "@sinclair/typebox";
import { defineTool, described } from "../../src/tools.js";
import { htmlToText } from "./html.js";
import { capLineLength, keepHead, type TruncationPolicy } from "./truncate.js";

export type FetchConfig = {
  /** 整个请求(含读 body)的超时毫秒数,缺省 30000。 */
  timeoutMs?: number;
  /** body 字节上限,缺省 5 MB;超过即中断并注明。 */
  maxBytes?: number;
  /** 同主机重定向最多跟几次,缺省 5。 */
  maxRedirects?: number;
  userAgent?: string;
  /** 会话内缓存的存活毫秒数,缺省 15 分钟;0 关。 */
  cacheTtlMs?: number;
};

const DEFAULTS = {
  timeoutMs: 30000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  cacheTtlMs: 15 * 60 * 1000,
  userAgent: "Mozilla/5.0 (compatible; clarook/0.1; +https://github.com/hirovel/clarook)",
};
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** 缓存总量上限(字符数)。 */
const CACHE_CHARS = 20 * 1024 * 1024;

/** GitHub blob 与 gist 页面是 JS 壳,改写成 raw 才有正文。返回改写后的 URL 与说明。 */
export function rewriteUrl(u: URL): { url: URL; note?: string } {
  if (u.hostname === "github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) {
      return {
        url: new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`),
        note: "github blob rewritten to raw",
      };
    }
  }
  if (u.hostname === "gist.github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/);
    if (m) {
      return {
        url: new URL(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`),
        note: "gist rewritten to raw",
      };
    }
  }
  return { url: u };
}

function parseContentType(header: string | null): { type: string; charset?: string } {
  const [mime = "", ...params] = (header ?? "").split(";").map((s) => s.trim().toLowerCase());
  const charset = params.find((p) => p.startsWith("charset="))?.slice("charset=".length);
  return { type: mime, ...(charset && { charset: charset.replace(/^"|"$/g, "") }) };
}

const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript"]);

type Fetched = {
  finalUrl: string;
  status: number;
  type: string;
  total: number;
  cut: boolean;
  text: string;
  isHtml: boolean;
  isJson: boolean;
  notes: string[];
  at: number;
};

export type FetchToolOptions = {
  config?: FetchConfig;
  /** HTML → 文本的转换器槽;缺省 htmlToText。 */
  convert?: (html: string, url: string) => string;
  truncate?: TruncationPolicy;
  maxLineChars?: number;
  now?: () => number;
};

export function createFetchTool(opts: FetchToolOptions = {}) {
  const cfg = { ...DEFAULTS, ...opts.config };
  const convert = opts.convert ?? htmlToText;
  const truncate = opts.truncate ?? keepHead();
  const cap = capLineLength(opts.maxLineChars ?? 2000);
  const clock = opts.now ?? Date.now;
  const cache = new Map<string, Fetched>();

  const cacheGet = (key: string): Fetched | undefined => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (clock() - hit.at > cfg.cacheTtlMs) {
      cache.delete(key);
      return undefined;
    }
    return hit;
  };

  const cachePut = (key: string, f: Fetched): void => {
    if (!cfg.cacheTtlMs) return;
    cache.set(key, f);
    let total = [...cache.values()].reduce((s, x) => s + x.text.length, 0);
    for (const k of cache.keys()) {
      if (total <= CACHE_CHARS) break;
      total -= cache.get(k)?.text.length ?? 0;
      cache.delete(k);
    }
  };

  const request = async (url: URL, signal: AbortSignal, ua: string): Promise<Response> => {
    try {
      return await fetch(url.toString(), {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": ua,
          Accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
        },
      });
    } catch (error) {
      if (error instanceof Error && error.cause instanceof Error) {
        const cause = error.cause as Error & { code?: string };
        throw new Error(`fetch ${url}: ${cause.message || cause.code || cause.name}`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  const download = async (
    start: URL,
    ctxSignal: AbortSignal | undefined,
    maxBytes: number,
    onChunk?: (data: Uint8Array) => void,
  ): Promise<Fetched> => {
    const notes: string[] = [];
    let current = start;
    let response: Response | undefined;
    for (let hop = 0; ; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:")
        throw new Error(`only http and https URLs are fetched, got ${current.protocol}`);
      const signal = ctxSignal
        ? AbortSignal.any([ctxSignal, AbortSignal.timeout(cfg.timeoutMs)])
        : AbortSignal.timeout(cfg.timeoutMs);
      let res = await request(current, signal, cfg.userAgent);
      // Cloudflare 拦下的 403 换浏览器 UA 再试一次(OpenCode 做法)。
      if (res.status === 403 && res.headers.get("cf-mitigated")) {
        await res.body?.cancel().catch(() => {});
        res = await request(current, signal, BROWSER_UA);
        notes.push("retried with a browser User-Agent after a Cloudflare 403");
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current);
        await res.body?.cancel().catch(() => {});
        if (next.host !== current.host) {
          return {
            finalUrl: current.toString(),
            status: res.status,
            type: "",
            total: 0,
            cut: false,
            text: `${current} → redirected to ${next} (another host, not followed); call fetch again with that URL if you trust it`,
            isHtml: false,
            isJson: false,
            notes: ["cross-host redirect"],
            at: clock(),
          };
        }
        if (hop >= cfg.maxRedirects) throw new Error(`more than ${cfg.maxRedirects} redirects`);
        current = next;
        continue;
      }
      response = res;
      break;
    }
    const ct = parseContentType(response.headers.get("content-type"));
    const isHtml = ct.type === "text/html" || ct.type === "application/xhtml+xml";
    const isJson = ct.type === "application/json" || ct.type.endsWith("+json");
    const isText =
      isHtml ||
      isJson ||
      ct.type.startsWith("text/") ||
      TEXT_TYPES.has(ct.type) ||
      ct.type.endsWith("+xml") ||
      ct.type === "";
    if (!isText) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${current} is ${ct.type}: binary content is not fetched into the context`);
    }
    // 逐块读,超过上限即停:大页面不该整份进内存。
    const chunks: Uint8Array[] = [];
    let total = 0;
    let cut = false;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          onChunk?.(value);
          chunks.push(value);
          total += value.byteLength;
          if (total > maxBytes) {
            cut = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
    }
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    let charset = ct.charset;
    if (!charset && isHtml) {
      const head = bytes.subarray(0, 4096).toString("latin1");
      charset = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1]?.toLowerCase();
    }
    let text: string;
    try {
      text = new TextDecoder(charset ?? "utf-8").decode(bytes);
    } catch {
      text = new TextDecoder("utf-8").decode(bytes);
    }
    return {
      finalUrl: current.toString(),
      status: response.status,
      type: ct.type,
      total,
      cut,
      text,
      isHtml,
      isJson,
      notes,
      at: clock(),
    };
  };

  return defineTool({
    name: "fetch",
    ...described({
      core:
        "Fetch a URL over http(s) and return its content as text. HTML is converted to markdown; JSON is pretty-printed; other text is returned as-is; binary content is refused. " +
        "GitHub blob and gist pages are rewritten to their raw form. Redirects to another host are reported, not followed. " +
        "Long pages are shortened for context; offset reads later lines already downloaded. If the download reaches its byte limit, retry with a larger maxBytes only when the rest is needed. Set raw=true to get the body unconverted.",
      guidance:
        "Pages are cached for 15 minutes, so paging is free. Fetch a page again with raw=true only when the conversion lost something you need.",
      rules:
        "NEVER fetch a page again with raw=true unless the conversion lost something you need.",
    }),
    parameters: Type.Object({
      url: Type.String({ description: "http or https URL" }),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "starting line number, 1-based" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "maximum number of lines to return" }),
      ),
      maxBytes: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `response byte budget for this call; default ${cfg.maxBytes}`,
        }),
      ),
      raw: Type.Optional(Type.Boolean({ description: "return the body without conversion" })),
    }),
    concurrency: "parallel",
    async execute(args, ctx) {
      const maxBytes = args.maxBytes ?? cfg.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error("maxBytes must be a positive safe integer.");
      const rewritten = rewriteUrl(new URL(args.url));
      const key = rewritten.url.toString();
      let fetched = cacheGet(key);
      let cached = true;
      if (!fetched) {
        cached = false;
        fetched = await download(rewritten.url, ctx.signal, maxBytes, ctx.output?.write);
        if (fetched.status < 400 && !fetched.cut) cachePut(key, fetched);
      }
      if (cached || fetched.notes.includes("cross-host redirect")) ctx.output?.write(fetched.text);
      if (fetched.notes.includes("cross-host redirect")) return fetched.text;

      let body: string;
      if (args.raw) body = fetched.text;
      else if (fetched.isHtml) body = convert(fetched.text, fetched.finalUrl);
      else if (fetched.isJson) {
        try {
          body = JSON.stringify(JSON.parse(fetched.text), null, 2);
        } catch {
          body = fetched.text;
        }
      } else body = fetched.text;

      const notes = [
        ...(rewritten.note ? [rewritten.note] : []),
        ...fetched.notes,
        ...(cached ? ["cached"] : []),
        ...(fetched.cut
          ? [
              `download may be incomplete: stopped at the ${maxBytes}-byte limit; retry with a larger maxBytes if the rest is needed`,
            ]
          : []),
        ...(fetched.isHtml && !args.raw && body.length < 200 && fetched.total > 20000
          ? ["page is probably rendered by JavaScript; content may be missing"]
          : []),
      ];
      const lines = body.split("\n");
      const start = args.offset ?? 1;
      if (
        !Number.isSafeInteger(start) ||
        start < 1 ||
        (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1))
      ) {
        throw new Error("offset and limit must be positive integers.");
      }
      if (start > lines.length)
        throw new Error(`offset ${start} is beyond the end of the page (${lines.length} lines).`);
      const slice = lines.slice(
        start - 1,
        args.limit === undefined ? undefined : start - 1 + args.limit,
      );
      const selected = slice.join("\n");
      const capped = cap(selected);
      const t = truncate(capped);
      const head = `${args.url}${fetched.finalUrl !== args.url ? ` → ${fetched.finalUrl}` : ""} · ${fetched.status} · ${fetched.type || "unknown type"} · ${fetched.total} bytes → ${body.length} chars, ${lines.length} lines${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
      const missingFrom = ctx.output?.ref.missingFrom;
      const sourceLabel =
        missingFrom !== undefined
          ? `Recording incomplete from byte ${missingFrom}; available prefix`
          : fetched.cut
            ? "Captured prefix"
            : "Original downloaded body";
      const source =
        (fetched.cut || capped !== selected || t.truncated || missingFrom !== undefined) &&
        ctx.output?.path
          ? `\n[${sourceLabel}: ${ctx.output.path}]`
          : "";
      if (!t.truncated && start - 1 + slice.length >= lines.length)
        return `${head}\n\n${t.text}${source}`;
      const shown = t.text.split("\n").length;
      return `${head}\n\n${t.text}\n[${t.note ?? "truncated"}; page has ${lines.length} lines, continue with offset=${start + shown}]${source}`;
    },
  });
}

export const fetchTool = createFetchTool();
