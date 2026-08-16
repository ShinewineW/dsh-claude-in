/**
 * dsh-claude-in — 打开工作区时自动载入 `.claude` 配置。
 *
 * 在会话 cwd 只检查当前工作区根的 `.claude`（不向上探测），并固定附加用户级
 * `~/.claude`，然后：
 *  - rules       —— `.claude/rules/**​/*.md`：always 规则进基线上下文，
 *                  paths/globs 规则在 read/write/edit 命中时按需注入；
 *  - skills      —— `.claude/skills/**​/SKILL.md` 与 `~/.claude/skills/**​/SKILL.md`
 *                  注册为技能（对齐 Claude Code：personal 优先于 project）；
 *  - hooks       —— settings.json / settings.local.json / hooks.json 的 command
 *                  hooks 映射到 DSH seams（SessionStart / UserPromptSubmit /
 *                  PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop）；
 *  - agents      —— `.claude/agents/**​/*.md`：基线目录 + 每个 agent 一个
 *                  `claude-agent-*` skill，供 subagent 工具委托时取用定义。
 *
 * 不复制、不改写工作区任何文件。
 * @module dsh-claude-in
 */
import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createUserMessage } from './compat.ts'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { findClaudeRoot, findUserClaudeRoot } from './discovery.ts'
import type { ClaudeRoot } from './discovery.ts'
import { discoverRules, renderBaseline, matchingScoped, renderTouched, relPathOf } from './rules.ts'
import type { RuleDiscovery, RuleFile } from './rules.ts'
import { createClaudeSkillProvider, PROVIDER_NAME } from './skills.ts'
import { discoverAgents, renderAgentCatalog, mergeAgents } from './agents.ts'
import type { ClaudeAgent } from './agents.ts'
import { applyHooks } from './hooks.ts'
import { loadAdaptConfig, mergeAdaptConfig } from './adapt.ts'
import { errorMessage } from './frontmatter.ts'

export const name = 'dsh-claude-in'
export const inject = ['skills', 'shell']
export { Config, resolveConfig }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-claude-in': {
      kind: 'dsh-claude-in'
      plugin: 'dsh-claude-in'
      form: 'instructions'
      origin: 'claude-rules' | 'claude-agents' | 'claude-md' | 'claude-hooks'
      claudeRoot?: string
    }
  }
}

interface SessionState {
  root?: ClaudeRoot
  userRoot?: ClaudeRoot
  config: ResolvedConfig
  discovery: RuleDiscovery
  agents: ClaudeAgent[]
  injectedScoped: Set<string>
}

const EMPTY_DISCOVERY: RuleDiscovery = { rules: [], always: [], scoped: [], requestable: [] }

/** 项目级 + 用户级规则合并（项目在前，预算截断时项目优先）。 */
function mergeDiscovery(project: RuleDiscovery, user: RuleDiscovery): RuleDiscovery {
  return {
    rules: [...project.rules, ...user.rules],
    always: [...project.always, ...user.always],
    scoped: [...project.scoped, ...user.scoped],
    requestable: [...project.requestable, ...user.requestable],
  }
}

