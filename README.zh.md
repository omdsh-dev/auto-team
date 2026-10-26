# DSH Auto Team

[English](README.md) | 中文

`@oh-my-dsh/auto-team` 是一个只跑在宿主侧的 DeepSeek Harness 插件，Cordis id 为 `auto-team`。它给长任务一个带评分的起点和团队式的执行方式，同时把具体分数留在模型上下文之外。

插件负责首轮判断、goal 桥接，以及 Lead 和执行 Agent 的策略闸门。队友、任务板和 worktree 工具由宿主 profile 提供。目标版本是 DSH 0.2.1-rc.2。

## 任务怎么跑

首轮由 Lead 调用一次 `auto_team_score`。参数是五个 1 到 5 的难度因子：scope、parallelism、ambiguity、risk、expected_steps，再加一句任务在通常语义上的目标。

插件把因子折算成 0 到 1 的加权分数。模型只拿到 `team` 或 `solo`，分数和实际阈值都留在宿主侧。默认阈值是 0.55。如果第一次打分时已经存在用户触发的 goal，阈值乘以 0.6。

首轮必须打分。如果这一轮想在没有调用工具时结束，`agent/turn-stopping` 监听器会把 Lead 拉回来，再发一次提醒。

分数在任务内冻结。只有用户主动执行 `/auto-team-reset` 才能清空；下一次打分成为新的冻结决定。它以 `plugin:auto-team/score` 记录写进 session log，并折进宿主侧的 `autoTeam` 投影。resume 时恢复这个决定，不会重新打分。

决定使用团队后，插件会：

- 复用当前 goal；没有 goal 就启动一个；
- 确保存在名为 `reporter` 的汇报 Agent，名字可配置；它面向用户写更新，Lead 负责转达；
- 提示 Lead 维护主 Git 仓库和团队，不写代码；
- 默认拒绝 Lead 的 `write` 和 `edit`；
- 要求每个执行 Agent 先成功调用 `create_worktree`，之后才允许自己的 `write` 或 `edit`；宿主返回 worktree 路径时，还会检查编辑路径是否在该 worktree 内。汇报 Agent 不受这条限制。

多轮执行交给 goal 运行时。插件只负责启动或复用 goal，不自己维护续跑循环。

决定不使用团队时，任务按普通单 Agent 流程执行。

## 依赖

profile 需要组合这些宿主服务：

- `agents`、`tools`、`systemPrompt`、`sessionProjections`
- `agentTeams`，来自 `@deepseek-ai/dsh-experimental-agent-team`
- `goals`，来自 `@deepseek-ai/dsh-goal`
- `commands`（可选；启用 `/auto-team-reset`）

必需服务缺失时插件仍会加载，但只打一条警告，不安装任何东西。之后某个服务到位，`internal/service` 监听器会重试安装。`commands` 服务是可选的：没有它，打分工具照常工作，但不会注册 `/auto-team-reset`。

## 安装

构建并打包：

```sh
pnpm install
pnpm run lint
pnpm test
pnpm run build
pnpm pack
```

从 npm 安装已发布的包：

```sh
dsh plugin --profile <profile> add @oh-my-dsh/auto-team
```

或者安装本地打包的 tarball：

```sh
dsh plugin --profile <profile> add ./oh-my-dsh-auto-team-0.1.2.tgz
```

包名是 `@oh-my-dsh/auto-team`，发布在 `@oh-my-dsh` scope 下。

## 配置

所有字段都可选。Schemastery 在加载时校验，非法值会让激活失败。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `message` | `auto-team loaded` | 激活时的日志。 |
| `threshold` | `0.55` | 进入团队模式的基础分数。 |
| `manualGoalFactor` | `0.6` | 已有用户触发 goal 时，阈值的乘数。 |
| `weights` | scope 0.3、parallelism 0.25、ambiguity 0.15、risk 0.15、expectedSteps 0.15 | 各难度因子的相对权重。 |
| `reportingAgentName` | `reporter` | 汇报 Agent 的名字。 |
| `reportingProvider` | `spawn` | 创建汇报 Agent 时用的子 Agent provider。 |
| `goalMaxRounds` | `256` | 插件启动 goal 时使用的轮次上限。 |
| `enforceLeadNoCode` | `true` | 是否安装 Lead 的写文件闸门。 |
| `leadDeniedTools` | `['write', 'edit']` | 团队模式下拒绝给 Lead 的工具名。 |

## 工具

这个包只增加一个模型可见工具。

`auto_team_score` 的参数：

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `scope` | 1 到 5 的整数 | 预计改动范围。 |
| `parallelism` | 1 到 5 的整数 | 有多少独立工作可以同时做。 |
| `ambiguity` | 1 到 5 的整数 | 还剩多少需求或设计不确定。 |
| `risk` | 1 到 5 的整数 | 改错了代价多大。 |
| `expected_steps` | 1 到 5 的整数 | 预计任务有多长。 |
| `objective` | 字符串 | 任务在通常语义上的目标。只在插件启动 goal 时使用。 |

返回 `{ decision, goal, reporter? }`。分数和阈值不在返回里。创建队友、发消息和共享任务板由宿主的 Agent Teams 工具负责；完成和续跑由宿主的 goal 生命周期负责。

## 命令

profile 提供宿主 `commands` 服务时，插件注册 `auto-team-reset`：

- `/auto-team-reset` 清空当前 session 的冻结分数。
- 它写入 `plugin:auto-team/reset` 记录，resume 时不会恢复被清掉的分数。
- 它默认静默，不发送消息；命令后附带的文字会作为用户消息发给 Lead。想让 Lead 重新打分就写 `/auto-team-reset call auto_team_score again`。当前 goal 和汇报 Agent 保留。
- 命令由用户触发，模型不能调用。

## 闸门与限制

- Lead 的闸门是工具名策略，不是沙箱。`pwsh`、`run_code` 和直接的文件系统操作可以绕过。策略文本会明确要求 Lead 不要拿它们绕路。
- 执行 Agent 的闸门会检查 `create_worktree` 是否成功；宿主返回 worktree 路径时，还会要求每次 `write`/`edit` 的 `file_path` 是该路径内的绝对路径。宿主结果没有路径时，只检查成功。
- 汇报 Agent 用配置的 provider 创建。如果创建失败，分数仍保持冻结，后续调用会重试创建。
- 仓库里还没有跑过真实 DSH profile 的组合测试。`tests/runtime.test.ts` 用真实 Cordis Context、真实 detached Session 和假的宿主服务，覆盖安装路径、打分工具、首轮停止闸门、Lead 闸门和执行 Agent 闸门。

## 开发

```sh
pnpm install
pnpm run lint
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

测试覆盖评分策略、配置、goal 与汇报 Agent 编排、持久化分数投影与重设、重设命令、运行时安装路径，以及 Loader 导出形状。

行为说明和流程图见[设计文档](docs/auto-team-design.md)，包规则见[插件契约](docs/dsh-plugin-contracts.md)。

## 状态

核心流程已经可用，并有仓库测试覆盖。发布检查已通过。把包装进已经组合好所需服务的 profile，跑一个长任务确认实际行为。