// src/index.ts
import { statSync as statSync6 } from "node:fs";
import { join as join7, resolve as resolve2 } from "node:path";

// src/compat.ts
import { randomUUID } from "node:crypto";
var SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isSkillName(name2) {
  return SKILL_NAME.test(name2);
}
function createUserMessage(input) {
  return {
    ...input,
    role: "user",
    id: randomUUID()
  };
}

// src/config.ts
import { isAbsolute } from "node:path";
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  enabled: z.boolean().default(true),
  claudeDir: z.string().default(".claude"),
  adaptDir: z.string().default(".dsn"),
  loadRules: z.boolean().default(true),
  rulesMaxBytes: z.number().default(131072),
  ruleMaxSourceBytes: z.number().default(65536),
  ruleImportMaxDepth: z.number().default(8),
  defaultAlwaysApply: z.boolean().default(true),
  loadSkills: z.boolean().default(true),
  loadAgents: z.boolean().default(true),
  loadHooks: z.boolean().default(true),
  hookTimeoutMs: z.number().default(6e5),
  stderrSummaryMaxChars: z.number().default(500)
});
var DEFAULT_CONFIG = {
  enabled: true,
  claudeDir: ".claude",
  adaptDir: ".dsn",
  loadRules: true,
  rulesMaxBytes: 131072,
  ruleMaxSourceBytes: 65536,
  ruleImportMaxDepth: 8,
  defaultAlwaysApply: true,
  loadSkills: true,
  loadAgents: true,
  loadHooks: true,
  hookTimeoutMs: 6e5,
  stderrSummaryMaxChars: 500
};
function resolveConfig(raw) {
  const resolved = {
    ...DEFAULT_CONFIG,
    ...raw ?? {}
  };
  assertDirectoryName("claudeDir", resolved.claudeDir);
  assertDirectoryName("adaptDir", resolved.adaptDir);
  for (const key of ["rulesMaxBytes", "ruleMaxSourceBytes", "ruleImportMaxDepth", "hookTimeoutMs", "stderrSummaryMaxChars"]) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1) {
      throw new Error(`dsh-claude-in: ${key} must be a positive safe integer`);
    }
  }
  return resolved;
}
function assertDirectoryName(key, value) {
  if (value === "" || value === "." || value === ".." || isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    throw new Error(`dsh-claude-in: ${key} must be one relative directory name`);
  }
}

// src/discovery.ts
import { existsSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var CACHE_TTL_MS = 3e3;
var cache = /* @__PURE__ */ new Map();
function findClaudeRoot(cwd, claudeDirName = ".claude") {
  const key = tryRealpath(cwd) ?? cwd;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) return hit.root;
  const claude = join(cwd, claudeDirName);
  let root;
  try {
    if (existsSync(claude) && statSync(claude).isDirectory()) {
      root = {
        path: realpathSync(cwd),
        claudeDir: claude,
        mtimeMs: statSync(claude).mtimeMs
      };
    }
  } catch {
  }
  cache.set(key, { root, checkedAt: Date.now(), mtimeMs: root?.mtimeMs ?? 0 });
  return root;
}
function findUserClaudeRoot(home = homedir(), claudeDirName = ".claude") {
  const claude = join(home, claudeDirName);
  try {
    if (existsSync(claude) && statSync(claude).isDirectory()) {
      return {
        path: realpathSync(home),
        claudeDir: claude,
        mtimeMs: statSync(claude).mtimeMs
      };
    }
  } catch {
  }
  return void 0;
}
function tryRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return void 0;
  }
}

// src/rules.ts
import { readFileSync, readdirSync, statSync as statSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2, relative, resolve, dirname } from "node:path";
import { homedir as homedir2 } from "node:os";

// src/frontmatter.ts
import { parse as parseYaml } from "yaml";
function splitFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { meta: void 0, body: content };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return { meta: void 0, body: content };
  const yamlText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  if (yamlText.trim() === "") return { meta: {}, body };
  try {
    const parsed = parseYaml(yamlText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { meta: parsed, body };
    }
    return { meta: {}, body };
  } catch (error) {
    return { meta: void 0, body, metaError: errorMessage(error) };
  }
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function stringList(meta, key) {
  const value = meta?.[key];
  if (value === void 0 || value === null) return [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? [] : [trimmed];
  }
  return [];
}
function toolList(meta, key) {
  const value = meta?.[key];
  if (value === void 0 || value === null) return [];
  const raw = Array.isArray(value) ? value.filter((item) => typeof item === "string") : typeof value === "string" ? [value] : [];
  return raw.flatMap((item) => item.split(",")).map((item) => item.trim()).filter((item) => item !== "");
}
function optionalString(meta, key) {
  const value = meta?.[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? void 0 : trimmed;
  }
  return void 0;
}
function optionalBoolean(meta, key) {
  const value = meta?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return void 0;
}

// src/glob.ts
function globToRegExp(pattern, asFragment = false) {
  const source = normalize(pattern);
  const anchored = source.includes("/");
  let re = "";
  let i = 0;
  const n = source.length;
  const parseSegment = () => {
    while (i < n && source[i] !== "/") {
      const ch = source[i];
      if (ch === "*") {
        if (source[i + 1] === "*") {
          i += 2;
          if (source[i] === "/") {
            i += 1;
            re += "(?:[^/]*/)*";
          } else {
            re += "[^/]*";
          }
        } else {
          i += 1;
          re += "[^/]*";
        }
        continue;
      }
      if (ch === "?") {
        i += 1;
        re += "[^/]";
        continue;
      }
      if (ch === "[") {
        const close = source.indexOf("]", i + 1);
        if (close === -1) {
          re += "\\[";
          i += 1;
          continue;
        }
        let cls = source.slice(i + 1, close);
        i = close + 1;
        let negate = false;
        if (cls.startsWith("!") || cls.startsWith("^")) {
          negate = true;
          cls = cls.slice(1);
        }
        cls = cls.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
        re += `[${negate ? "^" : ""}${cls}]`;
        continue;
      }
      if (ch === "{") {
        const close = findBraceEnd(source, i);
        if (close === -1) {
          re += "\\{";
          i += 1;
          continue;
        }
        const parts = splitAlternatives(source.slice(i + 1, close));
        if (parts.length > 1) {
          re += `(?:${parts.map((part) => globToRegExp(part, true).source).join("|")})`;
          i = close + 1;
        } else {
          re += "\\{";
          i += 1;
        }
        continue;
      }
      re += escapeRegex(ch);
      i += 1;
    }
  };
  if (anchored) {
    if (source.startsWith("**/")) {
      re += "(?:.*/)?";
      i = 3;
    }
    for (; ; ) {
      parseSegment();
      if (i >= n) break;
      re += "/";
      i += 1;
    }
    if (re.endsWith("/[^/]*") && patternTrimmed(source).endsWith("/**")) {
      re = re.slice(0, -"/[^/]*".length) + "(?:/.*)?";
    }
  } else {
    parseSegment();
  }
  if (asFragment) return new RegExp(re);
  return anchored ? new RegExp(`^${re}$`) : new RegExp(`(^|.*/)${re}$`);
}
function normalize(pattern) {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function patternTrimmed(source) {
  return source.replace(/\/+$/, "");
}
function findBraceEnd(source, open) {
  for (let j = open + 1; j < source.length; j += 1) {
    if (source[j] === "}") return j;
    if (source[j] === "{") return -1;
  }
  return -1;
}
function splitAlternatives(inner) {
  const parts = [];
  let inClass = false;
  let current = "";
  for (const ch of inner) {
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "," && !inClass) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}
function escapeRegex(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}
function globMatches(globs, relPath) {
  const posix = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const pattern of globs) {
    let regex;
    try {
      regex = globToRegExp(pattern);
    } catch {
      continue;
    }
    if (regex.test(posix)) return true;
  }
  return false;
}

