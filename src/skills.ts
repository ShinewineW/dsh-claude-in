/**
 * `ctx.skills` 注册 provider：把 `.claude/skills/**​/SKILL.md` 与
 * `.claude/agents/**​/*.md` 作为项目技能暴露（cwd 敏感，向上发现项目根）。
 * 不复制文件——`get()` 直接读源 SKILL.md / agent 定义。
 * @module dsh-claude-in/skills
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { splitFrontmatter, errorMessage, optionalString } from './frontmatter.ts'
import { findClaudeRoot, findUserClaudeRoot } from './discovery.ts'
import type { ResolvedConfig } from './config.ts'
import { loadAdaptConfig, mergeAdaptConfig } from './adapt.ts'
import { renderAgentDefinition } from './agents.ts'

export const PROVIDER_NAME = 'dsh-claude-in'
/** 项目 `.dsh/skills`(100)/`.agents/skills`(200) 之下：`.dsn/skills` 适配层(240) < `.claude/skills`(250)。 */
const DSN_SKILLS_RANK = 240
/** 项目 `.claude/skills` 的 rank：低于 `.dsh/skills`(100)/`.agents/skills`(200)，高于 custom(300)/user(400/500)。 */
const CLAUDE_SKILLS_RANK = 250
/** 项目 agents-as-skill 的 rank。 */
const CLAUDE_AGENTS_RANK = 260
/** 用户级 `~/.claude/skills` 的 rank：低于项目级(250)/custom(300)/user-dsh(400)，高于 user-agents(500)。 */
const USER_SKILLS_RANK = 450
/** 用户级 agents-as-skill 的 rank。 */
const USER_AGENTS_RANK = 460

export interface ClaudeSkillLocator {
  absPath: string
  dir: string
  kind: 'skill' | 'agent'
  /** agent 原始 name（frontmatter）。 */
  agentName: string
  /** agent 原始 description（frontmatter，未加前缀）。 */
  agentDescription: string
}

export interface DiscoveredClaudeSkill {
  name: string
  description: string
  whenToUse?: string
  locator: ClaudeSkillLocator
  rank: number
  source: 'project-claude' | 'user-claude' | 'project-dsn'
}

/**
 * 扫描 skills 与 agents（由 provider.list 调用）。
 * 层级与优先级（数字越小越优先，同名后者被去重）：
 *  - adaptSkillsDir（`.dsn/skills`）rank 240（DSH 适配层）
 *  - 项目级 `.claude/skills` rank 250、`.claude/agents` rank 260
 *  - 用户级 `~/.claude/skills` rank 450、`~/.claude/agents` rank 460
 * 项目级同名覆盖用户级（Claude Code 语义：项目优先）。
 */
export function discoverClaudeSkills(
  claudeDir: string | undefined,
  enabled: { skills: boolean; agents: boolean },
  warn?: (m: string) => void,
  adaptSkillsDir?: string,
  userClaudeDir?: string,
): DiscoveredClaudeSkill[] {
  const found: DiscoveredClaudeSkill[] = []
  if (claudeDir !== undefined && enabled.skills) {
    if (adaptSkillsDir !== undefined) {
      const dsnFiles: string[] = []
      walkSkillFiles(adaptSkillsDir, dsnFiles, 0)
      for (const file of dsnFiles) {
        const entry = loadSkillFile(file, adaptSkillsDir, DSN_SKILLS_RANK, 'project-dsn', warn)
        if (entry) found.push(entry)
      }
    }
    const skillsRoot = join(claudeDir, 'skills')
    const skillFiles: string[] = []
    walkSkillFiles(skillsRoot, skillFiles, 0)
    for (const file of skillFiles) {
      const entry = loadSkillFile(file, skillsRoot, CLAUDE_SKILLS_RANK, 'project-claude', warn)
      if (entry) found.push(entry)
    }
  }
  if (claudeDir !== undefined && enabled.agents) {
    const agentsRoot = join(claudeDir, 'agents')
    const agentFiles: string[] = []
    walkAgentFiles(agentsRoot, agentFiles, 0)
    for (const file of agentFiles) {
      const entry = loadClaudeAgent(file, agentsRoot, CLAUDE_AGENTS_RANK, 'project-claude', warn)
      if (entry) found.push(entry)
    }
  }
  if (userClaudeDir !== undefined) {
    if (enabled.skills) {
      const skillsRoot = join(userClaudeDir, 'skills')
      const skillFiles: string[] = []
      walkSkillFiles(skillsRoot, skillFiles, 0)
      for (const file of skillFiles) {
        const entry = loadSkillFile(file, skillsRoot, USER_SKILLS_RANK, 'user-claude', warn)
        if (entry) found.push(entry)
      }
    }
    if (enabled.agents) {
      const agentsRoot = join(userClaudeDir, 'agents')
      const agentFiles: string[] = []
      walkAgentFiles(agentsRoot, agentFiles, 0)
      for (const file of agentFiles) {
        const entry = loadClaudeAgent(file, agentsRoot, USER_AGENTS_RANK, 'user-claude', warn)
        if (entry) found.push(entry)
      }
    }
  }
  const known = new Set<string>()
  const result: DiscoveredClaudeSkill[] = []
  for (const entry of found) {
    if (known.has(entry.name)) {
      warn?.(`dsh-claude-in: duplicate claude skill name "${entry.name}" — keeping the higher-priority one`)
      continue
    }
    known.add(entry.name)
    result.push(entry)
  }
  return result
}

