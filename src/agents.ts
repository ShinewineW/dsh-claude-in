/**
 * `.claude/agents/**​/*.md` 的模型面向渲染：
 *  - 基线目录（名字/描述/模型/工具，省 token）；
 *  - 完整定义（subagent 委托时经 skill 工具载入）。
 * @module dsh-claude-in/agents
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { splitFrontmatter, errorMessage, optionalString, toolList } from './frontmatter.ts'

export interface ClaudeAgent {
  /** frontmatter name 或相对路径。 */
  name: string
  /** 来源层级：project（工作区 .claude）或 user（~/.claude）。 */
  level: 'project' | 'user'
  description: string
  /** frontmatter model（alias 或 inherit）。 */
  model?: string
  /** frontmatter tools（逗号分隔列表）。 */
  tools: string[]
  absPath: string
  relPath: string
  body: string
  meta: Record<string, unknown>
}

export function discoverAgents(claudeDir: string, warn?: (m: string) => void, level: 'project' | 'user' = 'project'): ClaudeAgent[] {
  const root = join(claudeDir, 'agents')
  const files: string[] = []
  walkAgentFiles(root, files, 0)
  const agents: ClaudeAgent[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const agent = loadAgent(file, root, warn, level)
    if (!agent) continue
    if (seen.has(agent.name)) {
      warn?.(`dsh-claude-in: duplicate agent name "${agent.name}" — keeping the first`)
      continue
    }
    seen.add(agent.name)
    agents.push(agent)
  }
  return agents
}

/** 项目级 + 用户级 agents 合并（项目同名优先）。 */
export function mergeAgents(project: ClaudeAgent[], user: ClaudeAgent[]): ClaudeAgent[] {
  const result = [...project]
  const known = new Set(project.map((a) => a.name))
  for (const agent of user) {
    if (known.has(agent.name)) continue
    known.add(agent.name)
    result.push(agent)
  }
  return result
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

function loadAgent(file: string, root: string, warn?: (m: string) => void, level: 'project' | 'user' = 'project'): ClaudeAgent | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    warn?.(`dsh-claude-in: cannot read agent ${file}: ${errorMessage(error)}`)
    return undefined
  }
  const rel = relative(root, file).replace(/\\/g, '/')
  const fallbackName = rel.replace(/\.md$/, '')
  const { meta, body, metaError } = splitFrontmatter(content)
  if (metaError) warn?.(`dsh-claude-in: invalid frontmatter in ${file}: ${metaError}`)
  const name = optionalString(meta, 'name') ?? fallbackName
  const description = optionalString(meta, 'description') ?? ''
  return {
    name,
    level,
    description,
    model: optionalString(meta, 'model'),
    tools: toolList(meta, 'tools'),
    absPath: file,
    relPath: rel,
    body,
    meta: meta ?? {},
  }
}

/** 基线目录块（模型可见的代理清单）。 */
export function renderAgentCatalog(agents: ClaudeAgent[], claudeRoot: string): string {
  if (agents.length === 0) return ''
  const lines: string[] = [
    '<claude_agents>',
    `These agents are defined in the project .claude and user ~/.claude (level=project | level=user; project wins on name conflicts) and may be delegated to.`,
    'To use one: call the skill tool with the listed skill name to load the full agent definition, then delegate via the subagent tool, prefixing the child prompt with that definition and instructing the child to act as the named agent.',
  ]
  for (const agent of agents) {
    const attrs = [
      `name="${escapeAttr(agent.name)}"`,
      `level="${agent.level}"`,
      agent.description !== '' ? `description="${escapeAttr(agent.description)}"` : '',
      agent.model !== undefined ? `model="${escapeAttr(agent.model)}"` : '',
      agent.tools.length > 0 ? `tools="${escapeAttr(agent.tools.join(', '))}"` : '',
      `skill="claude-agent-${agent.name.split('/').map(kebab).join('-')}"`,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`<agent ${attrs}/>`)
  }
  lines.push('</claude_agents>')
  return lines.join('\n')
}

/** 完整 agent 定义（skill 工具载入时的正文）。 */
export function renderAgentDefinition(name: string, description: string, meta: Record<string, unknown>, body: string): string {
  const model = optionalString(meta, 'model')
  const tools = toolList(meta, 'tools')
  const lines: string[] = ['<agent_definition>', `name: ${name}`]
  if (description !== '') lines.push(`description: ${description}`)
  if (model !== undefined) lines.push(`model: ${model}`)
  if (tools.length > 0) lines.push(`tools: ${tools.join(', ')}`)
  lines.push('', '<system_prompt>', body.trim(), '</system_prompt>', '</agent_definition>')
  return lines.join('\n')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
}

/** 与 skills.ts 共享的 kebab 化（避免循环依赖，在此独立实现）。 */
export function kebab(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
