// fetch 工具:HTML 转文本、重定向两态、字节上限、二进制拒绝、续读、超时;审批规则按 URL。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchTool, rewriteUrl } from "../cli/tools/fetch.js";
import { decodeEntities, htmlToText } from "../cli/tools/html.js";
import { decide } from "../src/approval.js";
import { toolOutput } from "../src/exchange.js";
import { EventLog } from "../src/log.js";

const ctx = { signal: new AbortController().signal } as never;
let server: Server;
let base = "";
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head><title>Docs &amp; Notes</title><style>body{}</style></head><body>
        <nav><a href="/x">skip me</a></nav>
        <main><h1>Hello</h1><p>First &lt;para&gt; with <a href="/rel">a link</a> and <code>x = 1</code>.</p>
        <ul><li>one</li><li>two</li></ul><pre><code>line 1\n  line 2</code></pre>
        <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></main>
        <footer>footer text</footer></body></html>`);
    } else if (url === "/hop") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (url === "/away") {
      res.writeHead(301, { location: "https://example.com/elsewhere" });
      res.end();
    } else if (url === "/big") {
      hits.big = (hits.big ?? 0) + 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x".repeat(12000));
      setTimeout(() => {
        if (!res.destroyed) res.end("y".repeat(8000));
      }, 20);
    } else if (url === "/bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2]));
    } else if (url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 500);
    } else if (url === "/gbk") {
      res.writeHead(200, { "content-type": "text/plain; charset=gbk" });
      res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    } else if (url === "/lines") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n"));
    } else if (url === "/rich") {
      hits.rich = (hits.rich ?? 0) + 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><main><p>Use <strong>bold</strong> and <em>soft</em> words.</p>
        <ul><li>one<ul><li>one-a</li><li>one-b</li></ul></li><li>two</li></ul>
        <ol><li>first</li><li>second</li></ol>
        <table><tr><th>name</th><th>tok</th></tr><tr><td>a | b</td><td>1</td></tr></table>
        <pre><code class="language-ts">const x: number = 1;\n  if (x &lt; 2) {}</code></pre></main></body></html>`);
    } else if (url === "/cf") {
      hits.cf = (hits.cf ?? 0) + 1;
      if (req.headers["user-agent"]?.includes("clarook")) {
        res.writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/plain" });
        res.end("blocked");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("welcome browser");
      }
    } else if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"a":1,"b":[1,2]}');
    } else if (url === "/spa") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body><div id="root"></div><script>${"x".repeat(30000)}</script></body></html>`,
      );
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("htmlToText", () => {
  it("取 main、去 nav/footer/style,标题、链接、代码、列表、表格、实体各成 markdown 形态", () => {
    const html = `<html><head><title>T &amp; U</title></head><body><nav>menu</nav><main><h2>Head</h2><p>a &nbsp; b <a href="/r">link</a></p><ul><li>x</li></ul></main><footer>f</footer></body></html>`;
    const out = htmlToText(html, "https://h.test/base/");
    expect(out).toContain("title: T & U");
    expect(out).toContain("## Head");
    expect(out).toContain("[link](https://h.test/r)");
    expect(out).toContain("- x");
    expect(out).not.toContain("menu");
    expect(out).not.toContain("f\n");
    expect(decodeEntities("&#x41;&#66;&mdash;&unknown;")).toBe("AB—&unknown;");
  });
});

describe("fetch 工具", () => {
  const tool = createFetchTool({
    config: { maxBytes: 10000, timeoutMs: 200 },
  });

  it("HTML → 文本,头行带状态与大小;同主机重定向自动跟", async () => {
    const out = await tool.execute({ url: `${base}/hop` }, ctx);
    expect(out).toContain(`${base}/hop → ${base}/page · 200 · text/html`);
    expect(out).toContain("title: Docs & Notes");
    expect(out).toContain("# Hello");
    expect(out).toContain(`[a link](${base}/rel)`);
    expect(out).toContain("`x = 1`");
    expect(out).toContain("- one");
    expect(out).toContain("```\nline 1\n  line 2\n```");
    expect(out).toContain("| a | b |");
    expect(out).not.toContain("skip me");
    expect(out).not.toContain("footer text");
    const raw = await tool.execute({ url: `${base}/page`, raw: true }, ctx);
    expect(raw).toContain("<title>");
  });

  it("跨主机重定向不跟,交给模型;超过字节上限停下并注明;二进制拒绝;404 照常返回正文", async () => {
    expect(await tool.execute({ url: `${base}/away` }, ctx)).toContain(
      "redirected to https://example.com/elsewhere (another host, not followed)",
    );
    const dir = mkdtempSync(join(tmpdir(), "kernel-fetch-prefix-"));
    const log = new EventLog(join(dir, "session.jsonl"));
    try {
      const output = toolOutput(log, "big", "fetch");
      if (!output) throw new Error("Recording output unavailable");
      const big = await tool.execute(
        { url: `${base}/big` },
        { signal: new AbortController().signal, output },
      );
      await log.checkpoint();
      expect(big).toContain("download may be incomplete: stopped at the 10000-byte limit");
      expect(big).toContain(`Captured prefix: ${output.path}`);
      expect(readFileSync(output.path, "utf8")).not.toContain("y");
      const completeOutput = toolOutput(log, "big-retry", "fetch");
      if (!completeOutput) throw new Error("Recording output unavailable");
      const complete = await tool.execute(
        { url: `${base}/big`, maxBytes: 25000 },
        { signal: new AbortController().signal, output: completeOutput },
      );
      await log.checkpoint();
      expect(complete).not.toContain("download may be incomplete");
      expect(readFileSync(completeOutput.path, "utf8")).toContain("y".repeat(8000));
      expect(hits.big).toBe(2);
      expect(await tool.execute({ url: `${base}/big`, offset: 1 }, ctx)).toContain("cached");
      expect(hits.big).toBe(2);
    } finally {
      log.recording?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(tool.execute({ url: `${base}/bin` }, ctx)).rejects.toThrow(/binary content/);
    expect(await tool.execute({ url: `${base}/missing` }, ctx)).toContain("· 404 ·");
  });

  it("offset/limit 续读;charset 解码;超时;只许 http(s)", async () => {
    const page = await tool.execute({ url: `${base}/lines`, offset: 10, limit: 3 }, ctx);
    expect(page).toContain("L10\nL11\nL12");
    expect(page).toContain("continue with offset=13");
    const finalPage = await tool.execute({ url: `${base}/lines`, offset: 49, limit: 10 }, ctx);
    expect(finalPage).toContain("L49\nL50");
    expect(finalPage).not.toContain("continue with offset=");
    await expect(tool.execute({ url: `${base}/lines`, offset: 51, limit: 1 }, ctx)).rejects.toThrow(
      /beyond the end/,
    );
    expect(await tool.execute({ url: `${base}/gbk` }, ctx)).toContain("你好");
    await expect(tool.execute({ url: `${base}/slow` }, ctx)).rejects.toThrow();
    await expect(tool.execute({ url: "ftp://x/y" }, ctx)).rejects.toThrow(/only http and https/);
  });

  it("转换质量:粗斜体、嵌套与有序列表、带分隔行的表格、带语言的代码块", async () => {
    const out = await tool.execute({ url: `${base}/rich` }, ctx);
    expect(out).toContain("Use **bold** and *soft* words.");
    expect(out).toContain("- one\n  - one-a\n  - one-b\n- two");
    expect(out).toContain("1. first\n2. second");
    expect(out).toContain("| name | tok |\n| --- | --- |\n| a \\| b | 1 |");
    expect(out).toContain("```ts\nconst x: number = 1;\n  if (x < 2) {}\n```");
  });

  it("缓存:同一 URL 15 分钟内不重下,分页命中缓存;GitHub blob 改写成 raw;JSON 美化;JS 页面提示", async () => {
    const fresh = createFetchTool();
    const before = hits.rich ?? 0;
    const a = await fresh.execute({ url: `${base}/rich`, offset: 1, limit: 2 }, ctx);
    const b = await fresh.execute({ url: `${base}/rich`, offset: 3, limit: 2 }, ctx);
    expect(hits.rich).toBe(before + 1);
    expect(a).not.toContain("(cached)");
    expect(b).toContain("(cached)");
    expect(rewriteUrl(new URL("https://github.com/o/r/blob/main/src/a.ts")).url.toString()).toBe(
      "https://raw.githubusercontent.com/o/r/main/src/a.ts",
    );
    expect(rewriteUrl(new URL("https://gist.github.com/u/0123abcd")).url.toString()).toBe(
      "https://gist.githubusercontent.com/u/0123abcd/raw",
    );
    expect(rewriteUrl(new URL("https://github.com/o/r")).note).toBeUndefined();
    expect(await tool.execute({ url: `${base}/json` }, ctx)).toContain(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    );
    expect(await tool.execute({ url: `${base}/spa` }, ctx)).toContain(
      "probably rendered by JavaScript",
    );
  });

  it("Cloudflare 403 换浏览器 UA 重试一次", async () => {
    const out = await tool.execute({ url: `${base}/cf` }, ctx);
    expect(out).toContain("welcome browser");
    expect(out).toContain("retried with a browser User-Agent");
    expect(hits.cf).toBe(2);
  });

  it("审批规则按 URL 匹配:fetch 缺省问,fetch:https://docs.example.com/* 放行", () => {
    const call = (url: string) => ({ id: "c", name: "fetch", args: { url } });
    expect(decide(call("https://docs.example.com/a"), { default: "ask" }, "C:/w").verdict).toBe(
      "ask",
    );
    const cfg = {
      default: "ask" as const,
      allow: ["fetch:https://docs.example.com/*"],
      deny: ["fetch:*evil*"],
    };
    expect(decide(call("https://docs.example.com/a/b"), cfg, "C:/w").verdict).toBe("allow");
    expect(decide(call("https://evil.example.com/"), cfg, "C:/w").verdict).toBe("deny");
    expect(decide(call("https://other.example.com/"), cfg, "C:/w").verdict).toBe("ask");
  });
});
