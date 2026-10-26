import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import type { ScoreRecord } from '#src/auto-team'
import {
  applyAutoTeamProjection,
  autoTeamProjectionDefinition,
} from '#src/projection'
import type { AutoTeamProjectionState } from '#src/projection'

const RECORD: ScoreRecord = {
  score: 0.5,
  threshold: 0.55,
  manualGoal: false,
  decision: 'solo',
  goal: 'none',
}

function scoreEvent(data: unknown): SessionEvent {
  return {
    type: 'plugin:auto-team/score',
    ignorable: true,
    seq: 0,
    time: 0,
    data,
  } as unknown as SessionEvent
}

function resetEvent(): SessionEvent {
  return {
    type: 'plugin:auto-team/reset',
    ignorable: true,
    seq: 1,
    time: 1,
    data: { at: 1 },
  } as unknown as SessionEvent
}

function unrelatedEvent(): SessionEvent {
  return {
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {},
  } as unknown as SessionEvent
}

describe('auto-team score projection', () => {
  it('folds the first score record', () => {
    const state = applyAutoTeamProjection({}, scoreEvent(RECORD))
    expect(state.score).toStrictEqual(RECORD)
  })

  it('keeps the first record when a later one appears', () => {
    const first = applyAutoTeamProjection({}, scoreEvent(RECORD))
    const second = applyAutoTeamProjection(
      first,
      scoreEvent({ ...RECORD, score: 1 }),
    )
    expect(second).toBe(first)
  })

  it('records a failure for invalid record data', () => {
    const state = applyAutoTeamProjection({}, scoreEvent({ score: 'invalid' }))
    expect(state.score).toBeUndefined()
    expect(state.failure).toBeTypeOf('string')
  })

  it('clears the score so a later score can replace it', () => {
    const scored = applyAutoTeamProjection({}, scoreEvent(RECORD))
    const reset = applyAutoTeamProjection(scored, resetEvent())
    expect(reset.score).toBeUndefined()
    const rescored = applyAutoTeamProjection(
      reset,
      scoreEvent({ ...RECORD, score: 1 }),
    )
    expect(rescored.score?.score).toBe(1)
  })

  it('ignores unrelated events', () => {
    const initial: AutoTeamProjectionState = {}
    expect(applyAutoTeamProjection(initial, unrelatedEvent())).toBe(initial)
  })

  it('validates the persisted projection state', () => {
    const parsed = autoTeamProjectionDefinition.stateSchema.safeParse({
      score: RECORD,
    })
    expect(parsed.success).toBeTruthy()
  })
})