// src/rules.ts
var MAX_DEPTH = 12;
function discoverRules(claudeRoot, options, level = "project") {
  const rulesDir = join2(claudeRoot, "rules");
  const files = [];
  walkMd(rulesDir, rulesDir, files, 0, options.warn);
  const rules = [];
  for (const file of files) {
    const rule = loadRule(file, rulesDir, options, level);
    if (rule) rules.push(rule);
  }
  const always = [];
  const scoped = [];
  const requestable = [];
  for (const rule of rules) {
    if (rule.alwaysApply) always.push(rule);
    else if (rule.globs.length > 0) scoped.push(rule);
    else requestable.push(rule);
  }
  return { rules, always, scoped, requestable };
}
function walkMd(dir, root, out, depth, warn) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    warn?.(`dsh-claude-in: cannot scan rules dir ${dir}: ${errorMessage(error)}`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = join2(dir, entry.name);
    let stat;
    try {
      stat = statSync2(abs);
    } catch {
      continue;
    }
    if (entry.isDirectory() || stat.isDirectory()) {
      walkMd(abs, root, out, depth + 1, warn);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
}
function loadRule(absPath, rulesDir, options, level) {
  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (error) {
    options.warn?.(`dsh-claude-in: cannot read rule ${absPath}: ${errorMessage(error)}`);
    return void 0;
  }
  const rawBytes = Buffer.byteLength(content, "utf8");
  if (rawBytes > options.maxSourceBytes) {
    content = content.slice(0, options.maxSourceBytes);
  }
  const relPath = relative(rulesDir, absPath).replace(/\\/g, "/");
  const name2 = relPath.replace(/\.md$/, "");
  const { meta, body, metaError } = splitFrontmatter(content);
  const globs = [...stringList(meta, "paths"), ...stringList(meta, "globs")];
  const alwaysMeta = optionalBoolean(meta, "alwaysApply");
  const enabled = optionalBoolean(meta, "enabled") ?? true;
  const alwaysApply = enabled && (alwaysMeta ?? (globs.length === 0 ? options.defaultAlwaysApply : false));
  const expanded = expandImports(body, dirname(absPath), options, /* @__PURE__ */ new Set(), 0);
  return {
    absPath,
    level,
    relPath,
    name: name2,
    description: optionalString(meta, "description"),
    alwaysApply,
    globs,
    enabled,
    content: expanded.content,
    rawBytes,
    metaError,
    allowedTools: toolList(meta, "allowed-tools")
  };
}
function expandImports(text, baseDir, options, visited, depth) {
  if (depth > options.importMaxDepth) return { content: text, warnings: ["import depth exceeded"] };
  const lines = text.split(/\r?\n/);
  const out = [];
  const warnings = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@") || trimmed.length < 2) {
      out.push(line);
      continue;
    }
    const target = trimmed.slice(1).trim();
    const resolved = resolveImportTarget(target, baseDir);
    if (resolved === void 0) {
      out.push(line);
      warnings.push(`cannot resolve import "${target}" from ${baseDir}`);
      continue;
    }
    if (visited.has(resolved)) {
      warnings.push(`import cycle at ${resolved}`);
      continue;
    }
    visited.add(resolved);
    try {
      const stat = statSync2(resolved);
      if (stat.isDirectory()) {
        const files = [];
        walkMd(resolved, resolved, files, 0);
        for (const file of files) {
          const imported = expandImports(readFileSync(file, "utf8"), dirname(file), options, visited, depth + 1);
          out.push(imported.content);
          warnings.push(...imported.warnings);
        }
      } else if (stat.isFile()) {
        const imported = expandImports(readFileSync(resolved, "utf8"), dirname(resolved), options, visited, depth + 1);
        out.push(imported.content);
        warnings.push(...imported.warnings);
      }
    } catch (error) {
      warnings.push(`cannot import ${resolved}: ${errorMessage(error)}`);
    }
    visited.delete(resolved);
  }
  return { content: out.join("\n"), warnings };
}
function resolveImportTarget(target, baseDir) {
  let path = target;
  if (path.startsWith("~/")) path = join2(homedir2(), path.slice(2));
  else if (path.startsWith("~")) return void 0;
  const resolved = resolve(baseDir, path);
  return existsSync2(resolved) ? resolved : void 0;
}
function renderBaseline(discovery, claudeRoot, maxBytes) {
  const parts = [];
  parts.push("<claude_workspace_rules>");
  parts.push("These rules are loaded from the project .claude/rules and the user ~/.claude/rules (level=project | level=user). Follow the instructions in each subsection.");
  if (discovery.always.length > 0) {
    parts.push("<always_applied_workspace_rules>");
    for (const rule of discovery.always) parts.push(renderRule(rule, "always"));
    parts.push("</always_applied_workspace_rules>");
  }
  if (discovery.requestable.length > 0) {
    parts.push("<agent_requestable_workspace_rules>");
    parts.push("The rules below are not loaded by default. Read the rule file with the read tool when its description matches the task.");
    for (const rule of discovery.requestable) {
      parts.push(`<rule name="${escapeAttr(rule.name)}"${rule.description ? ` description="${escapeAttr(rule.description)}"` : ""} path="${escapeAttr(rule.relPath)}"/>`);
    }
    parts.push("</agent_requestable_workspace_rules>");
  }
  parts.push("</claude_workspace_rules>");
  return budgetJoin(parts, maxBytes);
}
function renderTouched(scoped, claudeRoot, relFile, maxBytes) {
  const parts = [];
  parts.push("<claude_workspace_rules>");
  parts.push(`Path-scoped rules for ${relFile} (from ${claudeRoot}/.claude/rules):`);
  for (const rule of scoped) {
    if (rule.globs.length === 0 || !globMatches(rule.globs, relFile)) continue;
    parts.push(renderRule(rule, "path-scoped"));
  }
  parts.push("</claude_workspace_rules>");
  return budgetJoin(parts, maxBytes);
}
function matchingScoped(scoped, relFile) {
  return scoped.filter((rule) => rule.globs.length > 0 && globMatches(rule.globs, relFile));
}
function renderRule(rule, kind) {
  const header = [
    `name="${escapeAttr(rule.name)}"`,
    `level="${rule.level}"`,
    rule.description ? `description="${escapeAttr(rule.description)}"` : "",
    rule.allowedTools && rule.allowedTools.length > 0 ? `allowed-tools="${escapeAttr(rule.allowedTools.join(", "))}"` : "",
    kind === "path-scoped" ? `path="${escapeAttr(rule.relPath)}"` : ""
  ].filter(Boolean).join(" ");
  return `<rule ${header}>
${rule.content.trim()}
</rule>`;
}
function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ");
}
function budgetJoin(parts, maxBytes) {
  let result = "";
  for (const part of parts) {
    if (result === "") {
      result = truncateUtf8(part, maxBytes);
      continue;
    }
    const sep = "\n\n";
    const remaining = maxBytes - Buffer.byteLength(result + sep, "utf8");
    if (remaining <= 0) break;
    const fitted = truncateUtf8(part, remaining);
    if (fitted === "") break;
    result += sep + fitted;
  }
  return result;
}
function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = text.endsWith("</rule>") ? "</rule>" : "";
  const body = suffix === "" ? text : text.slice(0, -suffix.length);
  const note = `
(truncated to fit context budget)
${suffix}`;
  const available = maxBytes - Buffer.byteLength(note, "utf8");
  if (available <= 0) return "";
  let out = "";
  for (const ch of body) {
    const next = out + ch;
    if (Buffer.byteLength(next, "utf8") > available) break;
    out = next;
  }
  return out + note;
}
function relPathOf(root, absPath) {
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith("/")) return void 0;
  return rel.replace(/\\/g, "/");
}

