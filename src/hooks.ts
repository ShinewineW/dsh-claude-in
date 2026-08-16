/**
 * Claude Code command-hooks 执行器（per-session 版）。
 *
 * 语义对齐官方 bridge `@deepseek-ai/dsh-hooks-claude-code@0.1.0-rc.6`
 * （BSD-3-Clause，本文件为改写实现）：
 *  - 配置来源：`.claude/settings.json` + `.claude/settings.local.json` +
 *    `.claude/hooks.json`（local 按事件覆盖 settings，settings 覆盖 hooks.json）；
 *  - 7 个事件映射到 DSH seams：SessionStart→agent/session-start，
 *    UserPromptSubmit→agent/pre-step，PreToolUse→tools/pre-execute，
 *    PostToolUse→tools/post-execute，Stop→agent/turn-stopping，
 *    SubagentStart/Stop→subagent/start、subagent/end；
 *  - 只对会话 cwd 所属 `.claude` 项目生效（官方 bridge 是进程级单一配置，
 *    这里是 per-session 发现 + 过滤）；
 *  - 仅 `type: 'command'` hook 运行，其他类型跳过并告警；
 *  - `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_PLUGIN_ROOT}` 替换为项目根；
 *  - stdin 为 Claude Code JSON payload；退出码 2 = 阻塞；
 *    `permissionDecision` / `additionalContext` 按 bridge 语义折叠。
 * @module dsh-claude-in/hooks
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage } from './compat.ts'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  matchesMatcher,
  matcherDiagnostic,
  mergeHookOutputs,
  runHook,
} from '@deepseek-ai/dsh-hook-protocol'
import type { CommandHook, MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { findClaudeRoot } from './discovery.ts'
import type { ResolvedConfig } from './config.ts'
import { loadAdaptConfig, mergeAdaptConfig, applyHookCommandOverrides } from './adapt.ts'
import { errorMessage } from './frontmatter.ts'

export const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

export type ClaudeHookEvent = (typeof CLAUDE_EVENTS)[number]

export interface HookConfig {
  /** 项目根（cwd 过滤依据）。 */
  root: string
  /** 每事件 matcher 组。 */
  events: Record<string, MatcherGroup[]>
}

interface ParseResult {
  config: Record<string, MatcherGroup[]>
  skipped: { event: string; type: string }[]
}

interface HookRunOptions {
  agent?: any
  turn?: number
  signal: AbortSignal
}

/** 解析 CC 格式（settings.hooks 或裸事件表）。仅 command hook 运行。 */
export function parseClaudeConfig(raw: unknown, vars: { pluginRoot?: string; projectDir?: string } = {}): ParseResult {
  const config: Record<string, MatcherGroup[]> = {}
  const skipped: { event: string; type: string }[] = []
  const root = asObject(raw)
  const hooksMap = root ? (asObject(root.hooks) ?? root) : undefined
  if (!hooksMap) return { config, skipped }
  for (const event of CLAUDE_EVENTS) {
    const value = hooksMap[event]
    if (!Array.isArray(value)) continue
    for (const groupRaw of value) {
      const group = asObject(groupRaw)
      if (!group) continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      if (matcher !== undefined) {
        const diagnostic = matcherDiagnostic(matcher, 'claude-code')
        if (diagnostic !== undefined) {
          throw new SyntaxError(`invalid matcher "${matcher}" on ${event}: ${diagnostic}`)
        }
      }
      const hooks = Array.isArray(group.hooks) ? group.hooks : []
      const commands: CommandHook[] = []
      for (const hookRaw of hooks) {
        const hook = asObject(hookRaw)
        if (!hook) continue
        if (hook.type !== undefined && hook.type !== 'command') {
          skipped.push({ event, type: String(hook.type) })
          continue
        }
        if (typeof hook.command !== 'string' || hook.command.trim() === '') {
          skipped.push({ event, type: 'malformed' })
          continue
        }
        let command = substituteCommand(hook.command, vars)
        const timeoutSec = typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : undefined
        commands.push({ command, timeoutSec })
      }
      if (commands.length > 0) {
        ;(config[event] ??= []).push({ matcher, hooks: commands })
      }
    }
  }
  return { config, skipped }
}

