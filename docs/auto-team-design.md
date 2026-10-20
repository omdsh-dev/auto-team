# auto-team 设计说明

## 缘起

做这个仓库，是因为我发现任务慢的很大一个原因：AI 不愿意同时开可能冲突的任务，最后把本来能并行的活排成单 Agent 串行。

auto-team 想把长任务拆开，交给多个 Agent 并行完成。每个 Agent 针对自己的任务开 Worktree，Lead Agent 维护 Main Git 仓库和团队。

## 三个阶段

长任务的全流程是首轮 init、迭代、任务的设置与结束。

### 首轮：init

Lead 在首轮根据任务难度自动判断是否需要 Agent Team。判断通过打分完成：首轮必须完成打分，没有分数就不能停止。

分数由运行时保存，模型只看到是否启用团队，看不到具体数值。分数一旦确定，在任务结束前不能修改。

不给模型看分数，是因为有的模型会故意报高或报低，以此触发或不触发团队。

### 迭代

确定使用 Agent Team 后，Lead Agent 维护 Main Git 仓库和团队，不写任何代码。代码全部由其他 Agent 负责。

团队里设一个汇报 Agent，专门和用户对接，汇报团队状态。用户要问进度、确认细节，都通过它。

多个 Agent 并行执行。每个 Agent 针对自己的任务自行开 Worktree，不和其他 Agent 共用一个工作区。

### 任务的设置与结束

任务的设置就是确定这个任务在普适语义上的目标，也就是它在通常理解下要达成的结果。任务开始后朝这个目标推进，目标达成后，任务结束。

执行中出现的细节对接问题交给汇报 Agent。执行 Agent 不等待这些确认，任务继续推进。

## 评分与 goal

auto-team 的多轮连续执行完全复用 goal 的机制，不另写一套循环。

长任务开始时只有两种状态：用户已经触发 goal，或者没有 goal。

如果用户没有 goal，但选择了 team，auto-team 会自动启动 goal。

用户手动触发 goal 时，团队触发分数按原本分数的 60% 计算。

## 流程图

```mermaid
flowchart TD
    START([长任务开始]) --> USER_GOAL{用户触发 goal？}
    USER_GOAL -- 是 --> SIXTY[触发分数按原分数 60%]
    USER_GOAL -- 否 --> FULL[触发分数按原分数]
    SIXTY --> SCORE[Lead 按任务难度打分<br/>首轮必须打分，不能停止<br/>分数到任务结束前不可改<br/>模型只看到是否启用团队]
    FULL --> SCORE
    SCORE --> ENOUGH{分数达到团队触发线？}
    ENOUGH -- 否 --> SOLO([单 Agent 执行])
    ENOUGH -- 是 --> GOAL_STARTED{goal 已启动？}
    GOAL_STARTED -- 否 --> AUTO_GOAL[自动启动 goal]
    AUTO_GOAL --> TEAM[启用 Agent Team]
    GOAL_STARTED -- 是 --> TEAM
    TEAM --> ITER[进入迭代]
    ITER --> LEAD[Lead 维护 Main Git 仓库和团队<br/>不写代码]
    LEAD --> REPORT[设汇报 Agent 对接用户，汇报状态]
    LEAD --> WORKERS[执行 Agent 并行写代码]
    WORKERS --> WT[每个 Agent 自行开 Worktree]
    WT --> GOAL_LOOP[复用 goal 多轮执行<br/>朝普适语义目标推进]
    REPORT --> DETAIL[细节对接交给汇报 Agent<br/>不阻塞任务执行]
    DETAIL --> GOAL_LOOP
    GOAL_LOOP --> DONE{目标达成？}
    DONE -- 否 --> GOAL_LOOP
    DONE -- 是 --> FINISH([任务结束])
```
