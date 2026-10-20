/**
 * Pure difficulty scoring and team-trigger policy for auto-team.
 *
 * The numeric score and effective threshold stay host-side. The model-facing
 * tool projects only the resulting team or solo decision.
 *
 * @module @oh-my-dsh/auto-team/policy
 */

/** The five difficulty factors assessed in the first round. */
interface DifficultyAssessment {
  readonly scope: number
  readonly parallelism: number
  readonly ambiguity: number
  readonly risk: number
  readonly expectedSteps: number
}

/** Relative weight of each difficulty factor. */
interface ScoreWeights {
  readonly scope: number
  readonly parallelism: number
  readonly ambiguity: number
  readonly risk: number
  readonly expectedSteps: number
}

/** The only two outcomes the model may see. */
type TeamDecision = 'team' | 'solo'

/** Host-side inputs for one frozen scoring decision. */
interface ScoreOptions {
  readonly weights: ScoreWeights
  readonly threshold: number
  readonly manualGoal: boolean
  readonly manualGoalFactor: number
}

/** A frozen scoring outcome. The score and threshold stay host-side. */
interface ScoreDecision {
  readonly score: number
  readonly threshold: number
  readonly manualGoal: boolean
  readonly decision: TeamDecision
}

const MIN_FACTOR = 1
const MAX_FACTOR = 5
const FACTOR_RANGE = MAX_FACTOR - MIN_FACTOR

/** Clamp one finite factor to 1..5 and normalize it to 0..1. */
function normalizeFactor(
  name: keyof DifficultyAssessment,
  value: number,
): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`difficulty factor "${name}" must be a finite number`)
  }
  const clamped = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value))
  return (clamped - MIN_FACTOR) / FACTOR_RANGE
}

/** Reject negative or non-finite weights and an all-zero set. */
function validateWeights(weights: ScoreWeights): void {
  let total = 0
  for (const value of Object.values(weights)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('score weights must be finite and non-negative')
    }
    total += value
  }
  if (total <= 0) {
    throw new TypeError('score weights must have a positive total')
  }
}

/** Weighted 0..1 difficulty score. */
function scoreAssessment(
  assessment: DifficultyAssessment,
  weights: ScoreWeights,
): number {
  validateWeights(weights)
  const total =
    weights.scope
    + weights.parallelism
    + weights.ambiguity
    + weights.risk
    + weights.expectedSteps
  const weighted =
    normalizeFactor('scope', assessment.scope) * weights.scope
    + normalizeFactor('parallelism', assessment.parallelism)
      * weights.parallelism
    + normalizeFactor('ambiguity', assessment.ambiguity) * weights.ambiguity
    + normalizeFactor('risk', assessment.risk) * weights.risk
    + normalizeFactor('expectedSteps', assessment.expectedSteps)
      * weights.expectedSteps
  return weighted / total
}

/**
 * Effective trigger threshold; a user-triggered goal lowers it by the
 * configured factor.
 */
function effectiveThreshold(
  baseThreshold: number,
  manualGoal: boolean,
  manualGoalFactor: number,
): number {
  if (
    !Number.isFinite(baseThreshold)
    || baseThreshold < 0
    || baseThreshold > 1
  ) {
    throw new TypeError('threshold must be between 0 and 1')
  }
  if (
    !Number.isFinite(manualGoalFactor)
    || manualGoalFactor < 0
    || manualGoalFactor > 1
  ) {
    throw new TypeError('manualGoalFactor must be between 0 and 1')
  }
  let threshold = baseThreshold
  if (manualGoal) {
    threshold = baseThreshold * manualGoalFactor
  }
  return Math.min(1, Math.max(0, threshold))
}

/** Compare a score with the effective threshold. */
function decideTeam(score: number, threshold: number): TeamDecision {
  if (score >= threshold) {
    return 'team'
  }
  return 'solo'
}

/** Score one assessment and freeze the decision. */
function createScoreDecision(
  assessment: DifficultyAssessment,
  options: ScoreOptions,
): ScoreDecision {
  const threshold = effectiveThreshold(
    options.threshold,
    options.manualGoal,
    options.manualGoalFactor,
  )
  const score = scoreAssessment(assessment, options.weights)
  return {
    score,
    threshold,
    manualGoal: options.manualGoal,
    decision: decideTeam(score, threshold),
  }
}

export {
  createScoreDecision,
  decideTeam,
  effectiveThreshold,
  scoreAssessment,
  validateWeights,
  type DifficultyAssessment,
  type ScoreDecision,
  type ScoreOptions,
  type ScoreWeights,
  type TeamDecision,
}
