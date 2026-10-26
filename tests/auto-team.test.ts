import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { describe, expect, it } from 'vitest'

import { AutoTeam } from '#src/auto-team'
import type {
  GoalCreateRequest,
  GoalPort,
  ReporterRequest,
  ScoreRecord,
  ScoreStore,
  TeamMember,
  TeamPort,
} from '#src/auto-team'
import { resolveConfig } from '#src/config'
import type { PluginConfig } from '#src/config'
import type { DifficultyAssessment } from '#src/policy'

const AGENT = { id: 'agent-1' } as unknown as Agent
const HIGH: DifficultyAssessment = {
  scope: 5,
  parallelism: 5,
  ambiguity: 5,
  risk: 5,
  expectedSteps: 5,
}
const MID: DifficultyAssessment = {
  scope: 3,
  parallelism: 3,
  ambiguity: 3,
  risk: 3,
  expectedSteps: 3,
}
const LOW: DifficultyAssessment = {
  scope: 1,
  parallelism: 1,
  ambiguity: 1,
  risk: 1,
  expectedSteps: 1,
}
const SIGNAL = new AbortController().signal
const SOLO_RECORD: ScoreRecord = {
  score: 0,
  threshold: 0.55,
  manualGoal: false,
  decision: 'solo',
  goal: 'none',
}

interface Fakes {
  readonly agentsWithGoal: Set<Agent>
  readonly created: GoalCreateRequest[]
  readonly members: TeamMember[]
  readonly spawns: ReporterRequest[]
  readonly goals: GoalPort
  readonly stored: Map<Agent, ScoreRecord>
  readonly store: ScoreStore
  readonly team: TeamPort
}

function createFakes(): Fakes {
  const agentsWithGoal = new Set<Agent>()
  const created: GoalCreateRequest[] = []
  const members: TeamMember[] = []
  const spawns: ReporterRequest[] = []
  const stored = new Map<Agent, ScoreRecord>()

  const goals: GoalPort = {
    get: (agent) => {
      if (!agentsWithGoal.has(agent)) {
        return undefined
      }
      return { objective: 'existing' } as unknown as GoalView
    },
    create: (agent, request) => {
      created.push(request)
      agentsWithGoal.add(agent)
      return { objective: request.objective } as unknown as GoalView
    },
  }

  const team: TeamPort = {
    listMembers: () => members,
    spawnReporter: async (_agent, request) => {
      spawns.push(request)
      const member = { name: request.name }
      members.push(member)
      return Promise.resolve(member)
    },
  }

  const store: ScoreStore = {
    read: (agent) => stored.get(agent),
    write: (agent, record) => {
      stored.set(agent, record)
    },
    reset: (agent) => {
      stored.delete(agent)
    },
  }

  return {
    agentsWithGoal,
    created,
    members,
    spawns,
    goals,
    stored,
    store,
    team,
  }
}

function createAutoTeam(fakes: Fakes, overrides: PluginConfig = {}): AutoTeam {
  return new AutoTeam(
    { goals: fakes.goals, store: fakes.store, team: fakes.team },
    resolveConfig(overrides),
  )
}

describe('auto-team orchestration', () => {
  it('starts a goal and a reporter when the score triggers team', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect(result).toStrictEqual({
      decision: 'team',
      goal: 'started',
      reporter: 'reporter',
    })
    expect(fakes.created).toHaveLength(1)
    expect(fakes.created[0]).toStrictEqual({
      objective: 'ship the feature',
      maxGoalRounds: 256,
    })
    expect(fakes.spawns).toHaveLength(1)
    expect(fakes.spawns[0]?.provider).toBe('spawn')
    expect(autoTeam.hasScore(AGENT)).toBeTruthy()
  })

  it('keeps a solo task free of a goal and reporter', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: LOW,
      objective: 'tiny task',
      signal: SIGNAL,
    })

    expect(result).toStrictEqual({ decision: 'solo', goal: 'none' })
    expect(fakes.created).toHaveLength(0)
    expect(fakes.spawns).toHaveLength(0)
  })

  it('applies the 60 percent threshold to a user-triggered goal', async () => {
    const fakes = createFakes()
    fakes.agentsWithGoal.add(AGENT)
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: MID,
      objective: 'existing goal task',
      signal: SIGNAL,
    })

    expect(result.decision).toBe('team')
    expect(result.goal).toBe('reused')
    expect(fakes.created).toHaveLength(0)
    expect(fakes.spawns).toHaveLength(1)
  })

  it('freezes the first decision and reuses the reporter on later calls', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    const first = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })
    const second = await autoTeam.score(AGENT, {
      assessment: LOW,
      objective: 'different objective',
      signal: SIGNAL,
    })

    expect(second).toStrictEqual(first)
    expect(fakes.created).toHaveLength(1)
    expect(fakes.spawns).toHaveLength(1)
  })
})

