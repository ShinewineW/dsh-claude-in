// dsh-claude-in 纯逻辑单测（node 原生 type-stripping 直接跑 src/*.ts）
// 运行：node tests/test.mjs   （在插件目录下）
import assert from 'node:assert/strict'
import { splitFrontmatter } from '../src/frontmatter.ts'
import { globToRegExp, globMatches } from '../src/glob.ts'
import { discoverRules, matchingScoped, renderBaseline, renderTouched as renderTouchedFull, relPathOf } from '../src/rules.ts'
import { findUserClaudeRoot } from '../src/discovery.ts'
import { mergeAgents } from '../src/agents.ts'
import { loadUserHookConfig } from '../src/hooks.ts'
import { discoverClaudeSkills, kebab } from '../src/skills.ts'
import { discoverAgents, renderAgentCatalog, renderAgentDefinition } from '../src/agents.ts'
import { parseClaudeConfig, loadHookConfig } from '../src/hooks.ts'
import { loadAdaptConfig, mergeAdaptConfig, applyHookCommandOverrides } from '../src/adapt.ts'
import { findClaudeRoot } from '../src/discovery.ts'
import { resolveConfig } from '../src/config.ts'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// ── frontmatter ────────────────────────────────────────────────────────────
test('frontmatter: paths 数组', () => {
  const r = splitFrontmatter('---\npaths:\n  - "helloworld/**"\n  - "docs/**"\n---\n# body\n')
  assert.equal(r.meta.paths.length, 2)
  assert.equal(r.body.trim(), '# body')
})

test('frontmatter: 多行 description', () => {
  const r = splitFrontmatter('---\ndescription: |\n  line1\n  line2\n---\nbody')
  assert.equal(r.meta.description, 'line1\nline2\n')
})

test('frontmatter: 无 frontmatter', () => {
  const r = splitFrontmatter('# just a rule\n')
  assert.equal(r.meta, undefined)
  assert.match(r.body, /just a rule/)
})

test('frontmatter: 坏 YAML 不抛异常', () => {
  const r = splitFrontmatter('---\npaths: [unclosed\n---\nbody')
  assert.equal(r.meta, undefined)
  assert.ok(r.metaError)
})

// ── glob ───────────────────────────────────────────────────────────────────
test('glob: 目录前缀 **', () => {
  assert.ok(globMatches(['helloworld/**'], 'helloworld/src/a.py'))
  assert.ok(globMatches(['helloworld/**'], 'helloworld/a.py'))
  assert.ok(!globMatches(['helloworld/**'], 'other/a.py'))
})

test('glob: 结尾 /** 匹配目录前缀', () => {
  assert.ok(globMatches(['helloworld/**'], 'helloworld'))
})

test('glob: 段间 **/ 跨任意深度', () => {
  assert.ok(globMatches(['a/**/b.py'], 'a/x/b.py'))
  assert.ok(globMatches(['a/**/b.py'], 'a/x/y/b.py'))
  assert.ok(globMatches(['a/**/b.py'], 'a/b.py'))
  assert.ok(!globMatches(['a/**/b.py'], 'a/x/c.py'))
})

test('glob: 无斜杠匹配任意深度 basename', () => {
  assert.ok(globMatches(['*.py'], 'src/a.py'))
  assert.ok(globMatches(['*.py'], 'a.py'))
  assert.ok(!globMatches(['*.py'], 'src/a.ts'))
})

test('glob: 字符类与花括号', () => {
  assert.ok(globMatches(['src/[ab].py'], 'src/a.py'))
  assert.ok(globMatches(['src/[ab].py'], 'src/b.py'))
  assert.ok(!globMatches(['src/[ab].py'], 'src/c.py'))
  assert.ok(globMatches(['src/{a,b}.py'], 'src/b.py'))
  assert.ok(!globMatches(['src/{a,b}.py'], 'src/c.py'))
})

test('glob: **/*.py 任意深度', () => {
  assert.ok(globMatches(['**/*.py'], 'a.py'))
  assert.ok(globMatches(['**/*.py'], 'x/y/z.py'))
  assert.ok(!globMatches(['**/*.py'], 'x/y/z.ts'))
})

// ── wm-proj 真实 .claude ───────────────────────────────────────────────────
const WM = '/mnt/volumes/infra-cloud-alg-su01/wangjiazhe/wm-proj'
const wmRoot = findClaudeRoot(WM)

