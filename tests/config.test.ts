import { describe, expect, it } from 'vitest'

import { resolveConfig } from '#src/config'

describe('auto-team configuration', () => {
  it('resolves the documented defaults', () => {
    const config = resolveConfig()
    expect(config.message).toBe('auto-team loaded')
    expect(config.threshold).toBe(0.55)
    expect(config.manualGoalFactor).toBe(0.6)
    expect(config.reportingAgentName).toBe('reporter')
    expect(config.reportingProvider).toBe('spawn')
    expect(config.goalMaxRounds).toBe(256)
    expect(config.enforceLeadNoCode).toBeTruthy()
    expect(config.leadDeniedTools).toStrictEqual(['write', 'edit'])
    const weightTotal =
      config.weights.scope
      + config.weights.parallelism
      + config.weights.ambiguity
      + config.weights.risk
      + config.weights.expectedSteps
    expect(weightTotal).toBeCloseTo(1)
  })

  it('merges partial weight overrides', () => {
    const config = resolveConfig({ weights: { scope: 0.5 } })
    expect(config.weights.scope).toBe(0.5)
    expect(config.weights.parallelism).toBe(0.25)
  })

  it('rejects an all-zero weight set', () => {
    expect(() =>
      resolveConfig({
        weights: {
          scope: 0,
          parallelism: 0,
          ambiguity: 0,
          risk: 0,
          expectedSteps: 0,
        },
      }),
    ).toThrow(TypeError)
  })

  it('rejects threshold and factor values outside zero through one', () => {
    expect(() => resolveConfig({ threshold: 1.5 })).toThrow(TypeError)
    expect(() => resolveConfig({ manualGoalFactor: -0.1 })).toThrow(TypeError)
  })

  it('rejects reporting names that are not lower-kebab-case', () => {
    expect(() => resolveConfig({ reportingAgentName: 'lead' })).toThrow(
      TypeError,
    )
    expect(() => resolveConfig({ reportingAgentName: 'Reporter One' })).toThrow(
      TypeError,
    )
  })

  it('rejects an invalid goal round cap', () => {
    expect(() => resolveConfig({ goalMaxRounds: 0 })).toThrow(TypeError)
    expect(() => resolveConfig({ goalMaxRounds: 1.5 })).toThrow(TypeError)
  })
})
