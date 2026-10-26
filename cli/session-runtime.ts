// 会话与子任务共用资源装配;只共享连接,不共享工具闭包和日志包装。

import { now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { maxSteps, queueToTurnEnd, type TurnDeps } from "../src/loop.js";
import type { Provider } from "../src/provider.js";
import { errorMessage } from "../src/providers/errors.js";
import { type ChildInfo, type ChildTools, createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import type { CommonArgs } from "./args.js";
import {
  type bootstrap,
  buildCompaction,
  buildTools,
  loadExtensions,
  memoryFiles,
  resolveToolPrompts,
} from "./bootstrap.js";
import { connectMcpServers, type McpBridge } from "./mcp/bridge.js";
import { loadMcpServers, mcpConfigOf } from "./mcp/config.js";
import { McpConnections } from "./mcp/connections.js";
import {
  type ProjectMcpReview,
  projectMcpReview,
  projectMcpTrusted,
  trustProjectMcp,
} from "./mcp/trust.js";
import { automaticSkills, discoverSkills } from "./prompt.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { createSkillTool, skillCatalog } from "./tools/skill.js";

export async function prepareSessionRuntime(options: {
  boot: ReturnType<typeof bootstrap>;
  args: CommonArgs;
  log: EventLog;
  sessionFile: string;
  connections?: McpConnections;
  onChild?: (child: ChildInfo) => void;
  slots?: () => TurnDeps["slots"];
  current?: () => { provider: Provider; tools: readonly Tool[] } | undefined;
  allowUnavailable?: boolean;
  descriptions?: Record<string, string>;
  confirmProjectMcp?: (review: ProjectMcpReview) => Promise<boolean>;
}) {
  const { boot, args, log } = options;
  const choice = options.allowUnavailable ? boot.chooseOrNone(args.model) : boot.choose(args.model);
  const compaction = await buildCompaction(args, choice.contextWindow);
  const memory = args.memory ? memoryFiles() : undefined;
  const skills = discoverSkills(process.cwd(), {
    ...(args.skillsSources && { sources: args.skillsSources }),
    onError: (error) =>
      log.append({
        type: "ext/event",
        at: now(),
        source: "skills",
        kind: "load-error",
        payload: { message: error.message },
      }),
  });
  const toolPrompts = resolveToolPrompts(args, boot.config);
  if (options.descriptions) toolPrompts.descriptions = options.descriptions;
  const connections = options.connections ?? new McpConnections();
  const config = mcpConfigOf(boot.config.mcp);
  const projectReview = projectMcpReview(process.cwd());
  const allServers = loadMcpServers(
    config,
    process.cwd(),
    process.env,
    projectReview?.snapshot ?? null,
  );
  const projectNames = new Set(
    allServers
      .filter((server) => server.source === projectReview?.file)
      .map((server) => server.name),
  );
  const review = projectReview && {
    ...projectReview,
    servers: projectReview.servers.filter((server) => projectNames.has(server.name)),
  };
  let useProjectMcp = true;
  if (review?.servers.length && !projectMcpTrusted(review)) {
    if (!options.confirmProjectMcp)
      throw new Error(
        `Project MCP is not trusted: ${review.file}. Open Clarook TUI to review and approve it; no project MCP command was started.`,
      );
    useProjectMcp = await options.confirmProjectMcp(review);
    if (useProjectMcp) {
      trustProjectMcp(review);
      log.append({
        type: "ext/event",
        at: now(),
        source: "mcp",
        kind: "project-trusted",
        payload: { file: review.file },
      });
    }
  }
  const servers = allServers.filter((server) => useProjectMcp || server.source !== review?.file);
  if (review && projectMcpReview(process.cwd())?.digest !== review.digest)
    throw new Error(
      `${review.file} changed during preparation; inspect it again before connecting`,
    );
  if (review?.servers.length && !useProjectMcp)
    log.append({
      type: "ext/event",
      at: now(),
      source: "mcp",
      kind: "project-skipped",
      payload: { file: review.file },
    });

  async function assemble(target: EventLog, reconnect = false) {
    const ext = await loadExtensions(args.extensions, { cwd: process.cwd(), log: target });
    let mcp: McpBridge | undefined;
    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> =>
      (disposing ??= (async () => {
        const results = await Promise.allSettled([
          ext.dispose(),
          mcp?.close() ?? Promise.resolve(),
        ]);
        const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (errors.length) throw new AggregateError(errors, "Session resource cleanup failed");
      })());
    try {
      const base = buildTools({
        ...(memory && { memory }),
        ...(args.skillsLoad === "tool" && {
          skills: automaticSkills(skills, {
            ...(args.skillsMode && { mode: args.skillsMode }),
            ...(args.skillsInclude !== undefined && { include: args.skillsInclude }),
          }),
        }),
        ...(boot.config.fetch && { fetchConfig: boot.config.fetch }),
        toolPrompts,
        plan: args.plan ?? true,
      });
      const tools = [
        ...base.filter((t) => !ext.tools?.some((e) => e.name === t.name)),
        ...(ext.tools ?? []),
      ];
      mcp = await connectMcpServers(servers, {
        log: target,
        tools,
        connections,
        activate: false,
        ...(target.path && { artifactsDir: target.path.replace(/\.jsonl$/, ".mcp") }),
        ...(config && { mcp: config }),
        ...(reconnect && args.mcpReconnect && { reconnect: args.mcpReconnect }),
      });
      return { tools, mcp, slots: ext.slots, dispose };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Session initialization failed: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }
  const disposeOwned = async (dispose: () => Promise<void>): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
    if (!options.connections) {
      try {
        await connections.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Session resource cleanup failed");
  };
  let root: Awaited<ReturnType<typeof assemble>>;
  try {
    root = await assemble(log, true);
  } catch (error) {
    if (!options.connections) {
      try {
        await connections.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session initialization and cleanup failed",
        );
      }
    }
    throw error;
  }
  try {
    const current = () =>
      options.current?.() ?? {
        provider: choice.provider,
        tools: root.tools.filter((t) => !args.disabledTools?.includes(t.name)),
      };
    if (args.subagent && !root.tools.some((t) => t.name === "task")) {
      const task = createTaskTool({
        ...boot.config.subagents,
        parent: log,
        provider: () => current().provider,
        tools: (childLog) => {
          // 初始化前固定名称与描述;执行闭包由 assemble 重新创建。
          const enabled = current().tools;
          const selected = new Map(enabled.map((t) => [t.name, t.description]));
          const selectedSkill = enabled.find((t) => t.name === "skill");
          const catalog = selectedSkill && skillCatalog(selectedSkill);
          const fork = async (target: EventLog): Promise<ChildTools> => {
            const resources = await assemble(target);
            // 目录也随派发固定;不能用父会话启动时的旧范围重新装配。
            const tools = resources.tools.filter((t) => !skillCatalog(t));
            if (catalog) tools.push(createSkillTool([...catalog]));
            return {
              tools: tools
                .filter((t) => selected.has(t.name))
                .map((t) => ({
                  ...t,
                  description: selected.get(t.name) ?? t.description,
                })),
              dispose: resources.dispose,
              fork,
            };
          };
          return fork(childLog);
        },
        compaction,
        providerFor: (model) => boot.choose(model).provider,
        ...(options.onChild && { onChild: options.onChild }),
        ...(options.slots && { slots: options.slots }),
      });
      applyToolPrompts([task], toolPrompts);
      root.tools.push(task);
    }
    const slots: TurnDeps["slots"] = {
      ...root.slots,
      ...(args.maxSteps !== undefined && { termination: maxSteps(args.maxSteps) }),
      ...(args.execution && { execution: args.execution }),
      ...(args.steering === "turn" && { steering: queueToTurnEnd }),
    };
    return {
      choice,
      compaction,
      tools: root.tools,
      slots,
      mcp: root.mcp,
      memory,
      skills,
      toolPrompts,
      activate: () => root.mcp.activate(),
      dispose: () => disposeOwned(root.dispose),
    };
  } catch (error) {
    try {
      await disposeOwned(root.dispose);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Session initialization failed: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}
