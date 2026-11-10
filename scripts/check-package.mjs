import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 只接受 npm script 提供的 npm CLI,避免 Windows 的 .cmd 再解释参数。
const npmCli = process.env.npm_execpath;
assert(npmCli && basename(realpathSync(npmCli)) === "npm-cli.js", "Run npm run check:package with npm.");
const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const temporary = realpathSync(tmpdir());
const fromRepository = relative(repository, temporary);
assert(isAbsolute(fromRepository) || fromRepository === ".." || fromRepository.startsWith(`..${sep}`), "Package consumer must be outside the repository.");
const root = realpathSync(mkdtempSync(join(temporary, "clarook-package-")));
let server;
let summary;
try {
  const consumer = join(root, "consumer");
  const projectA = join(consumer, "project-a");
  const projectB = join(consumer, "project-b");
  const home = join(root, "home");
  for (const directory of [consumer, projectA, projectB, home]) mkdirSync(directory, { recursive: true });
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const name of ["user", "global"]) writeFileSync(join(root, `${name}.npmrc`), "");
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CLAROOK_HOME: join(home, ".clarook"),
    CLAROOK_CONFIG: join(root, "config.json"),
    CLAROOK_CREDENTIALS: join(root, "missing-credentials.json"),
    CLAROOK_SESSIONS: join(root, "sessions"),
    npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_update_notifier: "false",
    NO_COLOR: "1",
  });
  // 本轮只验本机模型,新鲜的空登记簿缓存避免启动时访问无关的公开清单。
  mkdirSync(env.CLAROOK_HOME, { recursive: true });
  writeFileSync(join(env.CLAROOK_HOME, "models.dev.json"), "{}");
  const execute = promisify(execFile);
  async function npm(args, cwd = consumer) {
    try {
      return (await execute(process.execPath, [npmCli, ...args], {
        cwd, env, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      })).stdout;
    } catch (error) {
      throw new Error(`npm ${args.join(" ")} failed:\n${error.message}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
  }
  const cli = (args, cwd = projectA) => npm(["exec", "--offline", "--", "clarook", ...args], cwd);
  const [packed] = JSON.parse(await npm(["pack", "--json", "--pack-destination", root], repository));
  assert(!packed.files.some(({ path }) => /^(docs|\.preview|src|cli|tests)\//.test(path)), "Package contains internal files.");
  const compiled = packed.files.filter(({ path }) => path.startsWith("dist/"));
  assert(compiled.length > 0, "Package has no compiled files.");
  const built = readdirSync(join(repository, "dist"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repository, join(entry.parentPath, entry.name)).split(sep).join("/"));
  assert.deepEqual(compiled.map(({ path }) => path).sort(), built.sort(), "Package omitted compiled files.");
  const compiledBytes = compiled.map(({ path }) => readFileSync(join(repository, path)));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "clarook-package-consumer", private: true }));
  await npm(["install", "--omit=dev", "--no-audit", "--no-fund", join(root, packed.filename)]);
  for (const [index, { path }] of compiled.entries()) {
    assert(readFileSync(join(consumer, "node_modules", "clarook", path)).equals(compiledBytes[index]), `Installed file differs: ${path}`);
  }
  assert((await cli(["--help"])).includes("Usage"), "Installed TUI help failed.");
  assert((await cli(["once", "--help"])).includes("Usage"), "Installed once help failed.");

  const markerA = "PACKAGE_ROOT_A_MARKER";
  const markerB = "PACKAGE_ATTACHMENT_B_MARKER";
  writeFileSync(join(projectA, "a.txt"), `${markerA}\n`);
  writeFileSync(join(projectA, "b.txt"), `${markerB}\n`);
  writeFileSync(join(projectB, "a.txt"), "WRONG_PROJECT_B\n");
  const requests = [];
  server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const step = requests.length;
      const calls = step === 1
        ? [{ name: "read", args: { path: "a.txt" } }, { name: "grep", args: { pattern: markerB } }]
        : step === 3 ? [{ name: "read", args: { path: "a.txt" } }] : [];
      assert(step <= 4, "Unexpected extra model request.");
      const delta = calls.length ? {
        tool_calls: calls.map((call, index) => ({
          index, id: `package-${step}-${index}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      } : { content: step === 2 ? "PACKAGE_FIRST_DONE" : "PACKAGE_RESUME_DONE" };
      const frames = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  writeFileSync(env.CLAROOK_CONFIG, JSON.stringify({
    default: "package-local/smoke",
    providers: { "package-local": {
      protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "package-local-fixture", models: [{ name: "smoke", contextWindow: 128000, maxTokens: 1000 }],
      retry: { maxRetries: 0 },
    } },
    defaults: {
      prompt: { sections: [] }, checkUpdates: false, plan: false, subagent: false,
      compaction: "clear", compactionTrigger: "manual", facts: { date: false },
      tools: { disable: ["write", "edit", "bash", "glob", "fetch"] },
    },
  }));
  const first = JSON.parse(await cli(["once", "Read and search @a.txt @b.txt", "--json"]));
  assert(first.ok && first.text === "PACKAGE_FIRST_DONE" && first.requests === 2 && first.toolCalls === 2, "Installed read/grep turn failed.");
  const prefix = readFileSync(first.sessionFile);
  const resumed = JSON.parse(await cli(["once", "Read a.txt again from the saved root.", "--resume", first.sessionFile, "--json"], projectB));
  assert(resumed.ok && resumed.text === "PACKAGE_RESUME_DONE" && resumed.sessionFile === first.sessionFile, "Second-process resume failed.");
  const saved = readFileSync(first.sessionFile);
  assert(saved.subarray(0, prefix.length).equals(prefix) && saved.length > prefix.length, "Resume changed the saved event prefix.");
  const directories = saved.toString("utf8").trim().split("\n").map(JSON.parse).filter((event) => event.type === "session/directory");
  assert(directories.length > 0 && directories.every((event) => event.cwd === projectA), "Resume changed the session root.");
  assert(requests.length === 4, "Expected four local model requests.");
  const initial = requests[0];
  const attached = initial.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  assert(attached.includes(`<file name="a.txt">\n${markerA}`) && attached.includes(`<file name="b.txt">\n${markerB}`), "Both attachments must reach the installed provider.");
  assert.deepEqual(initial.tools.map((tool) => tool.function.name).sort(), ["grep", "read"]);
  const results = requests[1].messages.filter((message) => message.role === "tool");
  assert(results.length === 2 && results.some((message) => message.content.includes(markerA)) && results.some((message) => message.content.includes(`b.txt:1:${markerB}`)), "Real read and native grep results did not return to the model.");
  const restoredRead = requests[3].messages.filter((message) => message.role === "tool").at(-1).content;
  assert(restoredRead.includes(markerA) && !restoredRead.includes("WRONG_PROJECT_B"), "Resumed read used the invoking directory.");
  assert(requests[2].messages.some((message) => message.content === "PACKAGE_FIRST_DONE"), "Saved model history was not restored.");
  const replay = await cli(["replay", first.sessionFile, "--messages"], projectB);
  assert(replay.includes(markerA) && replay.includes(`b.txt:1:${markerB}`) && replay.includes("PACKAGE_RESUME_DONE"), "Installed replay omitted saved results.");
  summary = {
    pass: true, node: process.version, platform: process.platform, arch: process.arch,
    packageFileCount: packed.files.length, packageBytes: packed.size, compiledFiles: compiled.length,
    localHttpRequests: requests.length, externalModelRequests: 0, costUsd: 0,
    results: ["installed-help", "installed-dist-bytes", "two-attachments", "read-native-grep", "saved-prefix", "resume-saved-root", "compiled-replay"],
  };
} finally {
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(summary, null, 2));
