/**
 * `.claude/rules/**​/*.md` 发现、@import 展开与渲染。
 * 纯函数 + node:fs，不依赖 DSH 运行时（可单测）。
 *
 * Claude Code 规则语义（适配 wm-proj 约定）：
 *  - `alwaysApply: true` → 基线注入；
 *  - `paths` / `globs` → 文件命中时按需注入；
 *  - 两者皆无 → 默认 alwaysApply（可配 defaultAlwaysApply=false 改为“按需列出”）；
 *  - `enabled: false` → 跳过；
 *  - `@path`（文件或目录）导入行在渲染前展开（相对规则文件，`~` → 家目录）。
 * @module dsh-claude-in/rules
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { splitFrontmatter, errorMessage, stringList, optionalString, optionalBoolean, toolList } from './frontmatter.ts'
import { globMatches } from './glob.ts'

export interface RuleFile {
  /** 绝对路径。 */
  absPath: string
  /** 来源层级：project（工作区 .claude）或 user（~/.claude）。 */
  level: 'project' | 'user'
  /** 相对 `.claude/rules` 的 POSIX 路径（含子目录）。 */
  relPath: string
  /** 规则名（relPath 去掉 .md）。 */
  name: string
  description?: string
  /** 是否基线（always）规则。 */
  alwaysApply: boolean
  /** paths+globs 合并后的模式列表（path-scoped 规则）。 */
  globs: string[]
  enabled: boolean
  /** 展开 @import 后的正文。 */
  content: string
  /** 原始文件字节数。 */
  rawBytes: number
  /** frontmatter 解析错误（规则仍可加载，正文保留）。 */
  metaError?: string
  /** Claude Code allowed-tools 字段（透传展示）。 */
  allowedTools?: string[]
}

export interface RuleOptions {
  /** 单条规则源文件读取上限（UTF-8 字节）。 */
  maxSourceBytes: number
  /** @import 展开最大深度。 */
  importMaxDepth: number
  /** 无 paths/globs 且无 alwaysApply 时是否视为基线。 */
  defaultAlwaysApply: boolean
  /** 警告回调（插件注入 ctx.logger.warn 或 console）。 */
  warn?: (message: string) => void
}

export interface RuleDiscovery {
  /** 全部启用规则。 */
  rules: RuleFile[]
  /** 基线（always）规则。 */
  always: RuleFile[]
  /** path-scoped 规则（globs 非空且非 always）。 */
  scoped: RuleFile[]
  /** 按需可列出的规则（有 frontmatter 描述、非 always、无 globs）。 */
  requestable: RuleFile[]
}

const MAX_DEPTH = 12

/** 递归扫描 `<claudeDir>/rules` 下全部 `.md`。level 标注项目/用户来源。 */
export function discoverRules(claudeRoot: string, options: RuleOptions, level: 'project' | 'user' = 'project'): RuleDiscovery {
  const rulesDir = join(claudeRoot, 'rules')
  const files: string[] = []
  walkMd(rulesDir, rulesDir, files, 0, options.warn)
  const rules: RuleFile[] = []
  for (const file of files) {
    const rule = loadRule(file, rulesDir, options, level)
    if (rule) rules.push(rule)
  }
  const always: RuleFile[] = []
  const scoped: RuleFile[] = []
  const requestable: RuleFile[] = []
  for (const rule of rules) {
    if (rule.alwaysApply) always.push(rule)
    else if (rule.globs.length > 0) scoped.push(rule)
    else requestable.push(rule)
  }
  return { rules, always, scoped, requestable }
}

function walkMd(dir: string, root: string, out: string[], depth: number, warn?: RuleOptions['warn']): void {
  if (depth > MAX_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    warn?.(`dsh-claude-in: cannot scan rules dir ${dir}: ${errorMessage(error)}`)
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (entry.isDirectory() || stat.isDirectory()) {
      walkMd(abs, root, out, depth + 1, warn)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(abs)
    }
  }
}

function loadRule(absPath: string, rulesDir: string, options: RuleOptions, level: 'project' | 'user'): RuleFile | undefined {
  let content: string
  try {
    content = readFileSync(absPath, 'utf8')
  } catch (error) {
    options.warn?.(`dsh-claude-in: cannot read rule ${absPath}: ${errorMessage(error)}`)
    return undefined
  }
  const rawBytes = Buffer.byteLength(content, 'utf8')
  if (rawBytes > options.maxSourceBytes) {
    content = content.slice(0, options.maxSourceBytes)
  }
  const relPath = relative(rulesDir, absPath).replace(/\\/g, '/')
  const name = relPath.replace(/\.md$/, '')
  const { meta, body, metaError } = splitFrontmatter(content)

  const globs = [...stringList(meta, 'paths'), ...stringList(meta, 'globs')]
  const alwaysMeta = optionalBoolean(meta, 'alwaysApply')
  const enabled = optionalBoolean(meta, 'enabled') ?? true
  const alwaysApply = enabled && (alwaysMeta ?? (globs.length === 0 ? options.defaultAlwaysApply : false))

  const expanded = expandImports(body, dirname(absPath), options, new Set(), 0)

  return {
    absPath,
    level,
    relPath,
    name,
    description: optionalString(meta, 'description'),
    alwaysApply,
    globs,
    enabled,
    content: expanded.content,
    rawBytes,
    metaError,
    allowedTools: toolList(meta, 'allowed-tools'),
  }
}

interface Expanded { content: string; warnings: string[] }