test('discovery: wm-proj 工作区自身发现 .claude 根', () => {
  assert.ok(wmRoot)
  assert.equal(wmRoot.path, WM)
})

test('discovery: 不向上漂移（子目录开会话不带上父目录 .claude）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-drift-'))
  mkdirSync(join(dir, 'ws', '.claude'), { recursive: true })
  mkdirSync(join(dir, 'ws', 'sub'), { recursive: true })
  assert.equal(findClaudeRoot(join(dir, 'ws', 'sub')), undefined)
  assert.ok(findClaudeRoot(join(dir, 'ws')))
  rmSync(dir, { recursive: true, force: true })
})

if (wmRoot) {
  const config = resolveConfig({})
  const discovery = discoverRules(wmRoot.claudeDir, {
    maxSourceBytes: config.ruleMaxSourceBytes,
    importMaxDepth: config.ruleImportMaxDepth,
    defaultAlwaysApply: config.defaultAlwaysApply,
    warn: (m) => console.log('  [warn]', m),
  })

  test('rules: wm-proj 扫描到 >30 条规则', () => {
    assert.ok(discovery.rules.length > 30, `got ${discovery.rules.length}`)
  })

  test('rules: routing.md 是 path-scoped（helloworld/**）', () => {
    const routing = discovery.rules.find((r) => r.relPath === 'helloworld/routing.md')
    assert.ok(routing, 'routing.md not found')
    assert.equal(routing.alwaysApply, false)
    assert.deepEqual(routing.globs, ['helloworld/**', 'docs/helloworld/**'])
  })

  test('rules: 02-destructive-ops-cwd-safety.md 无 frontmatter → always', () => {
    const rule = discovery.rules.find((r) => r.relPath === '02-destructive-ops-cwd-safety.md')
    assert.ok(rule, 'rule not found')
    assert.equal(rule.alwaysApply, true)
    assert.match(rule.content, /Destructive Ops Safety/)
  })

  test('rules: 命中 helloworld 文件的 path-scoped 规则', () => {
    const hits = matchingScoped(discovery.scoped, 'helloworld/scripts/train.py')
    assert.ok(hits.some((r) => r.relPath === 'helloworld/routing.md'))
  })

  test('rules: README.md 命中的全部规则标签都在渲染文本里（截断不丢规则）', () => {
    const hits = matchingScoped(discovery.scoped, 'helloworld/README.md')
    assert.ok(hits.length >= 4, `expected >=4 hits, got ${hits.length}`)
    const { renderTouched } = null ?? {}
    const text = renderTouchedFull(hits, wmRoot.path, 'helloworld/README.md', config.rulesMaxBytes)
    for (const rule of hits) {
      assert.ok(text.includes(`name="${rule.name}"`), `missing rule tag: ${rule.name}`)
    }
  })

  test('rules: renderBaseline 含 always 规则且在预算内', () => {
    const text = renderBaseline(discovery, wmRoot.path, config.rulesMaxBytes)
    assert.ok(text.includes('<claude_workspace_rules>'))
    assert.ok(Buffer.byteLength(text, 'utf8') <= config.rulesMaxBytes + 8192)
    console.log(`  [info] baseline ${Buffer.byteLength(text, 'utf8')} bytes; always=${discovery.always.length} scoped=${discovery.scoped.length} requestable=${discovery.requestable.length}`)
  })

  test('skills: wm-proj .claude/skills 扫描（9 个）', () => {
    const skills = discoverClaudeSkills(wmRoot.claudeDir, { skills: true, agents: true }, (m) => console.log('  [warn]', m))
    const real = skills.filter((s) => s.locator.kind === 'skill')
    assert.ok(real.length >= 9, `got ${real.length}`)
    for (const s of real) {
      assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(s.name), `invalid skill name ${s.name}`)
      assert.ok(s.description.length > 0, `${s.name} has empty description`)
    }
    console.log(`  [info] skills: ${real.map((s) => s.name).join(', ')}`)
  })

  test('relPathOf: 根外路径返回 undefined', () => {
    assert.equal(relPathOf('/a/b', '/a/c/x.py'), undefined)
    assert.equal(relPathOf('/a/b', '/a/b/x.py'), 'x.py')
  })
}

