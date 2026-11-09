// @文件引用:输入里 @路径 指向存在的文本文件时,把文件内容附在消息后面。
// 附上的内容就是用户消息的一部分:落盘、上屏、检视器里都完整可见,没有隐藏的注入。
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const ATTACH_MAX_BYTES = 50 * 1024;

export type Attachment = { ref: string; path: string; bytes: number; skipped?: string };

/** 只读取 source 中的 @引用,把附件加到 message 后;生成正文不参与引用解释。 */
export function expandFileRefs(
  source: string,
  cwd = process.cwd(),
  message = source,
): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const blocks: string[] = [];
  // 引号明确界定含空格的路径,不从后续自然语言猜测文件名。
  const re = /(^|\s)@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s@"'`<>]+))/g;
  for (const m of source.matchAll(re)) {
    const ref = (m[2] ?? m[3] ?? m[4]) as string;
    const path = resolve(cwd, ref);
    if (attachments.some((a) => a.path === path && !a.skipped)) continue;
    let size: number | undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
      if (size > ATTACH_MAX_BYTES) {
        attachments.push({
          ref,
          path,
          bytes: size,
          skipped: `exceeds ${ATTACH_MAX_BYTES} bytes, not attached`,
        });
        continue;
      }
      // 同一份字节用于检查和正文,避免重复打开文件。
      const bytes = readFileSync(path);
      size = bytes.length;
      if (size > ATTACH_MAX_BYTES) {
        attachments.push({
          ref,
          path,
          bytes: size,
          skipped: `exceeds ${ATTACH_MAX_BYTES} bytes, not attached`,
        });
        continue;
      }
      if (bytes.subarray(0, 8192).includes(0)) {
        attachments.push({ ref, path, bytes: size, skipped: "binary file, not attached" });
        continue;
      }
      let content: string;
      try {
        // 不能把损坏或其他编码的字节悄悄替换为 U+FFFD;有效 UTF-8 保留 BOM。
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        attachments.push({ ref, path, bytes: size, skipped: "not valid UTF-8 text, not attached" });
        continue;
      }
      attachments.push({ ref, path, bytes: size });
      const name = ref
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      blocks.push(`<file name="${name}">\n${content}\n</file>`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (size === undefined && (code === "ENOENT" || code === "ENOTDIR")) continue;
      attachments.push({
        ref,
        path,
        bytes: size ?? 0,
        skipped: `${(error as Error).message}; not attached`,
      });
    }
  }
  return {
    text: blocks.length > 0 ? `${message}\n\n${blocks.join("\n\n")}` : message,
    attachments,
  };
}