function walkSkillFiles(dir: string, out: string[], depth: number): void {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return // skills 目录不存在：静默
  }
  entries.sort()
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const abs = join(dir, name)
    let stat
    try {
      stat = statSync(abs) // 跟随符号链接（.claude/skills 目录常为链接）
    } catch {
      continue
    }
    if (stat.isDirectory()) walkSkillFiles(abs, out, depth + 1)
    else if (stat.isFile() && name === 'SKILL.md') out.push(abs)
  }
}

function walkAgentFiles(dir: string, out: string[], depth: number): void {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  entries.sort()
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const abs = join(dir, name)
    let stat
    try {
      stat = statSync(abs) // 跟随符号链接
    } catch {
      continue
    }
    if (stat.isDirectory()) walkAgentFiles(abs, out, depth + 1)
    else if (stat.isFile() && name.endsWith('.md')) out.push(abs)
  }
}

function loadSkillFile(file: string, skillsRoot: string, rank: number, source: 'project-claude' | 'project-dsn', warn?: (m: string) => void): DiscoveredClaudeSkill | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read ${file}: ${errorMessage(error)}`)
    return undefined
  }
  const rel = relative(skillsRoot, file).replace(/\\/g, '/')
  const dirRel = rel.slice(0, -'/SKILL.md'.length) || '.'
  const dirName = dirRel === '.' ? '' : dirRel.split('/').map(kebab).join('-')
  const { meta, metaError } = splitFrontmatter(content)
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`)
  const metaName = optionalString(meta, 'name')
  const description = optionalString(meta, 'description')
  if (description === undefined) {
    warn?.(`dsh-claude-in: skill ${file} has no description — skipped`)
    return undefined
  }
  const name = metaName ?? dirName
  if (name === '' || !isSkillName(name)) {
    warn?.(`dsh-claude-in: skill ${file} name "${name}" is not a valid dsh skill name — skipped`)
    return undefined
  }
  const dirIdx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return {
    name,
    description,
    whenToUse: optionalString(meta, 'whenToUse'),
    locator: { absPath: file, dir: dirIdx === -1 ? '' : file.slice(0, dirIdx), kind: 'skill', agentName: '', agentDescription: '' },
    rank,
    source,
  }
}

function loadClaudeAgent(file: string, agentsRoot: string, rank: number, source: 'project-claude' | 'user-claude', warn?: (m: string) => void): DiscoveredClaudeSkill | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read ${file}: ${errorMessage(error)}`)
    return undefined
  }
  const rel = relative(agentsRoot, file).replace(/\\/g, '/')
  const fallbackName = rel.replace(/\.md$/, '')
  const { meta, metaError } = splitFrontmatter(content)
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`)
  const agentName = optionalString(meta, 'name') ?? fallbackName
  const description = optionalString(meta, 'description') ?? ''
  const skillName = `claude-agent-${agentName.split('/').map(kebab).join('-')}`
  if (!isSkillName(skillName)) {
    warn?.(`dsh-claude-in: agent ${file} name "${agentName}" maps to invalid skill name — skipped`)
    return undefined
  }
  return {
    name: skillName,
    description: description === '' ? `Claude agent "${agentName}" from ${source === 'user-claude' ? '~/.claude' : '.claude'}/agents` : `Claude agent "${agentName}": ${description}`,
    whenToUse: 'Claude Code agent — load its full definition with the skill tool, then delegate via the subagent tool using that definition as the child prompt.',
    locator: {
      absPath: file,
      dir: file,
      kind: 'agent',
      agentName,
      agentDescription: description,
    },
    rank,
    source,
  }
}

/** 名字 kebab 化（保留已合规的部分）。 */
export function kebab(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function createClaudeSkillProvider(config: ResolvedConfig, warn?: (m: string) => void): SkillProvider {
  return {
    name: PROVIDER_NAME,
    async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
      if (options.cwd === undefined) return []
      const root = findClaudeRoot(options.cwd, config.claudeDir)
      const userRoot = findUserClaudeRoot()
      // 项目根就是家目录时，用户级与项目级是同一份，只载一次
      const userClaudeDir = userRoot !== undefined && (root === undefined || userRoot.path !== root.path) ? userRoot.claudeDir : undefined
      const adaptDir = root !== undefined ? join(root.path, config.adaptDir) : undefined
      const adapt = adaptDir !== undefined ? loadAdaptConfig(adaptDir, warn) : undefined
      const effective = mergeAdaptConfig(config, adapt)
      if (!effective.enabled || (!effective.loadSkills && !effective.loadAgents)) return []
      const adaptSkillsDir = effective.loadSkills && root !== undefined ? join(root.path, config.adaptDir, 'skills') : undefined
      const discovered = discoverClaudeSkills(root?.claudeDir, { skills: effective.loadSkills, agents: effective.loadAgents }, warn, adaptSkillsDir, userClaudeDir)
      return discovered.map(toCandidate)
    },
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator as ClaudeSkillLocator
      try {
        const content = readFileSync(locator.absPath, 'utf8')
        const { meta, body } = splitFrontmatter(content)
        if (locator.kind === 'skill') {
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
            resourceBase: locator.dir !== '' ? { kind: 'directory', path: locator.dir } : undefined,
          }
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
          metadata: meta ?? {},
        }
      } catch (error) {
        warn?.(`dsh-claude-in: cannot load claude skill ${locator.absPath}: ${errorMessage(error)}`)
        return undefined
      }
    },
  }
}

function toCandidate(entry: DiscoveredClaudeSkill): SkillCandidate {
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    source: entry.source,
    provider: PROVIDER_NAME,
    rank: entry.rank,
    locator: entry.locator,
    path: entry.locator.absPath,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}
