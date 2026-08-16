/**
 * 插件配置（普通对象 + 默认值解析，不引入 schema 依赖）。
 * @module dsh-claude-in/config
 */

export interface Config {
  /** 总开关。默认 true。 */
  enabled?: boolean
  /** Claude 目录名。默认 `.claude`。 */
  claudeDir?: string
  // CLAUDE.md 不在本插件加载范围（Skills/Rules/Hooks/Agents 四样）：
  // 项目级 CLAUDE.md 由 DSH 原生指令链（dsh-agent-instructions）加载。
  /** 载入 `.claude/rules/**​/*.md`。默认 true。 */
  loadRules?: boolean
  /** 基线/命中规则渲染字节预算（超出部分逐条截断正文、标签保留；项目规则优先，用户规则靠后先被截）。默认 131072（全量双层级常见的 ~100KB 规则量）。 */
  rulesMaxBytes?: number
  /** 单条规则源文件读取上限（UTF-8 字节，超出截断）。默认 65536。 */
  ruleMaxSourceBytes?: number
  /** `@import` 展开最大深度。默认 8。 */
  ruleImportMaxDepth?: number
  /** 无 frontmatter、且无 paths/globs 的规则默认视为 alwaysApply。默认 true（wm-proj 约定）。 */
  defaultAlwaysApply?: boolean
  /** 载入 `.claude/skills/**​/SKILL.md`。默认 true。 */
  loadSkills?: boolean
  /** 载入 `.claude/agents/**​/*.md`（基线目录 + 每个 agent 一个 skill）。默认 true。 */
  loadAgents?: boolean
  /** 载入 `.claude` hooks（settings.json / settings.local.json / hooks.json）。默认 true。 */
  loadHooks?: boolean
  /**
   * 项目级 DSH 适配层目录名（相对项目根；`.claude` SSOT 只读，适配只写/只读这里）。
   * 默认 `.dsn`。适配文件：`<adaptDir>/dsh-claude-in.yml`、`<adaptDir>/skills/**`。
   */
  adaptDir?: string
  /** hook 默认超时（ms），Claude Code 默认 600s。默认 600000。 */
  hookTimeoutMs?: number
  /** hook stderr 摘要字符上限。默认 500。 */
  stderrSummaryMaxChars?: number
}

export interface ResolvedConfig {
  enabled: boolean
  claudeDir: string
  adaptDir: string
  loadRules: boolean
  rulesMaxBytes: number
  ruleMaxSourceBytes: number
  ruleImportMaxDepth: number
  defaultAlwaysApply: boolean
  loadSkills: boolean
  loadAgents: boolean
  loadHooks: boolean
  hookTimeoutMs: number
  stderrSummaryMaxChars: number
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  claudeDir: '.claude',
  adaptDir: '.dsn',
  loadRules: true,
  rulesMaxBytes: 131072,
  ruleMaxSourceBytes: 65536,
  ruleImportMaxDepth: 8,
  defaultAlwaysApply: true,
  loadSkills: true,
  loadAgents: true,
  loadHooks: true,
  hookTimeoutMs: 600000,
  stderrSummaryMaxChars: 500,
}

export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
  }
}
