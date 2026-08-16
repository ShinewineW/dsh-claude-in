# dsh-claude-in

打开工作区时自动载入 Claude Code 配置 —— Claude Code 兼容层 for DeepSeek Harness (DSH)。

**核心原则：`.claude` 是 SSOT，只读、绝不改写；DSH 适配只放在项目根的 `.dsn/`。**
**只探测两个固定位置：当前工作区自身的 `.claude`（不向上漂移）+ `~/.claude`（有就加载、没有就不加、不探测）。**
**只加载四样：Skills / Rules / Hooks / Agents。其余（CLAUDE.md 注入、plugins、MCP、commands、memory 等）不在本插件范围。**

## 载入矩阵（项目级 + 用户级）

| Claude 资产 | 项目级（当前工作区自身的 `.claude`） | 用户级 `~/.claude` |
|---|---|---|
| `rules/**​/*.md` | always/无 paths 规则进基线；paths/globs 规则文件命中时注入；支持 `@import` | 同左（CC 语义：个人规则默认 alwaysApply） |
| `skills/**​/SKILL.md` | rank 250，`skill` 工具直读源文件 | rank 450（同名项目覆盖） |
| `agents/**​/*.md` | 基线目录 + `claude-agent-<name>` 技能桥 | 同左（同名项目覆盖） |
| `hooks`（settings.json / settings.local.json / hooks.json） | command hooks 映射到 DSH seams（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop），退出码 2 阻塞、permissionDecision 折叠 | **全局生效**（无项目 `.claude` 时也跑） |

**不在范围**：`CLAUDE.md` 注入（项目级 CLAUDE.md 由 DSH 原生指令链自行加载，插件不重复注入）、`.claude/plugins`、MCP 配置、commands、memory 等 Claude 专属资产——插件只扫 skills/rules/agents/hooks 四个子目录。

- 发现语义：**当前工作区自身**有 `.claude` 才载入，**不向上探测**（在子目录开会话不会带上父目录的 `.claude`）；`~/.claude` 固定检查，有就载、没有就不加。
- 规则注入顺序：项目规则在前、用户规则在后；字节预算内逐条截断正文、标签保留，先截用户级。
- 工作区就是家目录时两者同一份，只载一次。
- 与 DSH 原生 `.agents`/`.dsh` 体系并行：`~/.agents/skills`、`<ws>/.agents/skills` 由 DSH 出厂组件加载，本插件只负责 `.claude` 体系。

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

# 或从 GitHub 仓库安装
dsh plugin --profile web add github:<你的账号>/dsh-claude-in

# 或本地源码（file:/link: 依赖，见官方 dsh plugin 文档）
cd ~/.dsh/profiles/web
pnpm add "file:/path/to/dsh-claude-in"
# 然后把包名写进 profile 的 cordis.patch.yml 或依赖的 dsh.bundle.patch 自装配
```

依赖：`@deepseek-ai/dsh-hook-protocol@0.1.0-rc.6`（bundle 内打包 `bundledDependencies`）；`yaml` 在构建时打进 `lib/index.js`（产物自包含，任何安装位置可加载，无需宿主回落层）；宿主 API 的极小面（`isSkillName` / `createUserMessage`）为本地实现（`src/compat.ts`，与 DSH 0.1.0-rc.6 语义一致）。构建：`bash scripts/build.sh`（bun；缺 bun 时先 `npm i -g bun`）。测试：`node tests/test.mjs`（34 条；核心用例基于临时目录，实景扫描用例依赖本机 `.claude` 布局）。

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
- 规则 glob 匹配仅覆盖 read/write/edit 工具触达的文件（bash 内部操作的文件无法感知）。
- 技能/规则目录无 watcher（靠目录 mtime 失效 + 定期目录扫描刷新）。

## 参考实现（先行研究）

- [TimeCraker/dsh-claude-import](https://github.com/TimeCraker/dsh-claude-import) —— 一次性复制/合并导入（预览+冲突策略），与本插件的直读方案互补。
- [cms19859230182-lang/dsh-import](https://github.com/cms19859230182-lang/dsh-import) —— `/import` 命令导入 MCP/rules/hooks（多工具源）。
- 官方 `@deepseek-ai/dsh-hooks-claude-code` + `@deepseek-ai/dsh-hook-protocol`（npm）—— 本插件 hooks 语义的来源（进程级单配置；本插件补上了 per-session 发现 + cwd 过滤 + 用户级合并）。

## License

BSD-3-Clause。hooks 执行器语义改写自 `@deepseek-ai/dsh-hooks-claude-code`（BSD-3-Clause）。