function substituteCommand(command: string, vars: { pluginRoot?: string; projectDir?: string }): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** 读取并合并项目 hook 配置；无 hooks 时返回 undefined。 */
export function loadHookConfig(claudeDir: string, root: string, warn?: (m: string) => void): HookConfig | undefined {
  const sources: Array<{ file: string; raw: unknown }> = []
  const hooksJson = join(claudeDir, 'hooks.json')
  const settingsJson = join(claudeDir, 'settings.json')
  const settingsLocalJson = join(claudeDir, 'settings.local.json')
  for (const file of [hooksJson, settingsJson, settingsLocalJson]) {
    if (!existsSync(file)) continue
    try {
      sources.push({ file, raw: JSON.parse(readFileSync(file, 'utf8')) })
    } catch (error) {
      warn?.(`dsh-claude-in: cannot parse hook config ${file}: ${errorMessage(error)}`)
    }
  }
  if (sources.length === 0) return undefined

  // 按事件追加：hooks.json < settings.json < settings.local.json
  const merged: Record<string, unknown> = {}
  for (const source of sources) {
    const raw = asObject(source.raw)
    const hooks = raw ? (asObject(raw.hooks) ?? raw) : undefined
    if (!hooks) continue
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue
      const prev = merged[event]
      merged[event] = Array.isArray(prev) ? [...prev, ...value] : value
    }
  }

  const vars = { pluginRoot: root, projectDir: root }
  try {
    const { config, skipped } = parseClaudeConfig(merged, vars)
    for (const skip of skipped) {
      warn?.(`dsh-claude-in: skipping unsupported "${skip.type}" hook on ${skip.event} (only command hooks run)`)
    }
    const hasAny = Object.values(config).some((groups) => groups.length > 0)
    if (!hasAny) return undefined
    return { root, events: config }
  } catch (error) {
    warn?.(`dsh-claude-in: hook config invalid: ${errorMessage(error)} — no hooks registered`)
    return undefined
  }
}

/** 用户级 `~/.claude` hook 配置（全局生效；命令在当前项目上下文中解析）。 */
export function loadUserHookConfig(home = homedir(), warn?: (m: string) => void, projectDir = home): HookConfig | undefined {
  const claudeDir = join(home, '.claude')
  if (!existsSync(claudeDir)) return undefined
  return loadHookConfig(claudeDir, projectDir, warn)
}

/** 用户级 hook 配置源文件指纹（缓存失效依据）。 */
function userHookFingerprint(home: string): string {
  const claudeDir = join(home, '.claude')
  return ['settings.json', 'settings.local.json', 'hooks.json']
    .map((name) => {
      try {
        return String(statSync(join(claudeDir, name)).mtimeMs)
      } catch {
        return 'absent'
      }
    })
    .join(':')
}

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-claude-in' } as const

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `dsh-claude-in:${point}:${++handlerCounter}`
}

