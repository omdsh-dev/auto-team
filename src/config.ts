/**
 * Serializable configuration, schema, and direct-call defaults for auto-team.
 *
 * @module @oh-my-dsh/auto-team/config
 */

import schema from '@deepseek-ai/schemastery'

import { validateWeights } from './policy.ts'
import type { ScoreWeights } from './policy.ts'

/** Inclusive numeric range used by direct-call validation. */
interface NumberRange {
  readonly min: number
  readonly max: number
}

/** Plugin configuration supplied by the profile composition. */
interface PluginConfig {
  /** Message written when this plugin loads. */
  message?: string
  /** Base team-trigger threshold in the 0..1 range. */
  threshold?: number
  /**
   * Multiplier applied to the threshold when a user-triggered goal already
   * exists.
   */
  manualGoalFactor?: number
  /** Relative weight of each difficulty factor. */
  weights?: Partial<ScoreWeights>
  /** Name of the reporting teammate created for a team task. */
  reportingAgentName?: string
  /** Continuable-subagent provider used for the reporting teammate. */
  reportingProvider?: string
  /** Positive round cap used when auto-team creates a goal. */
  goalMaxRounds?: number
  /** Block Lead writes after the team decision. Defaults to true. */
  enforceLeadNoCode?: boolean
  /** Tool names denied to a Team-mode Lead. Defaults to write and edit. */
  leadDeniedTools?: string[]
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  scope: 0.3,
  parallelism: 0.25,
  ambiguity: 0.15,
  risk: 0.15,
  expectedSteps: 0.15,
}
const DEFAULT_THRESHOLD = 0.55
const DEFAULT_MANUAL_GOAL_FACTOR = 0.6
const DEFAULT_REPORTING_AGENT_NAME = 'reporter'
const DEFAULT_REPORTING_PROVIDER = 'spawn'
const DEFAULT_GOAL_MAX_ROUNDS = 256
const DEFAULT_ENFORCE_LEAD_NO_CODE = true
const DEFAULT_LEAD_DENIED_TOOLS: string[] = ['write', 'edit']
const REPORTER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u
const UNIT_RANGE: NumberRange = { min: 0, max: 1 }

/** Loader-visible configuration schema and defaults. */
const Config: schema<PluginConfig> = schema.object({
  message: schema.string().default('auto-team loaded'),
  threshold: schema.number().min(0).max(1).default(DEFAULT_THRESHOLD),
  manualGoalFactor: schema
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MANUAL_GOAL_FACTOR),
  weights: schema.object({
    scope: schema.number().min(0).max(1).default(DEFAULT_WEIGHTS.scope),
    parallelism: schema
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_WEIGHTS.parallelism),
    ambiguity: schema.number().min(0).max(1).default(DEFAULT_WEIGHTS.ambiguity),
    risk: schema.number().min(0).max(1).default(DEFAULT_WEIGHTS.risk),
    expectedSteps: schema
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_WEIGHTS.expectedSteps),
  }),
  reportingAgentName: schema
    .string()
    .pattern(REPORTER_NAME_PATTERN)
    .default(DEFAULT_REPORTING_AGENT_NAME),
  reportingProvider: schema.string().default(DEFAULT_REPORTING_PROVIDER),
  goalMaxRounds: schema.natural().min(1).default(DEFAULT_GOAL_MAX_ROUNDS),
  enforceLeadNoCode: schema.boolean().default(DEFAULT_ENFORCE_LEAD_NO_CODE),
  leadDeniedTools: schema
    .array(schema.string())
    .default([...DEFAULT_LEAD_DENIED_TOOLS]),
})

/** Configuration after defaults have been resolved. */
interface ResolvedConfig {
  /** Message written when this plugin loads. */
  message: string
  /** Base team-trigger threshold in the 0..1 range. */
  threshold: number
  /**
   * Multiplier applied to the threshold when a user-triggered goal already
   * exists.
   */
  manualGoalFactor: number
  /** Relative weight of each difficulty factor. */
  weights: ScoreWeights
  /** Name of the reporting teammate created for a team task. */
  reportingAgentName: string
  /** Continuable-subagent provider used for the reporting teammate. */
  reportingProvider: string
  /** Positive round cap used when auto-team creates a goal. */
  goalMaxRounds: number
  /** Block Lead writes after the team decision. */
  enforceLeadNoCode: boolean
  /** Tool names denied to a Team-mode Lead. */
  leadDeniedTools: string[]
}

/** Validate one finite number against an inclusive range. */
function numberInRange(
  name: string,
  value: number,
  range: NumberRange,
): number {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new TypeError(`${name} must be between ${range.min} and ${range.max}`)
  }
  return value
}

/** Merge partial factor weights over the defaults and validate the total. */
function resolveWeights(config: PluginConfig): ScoreWeights {
  const weights: ScoreWeights = {
    scope: config.weights?.scope ?? DEFAULT_WEIGHTS.scope,
    parallelism: config.weights?.parallelism ?? DEFAULT_WEIGHTS.parallelism,
    ambiguity: config.weights?.ambiguity ?? DEFAULT_WEIGHTS.ambiguity,
    risk: config.weights?.risk ?? DEFAULT_WEIGHTS.risk,
    expectedSteps:
      config.weights?.expectedSteps ?? DEFAULT_WEIGHTS.expectedSteps,
  }
  validateWeights(weights)
  return weights
}

/** Resolve and validate the reporting teammate name. */
function resolveReportingAgentName(config: PluginConfig): string {
  const name = config.reportingAgentName ?? DEFAULT_REPORTING_AGENT_NAME
  if (!REPORTER_NAME_PATTERN.test(name) || name === 'lead') {
    throw new TypeError(
      'reportingAgentName must be lower-kebab-case and must not be "lead"',
    )
  }
  return name
}

/** Resolve and validate the goal round cap. */
function resolveGoalMaxRounds(config: PluginConfig): number {
  const rounds = config.goalMaxRounds ?? DEFAULT_GOAL_MAX_ROUNDS
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new TypeError('goalMaxRounds must be a positive safe integer')
  }
  return rounds
}

/** Resolve and validate the two score thresholds. */
function resolveThresholds(
  config: PluginConfig,
): Pick<ResolvedConfig, 'threshold' | 'manualGoalFactor'> {
  return {
    threshold: numberInRange(
      'threshold',
      config.threshold ?? DEFAULT_THRESHOLD,
      UNIT_RANGE,
    ),
    manualGoalFactor: numberInRange(
      'manualGoalFactor',
      config.manualGoalFactor ?? DEFAULT_MANUAL_GOAL_FACTOR,
      UNIT_RANGE,
    ),
  }
}

/** Resolve the same defaults for direct callers that bypass Cordis Loader. */
function resolveConfig(config: PluginConfig = {}): ResolvedConfig {
  return {
    message: config.message ?? 'auto-team loaded',
    ...resolveThresholds(config),
    weights: resolveWeights(config),
    reportingAgentName: resolveReportingAgentName(config),
    reportingProvider: config.reportingProvider ?? DEFAULT_REPORTING_PROVIDER,
    goalMaxRounds: resolveGoalMaxRounds(config),
    enforceLeadNoCode: config.enforceLeadNoCode ?? DEFAULT_ENFORCE_LEAD_NO_CODE,
    leadDeniedTools: [...(config.leadDeniedTools ?? DEFAULT_LEAD_DENIED_TOOLS)],
  }
}

export { Config, resolveConfig, type PluginConfig, type ResolvedConfig }
