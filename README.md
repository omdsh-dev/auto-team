# DSH Auto Team

English | [中文](README.zh.md)

`@oh-my-dsh/auto-team` is a host-only DeepSeek Harness plugin (Cordis id `auto-team`). It gives long tasks a scored start and a team-shaped run, and it keeps the numeric score out of the model's context.

The plugin adds the first-round decision, the goal bridge, and the Lead and worker policy gates. The teammate, task-board, and worktree tools come from the host profile. It targets DSH 0.2.1-rc.2.

## How a task runs

The Lead calls `auto_team_score` once in the first round. The call takes five factors from 1 to 5, covering scope, parallelism, ambiguity, risk, and expected_steps, plus the task goal in its ordinary meaning.

The plugin turns the factors into a weighted score from 0 to 1. The model gets only `team` or `solo`; the score and the effective threshold stay host-side. The default threshold is 0.55. If a user-created goal already exists at the first score, the threshold is multiplied by 0.6.

The first round must be scored. If the turn tries to close before the tool ran, an `agent/turn-stopping` listener steers the Lead back with a reminder.

The score is frozen for the task. Only a user-triggered `/auto-team-reset` clears it; the next score becomes the new frozen decision. It is written to the session log as a `plugin:auto-team/score` record and folded into the host-only `autoTeam` projection, so resuming a session keeps the decision and does not score again.

On a team decision the plugin:

- reuses the current goal, or starts one when none exists;
- ensures a user-facing reporting teammate named `reporter`, which is configurable; the Lead relays its updates to the user;
- tells the Lead to keep the main Git repository and the team, and not to write code;
- denies the Lead's `write` and `edit` calls by default;
- requires each execution teammate to complete `create_worktree` before its own `write` or `edit` is allowed, and checks that an edit path stays inside the registered worktree when the host returns one. The reporter is exempt.

Multi-round execution belongs to the goal runtime. The plugin starts or reuses the goal and does not run its own continuation loop.

On a solo decision the task runs as a normal single-agent task.

## Requirements

The profile must compose these host services:

- `agents`, `tools`, `systemPrompt`, `sessionProjections`
- `agentTeams` from `@deepseek-ai/dsh-experimental-agent-team`
- `goals` from `@deepseek-ai/dsh-goal`
- `commands` (optional; enables `/auto-team-reset`)

The plugin loads without the required services but logs a warning and installs nothing. When a service arrives later, an `internal/service` listener retries the install. The `commands` service is optional: without it the score tool still works and `/auto-team-reset` is not registered.

## Install

Build and pack the package:

```sh
pnpm install
pnpm run lint
pnpm test
pnpm run build
pnpm pack
```

Install from npm once the package is published:

```sh
dsh plugin --profile <profile> add @oh-my-dsh/auto-team
```

Or install a locally packed tarball:

```sh
dsh plugin --profile <profile> add ./oh-my-dsh-auto-team-0.1.1.tgz
```

The package name is `@oh-my-dsh/auto-team`, published under the `@oh-my-dsh` scope.

## Configuration

Every field is optional. Schemastery checks the values at load; invalid values fail activation.

| Field | Default | Meaning |
| --- | --- | --- |
| `message` | `auto-team loaded` | Activation log line. |
| `threshold` | `0.55` | Base score needed for Team mode. |
| `manualGoalFactor` | `0.6` | Multiplier applied to the threshold when a user-created goal exists. |
| `weights` | scope 0.3, parallelism 0.25, ambiguity 0.15, risk 0.15, expectedSteps 0.15 | Relative weight of each difficulty factor. |
| `reportingAgentName` | `reporter` | Name of the reporting teammate. |
| `reportingProvider` | `spawn` | Subagent provider used for the reporter. |
| `goalMaxRounds` | `256` | Round cap used when the plugin starts a goal. |
| `enforceLeadNoCode` | `true` | Install the Lead write/edit gate. |
| `leadDeniedTools` | `['write', 'edit']` | Tool names denied to a Team-mode Lead. |

## Tool

The package adds one model-facing tool.

`auto_team_score` takes:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `scope` | integer 1 to 5 | Expected change scope. |
| `parallelism` | integer 1 to 5 | How much independent work can run at once. |
| `ambiguity` | integer 1 to 5 | How much requirement or design uncertainty remains. |
| `risk` | integer 1 to 5 | How costly a wrong change would be. |
| `expected_steps` | integer 1 to 5 | Expected task length. |
| `objective` | string | The task goal in its ordinary meaning. Used only when the plugin starts a goal. |

It returns `{ decision, goal, reporter? }`. The numeric score and threshold are not in the result. The host's Agent Teams tools handle spawning, messaging, and the shared task board. The host goal lifecycle handles completion and continuation.

## Commands

When the profile provides the host `commands` service, the plugin registers `auto-team-reset`:

- `/auto-team-reset` clears the frozen score for the current session.
- It appends a `plugin:auto-team/reset` record, so resuming the session does not restore the cleared score.
- It is silent by default. Any text after the command is sent to the Lead as a user message; use `/auto-team-reset call auto_team_score again` when you want the Lead to re-score. The current goal and reporter stay in place.
- The command is user-triggered; the model cannot invoke it.

## Guards and limits

- The Lead gate is a tool-name policy, not a sandbox. `pwsh`, `run_code`, and direct filesystem effects can bypass it. The policy tells the Lead not to use them as a workaround.
- The worker gate checks that a `create_worktree` call succeeded and, when the host returns the worktree path, that each `write` or `edit` uses an absolute `file_path` inside it. If the host result has no path, the gate falls back to checking only that the call succeeded.
- The reporter is spawned with the configured provider. If the spawn fails, the score stays frozen and a later call retries the reporter.
- A real DSH profile composition test has not been run in this repository. `tests/runtime.test.ts` mounts a real Cordis context and a real detached Session with fake host services, and covers the install path, the scoring tool, the stop guard, the Lead gate, and the worker gate.

## Development

```sh
pnpm install
pnpm run lint
pnpm test
pnpm run build
pnpm pack --dry-run --json
```

The tests cover the scoring policy, configuration, goal and reporter orchestration, the durable score projection and reset, the reset command, the runtime install path, and the Loader export shape.

Read [the design note](docs/auto-team-design.md) for the behavior and the flow chart, and [the plugin contracts](docs/dsh-plugin-contracts.md) for the package rules.

## Status

The core flow works and is covered by the repository tests. The release checks pass. Install the package in a profile that composes the required services, then run a long task to verify the behavior in your environment.