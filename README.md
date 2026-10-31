# dsh-claude-in

English | [简体中文](README.zh.md)

[![GitHub release](https://img.shields.io/github/v/release/ShinewineW/dsh-claude-in)](https://github.com/ShinewineW/dsh-claude-in/releases)
[![License](https://img.shields.io/github/license/ShinewineW/dsh-claude-in)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c8bf5)](https://github.com/topics/dsh-plugin)

Use an existing Claude Code workspace in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) without maintaining a second copy of its configuration.

`dsh-claude-in` loads Rules, Skills, command Hooks, and Agent definitions directly from `.claude`. The source files remain unchanged, making `.claude` the single source of truth across Claude Code and DSH.

## Highlights

- **No migration** — Claude assets are read at runtime instead of copied into DSH-specific files.
- **Project and user scopes** — loads the current workspace `.claude` together with `~/.claude`.
- **Native DSH integration** — exposes Skills through the DSH skill service, injects Rules into sessions, and bridges command Hooks to DSH events.
- **Explicit links stay valid** — linked Skills and Rule imports continue to resolve outside the discovery roots.
- **Optional DSH adaptations** — project-specific overrides live under `.dsn`, leaving Claude assets untouched.

## Supported assets

| Claude Code asset | Sources | DSH integration |
|---|---|---|
| Rules | `.claude/rules/**/*.md`, `~/.claude/rules/**/*.md` | Baseline and path-scoped session instructions |
| Skills | `.claude/skills/**/SKILL.md`, `~/.claude/skills/**/SKILL.md` | Native DSH skills, read from source when invoked |
| Command Hooks | `hooks.json`, `settings.json`, `settings.local.json` | DSH lifecycle hooks |
| Agents | `.claude/agents/**/*.md`, `~/.claude/agents/**/*.md` | Agent catalog and `claude-agent-*` skills |

Session history, MCP configuration, Claude plugins, commands, memory, and direct `CLAUDE.md` injection are outside this plugin's scope.

## Install

The current source targets DeepSeek Harness `0.2.1-rc.2` and its awaited `agent/created` lifecycle. These compatibility and context-timing changes are available on `master` and have not been published in a release.

### GitHub source

```sh
dsh plugin --profile web add github:ShinewineW/dsh-claude-in#master
```

Git-based installation builds the package through its `prepare` script. pnpm 10 or later may require the build to be allowed in the target profile:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-claude-in: true
```

After adding the entry, run the installation command again.

### Historical prebuilt release (v0.1.0)

The `v0.1.0` tarball targets the earlier DSH `0.1.0-rc.6` API and does not include the current source's compatibility or context-timing changes. For DSH `0.2.1-rc.2`, use the source installation above. The historical tarball does not require install-time build permission:

```sh
curl -LO https://github.com/ShinewineW/dsh-claude-in/releases/download/v0.1.0/dsh-claude-in-0.1.0.tgz
dsh plugin --profile web add ./dsh-claude-in-0.1.0.tgz
```

## How it works

Discovery has two entry points:

1. `.claude` directly under the current DSH workspace
2. `~/.claude`

Parent directories and unrelated filesystem locations are not scanned. A session started from a nested directory does not inherit a `.claude` directory located higher in the tree.

Symbolic links within discovered Skill and Agent trees are followed. Rule `@import` directives may also resolve files or directories outside the discovery roots. These are explicit asset references, not additional discovery locations.

### Context timing

Rules and the Agent catalog are included in the first admitted model request of new and resumed sessions. Skills are registered when the plugin loads. UserPromptSubmit Hook context joins that same request, as does SessionStart Hook context when the plugin observes the awaited `agent/created` lifecycle. Dynamically loading the plugin after that event cannot replay SessionStart. No preset adds a first-request delay.

### Rules

Rules without `paths` or `globs` are included in the session baseline by default. `alwaysApply: true` provides the same behavior explicitly. Path-scoped Rules are matched when DSH `read`, `write`, or `edit` tools touch a file and are injected once per session after the matching tool result.

Project and user Rules are combined. Project Rules are rendered first and receive priority if the configured context budget is exhausted.

### Skills

Each valid `SKILL.md` is registered with the DSH skill service. The original file is read when the Skill is invoked, so updates remain in `.claude` and no managed copy is created.

Name precedence, from highest to lowest:

1. Project `.dsn/skills`
2. User `~/.claude/skills`
3. Project `.claude/skills`

### Hooks

The following Claude command Hook events are bridged:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStart`
- `SubagentStop`

Hook groups from `hooks.json`, `settings.json`, and `settings.local.json` are appended in that order. Project Hooks run before user Hooks. `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_ROOT}` are resolved for the active workspace before execution.

Blocking exit code `2`, `permissionDecision`, and `additionalContext` are supported. Non-command Hook types are skipped with a warning.

### Agents

Agent definitions are added to a lightweight session catalog and exposed as Skills named `claude-agent-<name>`. Invoking one of these Skills loads the Agent definition and system prompt from its original Markdown file for use by the DSH subagent workflow.

Project Agent definitions take precedence over user definitions with the same name.

## Project adaptations

DSH-specific behavior can be configured without changing Claude assets:

```yaml
# .dsn/dsh-claude-in.yml
enabled: true
loadRules: true
loadSkills: true
loadAgents: true
loadHooks: true

hooks:
  PreToolUse:
    - from: "npx tsc --noEmit"
      to: "/opt/dsh/tsc-check.sh"
```

Hook adaptations use exact command matching and replace only the command text. The event, matcher, timeout, and execution semantics remain unchanged.

DSH-only Skills can be placed under `.dsn/skills/<name>/SKILL.md`. The plugin never creates or modifies `.dsn` files.

## Configuration

The default plugin configuration is equivalent to:

```yaml
enabled: true
claudeDir: ".claude"
adaptDir: ".dsn"
loadRules: true
rulesMaxBytes: 131072
ruleMaxSourceBytes: 65536
ruleImportMaxDepth: 8
defaultAlwaysApply: true
loadSkills: true
loadAgents: true
loadHooks: true
hookTimeoutMs: 600000
stderrSummaryMaxChars: 500
```

`claudeDir` and `adaptDir` accept one relative directory name. Absolute paths and directory traversal are rejected.

## Security

Claude assets are read-only, but command Hooks execute shell commands from project and user configuration. Project Hook execution therefore carries the same trust implications as trusting that workspace in Claude Code.

Hooks can be disabled per project:

```yaml
# .dsn/dsh-claude-in.yml
loadHooks: false
```

Explicit Skill symlinks and Rule imports can reference content outside `.claude`; those referenced targets are part of the trusted configuration surface.

## Known limitations

- Only command Hooks and the listed lifecycle events are supported.
- Hook outputs such as `updatedInput`, `systemMessage`, and `updatedToolOutput` are not applied.
- Agent `model` and `tools` fields are included in the bridged definition but are not enforced as native DSH runtime restrictions.
- Path-scoped Rules are injected after a matching `read`, `write`, or `edit` result and cannot retroactively govern the first completed write or edit.
- File access performed inside shell commands is not visible to path-scoped Rule matching.
- Rule and Agent baselines use a short metadata cache rather than file-level watchers.

## Development

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

The build is self-contained and does not depend on a DeepSeek Harness source checkout.

## License

[BSD-3-Clause](LICENSE). Hook execution semantics are adapted from `@deepseek-ai/dsh-hooks-claude-code`, also distributed under BSD-3-Clause.
