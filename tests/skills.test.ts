// 技能:frontmatter、四个发现目录、清单排除只许用户触发的、用户 /名 触发成用户消息、
// 统一审批、skill 工具(load = tool)、skills.mode = manual 不进系统提示词、/inspect skills 列表。
import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { applyPreset, buildTools, parseCommonArgs, systemPromptFor } from "../cli/bootstrap.js";
import {
  automaticSkills,
  discoverSkills,
  expandSkill,
  parseSkill,
  skillDirectories,
  skillSources,
  skillsSection,
} from "../cli/prompt.js";
import { recordSessionSetup, restoreSessionSetup } from "../cli/session-setup.js";
import { createSkillTool } from "../cli/tools/skill.js";
import { createTuiApp } from "../cli/tui-app.js";
import type { KernelConfig, Preset } from "../src/config.js";
import { changeContext } from "../src/context-edit.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import type { Provider } from "../src/provider.js";
import { DEFAULT_SKILL_SOURCES, setSetting } from "../src/settings.js";
import { systemAt, systemText } from "../src/system-prompt.js";
import { defineTool } from "../src/tools.js";
import { testDirectory } from "./helpers/setup.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), readdirSync: vi.fn(actual.readdirSync) };
});

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

const DEPLOY = `---
name: deploy
description: Ship a release
disable-model-invocation: false
allowed-tools: bash, read
argument-hint: <env>
---
Deploy to $1. Full args: $ARGUMENTS
Run ./scripts/release.sh`;

function project(): { home: string; proj: string } {
  const home = testDirectory("clarook-sk-home-");
  const proj = testDirectory("clarook-sk-proj-");
  mkdirSync(join(proj, ".git"));
  mkdirSync(join(home, "skills", "deploy"), { recursive: true });
  writeFileSync(join(home, "skills", "deploy", "SKILL.md"), DEPLOY);
  mkdirSync(join(proj, ".claude", "skills", "secret"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "skills", "secret", "SKILL.md"),
    "---\nname: secret\ndescription: user only\ndisable-model-invocation: true\n---\nOnly when asked.",
  );
  return { home, proj };
}

