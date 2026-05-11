// Filesystem-based introspection of the mounted ~/.claude directory.
//
// The Claude Agent SDK does not expose a "what did you discover?" API, so this
// module performs a best-effort walk of the filesystem locations the SDK reads
// when settingSources includes "user" and "project":
//
//   ~/.claude/skills/<name>/SKILL.md                    → user skills
//   ~/.claude/agents/<name>.md                          → user subagents
//   ~/.claude/commands/<name>.md                        → user slash commands
//   ~/.claude/plugins/<repo>/<plugin>/skills/.../SKILL.md → plugin skills
//   <cwd>/.claude/skills/<name>/SKILL.md                → project skills
//   ~/.claude/settings.json                              → enabled plugins, hooks
//
// The walk has a fixed depth limit so a deeply nested or pathological mount
// cannot blow up the process. All filesystem errors are caught — the endpoint
// must never throw because of a missing or unreadable subdirectory; the goal
// is observability, not correctness enforcement.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_RECURSION_DEPTH = 6;

export type SkillSource = "user" | "plugin" | "project";

export interface SkillEntry {
  name: string;
  path: string;
  description: string | null;
  source: SkillSource;
}

export interface NamedEntry {
  name: string;
  path: string;
  source: SkillSource;
}

export interface PluginEntry {
  name: string;
  path: string;
  skillCount: number;
  agentCount: number;
  commandCount: number;
}

export interface IntrospectionResult {
  claudeDir: string;
  exists: boolean;
  settingSources: readonly string[];
  settings: {
    path: string;
    exists: boolean;
    topLevelKeys: string[];
  };
  skills: SkillEntry[];
  agents: NamedEntry[];
  commands: NamedEntry[];
  plugins: PluginEntry[];
  warnings: string[];
}

const safeReaddir = async (p: string) => {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
};

const safeStat = async (p: string) => {
  try { return await stat(p); } catch { return null; }
};

const safeReadFile = async (p: string): Promise<string | null> => {
  try { return await readFile(p, "utf8"); } catch { return null; }
};

// Extract a `description:` line from YAML frontmatter at the top of a markdown
// file. Returns null if no frontmatter is present or the field is missing.
// Keeps the description trimmed to one line so the /skills response stays
// compact.
const extractDescription = (md: string): string | null => {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = fm?.[1];
  if (!frontmatter) return null;
  const dm = frontmatter.match(/^description:\s*(.+)$/m);
  const desc = dm?.[1];
  return desc ? desc.trim().replace(/^["']|["']$/g, "") : null;
};

// Walk a directory looking for SKILL.md files. Each SKILL.md identifies its
// containing directory as a skill. Recurses through subdirectories so plugin
// layouts like plugins/<repo>/<plugin>/skills/<name>/SKILL.md are picked up.
const collectSkills = async (
  root: string,
  source: SkillSource,
  depth = 0,
): Promise<SkillEntry[]> => {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const entries = await safeReaddir(root);
  const out: SkillEntry[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = join(root, ent.name);
    const skillMd = join(sub, "SKILL.md");
    const st = await safeStat(skillMd);
    if (st?.isFile()) {
      const text = await safeReadFile(skillMd);
      out.push({
        name: ent.name,
        path: sub,
        description: text ? extractDescription(text) : null,
        source,
      });
    }
    const nested = await collectSkills(sub, source, depth + 1);
    out.push(...nested);
  }
  return out;
};

// List .md files under a directory (non-recursive). Used for agents/ and
// commands/ which are flat by convention.
const listMarkdownFiles = async (
  root: string,
  source: SkillSource,
): Promise<NamedEntry[]> => {
  const entries = await safeReaddir(root);
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .map(e => ({
      name: e.name.replace(/\.md$/, ""),
      path: join(root, e.name),
      source,
    }));
};

// Parse settings.json and return its top-level keys. Used only as a debugging
// breadcrumb — we deliberately avoid trying to interpret the contents because
// the SDK is the authoritative reader.
const inspectSettings = async (path: string): Promise<{ exists: boolean; topLevelKeys: string[] }> => {
  const text = await safeReadFile(path);
  if (text === null) return { exists: false, topLevelKeys: [] };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { exists: true, topLevelKeys: Object.keys(parsed).sort() };
  } catch {
    return { exists: true, topLevelKeys: [] };
  }
};

// Aggregate skill/agent/command counts per top-level plugin directory under
// ~/.claude/plugins/. The directory shape is typically
//   plugins/<repo-or-marketplace>/<plugin-name>/...
// so we summarise at the first level (the repo/marketplace) — that maps
// one-to-one with how the user installed each plugin source.
const enumeratePlugins = async (pluginsRoot: string): Promise<PluginEntry[]> => {
  const entries = await safeReaddir(pluginsRoot);
  const out: PluginEntry[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const ppath = join(pluginsRoot, ent.name);
    const [skills, agents, commands] = await Promise.all([
      collectSkills(ppath, "plugin"),
      collectMarkdownRecursive(join(ppath), "agents"),
      collectMarkdownRecursive(join(ppath), "commands"),
    ]);
    out.push({
      name: ent.name,
      path: ppath,
      skillCount: skills.length,
      agentCount: agents,
      commandCount: commands,
    });
  }
  return out;
};

// Recursively count .md files inside subdirectories matching `subdirName`
// anywhere under `root`. Used to count plugin-provided agents and commands.
const collectMarkdownRecursive = async (
  root: string,
  subdirName: string,
  depth = 0,
): Promise<number> => {
  if (depth > MAX_RECURSION_DEPTH) return 0;
  const entries = await safeReaddir(root);
  let total = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = join(root, ent.name);
    if (ent.name === subdirName) {
      const mds = await safeReaddir(sub);
      total += mds.filter(e => e.isFile() && e.name.endsWith(".md")).length;
    }
    total += await collectMarkdownRecursive(sub, subdirName, depth + 1);
  }
  return total;
};