/** 展开 `@path` 导入行（文件或目录；相对导入文件；`~` → 家目录）。 */
export function expandImports(
  text: string,
  baseDir: string,
  options: RuleOptions,
  visited: Set<string>,
  depth: number,
): Expanded {
  if (depth > options.importMaxDepth) return { content: text, warnings: ['import depth exceeded'] }
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const warnings: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('@') || trimmed.length < 2) {
      out.push(line)
      continue
    }
    const target = trimmed.slice(1).trim()
    const resolved = resolveImportTarget(target, baseDir)
    if (resolved === undefined) {
      out.push(line)
      warnings.push(`cannot resolve import "${target}" from ${baseDir}`)
      continue
    }
    if (visited.has(resolved)) {
      warnings.push(`import cycle at ${resolved}`)
      continue
    }
    visited.add(resolved)
    try {
      const stat = statSync(resolved)
      if (stat.isDirectory()) {
        const files: string[] = []
        walkMd(resolved, resolved, files, 0)
        for (const file of files) {
          const imported = expandImports(readFileSync(file, 'utf8'), dirname(file), options, visited, depth + 1)
          out.push(imported.content)
          warnings.push(...imported.warnings)
        }
      } else if (stat.isFile()) {
        const imported = expandImports(readFileSync(resolved, 'utf8'), dirname(resolved), options, visited, depth + 1)
        out.push(imported.content)
        warnings.push(...imported.warnings)
      }
    } catch (error) {
      warnings.push(`cannot import ${resolved}: ${errorMessage(error)}`)
    }
    visited.delete(resolved)
  }
  return { content: out.join('\n'), warnings }
}

function resolveImportTarget(target: string, baseDir: string): string | undefined {
  let path = target
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  else if (path.startsWith('~')) return undefined
  const resolved = resolve(baseDir, path)
  return existsSync(resolved) ? resolved : undefined
}

/** 基线渲染：always 规则 + 按需规则目录。字节预算内按顺序保留。 */
export function renderBaseline(discovery: RuleDiscovery, claudeRoot: string, maxBytes: number): string {
  const parts: string[] = []
  parts.push('<claude_workspace_rules>')
  parts.push('These rules are loaded from the project .claude/rules and the user ~/.claude/rules (level=project | level=user). Follow the instructions in each subsection.')
  if (discovery.always.length > 0) {
    parts.push('<always_applied_workspace_rules>')
    for (const rule of discovery.always) parts.push(renderRule(rule, 'always'))
    parts.push('</always_applied_workspace_rules>')
  }
  if (discovery.requestable.length > 0) {
    parts.push('<agent_requestable_workspace_rules>')
    parts.push('The rules below are not loaded by default. Read the rule file with the read tool when its description matches the task.')
    for (const rule of discovery.requestable) {
      parts.push(`<rule name="${escapeAttr(rule.name)}"${rule.description ? ` description="${escapeAttr(rule.description)}"` : ''} path="${escapeAttr(rule.relPath)}"/>`)
    }
    parts.push('</agent_requestable_workspace_rules>')
  }
  parts.push('</claude_workspace_rules>')
  return budgetJoin(parts, maxBytes)
}

/** path-scoped 规则命中渲染（某文件被 read/write/edit 时）。 */
export function renderTouched(scoped: RuleFile[], claudeRoot: string, relFile: string, maxBytes: number): string {
  const parts: string[] = []
  parts.push('<claude_workspace_rules>')
  parts.push(`Path-scoped rules for ${relFile} (from ${claudeRoot}/.claude/rules):`)
  for (const rule of scoped) {
    if (rule.globs.length === 0 || !globMatches(rule.globs, relFile)) continue
    parts.push(renderRule(rule, 'path-scoped'))
  }
  parts.push('</claude_workspace_rules>')
  return budgetJoin(parts, maxBytes)
}

/** 命中 `relFile` 的 path-scoped 规则列表。 */
export function matchingScoped(scoped: RuleFile[], relFile: string): RuleFile[] {
  return scoped.filter((rule) => rule.globs.length > 0 && globMatches(rule.globs, relFile))
}

function renderRule(rule: RuleFile, kind: 'always' | 'path-scoped'): string {
  const header = [
    `name="${escapeAttr(rule.name)}"`,
    `level="${rule.level}"`,
    rule.description ? `description="${escapeAttr(rule.description)}"` : '',
    rule.allowedTools && rule.allowedTools.length > 0 ? `allowed-tools="${escapeAttr(rule.allowedTools.join(', '))}"` : '',
    kind === 'path-scoped' ? `path="${escapeAttr(rule.relPath)}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `<rule ${header}>\n${rule.content.trim()}\n</rule>`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
}

/** 在字节预算内按顺序拼接；单条超预算时截断正文而非整条丢弃（规则标签始终保留）。 */
function budgetJoin(parts: string[], maxBytes: number): string {
  let result = ''
  for (const part of parts) {
    if (result === '') {
      result = truncateUtf8(part, maxBytes)
      continue
    }
    const sep = '\n\n'
    const remaining = maxBytes - Buffer.byteLength(result + sep, 'utf8')
    if (remaining <= 0) break
    const fitted = truncateUtf8(part, remaining)
    if (fitted === '') break
    result += sep + fitted
  }
  return result
}

/** UTF-8 安全截断；`</rule>` 块保留闭合标签并在正文尾部加注记。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = text.endsWith('</rule>') ? '</rule>' : ''
  const body = suffix === '' ? text : text.slice(0, -suffix.length)
  const note = `\n(truncated to fit context budget)\n${suffix}`
  const available = maxBytes - Buffer.byteLength(note, 'utf8')
  if (available <= 0) return ''
  let out = ''
  for (const ch of body) {
    const next = out + ch
    if (Buffer.byteLength(next, 'utf8') > available) break
    out = next
  }
  return out + note
}

export function relPathOf(root: string, absPath: string): string | undefined {
  const rel = relative(root, absPath)
  if (rel.startsWith('..') || rel === '..' || rel.startsWith('/')) return undefined
  return rel.replace(/\\/g, '/')
}