describe("SKILL.md 解析与发现", () => {
  it("技能字段、目录、正文;.claude/skills 也算;清单排除 user-only", () => {
    const s = parseSkill("/x/deploy/SKILL.md", DEPLOY);
    expect(s).toMatchObject({
      name: "deploy",
      description: "Ship a release",
      dir: "/x/deploy",
      disableModelInvocation: false,
      argumentHint: "<env>",
    });
    expect(s.body.startsWith("Deploy to $1.")).toBe(true);

    const body = "Keep $ARGUMENTS literal.\r\n\r\n---\r\n  Indented Markdown stays intact.";
    const yaml = parseSkill(
      "/x/review/SKILL.md",
      `\uFEFF---\r\nname: "review" # comment\r\ndescription: >-\r\n  Review code changes\r\n  and find defects.\r\ndisable-model-invocation: true\r\nallowed-tools: 'read grep'\r\nargument-hint: '<file:line>'\r\n---\r\n${body}`,
    );
    expect(yaml).toMatchObject({
      name: "review",
      description: "Review code changes and find defects.",
      disableModelInvocation: true,
      argumentHint: "<file:line>",
      body,
    });
    expect(
      parseSkill("/x/review/SKILL.md", "---\ndescription: |\n  First line\n  Second line\n---")
        .description,
    ).toBe("First line\nSecond line");
    expect(
      parseSkill("/x/review/SKILL.md", "---\ndescription:\nname: review\n---\nbody").description,
    ).toBe("");
    // 不支持的元数据与其它未知字段一样忽略,不会因数组写法挡住技能加载。
    expect(
      parseSkill("/x/review/SKILL.md", "---\nallowed-tools: [read, grep]\n---\nbody").body,
    ).toBe("body");
    for (const invalid of [
      "name: [unclosed",
      "name: review\nname: duplicate",
      "- not a mapping",
      "disable-model-invocation: yes",
    ])
      expect(() => parseSkill("/x/broken/SKILL.md", `---\n${invalid}\n---\nbody`)).toThrow(
        "Invalid skill /x/broken/SKILL.md",
      );
    expect(() => parseSkill("/x/broken/SKILL.md", "---\nname: review")).toThrow(
      "Unclosed YAML frontmatter",
    );

    const { home, proj } = project();
    const broken = join(home, "skills", "broken", "SKILL.md");
    mkdirSync(join(home, "skills", "broken"), { recursive: true });
    writeFileSync(broken, "---\nname: [unclosed\n---\nbody");
    const warnings: string[] = [];
    const deniedDirectory = join(dirname(home), ".claude", "skills");
    const deniedFile = join(proj, ".agents", "skills", "unreadable", "SKILL.md");
    const duplicate = join(proj, ".agents", "skills", "deploy", "SKILL.md");
    mkdirSync(deniedDirectory, { recursive: true });
    mkdirSync(dirname(deniedFile), { recursive: true });
    mkdirSync(dirname(duplicate), { recursive: true });
    writeFileSync(deniedFile, "This file cannot be inspected.");
    writeFileSync(duplicate, "This duplicate must not replace the user skill.");
    const stat = fs.statSync;
    const readDirectory = fs.readdirSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      if (args[0] === deniedFile) throw new Error("EACCES: skill file");
      return stat(...args);
    });
    const directorySpy = vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      if (args[0] === deniedDirectory) throw new Error("EACCES: skill directory");
      return readDirectory(...args);
    });
    let skills: ReturnType<typeof discoverSkills>;
    try {
      skills = discoverSkills(proj, {
        home,
        root: proj,
        onError: (error) => warnings.push(error.message),
      });
    } finally {
      statSpy.mockRestore();
      directorySpy.mockRestore();
    }
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain(broken);
    expect(warnings[0]).toContain("Invalid skill");
    expect(warnings.some((w) => w.includes(deniedDirectory) && w.includes("EACCES"))).toBe(true);
    expect(warnings.some((w) => w.includes(deniedFile) && w.includes("EACCES"))).toBe(true);
    expect(
      warnings.some((w) => w.includes(duplicate) && w.includes(join(home, "skills", "deploy"))),
    ).toBe(true);
    expect(skills.map((x) => [x.name, x.disableModelInvocation])).toEqual([
      ["deploy", false],
      ["secret", true],
    ]);
    const sec = skillsSection(skills, { mode: "auto" });
    expect(sec?.text).toContain("- deploy: Ship a release");
    expect(sec?.text).not.toContain("secret");
    expect(skillsSection(skills.filter((x) => x.disableModelInvocation))).toBeUndefined();
    const custom = join(proj, "custom  skills");
    mkdirSync(join(custom, "deploy"), { recursive: true });
    writeFileSync(join(custom, "deploy", "SKILL.md"), "Custom deployment instructions.");
    const sources = {
      "./custom  skills": "on",
      ...DEFAULT_SKILL_SOURCES,
      "user-clarook": "off",
      [custom]: "on",
    } as const;
    expect(skillDirectories(proj, { home, root: proj, sources })).toEqual([
      custom,
      deniedDirectory,
      join(proj, ".agents", "skills"),
      join(proj, ".claude", "skills"),
    ]);
    expect(skillSources(proj, { home, root: proj, sources })[1]).toMatchObject({
      name: "user-clarook",
      enabled: false,
      path: join(home, "skills"),
    });
    const customSkills = discoverSkills(proj, {
      home,
      root: proj,
      sources,
      onError: (error) => warnings.push(error.message),
    });
    expect(customSkills.find((skill) => skill.name === "deploy")?.body).toBe(
      "Custom deployment instructions.",
    );
    expect(discoverSkills(proj, { home, root: proj, sources: {} })).toEqual([]);
  });

  it("技能正文不作模板替换,带来源并完整保留用户要求,无参数时只加载正文", () => {
    const s = parseSkill("/x/deploy/SKILL.md", DEPLOY);
    const request = 'staging "extra arg"\n保留字面量 $1、$@ 和 $ARGUMENTS';
    const msg = expandSkill(s, request);
    expect(msg).toContain(
      'Skill "deploy" (/x/deploy/SKILL.md; relative paths are relative to /x/deploy)',
    );
    expect(msg).toContain(s.body);
    expect(msg.endsWith(`User request:\n${request}`)).toBe(true);
    const ordinary = {
      ...s,
      body: "Collect writing fragments. Ask for the output path if missing.",
    };
    expect(expandSkill(ordinary, "Save to fragments.md")).toContain(
      `${ordinary.body}\n\nUser request:\nSave to fragments.md`,
    );
    expect(expandSkill(s, "").endsWith(s.body)).toBe(true);
    expect(expandSkill(s, " \n ")).toBe(expandSkill(s, ""));
  });

  it("skill 工具:只列 model 可调的,返回正文;buildTools 在 load = tool 时装上", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    const tool = createSkillTool(skills);
    expect(tool.description).toContain("deploy");
    expect(tool.description).not.toContain("secret");
    const out = await tool.execute(
      { name: "deploy", args: "prod" },
      { signal: new AbortController().signal },
    );
    expect(out).toContain("Deploy to $1. Full args: $ARGUMENTS");
    expect(out).toContain("User request:\nprod");
    expect(buildTools().map((t) => t.name)).not.toContain("skill");
    expect(buildTools({ skills }).map((t) => t.name)).toContain("skill");
  });

  it("手动缺省,自动范围全选包含后来发现的技能,指定名称保持固定;配置与预设都能给", () => {
    const { home, proj } = project();
    const base: KernelConfig = {
      default: "m",
      providers: {},
      prompt: { skills: { mode: "manual" } },
    };
    const args = applyPreset(parseCommonArgs([]), base);
    expect(args.skillsMode).toBe("manual");
    const withList = systemPromptFor({ ...parseCommonArgs([]), skillsMode: "auto" }, proj, {
      home,
      root: proj,
    });
    const without = systemPromptFor(args, proj, { home, root: proj });
    expect(withList.system.some((s) => s.id === "skills")).toBe(true);
    expect(without.system.some((s) => s.id === "skills")).toBe(false);
    expect(
      systemText(systemPromptFor(parseCommonArgs([]), proj, { home, root: proj }).system),
    ).not.toContain("# Skills");
    const path = join(proj, ".agents", "skills", "review", "SKILL.md");
    mkdirSync(join(proj, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(path, "---\nname: review\ndescription: Review a patch\n---\nCheck the patch.");
    const refreshed = discoverSkills(proj, { home, root: proj });
    expect(automaticSkills(refreshed, { mode: "auto", include: "all" }).map((s) => s.name)).toEqual(
      ["deploy", "review"],
    );
    expect(
      automaticSkills(refreshed, { mode: "auto", include: ["deploy", "secret"] }).map(
        (s) => s.name,
      ),
    ).toEqual(["deploy"]);
    expect(automaticSkills(refreshed, { mode: "auto", include: [] })).toEqual([]);
    expect(automaticSkills(refreshed, { mode: "manual", include: "all", load: "tool" })).toEqual(
      [],
    );
    expect(skillsSection(refreshed, { mode: "auto", load: "tool" })).toBeUndefined();
    const preset: KernelConfig = {
      default: "m",
      providers: {},
      presets: { p: { prompt: { skills: { load: "tool" } } } },
    };
    expect(applyPreset(parseCommonArgs(["--preset", "p"]), preset).skillsLoad).toBe("tool");
    const sourceArgs = applyPreset(parseCommonArgs([]), {
      ...base,
      defaults: { prompt: { skills: { mode: "auto", sources: { "project-claude": "on" } } } },
    });
    const sourcePrompt = systemPromptFor(sourceArgs, proj, { home, root: proj });
    // secret 是 manual-only,源切换不能偷偷把它放进自动清单。
    expect(sourcePrompt.system.some((s) => s.id === "skills")).toBe(false);
    expect(() =>
      applyPreset(parseCommonArgs([]), {
        ...base,
        prompt: { skills: { list: "system" } },
      } as unknown as KernelConfig),
    ).toThrow("was removed");
  });
});