// src/skills.ts
import { readFileSync as readFileSync4, readdirSync as readdirSync3, statSync as statSync4 } from "node:fs";
import { join as join5, relative as relative3 } from "node:path";

// src/adapt.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { parse as parseYaml2 } from "yaml";
function loadAdaptConfig(adaptDir, warn) {
  const file = join3(adaptDir, "dsh-claude-in.yml");
  if (!existsSync3(file)) return void 0;
  let raw;
  try {
    raw = parseYaml2(readFileSync2(file, "utf8"));
  } catch (error) {
    warn?.(`dsh-claude-in: cannot parse adapt config ${file}: ${errorMessage(error)}`);
    return void 0;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warn?.(`dsh-claude-in: adapt config ${file} must be a YAML object`);
    return void 0;
  }
  return raw;
}
function mergeAdaptConfig(global, adapt) {
  if (adapt === void 0) return global;
  const next = { ...global };
  for (const key of ["enabled", "loadClaudeMd", "loadRules", "loadSkills", "loadAgents", "loadHooks"]) {
    if (typeof adapt[key] === "boolean") next[key] = adapt[key];
  }
  return next;
}
function applyHookCommandOverrides(hookConfig, adapt) {
  if (adapt?.hooks === void 0) return hookConfig;
  const events = {};
  for (const [event, groups] of Object.entries(hookConfig.events)) {
    events[event] = overrideGroups(groups, adapt.hooks[event] ?? []);
  }
  return { ...hookConfig, events };
}
function overrideGroups(groups, overrides) {
  if (overrides.length === 0) return groups;
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((hook) => {
      const hit = overrides.find((o) => o.from === hook.command);
      return hit ? { ...hook, command: hit.to } : hook;
    })
  }));
}