/** 会话是否属于该项目根（cwd 过滤）。 */
function sessionInRoot(cwd: string | undefined, root: string): boolean {
  if (cwd === undefined) return false
  const rel = relative(root, cwd)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export function applyHooks(ctx: Context, config: ResolvedConfig): void {
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) return // 无 shell 服务：不注册任何 hook 监听
  const warn = (message: string): void => ctx.logger.warn(message)
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  const defaultTimeoutMs = config.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const detached = createDetachedRuns()
  ctx.effect(() => () => detached.drain(), 'dsh-claude-in: drain detached hook runs')
  const subagentChildren = new Map<string, any>()

  const configCache = new Map<string, HookConfig | undefined>()
  const hookConfigFor = (cwd: string | undefined): HookConfig | undefined => {
    if (cwd === undefined) return undefined
    const home = homedir()
    const root = findClaudeRoot(cwd, config.claudeDir)
    // 项目根即家目录时用户级与项目级同一份，只载一次
    const userIsProject = root !== undefined && root.path === home
    const adaptDir = root !== undefined ? join(root.path, config.adaptDir) : undefined
    const adapt = adaptDir !== undefined ? loadAdaptConfig(adaptDir, warn) : undefined
    const effective = mergeAdaptConfig(config, adapt)
    if (!effective.loadHooks || !effective.enabled) return undefined

    // 项目级（cwd 过滤 + .dsn 适配覆盖）
    let projectConfig: HookConfig | undefined
    if (root !== undefined && !userIsProject) {
      const cached = configCache.get(root.claudeDir)
      projectConfig = cached !== undefined ? cached : (() => {
        const loaded = loadHookConfig(root.claudeDir, root.path, warn)
        const overridden = loaded !== undefined ? applyHookCommandOverrides(loaded, adapt) : undefined
        configCache.set(root.claudeDir, overridden)
        return overridden
      })()
    }

    // 用户级（全局；无项目 .claude 时也生效）
    let userConfig: HookConfig | undefined
    {
      const executionRoot = root?.path ?? cwd
      const fingerprint = `${executionRoot}:${userHookFingerprint(home)}`
      const cached = userConfigCache.get(fingerprint)
      userConfig = cached !== undefined ? cached : (() => {
        const loaded = loadUserHookConfig(home, warn, executionRoot)
        userConfigCache.set(fingerprint, loaded)
        return loaded
      })()
    }

    const projectEvents = projectConfig?.events ?? {}
    const userEvents = userConfig?.events ?? {}
    const events: Record<string, MatcherGroup[]> = {}
    for (const event of new Set([...Object.keys(projectEvents), ...Object.keys(userEvents)])) {
      events[event] = [...(projectEvents[event] ?? []), ...(userEvents[event] ?? [])]
    }
    if (Object.keys(events).length === 0) return undefined
    const mergedRoot = root?.path ?? cwd
    return { root: mergedRoot, events }
  }
  const userConfigCache = new Map<string, HookConfig | undefined>()
  const invalidate = (cwd: string | undefined): void => {
    if (cwd === undefined) return
    const root = findClaudeRoot(cwd, config.claudeDir)
    if (root) configCache.delete(root.claudeDir)
  }

  /** 运行某事件的全部匹配 command hook，返回最严格折叠结果。 */
  async function runPoint(
    hookConfig: HookConfig,
    point: ClaudeHookEvent,
    matchQuery: string,
    payload: unknown,
    opts: HookRunOptions,
  ): Promise<ReturnType<typeof mergeHookOutputs>> {
    const groups = hookConfig.events[point] ?? []
    const outputs: Awaited<ReturnType<typeof runHook>>['output'][] = []
    const workdir = opts.agent?.session?.header?.cwd
    const hookEnv = hookConfig.root !== undefined ? { CLAUDE_PROJECT_DIR: hookConfig.root } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn,
            point,
            dialect: 'claude-code',
            handlerId,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          })
        }
        const { output, durationMs } = await runHook(
          shell,
          hook,
          {
            payload,
            defaultTimeoutMs,
            ...(hookEnv ? { env: hookEnv } : {}),
            ...(workdir !== undefined ? { cwd: workdir } : {}),
            signal: opts.signal,
            trailingNewline: true,
            expectedEventName: point,
          },
          () => performance.now(),
        )
        outputs.push(output)
        if (output.updatedInput !== undefined) warn(`dsh-claude-in: ${point} hook requested updatedInput, which is not honored (ignored)`)
        if (output.systemMessage !== undefined) warn(`dsh-claude-in: ${point} hook emitted a systemMessage, which is not surfaced (ignored)`)
        if (session && opts.turn !== undefined) {
          appendHookResult(session, {
            turn: opts.turn,
            point,
            handlerId,
            output,
            stderrSummaryMaxChars,
            durationMs,
          })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  function contextFrom(merged: ReturnType<typeof mergeHookOutputs>) {
    if (merged.additionalContext.length === 0) return undefined
    return createUserMessage({
      content: merged.additionalContext.map((text) => ({ type: 'text', text })),
      source: { ...PLUGIN_SOURCE, form: 'instructions' },
    })
  }

  /** 会话对应的 hook 配置（含 cwd 过滤）。 */
  const configForAgent = (agent: any): HookConfig | undefined => {
    const cwd = agent?.session?.header?.cwd
    const hookConfig = hookConfigFor(cwd)
    if (hookConfig === undefined) return undefined
    return sessionInRoot(cwd, hookConfig.root) ? hookConfig : undefined
  }

  // SessionStart —— 不能阻塞，detached 运行，additionalContext → agent.inject
  ctx.on('agent/session-start', ({ agent, source }) => {
    invalidate(agent?.session?.header?.cwd)
    const hookConfig = configForAgent(agent)
    if (hookConfig === undefined) return
    detached.track(
      runPoint(hookConfig, 'SessionStart', source ?? '', sessionStartPayload(ctx, agent, source), {
        agent,
        signal: detached.signal,
      })
        .then((merged) => {
          const context = contextFrom(merged)
          if (context) agent.inject(context)
        })
        .catch((error) => {
          warn(`dsh-claude-in: SessionStart hook failed: ${errorMessage(error)}`)
        }),
    )
  })

  // UserPromptSubmit —— deny → reject；additionalContext 追加
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (messages.length === 0) return next()
    const hookConfig = configForAgent(agent)
    if (hookConfig === undefined) return next()
    const prompt = messages.flatMap((m: any) => m.content).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const merged = await runPoint(hookConfig, 'UserPromptSubmit', '', promptPayload(ctx, agent, prompt), {
      agent,
      turn,
      signal,
    })
    if (merged.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return { kind: 'enter', messages: [...downstream.messages, ours] }
  })

  // PreToolUse —— deny → PreToolDecision.deny；ask → PreToolDecision.ask
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined) return next()
    const hookConfig = configForAgent(exec.agent)
    if (hookConfig === undefined) return next()
    const turn = lastTurn(exec.agent)
    const merged = await runPoint(hookConfig, 'PreToolUse', exec.name, preToolPayload(ctx, exec), {
      agent: exec.agent,
      turn,
      signal: exec.signal,
    })
    if (merged.decision === 'deny') {
      return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    }
    if (merged.decision === 'ask') {
      return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) }
    }
    return next()
  })

  // PostToolUse —— deny → block + feedback；additionalContext 前置
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.agent === undefined) return next()
    const hookConfig = configForAgent(exec.agent)
    if (hookConfig === undefined) return next()
    const turn = lastTurn(exec.agent)
    const merged = await runPoint(hookConfig, 'PostToolUse', exec.name, postToolPayload(ctx, exec, result), {
      agent: exec.agent,
      turn,
      signal: exec.signal,
    })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        ...(context ? { additionalContexts: [context] } : {}),
      }
    }
    const downstream = await next()
    if (!context) return downstream
    return {
      ...downstream,
      additionalContexts: [context, ...(downstream.additionalContexts ?? [])],
    }
  })

  // Stop —— deny → steer 强制再来一步
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const hookConfig = configForAgent(agent)
    if (hookConfig === undefined) return
    const merged = await runPoint(hookConfig, 'Stop', '', stopPayload(ctx, agent), {
      agent,
      turn,
      signal,
    })
    if (merged.decision === 'deny') {
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { ...PLUGIN_SOURCE, form: 'instructions' },
        }),
      )
    }
  })

  // SubagentStart / SubagentStop —— observe + 向进程内 child 注入上下文
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get?.(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    const hookConfig = configForAgent(child)
    if (hookConfig === undefined) return
    detached.track(
      runPoint(hookConfig, 'SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), {
        ...(child ? { agent: child } : {}),
        signal: detached.signal,
      })
        .then((merged) => {
          const context = contextFrom(merged)
          if (context && child) child.inject(context)
        })
        .catch((error) => {
          warn(`dsh-claude-in: SubagentStart hook failed: ${errorMessage(error)}`)
        }),
    )
  })

  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get?.(info.id)
    subagentChildren.delete(info.runId)
    const hookConfig = configForAgent(child)
    if (hookConfig === undefined) return
    detached.track(
      runPoint(hookConfig, 'SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), {
        ...(child ? { agent: child } : {}),
        signal: detached.signal,
      }).catch((error) => {
        warn(`dsh-claude-in: SubagentStop hook failed: ${errorMessage(error)}`)
      }),
    )
  })
}

