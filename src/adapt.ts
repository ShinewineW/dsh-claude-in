/**
 * `.dsn` 适配层（DSH 专属，与 Claude 的 `.claude` SSOT 分离）。
 *
 * 原则（用户约束）：
 *  - `.claude` 本体（CLAUDE.md / rules / skills / hooks / agents）是 SSOT，
 *    插件只读、绝不写入、绝不复制；
 *  - 需要 DSH 适配时，在项目根建 `.dsn/`，适配内容只放这里；
 *  - rules / skills 等 SSOT 资产不得改动；唯一允许适配的是 hooks 里的命令
 *    （`from → to` 替换），且不得改变 hook 的功能（触发事件、语义不变，
 *    只是让命令跑在 DSH 环境里）。
 *
 * `.dsn/dsh-claude-in.yml`（YAML）支持：
 * ```yaml
 * enabled: true          # 本项目是否启用插件
 * loadRules: true        # 逐项开关（缺省继承全局配置）
 * loadSkills: true
 * loadAgents: true
 * loadHooks: true
 * hooks:                 # hooks 命令适配（SSOT 不变，仅运行时替换）
 *   PreToolUse:
 *     - from: "npx tsc --noEmit"          # .claude 里的原始命令
 *       to: "/root/.venv/bin/python ..."   # DSH 环境的等价实现
 * ```
 * @module dsh-claude-in/adapt
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { errorMessage } from './frontmatter.ts'
import type { ResolvedConfig } from './config.ts'
import type { HookConfig } from './hooks.ts'

export interface HookCommandOverride {
  from: string
  to: string
}

export interface AdaptConfig {
  enabled?: boolean
  loadClaudeMd?: boolean
  loadRules?: boolean
  loadSkills?: boolean
  loadAgents?: boolean
  loadHooks?: boolean
  hooks?: Record<string, HookCommandOverride[]>
}

/** 读取 `<adaptDir>/dsh-claude-in.yml`；不存在或解析失败返回 undefined。 */
export function loadAdaptConfig(adaptDir: string, warn?: (m: string) => void): AdaptConfig | undefined {
  const file = join(adaptDir, 'dsh-claude-in.yml')
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(file, 'utf8'))
  } catch (error) {
    warn?.(`dsh-claude-in: cannot parse adapt config ${file}: ${errorMessage(error)}`)
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn?.(`dsh-claude-in: adapt config ${file} must be a YAML object`)
    return undefined
  }
  return raw as AdaptConfig
}

/** 项目级有效配置 = 全局配置 ← 适配层覆盖（适配层只允许布尔开关与 hooks 覆盖）。 */
export function mergeAdaptConfig(global: ResolvedConfig, adapt: AdaptConfig | undefined): ResolvedConfig {
  if (adapt === undefined) return global
  const next: ResolvedConfig = { ...global }
  for (const key of ['enabled', 'loadClaudeMd', 'loadRules', 'loadSkills', 'loadAgents', 'loadHooks'] as const) {
    if (typeof adapt[key] === 'boolean') (next as unknown as Record<string, unknown>)[key] = adapt[key]
  }
  return next
}

/**
 * 对已解析的 hook 配置应用命令适配：按事件 + 原始命令字符串精确匹配替换。
 * 只替换命令文本，事件、matcher、timeout 均不变 —— hook 功能不变。
 */
export function applyHookCommandOverrides(hookConfig: HookConfig, adapt: AdaptConfig | undefined): HookConfig {
  if (adapt?.hooks === undefined) return hookConfig
  const events: Record<string, ReturnType<typeof overrideGroups>> = {}
  for (const [event, groups] of Object.entries(hookConfig.events)) {
    events[event] = overrideGroups(groups, adapt.hooks[event] ?? [])
  }
  return { ...hookConfig, events }
}

function overrideGroups(groups: HookConfig['events'][string], overrides: HookCommandOverride[]): HookConfig['events'][string] {
  if (overrides.length === 0) return groups
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((hook) => {
      const hit = overrides.find((o) => o.from === hook.command)
      return hit ? { ...hook, command: hit.to } : hook
    }),
  }))
}