// ── agents ─────────────────────────────────────────────────────────────────
test('agents: 临时项目 agents 发现 + 渲染', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-agents-'))
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), '---\nname: code-reviewer\ndescription: reviews code\ntools: Read, Edit\nmodel: inherit\n---\nYou review code strictly.\n')
  const agents = discoverAgents(join(dir, '.claude'))
  assert.equal(agents.length, 1)
  assert.equal(agents[0].name, 'code-reviewer')
  assert.deepEqual(agents[0].tools, ['Read', 'Edit'])
  const catalog = renderAgentCatalog(agents, dir)
  assert.ok(catalog.includes('claude-agent-code-reviewer'))
  const definition = renderAgentDefinition('code-reviewer', 'reviews code', agents[0].meta, agents[0].body)
  assert.ok(definition.includes('<system_prompt>'))
  assert.ok(definition.includes('You review code strictly.'))
  rmSync(dir, { recursive: true, force: true })
})

test('skills: 临时项目 SKILL.md → 合法候选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-skills-'))
  mkdirSync(join(dir, '.claude', 'skills', 'my-skill'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: does things\n---\n# body\n')
  const skills = discoverClaudeSkills(join(dir, '.claude'), { skills: true, agents: false })
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'my-skill')
  assert.equal(skills[0].description, 'does things')
  rmSync(dir, { recursive: true, force: true })
})

test('kebab: 名字规范化', () => {
  assert.equal(kebab('Code Reviewer'), 'code-reviewer')
  assert.equal(kebab('foo/bar'), 'foo-bar')
})

// ── hooks ──────────────────────────────────────────────────────────────────
test('hooks: parse CC settings.json 格式 + 替换', () => {
  const raw = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Edit',
          hooks: [{ type: 'command', command: 'echo "${CLAUDE_PROJECT_DIR}"', timeout: 30 }],
        },
        { matcher: 'Read', hooks: [{ type: 'prompt', prompt: 'x' }] },
      ],
      UnknownEvent: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
    },
  }
  const { config, skipped } = parseClaudeConfig(raw, { projectDir: '/proj' })
  assert.equal(config.PreToolUse.length, 1)
  assert.equal(config.PreToolUse[0].hooks[0].command, 'echo "/proj"')
  assert.equal(config.PreToolUse[0].hooks[0].timeoutSec, 30)
  assert.ok(skipped.some((s) => s.event === 'PreToolUse' && s.type === 'prompt'))
  assert.equal(config.UnknownEvent, undefined)
})

test('hooks: 坏正则 matcher 抛 SyntaxError', () => {
  assert.throws(
    () => parseClaudeConfig({ PreToolUse: [{ matcher: '[bad', hooks: [{ type: 'command', command: 'true' }] }] }),
    SyntaxError,
  )
})

test('hooks: loadHookConfig 合并 settings.local 覆盖 settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-hooks-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo base' }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }] } }))
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo local' }] }] } }))
  const loaded = loadHookConfig(join(dir, '.claude'), dir)
  assert.ok(loaded)
  assert.equal(loaded.events.PreToolUse[0].hooks[0].command, 'echo local')
  assert.equal(loaded.events.PostToolUse[0].hooks[0].command, 'echo post')
  rmSync(dir, { recursive: true, force: true })
})

// ── .dsn 适配层 ────────────────────────────────────────────────────────────
test('adapt: loadAdaptConfig + mergeAdaptConfig（项目级开关）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-adapt-'))
  mkdirSync(join(dir, '.dsn'), { recursive: true })
  writeFileSync(join(dir, '.dsn', 'dsh-claude-in.yml'), 'enabled: true\nloadHooks: false\nloadSkills: true\n')
  const adapt = loadAdaptConfig(join(dir, '.dsn'))
  assert.ok(adapt)
  const merged = mergeAdaptConfig(resolveConfig({}), adapt)
  assert.equal(merged.loadHooks, false)
  assert.equal(merged.enabled, true)
  assert.equal(merged.loadRules, true) // 未覆盖的继承全局
  rmSync(dir, { recursive: true, force: true })
})

test('adapt: 无适配文件返回 undefined，不覆盖全局', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-adapt2-'))
  const adapt = loadAdaptConfig(join(dir, '.dsn'))
  assert.equal(adapt, undefined)
  assert.deepEqual(mergeAdaptConfig(resolveConfig({}), undefined), resolveConfig({}))
  rmSync(dir, { recursive: true, force: true })
})