describe('auto-team reporter lifecycle', () => {
  it('does not spawn a reporter that already exists', async () => {
    const fakes = createFakes()
    fakes.members.push({ name: 'reporter' })
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect(result.reporter).toBe('reporter')
    expect(fakes.spawns).toHaveLength(0)
  })

  it('rejects an empty objective before starting a goal', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    await expect(
      autoTeam.score(AGENT, {
        assessment: HIGH,
        objective: '   ',
        signal: SIGNAL,
      }),
    ).rejects.toThrow(TypeError)
    expect(fakes.created).toHaveLength(0)
    expect(autoTeam.hasScore(AGENT)).toBeFalsy()
  })

  it('keeps the score frozen when reporter provisioning fails', async () => {
    const fakes = createFakes()
    const failing: TeamPort = {
      listMembers: () => [],
      spawnReporter: async () => Promise.reject(new Error('spawn failed')),
    }
    const autoTeam = new AutoTeam(
      { goals: fakes.goals, store: fakes.store, team: failing },
      resolveConfig(),
    )

    await expect(
      autoTeam.score(AGENT, {
        assessment: HIGH,
        objective: 'ship the feature',
        signal: SIGNAL,
      }),
    ).rejects.toThrow('spawn failed')
    expect(autoTeam.hasScore(AGENT)).toBeTruthy()
    expect(fakes.created).toHaveLength(1)
  })

  it('never returns the numeric score or threshold', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect('score' in result).toBeFalsy()
    expect('threshold' in result).toBeFalsy()
  })
})

describe('auto-team persisted score', () => {
  it('writes the frozen record to the store', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    const stored = fakes.stored.get(AGENT)
    expect(stored).toBeDefined()
    expect(stored?.decision).toBe('team')
    expect(stored?.score).toBe(1)
    expect(stored?.threshold).toBe(0.55)
  })

  it('reuses a stored record without scoring again', async () => {
    const fakes = createFakes()
    fakes.stored.set(AGENT, SOLO_RECORD)
    const autoTeam = createAutoTeam(fakes)

    const result = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect(result).toStrictEqual({ decision: 'solo', goal: 'none' })
    expect(fakes.created).toHaveLength(0)
    expect(fakes.spawns).toHaveLength(0)
  })

  it('clears the frozen record on reset', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)
    await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect(autoTeam.hasScore(AGENT)).toBeTruthy()
    autoTeam.reset(AGENT)
    expect(autoTeam.hasScore(AGENT)).toBeFalsy()
    expect(fakes.stored.has(AGENT)).toBeFalsy()
  })

  it('restores a record without rescoring', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)
    autoTeam.restore(AGENT, SOLO_RECORD)

    const result = await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })

    expect(autoTeam.hasScore(AGENT)).toBeTruthy()
    expect(result.decision).toBe('solo')
  })
})

describe('auto-team decision access', () => {
  it('exposes the frozen decision to the runtime guard', async () => {
    const fakes = createFakes()
    const autoTeam = createAutoTeam(fakes)

    expect(autoTeam.decisionOf(AGENT)).toBeUndefined()
    await autoTeam.score(AGENT, {
      assessment: HIGH,
      objective: 'ship the feature',
      signal: SIGNAL,
    })
    expect(autoTeam.decisionOf(AGENT)).toBe('team')
  })
})
