import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { listFiles } from "./tools/search.js";

/** @ 只查文件名;命令和普通路径仍使用编辑器的公开补全接口。 */
export function createAutocompleteProvider(
  commands: SlashCommand[],
  cwd: string,
): AutocompleteProvider {
  const ordinary = new CombinedAutocompleteProvider(commands, cwd);
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const prefix = /(?:^|\s)(@(?:"[^"]*|'[^']*|[^\s@"'`<>]*))$/.exec(beforeCursor)?.[1];
      if (!prefix) return ordinary.getSuggestions(lines, cursorLine, cursorCol, options);
      try {
        const quote = prefix[1] === '"' || prefix[1] === "'" ? prefix[1] : "";
        const raw = prefix.slice(quote ? 2 : 1);
        const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf(sep));
        const base = raw.slice(0, slash + 1);
        const query = raw.slice(slash + 1).toLowerCase();
        const root = resolve(cwd, base);
        if (!statSync(root).isDirectory()) return null;
        const { paths } = await listFiles(root, options.signal);
        if (options.signal.aborted) return null;
        const entries = new Set(paths);
        for (const path of paths) {
          for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
            entries.add(path.slice(0, i + 1));
          }
        }
        const items = [...entries]
          .filter((path) => path.toLowerCase().includes(query))
          .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
          .slice(0, 100)
          .flatMap((path) => {
            const shown = base + path;
            let delimiter = quote || (/[\s@"'`<>]/.test(shown) ? '"' : "");
            if (delimiter && shown.includes(delimiter)) delimiter = delimiter === '"' ? "'" : '"';
            // 现有附件语法不支持转义;无法用一对引号表达的名字不提供错误候选。
            if ((delimiter && shown.includes(delimiter)) || /[\r\n]/.test(shown)) return [];
            return [{ value: `@${delimiter}${shown}${delimiter}`, label: path }];
          });
        return items.length ? { items, prefix } : null;
      } catch {
        return null;
      }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith("@")) {
        return ordinary.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol - prefix.length);
      const after = line.slice(cursorCol);
      const quote = prefix[1] === '"' || prefix[1] === "'" ? prefix[1] : "";
      const rest = quote && after.startsWith(quote) ? after.slice(1) : after;
      const directory = item.label.endsWith("/");
      const suffix = directory ? "" : " ";
      const completed = [...lines];
      completed[cursorLine] = before + item.value + suffix + rest;
      const quotedDirectory = directory && /["']$/.test(item.value);
      return {
        lines: completed,
        cursorLine,
        cursorCol: before.length + item.value.length + suffix.length - (quotedDirectory ? 1 : 0),
      };
    },
    shouldTriggerFileCompletion: ordinary.shouldTriggerFileCompletion.bind(ordinary),
  };
}
