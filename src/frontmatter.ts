/**
 * YAML frontmatter 拆分（`---` 行包裹），供 rules / SKILL.md / agents 使用。
 * 解析失败不抛异常：返回 metaError，调用方决定降级策略。
 * @module dsh-claude-in/frontmatter
 */
import { parse as parseYaml } from 'yaml'

export interface FrontmatterResult {
  /** 解析出的元数据；文件不以 `---` 开头或解析失败时为 undefined。 */
  meta: Record<string, unknown> | undefined
  /** frontmatter 之后的正文（无 frontmatter 时为全文）。 */
  body: string
  /** YAML 解析错误信息；无错误时为 undefined。 */
  metaError: string | undefined
}

export function splitFrontmatter(content: string): FrontmatterResult {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { meta: undefined, body: content }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return { meta: undefined, body: content }
  const yamlText = lines.slice(1, close).join('\n')
  const body = lines.slice(close + 1).join('\n')
  if (yamlText.trim() === '') return { meta: {}, body }
  try {
    const parsed = parseYaml(yamlText)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { meta: parsed as Record<string, unknown>, body }
    }
    return { meta: {}, body }
  } catch (error) {
    return { meta: undefined, body, metaError: errorMessage(error) }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 从 frontmatter 提取字符串列表字段（兼容 `paths` / `globs` / `tools` 的单值或数组形式）。 */
export function stringList(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key]
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? [] : [trimmed]
  }
  return []
}

/** `tools: Read, Edit`（逗号分隔单字符串）与数组两种写法都支持。 */
export function toolList(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key]
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : []
  return raw.flatMap((item) => item.split(',')).map((item) => item.trim()).filter((item) => item !== '')
}

/** 从 frontmatter 提取可选字符串字段。 */
export function optionalString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return undefined
}

/** 从 frontmatter 提取布尔字段。 */
export function optionalBoolean(meta: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = meta?.[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }
  return undefined
}
