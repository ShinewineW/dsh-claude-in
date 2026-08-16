# dsh-claude-in

在 DeepSeek Harness 里复现 Claude Code 工作流的文本侧体验，同时继续把 `.claude` 作为唯一真源。

这个插件的目标很窄，也因此很明确：当你在 DSH 中打开一个 Claude Code 项目时，它会只读加载当前工作区根目录的 `.claude` 和用户级 `~/.claude`，把其中可移植的 Skills、Rules、command Hooks、Agents 接到 DSH 里。它不复制配置、不制造第二份资产，让 `.claude` 继续充当 Claude 工作流的唯一真源。会话历史、MCP、Claude 原生 plugins 等运行时专属能力不会被导入。

**核心原则：`.claude` 是 SSOT，只读、绝不改写；DSH 适配只放在项目根的 `.dsn/`。**
**只探测两个固定位置：当前工作区自身的 `.claude`（不向上漂移）+ `~/.claude`（有就加载、没有就不加、不探测）。**
**只加载四样：Skills / Rules / Hooks / Agents。其余（CLAUDE.md 注入、plugins、MCP、commands、memory 等）不在本插件范围。**

## 载入矩阵（项目级 + 用户级）

| Claude 资产 | 项目级（当前工作区自身的 `.claude`） | 用户级 `~/.claude` |
|---|---|---|
| `rules/**​/*.md` | always/无 paths 规则进基线；paths/globs 规则文件命中时注入；支持 `@import` | 同左（CC 语义：个人规则默认 alwaysApply） |
| `skills/**​/SKILL.md` | rank 450，`skill` 工具直读源文件 | rank 250（同名用户覆盖项目；对齐 Claude Code personal > project） |
| `agents/**​/*.md` | 基线目录 + `claude-agent-<name>` 技能桥 | 同左（同名项目覆盖） |
| `hooks`（settings.json / settings.local.json / hooks.json） | command hooks 映射到 DSH seams（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop），退出码 2 阻塞、permissionDecision 折叠 | **全局生效**（无项目 `.claude` 时也跑） |

**不在范围**：`CLAUDE.md` 注入（项目级 CLAUDE.md 由 DSH 原生指令链自行加载，插件不重复注入）、`.claude/plugins`、MCP 配置、commands、memory 等 Claude 专属资产——插件只扫 skills/rules/agents/hooks 四个子目录。

- 发现语义：**当前工作区自身**有 `.claude` 才载入，**不向上探测**（在子目录开会话不会带上父目录的 `.claude`）；`~/.claude` 固定检查，有就载、没有就不加。
- 规则注入顺序：项目规则在前、用户规则在后；字节预算内逐条截断正文、标签保留，先截用户级。
- 工作区就是家目录时两者同一份，只载一次。
- 与 DSH 原生 `.agents`/`.dsh` 体系并行：`~/.agents/skills`、`<ws>/.agents/skills` 由 DSH 出厂组件加载，本插件只负责 `.claude` 体系。

## 设计取舍

这个插件刻意没有逐字逐项复制 Claude Code 的完整发现语义，而是做了一个受控兼容层：

- 只查两个位置：当前工作区根的 `.claude` 与 `~/.claude`。不会像 Claude Code 那样沿父目录向上扫描，也不会因为进入子目录而额外激活嵌套 `.claude`。
- 这样做是为了把自动发现边界压到最清楚：插件不会遍历第三处环境目录。`.claude` 内显式声明的符号链接和规则 `@import` 仍会按 Claude 资产本身的语义解析；这是显式引用，不是额外的环境扫描，也不应被当成文件系统沙箱。
- 在这条受控边界内，冲突优先级尽量对齐 Claude Code：skills 采用 `~/.claude` 覆盖项目 `.claude`；agents 采用项目覆盖用户；rules 合并注入，并在上下文预算不足时优先保留项目规则。

## 为什么是「直读」而不是「导入」

`dsh-claude-import`（见文末参考）把 Claude 资产**复制/合并**进 `.agents`、`AGENTS.md`，需要手动触发、会产生副本。本插件选择**运行时直读**：

- 打开工作区 → 立即生效，无需任何导入步骤；
- 规则/技能改动即时生效（基线 30s 内、目录 mtime 变化后刷新；技能目录每次扫描实时读取）；
- 工作区文件零写入、零副本，`.claude` 永远是唯一真源。

## `.dsn` 适配层

需要 DSH 专属适配时（例如 hook 命令依赖 Claude Code 环境），在**项目根**新建 `.dsn/`：

```yaml
# .dsn/dsh-claude-in.yml（YAML）
enabled: true        # 本项目是否启用（默认继承全局）
loadRules: true      # 逐项开关，缺省继承全局配置；关掉的项目级开关同样作用于该工作区的用户级资产
loadSkills: true
loadAgents: true
loadHooks: true      # 设为 false 时，该工作区内项目级 + 用户级 hooks 都不跑
hooks:               # hooks 命令适配：SSOT 不变，运行时按原始命令精确替换
  PreToolUse:
    - from: "npx tsc --noEmit"            # .claude/settings.json 里的原始命令
      to: "/opt/dsh/tsc-check.sh"         # DSH 环境的等价实现（功能不得改变）
```