describe("界面里的技能", () => {
  it("技能设置只保存到以后会话,手改与关闭正文保留,已准备的 read/tool 仍可加载", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    skills.push({
      ...parseSkill("/x/review/SKILL.md", DEPLOY),
      name: "review",
      description: "Review a patch",
      body: "Check the patch.",
    });
    const currentSkills = {
      mode: "auto" as const,
      include: ["deploy"],
      load: "tool" as const,
      sources: DEFAULT_SKILL_SOURCES,
    };
    const catalog = skillsSection(skills, { mode: "auto", load: "read" });
    if (!catalog) throw new Error("missing test skill catalog");
    const system = [
      { id: "custom", name: "Custom", text: "My exact base instructions.", enabled: true },
      { id: "skills", ...catalog, enabled: true },
    ];
    const log = new EventLog();
    log.append({
      type: "session/start",
      at: "2026-10-25T00:00:00.000Z",
      model: "m",
      system,
    });
    let defaults: Preset = { prompt: { skills: { include: "all", sources: {} } } };
    const saved: [string, unknown][] = [];
    const term = new VirtualTerminal(100, 32);
    const requests: { system: string; tools: string[]; description: string }[] = [];
    const preparedTools = buildTools({
      cwd: proj,
      skills: automaticSkills(skills, currentSkills),
    });
    const app = createTuiApp({
      terminal: term,
      log,
      skills,
      tools: preparedTools,
      provider: {
        model: "m",
        async complete(messages, tools) {
          requests.push({
            system: String(messages.find((m) => m.role === "system")?.content),
            tools: tools.map((t) => t.name),
            description: tools.find((t) => t.name === "skill")?.description ?? "",
          });
          const last = messages.at(-1);
          if (
            last?.role === "user" &&
            typeof last.content === "string" &&
            last.content.startsWith("load prepared instructions with ")
          ) {
            const name = last.content.endsWith("read") ? "read" : "skill";
            return {
              text: "",
              toolCalls: [
                {
                  id: "load",
                  name,
                  args: name === "read" ? { path: skills[0]?.path } : { name: "deploy" },
                },
              ],
              stopReason: "tool",
            };
          }
          if (last?.role === "tool")
            expect(last.content).toContain("Deploy to $1. Full args: $ARGUMENTS");
          return { text: "ok", toolCalls: [], stopReason: "end" };
        },
      },
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: systemText(system),
      startupSettings: { prompt: { skills: currentSkills } },
      settings: {
        listModels: () => [],
        switchModel: () => {
          throw new Error("no");
        },
        setKey: () => {},
        setDefault: () => {},
        settingLayers: () => ({ defaults }),
        saveSetting: (key, value) => {
          saved.push([key, value]);
          defaults = setSetting(defaults, key, value);
        },
      },
      onExit: () => {},
      onSetupChange: (setup) => recordSessionSetup(log, setup),
    });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const menu = () => app.dialogLines().map(plain).join("\n");
    try {
      const editedInstructions = "My edited base instructions.\nKeep the literal phrase # Skills.";
      await app.command(`/edit 0 system custom ${editedInstructions}`);
      await app.command("/edit 0 system skills Keep my edited skill catalog.");
      changeContext(log, { type: "toggle-section", target: 0, section: "skills" });
      const edited = structuredClone(systemAt(log.events));
      const discovered = structuredClone(skills);
      const tools = app.setup().tools;
      // 本会话入口拒绝四项来源设置,不能追加设置或正文事件。
      for (const key of ["mode", "sources", "include", "load"]) {
        await app.command(`/settings prompt.skills.${key}`);
        const before = log.events.length;
        app.dialogInput("\r");
        await tick();
        expect(log.events).toHaveLength(before);
        expect(saved).toEqual([]);
        app.dialogInput("\x1b");
        app.dialogInput("\x1b");
      }
      await app.command("/settings prompt.skills.include");
      app.dialogInput("\t");
      app.dialogInput("\r");
      expect(menu()).toContain("All (including new skills)");
      app.dialogInput("\x1b[B");
      app.dialogInput("\r");
      await tick();
      expect(defaults.prompt?.skills?.include).toEqual(["review"]);
      app.dialogInput("\x1b[H");
      app.dialogInput("\r");
      await tick();
      expect(defaults.prompt?.skills?.include).toBe("all");
      app.dialogInput("\x1b");
      app.dialogInput("\x1b");
      app.dialogInput("\x1b");
      // 来源的增删只改保存配置,不重扫当前目录,也不删除磁盘文件。
      const custom = join(proj, "custom  skills");
      mkdirSync(join(custom, "review"), { recursive: true });
      writeFileSync(
        join(custom, "review", "SKILL.md"),
        "---\nname: review\ndescription: Custom review\n---\nCheck custom instructions.",
      );
      await app.command("/settings prompt.skills.sources");
      app.dialogInput("\t");
      app.dialogInput("\r");
      app.dialogInput("\x1b[F");
      app.dialogInput("\r");
      app.dialogInput(custom);
      app.dialogInput("\r");
      await tick();
      expect(defaults.prompt?.skills?.sources).toEqual({ [custom]: "on" });
      app.dialogInput("\r");
      await tick();
      expect(defaults.prompt?.skills?.sources).toEqual({ [custom]: "off" });
      app.dialogInput("\r");
      await tick();
      expect(defaults.prompt?.skills?.sources).toEqual({ [custom]: "on" });
      app.dialogInput("\x1b[3~");
      await tick();
      expect(defaults.prompt?.skills?.sources).toEqual({});
      expect(fs.existsSync(join(custom, "review", "SKILL.md"))).toBe(true);
      app.dialogInput("\x1b");
      app.dialogInput("\x1b");
      app.dialogInput("\x1b");
      const beforeTyped = log.events.length;
      for (const [key, value] of [
        ["mode", "manual"],
        ["include", "review"],
        ["load", "read"],
        ["sources", "{}"],
      ])
        await app.command(`/settings prompt.skills.${key} ${value}`);
      expect(log.events).toHaveLength(beforeTyped);
      expect(saved.slice(-4)).toEqual([
        ["prompt.skills.mode", "manual"],
        ["prompt.skills.include", ["review"]],
        ["prompt.skills.load", "read"],
        ["prompt.skills.sources", {}],
      ]);
      expect(systemAt(log.events)).toEqual(edited);
      expect(skills).toEqual(discovered);
      expect(app.setup().tools).toEqual(tools);
      expect(app.setup().values.prompt?.skills).toEqual(currentSkills);
      expect(restoreSessionSetup(log.events, defaults).setup.values.prompt?.skills).toEqual(
        currentSkills,
      );
      for (const name of ["read", "skill"]) {
        await app.submit(`load prepared instructions with ${name}`);
        expect(
          log.events.some(
            (event) => event.type === "tool/result" && event.name === name && !event.isError,
          ),
        ).toBe(true);
      }
      expect(requests.at(-1)?.system).toBe(editedInstructions);
      expect(requests.at(-1)?.tools).toContain("skill");
      expect(requests.at(-1)?.description).toContain("deploy");
      expect(requests.at(-1)?.description).not.toContain("review");
      await app.command("/deploy staging");
      expect(JSON.stringify(deriveMessages(log.events))).toContain("User request:\\nstaging");
      expect(systemAt(log.events)).toEqual(edited);
    } finally {
      app.stop();
    }
  });
  it("技能正文及排队要求进入实际请求,工具统一审批且保留明确的本会话放行", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    let bashRuns = 0;
    let otherRuns = 0;
    const bash = defineTool({
      name: "bash",
      description: "",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        bashRuns++;
        return "ran";
      },
    });
    const other = defineTool({
      name: "other",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        otherRuns++;
        return "x";
      },
    });
    let step = 0;
    const provider: Provider = {
      model: "m",
      async complete(messages) {
        step += 1;
        if (step === 1) {
          // 第一步:技能正文与用户要求都真实投递,而非仅显示在界面里。
          const last = messages.at(-1);
          expect(last?.role === "user" && last.content).toContain(
            "Deploy to $1. Full args: $ARGUMENTS",
          );
          expect(last?.role === "user" && last.content).toContain("User request:\nstaging");
          return {
            text: "",
            toolCalls: [
              { id: "1", name: "bash", args: { command: "x" } },
              { id: "2", name: "other", args: {} },
            ],
            stopReason: "tool",
          };
        }
        if (step === 2) {
          expect(messages.at(-1)?.content).toContain("User request:\nproduction");
          expect(messages.filter((m) => m.role === "tool")).toMatchObject([
            { name: "bash", isError: true },
            { name: "other", isError: false },
          ]);
          return {
            text: "",
            toolCalls: [
              { id: "3", name: "bash", args: { command: "y" } },
              { id: "4", name: "other", args: {} },
            ],
            stopReason: "tool",
          };
        }
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const log = new EventLog();
    const term = new VirtualTerminal(110, 30);
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [bash, other],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      approve: "ask",
      skills,
      onExit: () => {},
    });
    const run = app.command("/deploy staging");
    try {
      await vi.waitFor(() => expect(plain(app.approvalLines().join("\n"))).toContain("bash"));
      expect(bashRuns).toBe(0);
      await app.command("/deploy production");
      expect(app.agent.queued).toBe(1);
      expect(plain(app.approvalLines().join("\n"))).toContain("bash");
      term.feed("4"); // 拒绝本次bash;技能声明不绕过审批。
      term.feed("\r");
      await vi.waitFor(() => expect(plain(app.approvalLines().join("\n"))).toContain("other"));
      term.feed("2"); // 明确的本会话放行仍在后续调用生效。
      term.feed("\r");
      await vi.waitFor(() => expect(plain(app.approvalLines().join("\n"))).toContain("bash"));
      expect(bashRuns).toBe(0);
      term.feed("1");
      term.feed("\r");
      await run;
      expect(bashRuns).toBe(1);
      expect(otherRuns).toBe(2);
      expect(app.agent.queued).toBe(0);
      expect(log.events.filter((e) => e.type === "tool/result")).toMatchObject([
        { name: "bash", isError: true },
        { name: "other", isError: false },
        { name: "bash", isError: false, content: "ran" },
        { name: "other", isError: false },
      ]);
      const user = log.events.find((e) => e.type === "user/message");
      expect(user?.type === "user/message" && user.text).toContain('Skill "deploy"');
      expect(user?.type === "user/message" && user.text).toContain("User request:\nstaging");
      expect(plain(app.lines(110).join("\n"))).toContain("skill /deploy");

      await app.command("/inspect skills");
      const doc = plain(app.lines(110).join("\n"));
      expect(doc).toContain("/deploy");
      expect(doc).toContain("/secret");
      expect(doc).toContain("user-only");
    } finally {
      app.agent.interrupt();
      await run;
      app.stop();
    }
  });
});