export function apply(ctx: Context, raw?: Config): void {
  const config = resolveConfig(raw)
  if (!config.enabled) return
  const warn = (message: string): void => ctx.logger.warn(message)
  ctx.logger.info(`dsh-claude-in: enabled (claudeDir=${config.claudeDir}, rules=${config.loadRules}, skills=${config.loadSkills}, agents=${config.loadAgents}, hooks=${config.loadHooks})`)

  // ── skills provider（.claude/skills + agents-as-skill）──────────────────
  if (config.loadSkills || config.loadAgents) {
    const skills = ctx.get('skills') as SkillRegistry | undefined
    if (skills === undefined) {
      warn('dsh-claude-in: ctx.skills unavailable — skill/agent loading skipped')
    } else {
      ctx.effect(
        () => skills.registerProvider(() => createClaudeSkillProvider(config, warn)),
        'dsh-claude-in.skills',
      )
    }
  }

  // ── 会话状态与基线缓存 ─────────────────────────────────────────────────
  const sessions = new WeakMap<object, SessionState>()

  interface BaselineCacheEntry {
    state: SessionState
    loadedAt: number
    fingerprint: string
  }
  const baselineCache = new Map<string, BaselineCacheEntry>()
  const BASELINE_TTL_MS = 30000

  const fingerprint = (root: ClaudeRoot | undefined, userRoot: ClaudeRoot | undefined): string => {
    const parts: string[] = []
    for (const r of [root, userRoot]) {
      if (r === undefined) {
        parts.push('no-root')
        continue
      }
      parts.push(String(r.mtimeMs))
      for (const sub of ['rules', 'agents', 'skills']) {
        try {
          parts.push(String(statSync(join(r.claudeDir, sub)).mtimeMs))
        } catch {
          parts.push('absent')
        }
      }
    }
    if (root !== undefined) {
      try {
        parts.push(String(statSync(join(root.path, config.adaptDir, 'dsh-claude-in.yml')).mtimeMs))
      } catch {
        parts.push('no-adapt')
      }
    }
    return parts.join(':')
  }

  const ruleOptions = (effective: ResolvedConfig): Parameters<typeof discoverRules>[1] => ({
    maxSourceBytes: effective.ruleMaxSourceBytes,
    importMaxDepth: effective.ruleImportMaxDepth,
    defaultAlwaysApply: effective.defaultAlwaysApply,
    warn,
  })

  const loadSessionState = (agent: any): SessionState | undefined => {
    const cwd = agent?.session?.header?.cwd
    if (cwd === undefined) return undefined
    const root = findClaudeRoot(cwd, config.claudeDir)
    let userRoot = findUserClaudeRoot()
    // 项目根即家目录时，用户级与项目级是同一份，只载一次
    if (userRoot !== undefined && root !== undefined && userRoot.path === root.path) userRoot = undefined
    if (root === undefined && userRoot === undefined) return undefined

    const adapt = root !== undefined ? loadAdaptConfig(join(root.path, config.adaptDir), warn) : undefined
    const effective = mergeAdaptConfig(config, adapt)
    if (!effective.enabled) return undefined

    const cacheKey = `${root?.path ?? ''}|${userRoot?.path ?? ''}`
    const fp = fingerprint(root, userRoot)
    const cached = baselineCache.get(cacheKey)
    if (cached && cached.fingerprint === fp && Date.now() - cached.loadedAt < BASELINE_TTL_MS) {
      return cached.state
    }
    const projectDiscovery = effective.loadRules && root !== undefined
      ? discoverRules(root.claudeDir, ruleOptions(effective), 'project')
      : EMPTY_DISCOVERY
    const userDiscovery = effective.loadRules && userRoot !== undefined
      ? discoverRules(userRoot.claudeDir, ruleOptions(effective), 'user')
      : EMPTY_DISCOVERY
    const discovery = mergeDiscovery(projectDiscovery, userDiscovery)
    const projectAgents = effective.loadAgents && root !== undefined ? discoverAgents(root.claudeDir, warn, 'project') : []
    const userAgents = effective.loadAgents && userRoot !== undefined ? discoverAgents(userRoot.claudeDir, warn, 'user') : []
    const agents = mergeAgents(projectAgents, userAgents)
    const state: SessionState = { root, userRoot, config: effective, discovery, agents, injectedScoped: new Set() }
    baselineCache.set(cacheKey, { state, loadedAt: Date.now(), fingerprint: fp })
    return state
  }

  const buildBaseline = (state: SessionState, config: ResolvedConfig): string | undefined => {
    const parts: string[] = []
    if (config.loadRules) {
      const rendered = renderBaseline(state.discovery, state.root?.path ?? state.userRoot?.path ?? '', config.rulesMaxBytes)
      if (rendered !== '') parts.push(rendered)
    }
    if (config.loadAgents && state.agents.length > 0) {
      const catalog = renderAgentCatalog(state.agents, state.root?.path ?? state.userRoot?.path ?? '')
      if (catalog !== '') parts.push(catalog)
    }
    if (parts.length === 0) return undefined
    return parts.join('\n\n')
  }

  const injectBaseline = (agent: any): void => {
    const state = loadSessionState(agent)
    if (state === undefined) return
    sessions.set(agent.session, state)
    const text = buildBaseline(state, state.config)
    if (text === undefined || text === '') return
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'dsh-claude-in',
        plugin: 'dsh-claude-in',
        form: 'instructions',
        origin: 'claude-rules',
        claudeRoot: state.root?.path ?? state.userRoot?.path,
      },
    })
    agent.inject(message)
    const roots = [state.root?.claudeDir, state.userRoot?.claudeDir].filter((p): p is string => p !== undefined).join(' + ')
    ctx.logger.info(`dsh-claude-in: injected baseline (.claude: ${roots}; rules=${state.discovery.rules.length}, agents=${state.agents.length})`)
  }

  if (config.loadRules || config.loadAgents) {
    ctx.on('agent/session-start', ({ agent }) => {
      try {
        injectBaseline(agent)
      } catch (error) {
        warn(`dsh-claude-in: baseline injection failed: ${errorMessage(error)}`)
      }
    })
  }

  // ── path-scoped 规则：read/write/edit 命中文件时注入 ────────────────────
  if (config.loadRules) {
    const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])
    const filePathFromExecution = (exec: any): string | undefined => {
      if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
      if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
      if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
      const filePath = exec.arguments.file_path.trim()
      return filePath.length > 0 ? filePath : undefined
    }

    ctx.on('tools/result', (exec: any, result: any) => {
      try {
        const agent = exec.agent
        if (agent === undefined) return
        const state = sessions.get(agent.session)
        if (state === undefined) return
        const filePath = filePathFromExecution(exec)
        if (filePath === undefined) return
        const cwd = agent.session.header.cwd ?? process.cwd()
        const abs = resolve(cwd, filePath)
        const anchor = state.root?.path ?? cwd
        const rel = relPathOf(anchor, abs)
        if (rel === undefined) return
        const hits = matchingScoped(state.discovery.scoped, rel).filter((rule) => !state.injectedScoped.has(rule.absPath))
        if (hits.length === 0) return
        for (const rule of hits) state.injectedScoped.add(rule.absPath)
        const text = renderTouched(hits, anchor, rel, state.config.rulesMaxBytes)
        if (text === '') return
        agent.inject(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'dsh-claude-in',
              plugin: 'dsh-claude-in',
              form: 'instructions',
              origin: 'claude-rules',
              claudeRoot: state.root?.path ?? state.userRoot?.path,
            },
          }),
        )
        ctx.logger.info(`dsh-claude-in: injected ${hits.length} path-scoped rule(s) for ${rel} (${hits.map((r) => r.name).join(', ')})`)
      } catch (error) {
        warn(`dsh-claude-in: path-scoped rule injection failed: ${errorMessage(error)}`)
      }
    })
  }

  // ── hooks ───────────────────────────────────────────────────────────────
  if (config.loadHooks) {
    if (ctx.get('shell') === undefined) {
      warn('dsh-claude-in: ctx.shell unavailable — hooks skipped')
    } else {
      applyHooks(ctx, config)
    }
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
}

export { PROVIDER_NAME }