const SUBAGENT_TYPE = 'general-purpose'

function lastTurn(agent: any): number {
  if (!agent) return 0
  const events = [...agent.session.events]
  const last = events.findLast((e: any) => e.type === 'turn/start')
  return last?.type === 'turn/start' ? last.data.turn : 0
}

function blocksToText(content: readonly any[]): string {
  return content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
}

function base(ctx: Context, agent: any, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session?.header?.id ?? '',
    transcript_path: agent === undefined ? '' : ctx.get('sessionPersistence')?.locate?.(agent.session.header)?.path ?? '',
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(ctx: Context, agent: any, source: unknown): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionStart'), source }
}

function promptPayload(ctx: Context, agent: any, prompt: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt }
}

function preToolPayload(ctx: Context, exec: any): Record<string, unknown> {
  return {
    ...base(ctx, exec.agent, 'PreToolUse'),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
  }
}

function postToolPayload(ctx: Context, exec: any, result: any): Record<string, unknown> {
  return {
    ...base(ctx, exec.agent, 'PostToolUse'),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
    tool_response: blocksToText(result.content ?? []),
  }
}

function stopPayload(ctx: Context, agent: any): Record<string, unknown> {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: false }
}

function subagentPayload(ctx: Context, event: 'SubagentStart' | 'SubagentStop', info: any, child: any): Record<string, unknown> {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...(event === 'SubagentStop' ? { stop_hook_active: false } : {}),
  }
}
