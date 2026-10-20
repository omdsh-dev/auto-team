import { describe, expect, it } from 'vitest'

import {
  createScoreDecision,
  decideTeam,
  effectiveThreshold,
  scoreAssessment,
  validateWeights,
} from '#src/policy'
import type { DifficultyAssessment, ScoreWeights } from '#src/policy'

const WEIGHTS: ScoreWeights = {
  scope: 0.3,
  parallelism: 0.25,
  ambiguity: 0.15,
  risk: 0.15,
  expectedSteps: 0.15,
}
const ALL_ONE: DifficultyAssessment = {
  scope: 1,
  parallelism: 1,
  ambiguity: 1,
  risk: 1,
  expectedSteps: 1,
}
const ALL_THREE: DifficultyAssessment = {
  scope: 3,
  parallelism: 3,
  ambiguity: 3,
  risk: 3,
  expectedSteps: 3,
}
const ALL_FIVE: DifficultyAssessment = {
  scope: 5,
  parallelism: 5,
  ambiguity: 5,
  risk: 5,
  expectedSteps: 5,
}

describe('auto-team scoring policy', () => {
  it('normalizes the factor range to zero through one', () => {
    expect(scoreAssessment(ALL_ONE, WEIGHTS)).toBe(0)
    expect(scoreAssessment(ALL_THREE, WEIGHTS)).toBe(0.5)
    expect(scoreAssessment(ALL_FIVE, WEIGHTS)).toBe(1)
  })

  it('clamps finite factors outside the documented range', () => {
    expect(scoreAssessment({ ...ALL_ONE, scope: 0 }, WEIGHTS)).toBe(0)
    expect(scoreAssessment({ ...ALL_FIVE, scope: 6 }, WEIGHTS)).toBe(1)
  })

  it('rejects non-finite factors', () => {
    expect(() =>
      scoreAssessment({ ...ALL_ONE, scope: Number.NaN }, WEIGHTS),
    ).toThrow(TypeError)
  })

  it('rejects invalid weight sets', () => {
    expect(() => {
      validateWeights({
        scope: 0,
        parallelism: 0,
        ambiguity: 0,
        risk: 0,
        expectedSteps: 0,
      })
    }).toThrow(TypeError)
    expect(() => {
      validateWeights({ ...WEIGHTS, scope: -1 })
    }).toThrow(TypeError)
    expect(() => {
      validateWeights({ ...WEIGHTS, scope: Number.POSITIVE_INFINITY })
    }).toThrow(TypeError)
  })

  it('lowers the threshold for a user-triggered goal', () => {
    expect(effectiveThreshold(0.55, false, 0.6)).toBe(0.55)
    expect(effectiveThreshold(0.55, true, 0.6)).toBeCloseTo(0.33)
  })

  it('decides team at the threshold boundary', () => {
    expect(decideTeam(0.55, 0.55)).toBe('team')
    expect(decideTeam(0.549, 0.55)).toBe('solo')
  })

  it('freezes the decision with the manual-goal threshold', () => {
    const decision = createScoreDecision(ALL_THREE, {
      weights: WEIGHTS,
      threshold: 0.55,
      manualGoal: true,
      manualGoalFactor: 0.6,
    })
    expect(decision.score).toBeCloseTo(0.5)
    expect(decision.threshold).toBeCloseTo(0.33)
    expect(decision.manualGoal).toBeTruthy()
    expect(decision.decision).toBe('team')
  })
})