test('adapt: hook 命令适配只换命令，事件/matcher 不变', () => {
  const { config } = parseClaudeConfig({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'claude-run-check', timeout: 10 }] }] })
  const hookConfig = { root: '/proj', events: config }
  const adapted = applyHookCommandOverrides(hookConfig, {
    hooks: { PreToolUse: [{ from: 'claude-run-check', to: '/opt/dsh/bin/run-check' }] },
  })
  assert.equal(adapted.events.PreToolUse[0].hooks[0].command, '/opt/dsh/bin/run-check')
  assert.equal(adapted.events.PreToolUse[0].hooks[0].timeoutSec, 10)
  assert.equal(adapted.events.PreToolUse[0].matcher, 'Bash')
  // 未匹配的命令保持原样
  const untouched = applyHookCommandOverrides(hookConfig, { hooks: { PostToolUse: [{ from: 'x', to: 'y' }] } })
  assert.equal(untouched.events.PreToolUse[0].hooks[0].command, 'claude-run-check')
})

// ── 用户级 ~/.claude ───────────────────────────────────────────────────────
test('discovery: findUserClaudeRoot 读 HOME/.claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-home-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const userRoot = findUserClaudeRoot(dir)
  assert.ok(userRoot)
  assert.equal(userRoot.path, dir)
  assert.equal(findUserClaudeRoot(join(dir, 'nope')), undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('rules: user 级规则带 level 标注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-urules-'))
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'rules', 'personal.md'), '# personal rule\n')
  const disc = discoverRules(join(dir, '.claude'), { maxSourceBytes: 65536, importMaxDepth: 8, defaultAlwaysApply: true }, 'user')
  assert.equal(disc.rules.length, 1)
  assert.equal(disc.rules[0].level, 'user')
  assert.equal(disc.rules[0].alwaysApply, true)
  rmSync(dir, { recursive: true, force: true })
})

test('agents: mergeAgents 项目同名优先', () => {
  const project = [{ name: 'reviewer', level: 'project', description: 'p', model: undefined, tools: [], absPath: '/p', relPath: 'reviewer.md', body: '', meta: {} }]
  const user = [
    { name: 'reviewer', level: 'user', description: 'u', model: undefined, tools: [], absPath: '/u', relPath: 'reviewer.md', body: '', meta: {} },
    { name: 'architect', level: 'user', description: 'u2', model: undefined, tools: [], absPath: '/u2', relPath: 'architect.md', body: '', meta: {} },
  ]
  const merged = mergeAgents(project, user)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].level, 'project')
  assert.equal(merged[1].name, 'architect')
})

test('skills: 项目级 + 用户级扫描，同名项目优先、用户独有进入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-dual-'))
  mkdirSync(join(dir, 'proj', '.claude', 'skills', 'shared'), { recursive: true })
  mkdirSync(join(dir, 'home', '.claude', 'skills', 'shared'), { recursive: true })
  mkdirSync(join(dir, 'home', '.claude', 'skills', 'user-only'), { recursive: true })
  writeFileSync(join(dir, 'proj', '.claude', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: project version\n---\n# p\n')
  writeFileSync(join(dir, 'home', '.claude', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: user version\n---\n# u\n')
  writeFileSync(join(dir, 'home', '.claude', 'skills', 'user-only', 'SKILL.md'), '---\nname: user-only\ndescription: user skill\n---\n# u\n')
  const found = discoverClaudeSkills(join(dir, 'proj', '.claude'), { skills: true, agents: false }, undefined, undefined, join(dir, 'home', '.claude'))
  const names = found.map((s) => s.name)
  assert.deepEqual(names, ['shared', 'user-only'])
  const shared = found.find((s) => s.name === 'shared')
  assert.equal(shared.description, 'project version')
  assert.equal(shared.source, 'project-claude')
  assert.equal(shared.rank, 250)
  const userOnly = found.find((s) => s.name === 'user-only')
  assert.equal(userOnly.source, 'user-claude')
  assert.equal(userOnly.rank, 450)
  rmSync(dir, { recursive: true, force: true })
})

test('hooks: loadUserHookConfig 从 HOME/.claude 读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-uhooks-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo u' }] }] } }))
  const loaded = loadUserHookConfig(dir)
  assert.ok(loaded)
  assert.equal(loaded.events.PreToolUse[0].hooks[0].command, 'echo u')
  rmSync(dir, { recursive: true, force: true })
})

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} tests passed${process.exitCode ? ' (some failed)' : ''}`)
