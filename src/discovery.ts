/**
 * 工作区级 Claude 根：只检查**当前工作区（会话 cwd）自身**的 `.claude`，
 * 不向上探测（防漂移：子目录里开会话不会带上父目录的 .claude）。
 * 带轻量缓存（按 cwd + `.claude` 目录 mtime 失效）。
 * @module dsh-claude-in/discovery
 */
import { existsSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ClaudeRoot {
  /** 工作区根绝对路径（realpath，唯一性 canon）。 */
  path: string
  /** `.claude` 目录绝对路径。 */
  claudeDir: string
  /** `.claude` 目录 mtime（缓存失效依据）。 */
  mtimeMs: number
}

const CACHE_TTL_MS = 3000

interface CacheEntry {
  root: ClaudeRoot | undefined
  checkedAt: number
  mtimeMs: number
}

const cache = new Map<string, CacheEntry>()

/**
 * 只检查 `<cwd>/.claude`（当前工作区自身），有则返回、无则 undefined。
 * 不向父目录探测。
 */
export function findClaudeRoot(cwd: string, claudeDirName = '.claude'): ClaudeRoot | undefined {
  const key = tryRealpath(cwd) ?? cwd
  const hit = cache.get(key)
  if (hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) return hit.root

  const claude = join(cwd, claudeDirName)
  let root: ClaudeRoot | undefined
  try {
    // 只保护 fs 探测；发现后的构造失败必须外抛，不能被吞掉。
    if (existsSync(claude) && statSync(claude).isDirectory()) {
      root = {
        path: realpathSync(cwd),
        claudeDir: claude,
        mtimeMs: statSync(claude).mtimeMs,
      }
    }
  } catch {
    // 权限/竞态：视为不存在。
  }
  cache.set(key, { root, checkedAt: Date.now(), mtimeMs: root?.mtimeMs ?? 0 })
  return root
}

export function clearRootCache(): void {
  cache.clear()
}

/**
 * 用户级 Claude 根：`<home>/.claude`（固定位置，不做向上发现）。
 * 与项目根为同一目录时（例如会话就在家目录里）由调用方去重。
 */
export function findUserClaudeRoot(home = homedir(), claudeDirName = '.claude'): ClaudeRoot | undefined {
  const claude = join(home, claudeDirName)
  try {
    if (existsSync(claude) && statSync(claude).isDirectory()) {
      return {
        path: realpathSync(home),
        claudeDir: claude,
        mtimeMs: statSync(claude).mtimeMs,
      }
    }
  } catch {
    // 无用户级 .claude：跳过
  }
  return undefined
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}