// src/agents.ts
import { readFileSync as readFileSync3, readdirSync as readdirSync2, statSync as statSync3 } from "node:fs";
import { join as join4, relative as relative2 } from "node:path";
function discoverAgents(claudeDir, warn, level = "project") {
  const root = join4(claudeDir, "agents");
  const files = [];
  walkAgentFiles(root, files, 0);
  const agents = [];
  const seen = /* @__PURE__ */ new Set();
  for (const file of files) {
    const agent = loadAgent(file, root, warn, level);
    if (!agent) continue;
    if (seen.has(agent.name)) {
      warn?.(`dsh-claude-in: duplicate agent name "${agent.name}" \u2014 keeping the first`);
      continue;
    }
    seen.add(agent.name);
    agents.push(agent);
  }
  return agents;
}
function mergeAgents(project, user) {
  const result = [...project];
  const known = new Set(project.map((a) => a.name));
  for (const agent of user) {
    if (known.has(agent.name)) continue;
    known.add(agent.name);
    result.push(agent);
  }
  return result;
}
function walkAgentFiles(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync2(dir);
  } catch {
    return;
  }
  entries.sort();
  for (const name2 of entries) {
    if (name2.startsWith(".")) continue;
    const abs = join4(dir, name2);
    let stat;
    try {
      stat = statSync3(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkAgentFiles(abs, out, depth + 1);
    else if (stat.isFile() && name2.endsWith(".md")) out.push(abs);
  }
}
function loadAgent(file, root, warn, level = "project") {
  let content;
  try {
    content = readFileSync3(file, "utf8");
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read agent ${file}: ${errorMessage(error)}`);
    return void 0;
  }
  const rel = relative2(root, file).replace(/\\/g, "/");
  const fallbackName = rel.replace(/\.md$/, "");
  const { meta, body, metaError } = splitFrontmatter(content);
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`);
  const name2 = optionalString(meta, "name") ?? fallbackName;
  const description = optionalString(meta, "description") ?? "";
  return {
    name: name2,
    level,
    description,
    model: optionalString(meta, "model"),
    tools: toolList(meta, "tools"),
    absPath: file,
    relPath: rel,
    body,
    meta: meta ?? {}
  };
}
function renderAgentCatalog(agents, claudeRoot) {
  if (agents.length === 0) return "";
  const lines = [
    "<claude_agents>",
    `These agents are defined in the project .claude and user ~/.claude (level=project | level=user; project wins on name conflicts) and may be delegated to.`,
    "To use one: call the skill tool with the listed skill name to load the full agent definition, then delegate via the subagent tool, prefixing the child prompt with that definition and instructing the child to act as the named agent."
  ];
  for (const agent of agents) {
    const attrs = [
      `name="${escapeAttr2(agent.name)}"`,
      `level="${agent.level}"`,
      agent.description !== "" ? `description="${escapeAttr2(agent.description)}"` : "",
      agent.model !== void 0 ? `model="${escapeAttr2(agent.model)}"` : "",
      agent.tools.length > 0 ? `tools="${escapeAttr2(agent.tools.join(", "))}"` : "",
      `skill="claude-agent-${agent.name.split("/").map(kebab).join("-")}"`
    ].filter(Boolean).join(" ");
    lines.push(`<agent ${attrs}/>`);
  }
  lines.push("</claude_agents>");
  return lines.join("\n");
}
function renderAgentDefinition(name2, description, meta, body) {
  const model = optionalString(meta, "model");
  const tools = toolList(meta, "tools");
  const lines = ["<agent_definition>", `name: ${name2}`];
  if (description !== "") lines.push(`description: ${description}`);
  if (model !== void 0) lines.push(`model: ${model}`);
  if (tools.length > 0) lines.push(`tools: ${tools.join(", ")}`);
  lines.push("", "<system_prompt>", body.trim(), "</system_prompt>", "</agent_definition>");
  return lines.join("\n");
}
function escapeAttr2(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ");
}
function kebab(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// src/skills.ts
var PROVIDER_NAME = "dsh-claude-in";
var DSN_SKILLS_RANK = 240;
var USER_SKILLS_RANK = 250;
var CLAUDE_SKILLS_RANK = 450;
var CLAUDE_AGENTS_RANK = 260;
var USER_AGENTS_RANK = 460;
function discoverClaudeSkills(claudeDir, enabled, warn, adaptSkillsDir, userClaudeDir) {
  const found = [];
  if (claudeDir !== void 0 && enabled.skills) {
    if (adaptSkillsDir !== void 0) {
      const dsnFiles = [];
      walkSkillFiles(adaptSkillsDir, dsnFiles, 0);
      for (const file of dsnFiles) {
        const entry = loadSkillFile(file, adaptSkillsDir, DSN_SKILLS_RANK, "project-dsn", warn);
        if (entry) found.push(entry);
      }
    }
    const skillsRoot = join5(claudeDir, "skills");
    const skillFiles = [];
    walkSkillFiles(skillsRoot, skillFiles, 0);
    for (const file of skillFiles) {
      const entry = loadSkillFile(file, skillsRoot, CLAUDE_SKILLS_RANK, "project-claude", warn);
      if (entry) found.push(entry);
    }
  }
  if (claudeDir !== void 0 && enabled.agents) {
    const agentsRoot = join5(claudeDir, "agents");
    const agentFiles = [];
    walkAgentFiles2(agentsRoot, agentFiles, 0);
    for (const file of agentFiles) {
      const entry = loadClaudeAgent(file, agentsRoot, CLAUDE_AGENTS_RANK, "project-claude", warn);
      if (entry) found.push(entry);
    }
  }
  if (userClaudeDir !== void 0) {
    if (enabled.skills) {
      const skillsRoot = join5(userClaudeDir, "skills");
      const skillFiles = [];
      walkSkillFiles(skillsRoot, skillFiles, 0);
      for (const file of skillFiles) {
        const entry = loadSkillFile(file, skillsRoot, USER_SKILLS_RANK, "user-claude", warn);
        if (entry) found.push(entry);
      }
    }
    if (enabled.agents) {
      const agentsRoot = join5(userClaudeDir, "agents");
      const agentFiles = [];
      walkAgentFiles2(agentsRoot, agentFiles, 0);
      for (const file of agentFiles) {
        const entry = loadClaudeAgent(file, agentsRoot, USER_AGENTS_RANK, "user-claude", warn);
        if (entry) found.push(entry);
      }
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.locator.absPath.localeCompare(b.locator.absPath));
  const known = /* @__PURE__ */ new Set();
  const result = [];
  for (const entry of found) {
    if (known.has(entry.name)) {
      warn?.(`dsh-claude-in: duplicate claude skill name "${entry.name}" \u2014 keeping the higher-priority one`);
      continue;
    }
    known.add(entry.name);
    result.push(entry);
  }
  return result;
}
function walkSkillFiles(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync3(dir);
  } catch {
    return;
  }
  entries.sort();
  for (const name2 of entries) {
    if (name2.startsWith(".")) continue;
    const abs = join5(dir, name2);
    let stat;
    try {
      stat = statSync4(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkSkillFiles(abs, out, depth + 1);
    else if (stat.isFile() && name2 === "SKILL.md") out.push(abs);
  }
}
function walkAgentFiles2(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync3(dir);
  } catch {
    return;
  }
  entries.sort();
  for (const name2 of entries) {
    if (name2.startsWith(".")) continue;
    const abs = join5(dir, name2);
    let stat;
    try {
      stat = statSync4(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkAgentFiles2(abs, out, depth + 1);
    else if (stat.isFile() && name2.endsWith(".md")) out.push(abs);
  }
}
function loadSkillFile(file, skillsRoot, rank, source, warn) {
  let content;
  try {
    content = readFileSync4(file, "utf8");
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read ${file}: ${errorMessage(error)}`);
    return void 0;
  }
  const rel = relative3(skillsRoot, file).replace(/\\/g, "/");
  const dirRel = rel.slice(0, -"/SKILL.md".length) || ".";
  const dirName = dirRel === "." ? "" : dirRel.split("/").map(kebab2).join("-");
  const { meta, metaError } = splitFrontmatter(content);
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`);
  const metaName = optionalString(meta, "name");
  const description = optionalString(meta, "description");
  if (description === void 0) {
    warn?.(`dsh-claude-in: skill ${file} has no description \u2014 skipped`);
    return void 0;
  }
  const name2 = metaName ?? dirName;
  if (name2 === "" || !isSkillName(name2)) {
    warn?.(`dsh-claude-in: skill ${file} name "${name2}" is not a valid dsh skill name \u2014 skipped`);
    return void 0;
  }
  const dirIdx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return {
    name: name2,
    description,
    whenToUse: optionalString(meta, "whenToUse"),
    locator: { absPath: file, dir: dirIdx === -1 ? "" : file.slice(0, dirIdx), kind: "skill", agentName: "", agentDescription: "" },
    rank,
    source
  };
}
function loadClaudeAgent(file, agentsRoot, rank, source, warn) {
  let content;
  try {
    content = readFileSync4(file, "utf8");
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read ${file}: ${errorMessage(error)}`);
    return void 0;
  }
  const rel = relative3(agentsRoot, file).replace(/\\/g, "/");
  const fallbackName = rel.replace(/\.md$/, "");
  const { meta, metaError } = splitFrontmatter(content);
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`);
  const agentName = optionalString(meta, "name") ?? fallbackName;
  const description = optionalString(meta, "description") ?? "";
  const skillName = `claude-agent-${agentName.split("/").map(kebab2).join("-")}`;
  if (!isSkillName(skillName)) {
    warn?.(`dsh-claude-in: agent ${file} name "${agentName}" maps to invalid skill name \u2014 skipped`);
    return void 0;
  }
  return {
    name: skillName,
    description: description === "" ? `Claude agent "${agentName}" from ${source === "user-claude" ? "~/.claude" : ".claude"}/agents` : `Claude agent "${agentName}": ${description}`,
    whenToUse: "Claude Code agent \u2014 load its full definition with the skill tool, then delegate via the subagent tool using that definition as the child prompt.",
    locator: {
      absPath: file,
      dir: file,
      kind: "agent",
      agentName,
      agentDescription: description
    },
    rank,
    source
  };
}
function kebab2(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function createClaudeSkillProvider(config, warn) {
  return {
    name: PROVIDER_NAME,
    async list(options) {
      if (options.cwd === void 0) return [];
      const root = findClaudeRoot(options.cwd, config.claudeDir);
      const userRoot = findUserClaudeRoot();
      const userClaudeDir = userRoot !== void 0 && (root === void 0 || userRoot.path !== root.path) ? userRoot.claudeDir : void 0;
      const adaptDir = root !== void 0 ? join5(root.path, config.adaptDir) : void 0;
      const adapt = adaptDir !== void 0 ? loadAdaptConfig(adaptDir, warn) : void 0;
      const effective = mergeAdaptConfig(config, adapt);
      if (!effective.enabled || !effective.loadSkills && !effective.loadAgents) return [];
      const adaptSkillsDir = effective.loadSkills && root !== void 0 ? join5(root.path, config.adaptDir, "skills") : void 0;
      const discovered = discoverClaudeSkills(root?.claudeDir, { skills: effective.loadSkills, agents: effective.loadAgents }, warn, adaptSkillsDir, userClaudeDir);
      return discovered.map(toCandidate);
    },
    async get(candidate) {
      const locator = candidate.locator;
      try {
        const content = readFileSync4(locator.absPath, "utf8");
        const { meta, body } = splitFrontmatter(content);
        if (locator.kind === "skill") {
          return {
            name: candidate.name,
            description: candidate.description,
            whenToUse: candidate.whenToUse,
            source: candidate.source,
            provider: candidate.provider,
            invocation: candidate.invocation,
            content: body,
            path: locator.absPath,
            metadata: meta ?? {},
            resourceBase: locator.dir !== "" ? { kind: "directory", path: locator.dir } : void 0
          };
        }
        return {
          name: candidate.name,
          description: candidate.description,
          whenToUse: candidate.whenToUse,
          source: candidate.source,
          provider: candidate.provider,
          invocation: candidate.invocation,
          content: renderAgentDefinition(locator.agentName, locator.agentDescription, meta ?? {}, body),
          path: locator.absPath,
          metadata: meta ?? {}
        };
      } catch (error) {
        warn?.(`dsh-claude-in: cannot load claude skill ${locator.absPath}: ${errorMessage(error)}`);
        return void 0;
      }
    }
  };
}
function toCandidate(entry) {
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    source: entry.source,
    provider: PROVIDER_NAME,
    rank: entry.rank,
    locator: entry.locator,
    path: entry.locator.absPath,
    invocation: { modelInvocable: true, userInvocable: true }
  };
}

// src/hooks.ts
import { readFileSync as readFileSync5, existsSync as existsSync4, statSync as statSync5 } from "node:fs";
import { join as join6, relative as relative4 } from "node:path";
import { homedir as homedir3 } from "node:os";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  matchesMatcher,
  matcherDiagnostic,
  mergeHookOutputs,
  runHook
} from "@deepseek-ai/dsh-hook-protocol";
var CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop"
];
function parseClaudeConfig(raw, vars = {}) {
  const config = {};
  const skipped = [];
  const root = asObject(raw);
  const hooksMap = root ? asObject(root.hooks) ?? root : void 0;
  if (!hooksMap) return { config, skipped };
  for (const event of CLAUDE_EVENTS) {
    const value = hooksMap[event];
    if (!Array.isArray(value)) continue;
    for (const groupRaw of value) {
      const group = asObject(groupRaw);
      if (!group) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : void 0;
      if (matcher !== void 0) {
        const diagnostic = matcherDiagnostic(matcher, "claude-code");
        if (diagnostic !== void 0) {
          throw new SyntaxError(`invalid matcher "${matcher}" on ${event}: ${diagnostic}`);
        }
      }
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const commands = [];
      for (const hookRaw of hooks) {
        const hook = asObject(hookRaw);
        if (!hook) continue;
        if (hook.type !== void 0 && hook.type !== "command") {
          skipped.push({ event, type: String(hook.type) });
          continue;
        }
        if (typeof hook.command !== "string" || hook.command.trim() === "") {
          skipped.push({ event, type: "malformed" });
          continue;
        }
        let command = substituteCommand(hook.command, vars);
        const timeoutSec = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : void 0;
        commands.push({ command, timeoutSec });
      }
      if (commands.length > 0) {
        ;
        (config[event] ??= []).push({ matcher, hooks: commands });
      }
    }
  }
  return { config, skipped };
}
function substituteCommand(command, vars) {
  let out = command;
  if (vars.pluginRoot !== void 0) out = out.split("${CLAUDE_PLUGIN_ROOT}").join(vars.pluginRoot);
  if (vars.projectDir !== void 0) out = out.split("${CLAUDE_PROJECT_DIR}").join(vars.projectDir);
  return out;
}
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function loadHookConfig(claudeDir, root, warn) {
  const sources = [];
  const hooksJson = join6(claudeDir, "hooks.json");
  const settingsJson = join6(claudeDir, "settings.json");
  const settingsLocalJson = join6(claudeDir, "settings.local.json");
  for (const file of [hooksJson, settingsJson, settingsLocalJson]) {
    if (!existsSync4(file)) continue;
    try {
      sources.push({ file, raw: JSON.parse(readFileSync5(file, "utf8")) });
    } catch (error) {
      warn?.(`dsh-claude-in: cannot parse hook config ${file}: ${errorMessage(error)}`);
    }
  }
  if (sources.length === 0) return void 0;
  const merged = {};
  for (const source of sources) {
    const raw = asObject(source.raw);
    const hooks = raw ? asObject(raw.hooks) ?? raw : void 0;
    if (!hooks) continue;
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue;
      const prev = merged[event];
      merged[event] = Array.isArray(prev) ? [...prev, ...value] : value;
    }
  }
  const vars = { pluginRoot: root, projectDir: root };
  try {
    const { config, skipped } = parseClaudeConfig(merged, vars);
    for (const skip of skipped) {
      warn?.(`dsh-claude-in: skipping unsupported "${skip.type}" hook on ${skip.event} (only command hooks run)`);
    }
    const hasAny = Object.values(config).some((groups) => groups.length > 0);
    if (!hasAny) return void 0;
    return { root, events: config };
  } catch (error) {
    warn?.(`dsh-claude-in: hook config invalid: ${errorMessage(error)} \u2014 no hooks registered`);
    return void 0;
  }
}
function loadUserHookConfig(home = homedir3(), warn, projectDir = home) {
  const claudeDir = join6(home, ".claude");
  if (!existsSync4(claudeDir)) return void 0;
  return loadHookConfig(claudeDir, projectDir, warn);
}
function userHookFingerprint(home) {
  const claudeDir = join6(home, ".claude");
  return ["settings.json", "settings.local.json", "hooks.json"].map((name2) => {
    try {
      return String(statSync5(join6(claudeDir, name2)).mtimeMs);
    } catch {
      return "absent";
    }
  }).join(":");
}
var PLUGIN_SOURCE = { kind: "plugin", plugin: "dsh-claude-in" };
var handlerCounter = 0;
function nextHandlerId(point) {
  return `dsh-claude-in:${point}:${++handlerCounter}`;
}
function sessionInRoot(cwd, root) {
  if (cwd === void 0) return false;
  const rel = relative4(root, cwd);
  return rel === "" || !rel.startsWith("..") && !rel.startsWith("/");
}
function applyHooks(ctx, config, contextGate) {
  const shell = ctx.get("shell");
  if (shell === void 0) return;
  const warn = (message) => ctx.logger.warn(message);
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS;
  const defaultTimeoutMs = config.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const detached = createDetachedRuns();
  ctx.effect(() => () => detached.drain(), "dsh-claude-in: drain detached hook runs");
  const subagentChildren = /* @__PURE__ */ new Map();
  const configCache = /* @__PURE__ */ new Map();
  const hookConfigFor = (cwd) => {
    if (cwd === void 0) return void 0;
    const home = homedir3();
    const root = findClaudeRoot(cwd, config.claudeDir);
    const userIsProject = root !== void 0 && root.path === home;
    const adaptDir = root !== void 0 ? join6(root.path, config.adaptDir) : void 0;
    const adapt = adaptDir !== void 0 ? loadAdaptConfig(adaptDir, warn) : void 0;
    const effective = mergeAdaptConfig(config, adapt);
    if (!effective.loadHooks || !effective.enabled) return void 0;
    let projectConfig;
    if (root !== void 0 && !userIsProject) {
      const cached = configCache.get(root.claudeDir);
      projectConfig = cached !== void 0 ? cached : (() => {
        const loaded = loadHookConfig(root.claudeDir, root.path, warn);
        const overridden = loaded !== void 0 ? applyHookCommandOverrides(loaded, adapt) : void 0;
        configCache.set(root.claudeDir, overridden);
        return overridden;
      })();
    }
    let userConfig;
    {
      const executionRoot = root?.path ?? cwd;
      const fingerprint = `${executionRoot}:${userHookFingerprint(home)}`;
      const cached = userConfigCache.get(fingerprint);
      userConfig = cached !== void 0 ? cached : (() => {
        const loaded = loadUserHookConfig(home, warn, executionRoot);
        userConfigCache.set(fingerprint, loaded);
        return loaded;
      })();
    }
    const projectEvents = projectConfig?.events ?? {};
    const userEvents = userConfig?.events ?? {};
    const events = {};
    for (const event of /* @__PURE__ */ new Set([...Object.keys(projectEvents), ...Object.keys(userEvents)])) {
      events[event] = [...projectEvents[event] ?? [], ...userEvents[event] ?? []];
    }
    if (Object.keys(events).length === 0) return void 0;
    const mergedRoot = root?.path ?? cwd;
    return { root: mergedRoot, events };
  };
  const userConfigCache = /* @__PURE__ */ new Map();
  const invalidate = (cwd) => {
    if (cwd === void 0) return;
    const root = findClaudeRoot(cwd, config.claudeDir);
    if (root) configCache.delete(root.claudeDir);
  };
  async function runPoint(hookConfig, point, matchQuery, payload, opts) {
    const groups = hookConfig.events[point] ?? [];
    const outputs = [];
    const workdir = opts.agent?.session?.header?.cwd;
    const hookEnv = hookConfig.root !== void 0 ? { CLAUDE_PROJECT_DIR: hookConfig.root } : void 0;
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, "claude-code")) continue;
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point);
        const session = opts.agent?.session;
        if (session && opts.turn !== void 0) {
          appendHookInvoked(session, {
            turn: opts.turn,
            point,
            dialect: "claude-code",
            handlerId,
            ...group.matcher !== void 0 ? { matcher: group.matcher } : {}
          });
        }
        const { output, durationMs } = await runHook(
          shell,
          hook,
          {
            payload,
            defaultTimeoutMs,
            ...hookEnv ? { env: hookEnv } : {},
            ...workdir !== void 0 ? { cwd: workdir } : {},
            signal: opts.signal,
            trailingNewline: true,
            expectedEventName: point
          },
          () => performance.now()
        );
        outputs.push(output);
        if (output.updatedInput !== void 0) warn(`dsh-claude-in: ${point} hook requested updatedInput, which is not honored (ignored)`);
        if (output.systemMessage !== void 0) warn(`dsh-claude-in: ${point} hook emitted a systemMessage, which is not surfaced (ignored)`);
        if (session && opts.turn !== void 0) {
          appendHookResult(session, {
            turn: opts.turn,
            point,
            handlerId,
            output,
            stderrSummaryMaxChars,
            durationMs
          });
        }
      }
    }
    return mergeHookOutputs(outputs);
  }
  function contextFrom(merged) {
    if (merged.additionalContext.length === 0) return void 0;
    return createUserMessage({
      content: merged.additionalContext.map((text) => ({ type: "text", text })),
      source: { ...PLUGIN_SOURCE, form: "instructions" }
    });
  }
  const configForAgent = (agent) => {
    const cwd = agent?.session?.header?.cwd;
    const hookConfig = hookConfigFor(cwd);
    if (hookConfig === void 0) return void 0;
    return sessionInRoot(cwd, hookConfig.root) ? hookConfig : void 0;
  };
  ctx.on("agent/session-start", ({ agent, source }) => {
    invalidate(agent?.session?.header?.cwd);
    const hookConfig = configForAgent(agent);
    if (hookConfig === void 0) return;
    detached.track(
      runPoint(hookConfig, "SessionStart", source ?? "", sessionStartPayload(ctx, agent, source), {
        agent,
        signal: detached.signal
      }).then((merged) => {
        const context = contextFrom(merged);
        if (context) {
          if (contextGate === void 0) agent.inject(context);
          else contextGate.inject(agent, context);
        }
      }).catch((error) => {
        warn(`dsh-claude-in: SessionStart hook failed: ${errorMessage(error)}`);
      })
    );
  });
  ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
    if (messages.length === 0) return next();
    const hookConfig = configForAgent(agent);
    if (hookConfig === void 0) return next();
    const prompt = messages.flatMap((m) => m.content).filter((b) => b.type === "text").map((b) => b.text).join("");
    const merged = await runPoint(hookConfig, "UserPromptSubmit", "", promptPayload(ctx, agent, prompt), {
      agent,
      turn,
      signal
    });
    if (merged.decision === "deny") return { kind: "reject" };
    const downstream = await next();
    const ours = contextFrom(merged);
    if (!ours || downstream.kind !== "enter") return downstream;
    if (contextGate !== void 0 && !contextGate.ready(agent)) {
      contextGate.inject(agent, ours);
      return downstream;
    }
    return { kind: "enter", messages: [...downstream.messages, ours] };
  });
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.agent === void 0) return next();
    const hookConfig = configForAgent(exec.agent);
    if (hookConfig === void 0) return next();
    const turn = lastTurn(exec.agent);
    const merged = await runPoint(hookConfig, "PreToolUse", exec.name, preToolPayload(ctx, exec), {
      agent: exec.agent,
      turn,
      signal: exec.signal
    });
    if (merged.decision === "deny") {
      return { kind: "deny", reason: merged.reason ?? "blocked by PreToolUse hook" };
    }
    if (merged.decision === "ask") {
      return { kind: "ask", ...merged.reason !== void 0 ? { reason: merged.reason } : {} };
    }
    return next();
  });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    if (exec.agent === void 0) return next();
    const hookConfig = configForAgent(exec.agent);
    if (hookConfig === void 0) return next();
    const turn = lastTurn(exec.agent);
    const merged = await runPoint(hookConfig, "PostToolUse", exec.name, postToolPayload(ctx, exec, result), {
      agent: exec.agent,
      turn,
      signal: exec.signal
    });
    const context = contextFrom(merged);
    if (merged.decision === "deny") {
      return {
        kind: "block",
        feedback: [{ type: "text", text: merged.reason ?? "blocked by PostToolUse hook" }],
        ...context ? { additionalContexts: [context] } : {}
      };
    }
    const downstream = await next();
    if (!context) return downstream;
    return {
      ...downstream,
      additionalContexts: [context, ...downstream.additionalContexts ?? []]
    };
  });
  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const hookConfig = configForAgent(agent);
    if (hookConfig === void 0) return;
    const merged = await runPoint(hookConfig, "Stop", "", stopPayload(ctx, agent), {
      agent,
      turn,
      signal
    });
    if (merged.decision === "deny") {
      const text = merged.reason ?? "continue: blocked by Stop hook";
      agent.steer(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { ...PLUGIN_SOURCE, form: "instructions" }
        })
      );
    }
  });
  ctx.on("subagent/start", (info) => {
    const child = ctx.get("agents")?.get?.(info.id);
    if (child !== void 0) subagentChildren.set(info.runId, child);
    const hookConfig = configForAgent(child);
    if (hookConfig === void 0) return;
    detached.track(
      runPoint(hookConfig, "SubagentStart", SUBAGENT_TYPE, subagentPayload(ctx, "SubagentStart", info, child), {
        ...child ? { agent: child } : {},
        signal: detached.signal
      }).then((merged) => {
        const context = contextFrom(merged);
        if (context && child) child.inject(context);
      }).catch((error) => {
        warn(`dsh-claude-in: SubagentStart hook failed: ${errorMessage(error)}`);
      })
    );
  });
  ctx.on("subagent/end", (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get("agents")?.get?.(info.id);
    subagentChildren.delete(info.runId);
    const hookConfig = configForAgent(child);
    if (hookConfig === void 0) return;
    detached.track(
      runPoint(hookConfig, "SubagentStop", SUBAGENT_TYPE, subagentPayload(ctx, "SubagentStop", info, child), {
        ...child ? { agent: child } : {},
        signal: detached.signal
      }).catch((error) => {
        warn(`dsh-claude-in: SubagentStop hook failed: ${errorMessage(error)}`);
      })
    );
  });
}
var SUBAGENT_TYPE = "general-purpose";
function lastTurn(agent) {
  if (!agent) return 0;
  const events = [...agent.session.events];
  const last = events.findLast((e) => e.type === "turn/start");
  return last?.type === "turn/start" ? last.data.turn : 0;
}
function blocksToText(content) {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
function base(ctx, agent, event) {
  return {
    session_id: agent?.session?.header?.id ?? "",
    transcript_path: agent === void 0 ? "" : ctx.get("sessionPersistence")?.locate?.(agent.session.header)?.path ?? "",
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
    hook_event_name: event
  };
}
function sessionStartPayload(ctx, agent, source) {
  return { ...base(ctx, agent, "SessionStart"), source };
}
function promptPayload(ctx, agent, prompt) {
  return { ...base(ctx, agent, "UserPromptSubmit"), prompt };
}
function preToolPayload(ctx, exec) {
  return {
    ...base(ctx, exec.agent, "PreToolUse"),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId
  };
}
function postToolPayload(ctx, exec, result) {
  return {
    ...base(ctx, exec.agent, "PostToolUse"),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
    tool_response: blocksToText(result.content ?? [])
  };
}
function stopPayload(ctx, agent) {
  return { ...base(ctx, agent, "Stop"), stop_hook_active: false };
}
function subagentPayload(ctx, event, info, child) {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === "SubagentStop" ? { stop_hook_active: false } : {}
  };
}

