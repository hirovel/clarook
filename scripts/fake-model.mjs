// 本机假模型:OpenAI 兼容协议的最小服务器,不联网、不要 key。
// 用途:没有 key 也能把 内核 → 工具 → 日志 → 界面 → 检视器 整条链路跑起来看。
// 行为是脚本化的"像 agent":先 ls 看目录,再 read 一个文件,最后用工具结果写一段回答;
// 用户消息含 "长" 时故意输出一段长文,方便看压缩;含 "错" 时先发一次 429 让重试可见。
// 用法:node scripts/fake-model.mjs [端口]   缺省 4111
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4111);
let rateLimited = false;

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let i = 0;
  const tick = () => {
    if (i < events.length) {
      res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
      setTimeout(tick, 12);
    } else res.end("data: [DONE]\n\n");
  };
  tick();
};
// 短文按 6 字一块流(看得清逐字);长文按 400 字一块,否则两万字要流四十秒。
const textChunks = (s) =>
  [...s.matchAll(s.length > 2000 ? /.{1,400}/gs : /.{1,6}/gs)].map((m) => ({
    choices: [{ delta: { content: m[0] } }],
  }));
const toolCall = (id, name, args) => ({
  choices: [
    {
      delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
    },
  ],
});
const finish = (reason, prompt, completion) => ({
  choices: [{ delta: {}, finish_reason: reason }],
  usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_cache_hit_tokens: Math.floor(prompt * 0.6) },
});

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake-agent" }, { id: "fake-agent-mini" }] }));
    return;
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const toolResults = messages.filter((m) => m.role === "tool");
    const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
    // 只认用户输入里的 "(错)",别把摘要提示词里的"报错"当信号。
    const wantError = lastUser.includes("(错)");
    if (wantError && !rateLimited) {
      rateLimited = true;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "rate limited (fake)" } }));
      return;
    }
    rateLimited = false;
    // 摘要请求(压缩策略发的)直接给一段摘要。
    if (/Summarize only the conversation before this instruction\./.test(lastUser)) {
      sse(res, [...textChunks("## Goal\nInspect the directory and summarize the README.\n## Next Steps\nContinue answering the user."), finish("stop", promptTokens, 30)]);
      return;
    }
    if (toolResults.length === 0) {
      sse(res, [...textChunks("先看一下目录。"), toolCall("call_1", "read", { path: "." }), finish("tool_calls", promptTokens, 20)]);
      return;
    }
    if (toolResults.length === 1) {
      sse(res, [toolCall("call_2", "read", { path: "README.md", limit: 8 }), finish("tool_calls", promptTokens, 15)]);
      return;
    }
    const last = toolResults.at(-1)?.content ?? "";
    const firstLine = last.split("\n")[0]?.replace(/^\d+\t/, "") ?? "";
    // "长":约 2 万字填充(≈5000 tok),小窗口下一步就越过压缩阈值。
    const long = /长/.test(lastUser) ? `\n\n${"这是一段用来撑大上下文的填充文字。".repeat(1200)}` : "";
    const answer = `## 结论\n\n目录里有 ${messages.find((m) => m.role === "tool")?.content.split("\n").length ?? 0} 项,README 第一行是:\n\n> ${firstLine}\n\n这是本机假模型生成的回答,全部内容来自工具结果。${long}`;
    sse(res, [...textChunks(answer), finish("stop", promptTokens, Math.ceil(answer.length / 4))]);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`假模型已启动 http://127.0.0.1:${port}  (GET /models, POST /chat/completions)`);
});
