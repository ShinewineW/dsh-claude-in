/**
 * 轻量 glob → RegExp：支持 `**`（跨目录）、`*`、`?`、`[...]` / `[!...]` 字符类、
 * `{a,b}` 花括号选择。语义对齐 gitignore 常见用法：
 *  - 含 `/` 的模式锚定到项目根相对路径整体匹配；
 *  - 不含 `/` 的模式匹配任意深度的 basename；
 *  - 以 `/**` 结尾的模式同时匹配目录前缀本身；
 *  - 以 `**​/` 开头的模式允许任意目录前缀。
 * 匹配对象是 POSIX 相对路径（规则 paths/globs 与文件相对项目根）。
 * `asFragment` 只返回模式本体（无锚点），供花括号展开递归使用。
 * @module dsh-claude-in/glob
 */

export function globToRegExp(pattern: string, asFragment = false): RegExp {
  const source = normalize(pattern)
  const anchored = source.includes('/')
  let re = ''
  let i = 0
  const n = source.length

  /** 解析一个“段”（到 `/` 或结尾）。 */
  const parseSegment = (): void => {
    while (i < n && source[i] !== '/') {
      const ch = source[i]
      if (ch === '*') {
        if (source[i + 1] === '*') {
          i += 2
          if (source[i] === '/') {
            // 段间 `**​/`：零个或多个中间目录
            i += 1
            re += '(?:[^/]*/)*'
          } else {
            re += '[^/]*' // 段尾 `**` 等价于 `*`
          }
        } else {
          i += 1
          re += '[^/]*'
        }
        continue
      }
      if (ch === '?') {
        i += 1
        re += '[^/]'
        continue
      }
      if (ch === '[') {
        const close = source.indexOf(']', i + 1)
        if (close === -1) {
          re += '\\['
          i += 1
          continue
        }
        let cls = source.slice(i + 1, close)
        i = close + 1
        let negate = false
        if (cls.startsWith('!') || cls.startsWith('^')) {
          negate = true
          cls = cls.slice(1)
        }
        cls = cls.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
        re += `[${negate ? '^' : ''}${cls}]`
        continue
      }
      if (ch === '{') {
        const close = findBraceEnd(source, i)
        if (close === -1) {
          re += '\\{'
          i += 1
          continue
        }
        const parts = splitAlternatives(source.slice(i + 1, close))
        if (parts.length > 1) {
          re += `(?:${parts.map((part) => globToRegExp(part, true).source).join('|')})`
          i = close + 1
        } else {
          re += '\\{'
          i += 1
        }
        continue
      }
      re += escapeRegex(ch)
      i += 1
    }
  }

  if (anchored) {
    // 前导 `**​/`：任意目录前缀
    if (source.startsWith('**/')) {
      re += '(?:.*/)?'
      i = 3
    }
    for (;;) {
      parseSegment()
      if (i >= n) break
      re += '/'
      i += 1 // 跳过 `/`
    }
    // 结尾 `/**`：同时匹配目录前缀本身
    if (re.endsWith('/[^/]*') && patternTrimmed(source).endsWith('/**')) {
      re = re.slice(0, -'/[^/]*'.length) + '(?:/.*)?'
    }
  } else {
    parseSegment()
  }

  if (asFragment) return new RegExp(re)
  return anchored ? new RegExp(`^${re}$`) : new RegExp(`(^|.*/)${re}$`)
}

/** 归一化：反斜杠 → `/`，去掉 `./` 前缀与尾部 `/`。 */
function normalize(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** 原样模式（未归一化截断）尾部是否 `/**`。 */
function patternTrimmed(source: string): string {
  return source.replace(/\/+$/, '')
}

/** 找到与 `{` 配对的 `}`（不支持嵌套）。 */
function findBraceEnd(source: string, open: number): number {
  for (let j = open + 1; j < source.length; j += 1) {
    if (source[j] === '}') return j
    if (source[j] === '{') return -1
  }
  return -1
}

/** 顶层逗号切分（不在字符类内）。 */
function splitAlternatives(inner: string): string[] {
  const parts: string[] = []
  let inClass = false
  let current = ''
  for (const ch of inner) {
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === ',' && !inClass) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch
}

/** 任一模式匹配给定的根相对路径。 */
export function globMatches(globs: readonly string[], relPath: string): boolean {
  const posix = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const pattern of globs) {
    let regex: RegExp
    try {
      regex = globToRegExp(pattern)
    } catch {
      continue
    }
    if (regex.test(posix)) return true
  }
  return false
}