// src/context-gate.ts
var PROMOTION_EVENTS = /* @__PURE__ */ new Set(["assistant/message", "tool/call"]);
function sessionKey(session) {
  return typeof session?.id === "string" && session.id.length > 0 ? session.id : void 0;
}
function alreadyPromoted(session) {
  return Array.isArray(session?.events) && session.events.some((event) => PROMOTION_EVENTS.has(event?.type));
}
function createDeferredContextGate() {
  const seenRequest = /* @__PURE__ */ new Set();
  const promoted = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  return {
    attach(agent) {
      const session = agent?.session;
      const key = sessionKey(session);
      if (key === void 0) return;
      if (alreadyPromoted(session)) promoted.add(key);
    },
    beginRequest(agent) {
      const session = agent?.session;
      const key = sessionKey(session);
      if (key === void 0) return false;
      if (promoted.has(key) || alreadyPromoted(session) || seenRequest.has(key)) {
        promoted.add(key);
        return true;
      }
      seenRequest.add(key);
      return false;
    },
    ready(agent) {
      const session = agent?.session;
      const key = sessionKey(session);
      return key !== void 0 && (promoted.has(key) || alreadyPromoted(session));
    },
    defer(agent, message) {
      const key = sessionKey(agent?.session);
      if (key === void 0) return;
      const messages = pending.get(key);
      if (messages === void 0) pending.set(key, [message]);
      else messages.push(message);
    },
    drain(agent) {
      const key = sessionKey(agent?.session);
      if (key === void 0 || !promoted.has(key)) return [];
      const messages = pending.get(key) ?? [];
      pending.delete(key);
      return messages;
    },
    inject(agent, message) {
      const session = agent?.session;
      const key = sessionKey(session);
      if (key === void 0) return false;
      if (promoted.has(key) || alreadyPromoted(session)) {
        promoted.add(key);
        agent.inject(message);
        return true;
      }
      this.defer(agent, message);
      return false;
    }
  };
}

