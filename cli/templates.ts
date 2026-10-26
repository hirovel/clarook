// 提示词模板:一个 .md 文件就是一条斜杠命令。用户级在 ~/.clarook/prompts,项目级在 <git 根>/.clarook/prompts。
// 正文里 $ARGUMENTS / $@ 是全部参数,$1..$9 是按空格切分的第 n 个;可选 frontmatter 只认 description。
// 展开结果作为普通用户消息进日志,与手打的一样落盘、上屏。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { clarookHome } from "../src/config.js";
import { findGitRoot } from "./prompt.js";

export type PromptTemplate = {
  name: string;
  description: string;
  body: string;
  path: string;
};

export function parseTemplate(path: string, raw: string): PromptTemplate {
  const name = basename(path).replace(/\.md$/i, "");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let description = "";
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    const d = m[1]?.match(/^description:\s*(.+)$/m);
    if (d?.[1]) description = d[1].trim();
  }
  return { name, description: description || `template ${name}`, body: body.trim(), path };
}

/** 发现顺序:用户级 → 项目级;同名以项目级为准。 */
export function discoverTemplates(
  cwd = process.cwd(),
  home = clarookHome(),
  onError?: (error: Error) => void,
): PromptTemplate[] {
  const dirs = [join(home, "prompts")];
  const root = findGitRoot(cwd) ?? cwd;
  dirs.push(join(root, ".clarook", "prompts"));
  const byName = new Map<string, PromptTemplate>();
  const absent = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  };
  const warn = (message: string) => {
    if (onError) onError(new Error(message));
    else console.warn(message);
  };
  for (const dir of dirs) {
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) throw new Error("Expected a directory.");
      names = readdirSync(dir).sort();
    } catch (error) {
      if (absent(error)) continue;
      warn(`Skipped template directory ${dir}: ${(error as Error).message}`);
      continue;
    }
    for (const f of names) {
      if (!/\.md$/i.test(f)) continue;
      const p = join(dir, f);
      try {
        if (!statSync(p).isFile()) throw new Error("Expected a file.");
        const t = parseTemplate(p, readFileSync(p, "utf8"));
        byName.set(t.name, t);
      } catch (error) {
        if (absent(error)) continue;
        warn(`Skipped template ${p}: ${(error as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}

/** 参数切分:空格分隔,双引号或单引号包起来的算一个。 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function expandTemplate(t: PromptTemplate, argText: string): string {
  const args = splitArgs(argText);
  // 单次替换只解释模板里的占位符,不再次解释插入的用户文本。
  return t.body.replace(/\$ARGUMENTS|\$@|\$(\d)/g, (_, n: string | undefined) =>
    n === undefined ? argText.trim() : (args[Number(n) - 1] ?? ""),
  );
}
