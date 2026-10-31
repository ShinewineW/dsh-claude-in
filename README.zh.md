# dsh-claude-in

[English](README.md) | 简体中文

[![GitHub release](https://img.shields.io/github/v/release/ShinewineW/dsh-claude-in)](https://github.com/ShinewineW/dsh-claude-in/releases)
[![License](https://img.shields.io/github/license/ShinewineW/dsh-claude-in)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c8bf5)](https://github.com/topics/dsh-plugin)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中直接复用已有的 Claude Code 工作区，无需维护第二份配置。

`dsh-claude-in` 在运行时从 `.claude` 读取 Rules、Skills、command Hooks 和 Agent 定义。源文件始终保持不变，使 `.claude` 成为 Claude Code 与 DSH 共享的唯一真源。

## 主要特性

- **无需迁移**：运行时读取 Claude 资产，不复制到 DSH 专用文件。
- **项目级与用户级配置**：同时加载当前工作区 `.claude` 和 `~/.claude`。
- **原生 DSH 集成**：Skills 接入 DSH skill service，Rules 注入会话，command Hooks 映射到 DSH 事件。
- **保留显式引用**：Skill 软链与 Rule imports 可以继续指向发现入口之外的目标。
- **独立适配层**：DSH 专属调整放在 `.dsn`，不修改 Claude 资产。

## 支持的资产

| Claude Code 资产 | 来源 | DSH 中的行为 |
|---|---|---|
| Rules | `.claude/rules/**/*.md`、`~/.claude/rules/**/*.md` | 基线指令与路径规则注入 |
| Skills | `.claude/skills/**/SKILL.md`、`~/.claude/skills/**/SKILL.md` | 原生 DSH Skills，调用时读取源文件 |
| Command Hooks | `hooks.json`、`settings.json`、`settings.local.json` | 映射到 DSH 生命周期事件 |
| Agents | `.claude/agents/**/*.md`、`~/.claude/agents/**/*.md` | Agent 目录与 `claude-agent-*` Skills |

会话历史、MCP 配置、Claude Plugins、Commands、Memory 以及直接注入 `CLAUDE.md` 不在本插件范围内。

## 安装

`0.2.0` 版本适配 DeepSeek Harness `0.2.1-rc.2`，使用宿主等待完成的 `agent/created` 生命周期。这是本次发布已验证的兼容基线，尚未验证更高版本的 DSH。

### 从 GitHub 源码安装

```sh
dsh plugin --profile web add github:ShinewineW/dsh-claude-in#v0.2.0
```

Git 安装通过 `prepare` 脚本从源码构建。pnpm 10 及以上版本可能要求在目标 profile 中显式允许构建：

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-claude-in: true
```

加入配置后重新执行安装命令即可。

### 从预构建 Release 安装

`v0.2.0` 包含预构建代码，不需要安装时构建权限：

```sh
curl -LO https://github.com/ShinewineW/dsh-claude-in/releases/download/v0.2.0/dsh-claude-in-0.2.0.tgz
dsh plugin --profile web add ./dsh-claude-in-0.2.0.tgz
```

## 发现模型

插件只使用两个发现入口：

1. 当前 DSH 工作区直属的 `.claude`
2. `~/.claude`

插件不会扫描父目录或其他文件系统位置。从项目子目录启动的会话不会继承上级目录中的 `.claude`。

发现目录内的显式引用仍然有效。Skill 与 Agent 目录中的符号链接会被跟随，Rule `@import` 也可以解析发现入口之外的文件或目录。这些引用属于资产的显式声明，不会扩大自动发现范围。

## 运行机制

### 上下文时序

新建和恢复会话的首个获准执行的模型请求就会包含 Rules 与 Agent 目录。Skills 在插件加载时注册。UserPromptSubmit Hook 的上下文加入同一次请求；插件观察到宿主等待完成的 `agent/created` 生命周期时，SessionStart Hook 的上下文也会加入该请求。在此事件之后动态加载插件无法补跑 SessionStart。所有 preset 均无首轮延迟。

### Rules

默认情况下，不包含 `paths` 或 `globs` 的 Rules 会进入会话基线；`alwaysApply: true` 可以显式声明同样的行为。路径规则在 DSH 的 `read`、`write` 或 `edit` 工具触达匹配文件后注入，每个会话只注入一次。

项目 Rules 与用户 Rules 会合并加载。项目 Rules 排在前面，并在上下文预算不足时优先保留。

### Skills

每个合法的 `SKILL.md` 都会注册到 DSH skill service。Skill 被调用时读取原始文件，因此所有更新仍保留在 `.claude` 中，不会产生受插件管理的副本。

同名 Skill 的优先级从高到低为：

1. 项目 `.dsn/skills`
2. 用户 `~/.claude/skills`
3. 项目 `.claude/skills`

### Hooks

当前支持以下 Claude command Hook 事件：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStart`
- `SubagentStop`

`hooks.json`、`settings.json`、`settings.local.json` 中的 Hook 组按此顺序追加。项目 Hooks 先于用户 Hooks 执行。命令执行前会根据当前工作区解析 `${CLAUDE_PROJECT_DIR}` 和 `${CLAUDE_PLUGIN_ROOT}`。

插件支持阻塞退出码 `2`、`permissionDecision` 和 `additionalContext`。非 command 类型 Hook 会被跳过并记录警告。

### Agents

Agent 定义会进入轻量会话目录，同时注册为 `claude-agent-<name>` Skills。调用对应 Skill 时，插件从原始 Markdown 文件读取 Agent 定义和 system prompt，并交给 DSH subagent 工作流使用。

项目级 Agent 与用户级 Agent 同名时，项目级定义优先。

## `.dsn` 项目适配

DSH 专属行为可以在不修改 Claude 资产的情况下单独配置：

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

Hook 适配采用命令文本精确匹配，只替换命令本身，不改变事件、matcher、timeout 或执行语义。

DSH 专属 Skills 可以放在 `.dsn/skills/<name>/SKILL.md`。插件不会创建或修改 `.dsn` 文件。

## 配置

默认配置等价于：

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

`claudeDir` 和 `adaptDir` 只接受一个相对目录名，不接受绝对路径或目录穿越。

## 安全模型

Claude 资产以只读方式加载，但 command Hooks 会执行项目级和用户级配置中的 shell 命令。项目 Hook 的信任边界与 Claude Code 中信任该工作区后的行为一致。

项目级 Hooks 可以单独关闭：

```yaml
# .dsn/dsh-claude-in.yml
loadHooks: false
```

显式 Skill 软链和 Rule imports 可以引用 `.claude` 之外的内容，相应目标也属于配置的信任范围。

## 已知限制

- 仅支持 command Hooks 和文档列出的生命周期事件。
- `updatedInput`、`systemMessage`、`updatedToolOutput` 等 Hook 输出不会生效。
- Agent 的 `model` 与 `tools` 字段会包含在桥接定义中，但不会成为 DSH 原生运行时强制限制。
- 路径规则在匹配的 `read`、`write` 或 `edit` 返回后注入，无法追溯约束第一次已经完成的写入或编辑。
- Shell 命令内部发生的文件访问无法参与路径规则匹配。
- Rule 与 Agent 基线使用短期元数据缓存，而不是文件级 watcher。

## 开发

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

构建过程完全自包含，不依赖 DeepSeek Harness 源码 checkout。

## License

[BSD-3-Clause](LICENSE)。Hook 执行语义改写自同样采用 BSD-3-Clause 的 `@deepseek-ai/dsh-hooks-claude-code`。
