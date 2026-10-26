// 测试隔离:用户目录指向一个临时目录,任何没显式给 home 的发现(AGENTS.md、skills、prompts、config)都碰不到真机。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "clarook-test-home-"));
process.env.CLAROOK_HOME = join(home, ".clarook");
process.env.CLAROOK_CONFIG = join(home, ".clarook", "config.json");
/** 临时产物放在已有隔离根下,由同一个 afterAll 回收。 */
export function testDirectory(prefix: string): string {
  return mkdtempSync(join(home, prefix));
}
afterAll(() => rmSync(home, { recursive: true, force: true }));