- `.dsn/skills/<name>/SKILL.md` 也会被扫描为项目技能（rank 240，DSH 专属技能放这里，不要放 `.claude/skills`）。
- 适配只允许：插件开关、hook 命令等价替换、DSH 新增技能。**rules/skills 等 SSOT 资产不得改动**；hook 替换不得改变 hook 的功能（触发事件、matcher、timeout、语义均不变，只是让命令能在 DSH 环境里跑）。
- 插件本身**不向工作区写任何文件**；`.dsn` 由用户手工创建。

## 安装

```sh
# 发布到 npm 后（推荐）
dsh plugin --profile web add dsh-claude-in

# 或从 GitHub 仓库安装源码
dsh plugin --profile web add github:<你的账号>/dsh-claude-in
```

如果你通过 GitHub 源码安装，DSH 会拿到源码 checkout 而不是 npm registry 的预编译包，因此本仓库依赖 `prepare` 自动构建。首次安装时，pnpm >= 10 可能要求在目标 profile 的 `pnpm-workspace.yaml` 里显式允许构建：

```yaml
allowBuilds:
  dsh-claude-in: true
```

依赖：`@deepseek-ai/dsh-hook-protocol@0.1.0-rc.6`（npm 包内通过 `bundledDependencies` 携带）、`@deepseek-ai/schemastery` 和 `yaml`；后两者由安装器作为正常运行时依赖安装。构建过程只依赖本仓库声明的包，不依赖私有 Pod 路径或某个 DSH 源码 checkout。宿主 API 的极小面（`isSkillName` / `createUserMessage`）为本地实现（`src/compat.ts`，与 DSH 0.1.0-rc.6 语义一致）。构建：`npm run build`。测试：`npm test`。如需跑真实工作区回归样本，额外设置 `DSH_CLAUDE_IN_FIXTURE=/path/to/workspace`。

## 发布到 GitHub

发布前至少做这几件事：

- 仓库保持这个 bundle 结构：`package.json` 声明 `dsh.bundle`，`cordis.patch.yml` 插入插件行，`lib/index.js` 是可加载入口。
- 给仓库加 GitHub topic：`dsh-plugin`。这是当前社区目录与 GitHub topic 检索的主发现入口，不是 `package.json` 字段，必须在 GitHub 仓库设置里手工添加。
- 如果面向源码安装，保留自包含的 `prepare` 构建链；不要依赖某个私有 DSH checkout、私有 Pod 路径或本地 monorepo 才能构建。
- 如果你想避免用户在安装时授予 `allowBuilds`，就改为发 npm 包或发布 `pnpm pack` 生成的 tarball。

## 配置（cordis.patch.yml 的 `config`）

```yaml
enabled: true
claudeDir: ".claude"
adaptDir: ".dsn"
loadRules: true
rulesMaxBytes: 131072      # 项目+用户 always 规则全量约 100KB；调小会先截用户级
ruleMaxSourceBytes: 65536
ruleImportMaxDepth: 8
defaultAlwaysApply: true
loadSkills: true
loadAgents: true
loadHooks: true
hookTimeoutMs: 600000
stderrSummaryMaxChars: 500
```

默认全开、开箱即用（无需任何配置即生效）；上述开关只是逃生门（例如在某个不信任的工作区用 `.dsn` 关掉 hooks）。

## 安全

- **hooks 会执行项目 `.claude` 与用户 `~/.claude` 里的 shell 命令**。用户级 hooks 是你自己的配置（信任级别同 `~/.agents`）；项目级 hooks 按「打开工作区即信任该目录」模型直接运行（与 Claude Code 信任目录后的行为一致）。不信任的项目请用 `.dsn/dsh-claude-in.yml` 设 `loadHooks: false`。
- 不支持非 command hook（`prompt`/`http` 等）——跳过并告警，不执行。
- hook 执行经 `ctx.shell`（凭据脱敏、进程组取消、超时）。

## 已知限制

- `updatedInput`/`systemMessage`/`updatedToolOutput` 不生效（与官方 bridge 相同，仅告警）。
- 非 command 类型 hook、`PreCompact`/`SessionEnd` 等未映射事件不执行。
- Agents 通过 `claude-agent-*` skill 加载定义后交给 DSH subagent；Claude 的模型/工具限制不会被原样强制到子代理运行时。
- 规则 glob 匹配仅覆盖 read/write/edit 工具触达的文件（bash 内部操作的文件无法感知）。
- 路径规则在 DSH 的 read/write/edit 返回后注入：它会约束后续步骤，但不能追溯约束首次 write/edit 已完成的变更。
- 技能/规则目录无 watcher（靠目录 mtime 失效 + 定期目录扫描刷新）。

## 参考实现（先行研究）

- [TimeCraker/dsh-claude-import](https://github.com/TimeCraker/dsh-claude-import) —— 一次性复制/合并导入（预览+冲突策略），与本插件的直读方案互补。
- [cms19859230182-lang/dsh-import](https://github.com/cms19859230182-lang/dsh-import) —— `/import` 命令导入 MCP/rules/hooks（多工具源）。
- 官方 `@deepseek-ai/dsh-hooks-claude-code` + `@deepseek-ai/dsh-hook-protocol`（npm）—— 本插件 hooks 语义的来源（进程级单配置；本插件补上了 per-session 发现 + cwd 过滤 + 用户级合并）。

## License

BSD-3-Clause。hooks 执行器语义改写自 `@deepseek-ai/dsh-hooks-claude-code`（BSD-3-Clause）。
