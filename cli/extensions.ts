import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import type { TurnDeps } from "../src/loop.js";
import { errorMessage } from "../src/providers/errors.js";
import type { Tool } from "../src/tools.js";

/** 扩展模块的返回形态:要加的工具、要换的槽实现、要订阅事件的回调。都可选。 */
export type Extension = {
  tools?: Tool[];
  slots?: TurnDeps["slots"];
  onEvent?: (e: AgentEvent, index: number) => void;
  /** 释放此工厂实例持有的资源;共享资源由扩展自己管理其引用。 */
  dispose?: () => void | Promise<void>;
};

/**
 * 装载扩展模块(外部注入):default 导出 `(ctx) => Extension`,ctx 里有工作目录与事件日志。
 * 多个模块按顺序合并,后者的槽覆盖前者;工具重名以后者为准。
 */
export async function loadExtensions(
  paths: string[],
  ctx: { cwd: string; log: EventLog },
): Promise<Extension & { dispose(): Promise<void> }> {
  const merged: Extension = { tools: [], slots: {} };
  const cleanup: (() => void | Promise<void>)[] = [];
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposing ??= (async () => {
      const errors: unknown[] = [];
      for (const release of cleanup.reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Extension cleanup failed");
    })());
  try {
    for (const p of paths) {
      const mod = (await import(pathToFileURL(resolve(ctx.cwd, p)).href)) as { default?: unknown };
      if (typeof mod.default !== "function") {
        throw new Error(
          `extension module ${p} must default-export a function (ctx) => ({ tools?, slots?, onEvent? })`,
        );
      }
      const ext = (await (mod.default as (c: typeof ctx) => Extension | Promise<Extension>)(
        ctx,
      )) as Extension;
      if (ext.dispose) cleanup.push(() => ext.dispose?.());
      for (const t of ext.tools ?? []) {
        merged.tools = [...(merged.tools ?? []).filter((x) => x.name !== t.name), t];
      }
      merged.slots = { ...merged.slots, ...ext.slots };
      if (ext.onEvent) cleanup.push(ctx.log.subscribe(ext.onEvent));
    }
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Extension initialization failed: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
  return { ...merged, dispose };
}