// src/index.ts
var name = "dsh-claude-in";
var inject = ["skills", "shell"];
var EMPTY_DISCOVERY = { rules: [], always: [], scoped: [], requestable: [] };
function mergeDiscovery(project, user) {
  return {
    rules: [...project.rules, ...user.rules],
    always: [...project.always, ...user.always],
    scoped: [...project.scoped, ...user.scoped],
    requestable: [...project.requestable, ...user.requestable]
  };
}
function apply(ctx, raw) {
  const config = resolveConfig(raw);
  if (!config.enabled) return;
  const warn = (message) => ctx.logger.warn(message);
  ctx.logger.info(`dsh-claude-in: enabled (claudeDir=${config.claudeDir}, rules=${config.loadRules}, skills=${config.loadSkills}, agents=${config.loadAgents}, hooks=${config.loadHooks})`);
  if (config.loadSkills || config.loadAgents) {
    const skills = ctx.get("skills");
    if (skills === void 0) {
      warn("dsh-claude-in: ctx.skills unavailable \u2014 skill/agent loading skipped");
    } else {
      ctx.effect(
        () => skills.registerProvider(() => createClaudeSkillProvider(config, warn)),
        "dsh-claude-in.skills"
      );
    }
  }
  const sessions = /* @__PURE__ */ new WeakMap();
  const contextGate = createDeferredContextGate();
  const baselineCache = /* @__PURE__ */ new Map();
  const BASELINE_TTL_MS = 3e4;
  const fingerprint = (root, userRoot) => {
    const parts = [];
    for (const r of [root, userRoot]) {
      if (r === void 0) {
        parts.push("no-root");
        continue;
      }
      parts.push(String(r.mtimeMs));
      for (const sub of ["rules", "agents", "skills"]) {
        try {
          parts.push(String(statSync6(join7(r.claudeDir, sub)).mtimeMs));
        } catch {
          parts.push("absent");
        }
      }
    }
    if (root !== void 0) {
      try {
        parts.push(String(statSync6(join7(root.path, config.adaptDir, "dsh-claude-in.yml")).mtimeMs));
      } catch {
        parts.push("no-adapt");
      }
    }
    return parts.join(":");
  };
  const ruleOptions = (effective) => ({
    maxSourceBytes: effective.ruleMaxSourceBytes,
    importMaxDepth: effective.ruleImportMaxDepth,
    defaultAlwaysApply: effective.defaultAlwaysApply,
    warn
  });
  const loadSessionState = (agent) => {
    const cwd = agent?.session?.header?.cwd;
    if (cwd === void 0) return void 0;
    const root = findClaudeRoot(cwd, config.claudeDir);
    let userRoot = findUserClaudeRoot();
    if (userRoot !== void 0 && root !== void 0 && userRoot.path === root.path) userRoot = void 0;
    if (root === void 0 && userRoot === void 0) return void 0;
    const adapt = root !== void 0 ? loadAdaptConfig(join7(root.path, config.adaptDir), warn) : void 0;
    const effective = mergeAdaptConfig(config, adapt);
    if (!effective.enabled) return void 0;
    const cacheKey = `${root?.path ?? ""}|${userRoot?.path ?? ""}`;
    const fp = fingerprint(root, userRoot);
    const cached = baselineCache.get(cacheKey);
    if (cached && cached.fingerprint === fp && Date.now() - cached.loadedAt < BASELINE_TTL_MS) {
      return cached.state;
    }
    const projectDiscovery = effective.loadRules && root !== void 0 ? discoverRules(root.claudeDir, ruleOptions(effective), "project") : EMPTY_DISCOVERY;
    const userDiscovery = effective.loadRules && userRoot !== void 0 ? discoverRules(userRoot.claudeDir, ruleOptions(effective), "user") : EMPTY_DISCOVERY;
    const discovery = mergeDiscovery(projectDiscovery, userDiscovery);
    const projectAgents = effective.loadAgents && root !== void 0 ? discoverAgents(root.claudeDir, warn, "project") : [];
    const userAgents = effective.loadAgents && userRoot !== void 0 ? discoverAgents(userRoot.claudeDir, warn, "user") : [];
    const agents = mergeAgents(projectAgents, userAgents);
    const state = { root, userRoot, config: effective, discovery, agents, injectedScoped: /* @__PURE__ */ new Set() };
    baselineCache.set(cacheKey, { state, loadedAt: Date.now(), fingerprint: fp });
    return state;
  };
  const buildBaseline = (state, config2) => {
    const parts = [];
    if (config2.loadRules) {
      const rendered = renderBaseline(state.discovery, state.root?.path ?? state.userRoot?.path ?? "", config2.rulesMaxBytes);
      if (rendered !== "") parts.push(rendered);
    }
    if (config2.loadAgents && state.agents.length > 0) {
      const catalog = renderAgentCatalog(state.agents, state.root?.path ?? state.userRoot?.path ?? "");
      if (catalog !== "") parts.push(catalog);
    }
    if (parts.length === 0) return void 0;
    return parts.join("\n\n");
  };
  const injectBaseline = (agent) => {
    const state = loadSessionState(agent);
    if (state === void 0) return;
    sessions.set(agent.session, state);
    const text = buildBaseline(state, state.config);
    if (text === void 0 || text === "") return;
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "dsh-claude-in",
        plugin: "dsh-claude-in",
        form: "instructions",
        origin: "claude-rules",
        claudeRoot: state.root?.path ?? state.userRoot?.path
      }
    });
    contextGate.defer(agent, message);
    const roots = [state.root?.claudeDir, state.userRoot?.claudeDir].filter((p) => p !== void 0).join(" + ");
    ctx.logger.info(`dsh-claude-in: deferred baseline (.claude: ${roots}; rules=${state.discovery.rules.length}, agents=${state.agents.length})`);
  };
  if (config.loadRules || config.loadAgents) {
    const prepareBaseline = (agent) => {
      try {
        contextGate.attach(agent);
        injectBaseline(agent);
      } catch (error) {
        warn(`dsh-claude-in: baseline injection failed: ${errorMessage(error)}`);
      }
    };
    ctx.on("agent/session-start", ({ agent }) => {
      prepareBaseline(agent);
    });
    ctx.on("agent/pre-step", async ({ agent }, next) => {
      const ready = contextGate.beginRequest(agent);
      if (!sessions.has(agent.session)) prepareBaseline(agent);
      const decision = await next();
      if (!ready || decision.kind !== "enter") return decision;
      const deferred = contextGate.drain(agent);
      return deferred.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...deferred] };
    }, { prepend: true });
  }
  if (config.loadRules) {
    const FILE_TOUCH_TOOL_NAMES = /* @__PURE__ */ new Set(["read", "write", "edit"]);
    const filePathFromExecution = (exec) => {
      if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return void 0;
      if (typeof exec.arguments !== "object" || exec.arguments === null) return void 0;
      if (!("file_path" in exec.arguments) || typeof exec.arguments.file_path !== "string") return void 0;
      const filePath = exec.arguments.file_path.trim();
      return filePath.length > 0 ? filePath : void 0;
    };
    ctx.on("tools/result", (exec, result) => {
      try {
        const agent = exec.agent;
        if (agent === void 0) return;
        const state = sessions.get(agent.session);
        if (state === void 0) return;
        const filePath = filePathFromExecution(exec);
        if (filePath === void 0) return;
        const cwd = agent.session.header.cwd ?? process.cwd();
        const abs = resolve2(cwd, filePath);
        const anchor = state.root?.path ?? cwd;
        const rel = relPathOf(anchor, abs);
        if (rel === void 0) return;
        const hits = matchingScoped(state.discovery.scoped, rel).filter((rule) => !state.injectedScoped.has(rule.absPath));
        if (hits.length === 0) return;
        for (const rule of hits) state.injectedScoped.add(rule.absPath);
        const text = renderTouched(hits, anchor, rel, state.config.rulesMaxBytes);
        if (text === "") return;
        agent.inject(
          createUserMessage({
            content: [{ type: "text", text }],
            source: {
              kind: "dsh-claude-in",
              plugin: "dsh-claude-in",
              form: "instructions",
              origin: "claude-rules",
              claudeRoot: state.root?.path ?? state.userRoot?.path
            }
          })
        );
        ctx.logger.info(`dsh-claude-in: injected ${hits.length} path-scoped rule(s) for ${rel} (${hits.map((r) => r.name).join(", ")})`);
      } catch (error) {
        warn(`dsh-claude-in: path-scoped rule injection failed: ${errorMessage(error)}`);
      }
    });
  }
  if (config.loadHooks) {
    if (ctx.get("shell") === void 0) {
      warn("dsh-claude-in: ctx.shell unavailable \u2014 hooks skipped");
    } else {
      applyHooks(ctx, config, contextGate);
    }
  }
}
export {
  Config,
  PROVIDER_NAME,
  apply,
  inject,
  name,
  resolveConfig
};