export interface IntrospectOptions {
  /** Host directory mounted at ~/.claude inside the container. */
  claudeDir: string;
  /** The current working directory whose .claude/ acts as the "project" layer. */
  projectDir?: string;
  /** The settingSources value handed to the SDK — echoed in the response. */
  settingSources: readonly string[];
}

export const introspectClaudeMount = async (opts: IntrospectOptions): Promise<IntrospectionResult> => {
  const { claudeDir, projectDir, settingSources } = opts;
  const warnings: string[] = [];

  const st = await safeStat(claudeDir);
  const exists = st?.isDirectory() === true;
  if (!exists) {
    warnings.push(
      `Claude directory '${claudeDir}' does not exist or is not a directory. ` +
      `If you expected ~/.claude to be available, ensure run-docker.sh / run-apple-container.sh ` +
      `was invoked with CLAUDE_DIR pointing at your host ~/.claude folder.`,
    );
    return {
      claudeDir,
      exists: false,
      settingSources,
      settings: { path: join(claudeDir, "settings.json"), exists: false, topLevelKeys: [] },
      skills: [],
      agents: [],
      commands: [],
      plugins: [],
      warnings,
    };
  }

  const settingsPath = join(claudeDir, "settings.json");
  const [
    settings,
    userSkills,
    pluginSkills,
    userAgents,
    userCommands,
    plugins,
  ] = await Promise.all([
    inspectSettings(settingsPath),
    collectSkills(join(claudeDir, "skills"), "user"),
    collectSkills(join(claudeDir, "plugins"), "plugin"),
    listMarkdownFiles(join(claudeDir, "agents"), "user"),
    listMarkdownFiles(join(claudeDir, "commands"), "user"),
    enumeratePlugins(join(claudeDir, "plugins")),
  ]);

  let projectSkills: SkillEntry[] = [];
  let projectAgents: NamedEntry[] = [];
  let projectCommands: NamedEntry[] = [];
  if (projectDir !== undefined) {
    const projectClaude = join(projectDir, ".claude");
    if ((await safeStat(projectClaude))?.isDirectory()) {
      [projectSkills, projectAgents, projectCommands] = await Promise.all([
        collectSkills(join(projectClaude, "skills"), "project"),
        listMarkdownFiles(join(projectClaude, "agents"), "project"),
        listMarkdownFiles(join(projectClaude, "commands"), "project"),
      ]);
    }
  }

  if (!settings.exists) {
    warnings.push(
      `${settingsPath} not found. Without it the SDK has no plugin enablement ` +
      `record, so plugin-provided skills/agents/commands will be invisible even ` +
      `if installed under ~/.claude/plugins/.`,
    );
  }

  return {
    claudeDir,
    exists: true,
    settingSources,
    settings: {
      path: settingsPath,
      exists: settings.exists,
      topLevelKeys: settings.topLevelKeys,
    },
    skills: [...userSkills, ...pluginSkills, ...projectSkills].sort((a, b) => a.name.localeCompare(b.name)),
    agents: [...userAgents, ...projectAgents].sort((a, b) => a.name.localeCompare(b.name)),
    commands: [...userCommands, ...projectCommands].sort((a, b) => a.name.localeCompare(b.name)),
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
};
