/**
 * Host-independent auto-team orchestration: scoring, goal reuse, and reporter
 * provisioning.
 *
 * @module @oh-my-dsh/auto-team/auto-team
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'

import type { ResolvedConfig } from './config.ts'
import { createScoreDecision } from './policy.ts'
import type { DifficultyAssessment, TeamDecision } from './policy.ts'
import { reporterPrompt } from './prompt.ts'

/** Final goal action reported to the model. */
type GoalAction = 'started' | 'reused' | 'none'

/** Model-facing scoring result. The numeric score and threshold are absent. */
interface ScoreResult {
  readonly decision: TeamDecision
  readonly goal: GoalAction
  readonly reporter?: string
}

/** One score request from the model-facing tool. */
interface ScoreRequest {
  readonly assessment: DifficultyAssessment
  readonly objective: string
  readonly signal: AbortSignal
}

/** Request used to create a goal. */
interface GoalCreateRequest {
  readonly objective: string
  readonly maxGoalRounds: number
}

/** Goal operations auto-team needs. The real goal service satisfies this port. */
interface GoalPort {
  readonly get: (agent: Agent) => GoalView | undefined
  readonly create: (agent: Agent, request: GoalCreateRequest) => GoalView
}

/** One team member as far as auto-team needs to identify it. */
interface TeamMember {
  readonly name: string
}

/** Request used to provision the dedicated reporting teammate. */
interface ReporterRequest {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly provider: string
  readonly signal: AbortSignal
}

/** Team operations auto-team needs. The real Team service satisfies this port. */
interface TeamPort {
  readonly listMembers: (agent: Agent) => readonly TeamMember[]
  readonly spawnReporter: (
    agent: Agent,
    request: ReporterRequest,
  ) => Promise<TeamMember>
}

/** Durable score storage used to survive session resume. */
interface ScoreStore {
  readonly read: (agent: Agent) => ScoreRecord | undefined
  readonly write: (agent: Agent, record: ScoreRecord) => void
}

/** Host operations used by the orchestrator. */
interface AutoTeamDeps {
  readonly goals: GoalPort
  readonly team: TeamPort
  readonly store: ScoreStore
}

/** Frozen host-side score record. Never projected to the model. */
interface ScoreRecord {
  readonly score: number
  readonly threshold: number
  readonly manualGoal: boolean
  readonly decision: TeamDecision
  readonly goal: GoalAction
}

/** Host-side auto-team state and operations. */
class AutoTeam {
  private readonly records = new WeakMap<Agent, ScoreRecord>()
  private readonly deps: AutoTeamDeps
  private readonly config: ResolvedConfig

  public constructor(deps: AutoTeamDeps, config: ResolvedConfig) {
    this.deps = deps
    this.config = config
  }

  /** Whether this agent already has a frozen score. */
  public hasScore(agent: Agent): boolean {
    return this.records.has(agent)
  }

  /** Seed a record restored from durable storage without scoring again. */
  public restore(agent: Agent, record: ScoreRecord): void {
    if (!this.records.has(agent)) {
      this.records.set(agent, record)
    }
  }

  /** The frozen team decision, when this agent has one. */
  public decisionOf(agent: Agent): TeamDecision | undefined {
    return (this.records.get(agent) ?? this.deps.store.read(agent))?.decision
  }

  /**
   * Score one task, freeze the decision, then start or reuse its goal and
   * ensure the reporting teammate.
   */
  public async score(
    agent: Agent,
    request: ScoreRequest,
  ): Promise<ScoreResult> {
    const existing = this.records.get(agent) ?? this.deps.store.read(agent)
    if (existing !== undefined) {
      this.records.set(agent, existing)
      const frozen = await this.finish(agent, existing, request.signal)
      return frozen
    }

    const existingGoal = this.deps.goals.get(agent)
    const manualGoal = existingGoal !== undefined
    const decision = createScoreDecision(request.assessment, {
      weights: this.config.weights,
      threshold: this.config.threshold,
      manualGoal,
      manualGoalFactor: this.config.manualGoalFactor,
    })

    let goal: GoalAction = 'none'
    if (decision.decision === 'team' && existingGoal === undefined) {
      goal = this.startGoal(agent, request.objective)
    } else if (existingGoal !== undefined) {
      goal = 'reused'
    }

    const record: ScoreRecord = {
      score: decision.score,
      threshold: decision.threshold,
      manualGoal,
      decision: decision.decision,
      goal,
    }
    this.deps.store.write(agent, record)
    this.records.set(agent, record)
    const finished = await this.finish(agent, record, request.signal)
    return finished
  }

  /** Create the auto-started goal and return the reported action. */
  private startGoal(agent: Agent, objective: string): GoalAction {
    const trimmed = objective.trim()
    if (trimmed.length === 0) {
      throw new TypeError('objective is required when auto-team starts a goal')
    }
    this.deps.goals.create(agent, {
      objective: trimmed,
      maxGoalRounds: this.config.goalMaxRounds,
    })
    return 'started'
  }

  /** Add the reporter result to a frozen record, provisioning it when needed. */
  private async finish(
    agent: Agent,
    record: ScoreRecord,
    signal: AbortSignal,
  ): Promise<ScoreResult> {
    if (record.decision === 'solo') {
      return { decision: 'solo', goal: record.goal }
    }
    const reporter = await this.ensureReporter(agent, signal)
    return { decision: 'team', goal: record.goal, reporter }
  }

  /** Reuse an existing reporting teammate or spawn one. */
  private async ensureReporter(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<string> {
    const name = this.config.reportingAgentName
    const existing = this.deps.team
      .listMembers(agent)
      .find((member) => member.name === name)
    if (existing !== undefined) {
      return existing.name
    }

    const spawned = await this.deps.team.spawnReporter(agent, {
      name,
      description: 'User-facing status reporter for the auto team',
      prompt: reporterPrompt(),
      provider: this.config.reportingProvider,
      signal,
    })
    return spawned.name
  }
}

export {
  AutoTeam,
  type AutoTeamDeps,
  type GoalAction,
  type GoalCreateRequest,
  type GoalPort,
  type ReporterRequest,
  type ScoreRecord,
  type ScoreRequest,
  type ScoreResult,
  type ScoreStore,
  type TeamMember,
  type TeamPort,
}
