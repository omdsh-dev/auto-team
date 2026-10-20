/**
 * Durable, host-only projection for the frozen auto-team score.
 *
 * The score is appended as an ignorable plugin record. The projection keeps the
 * first record and never exposes the numeric score to the model or client.
 *
 * @module @oh-my-dsh/auto-team/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

import type { ScoreRecord } from './auto-team.ts'

/** Fold state for the host-only autoTeam projection. */
interface AutoTeamProjectionState {
  readonly score?: ScoreRecord | undefined
  readonly failure?: string | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:auto-team/score': ScoreRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    autoTeam: AutoTeamProjectionState
  }
}

const SCORE_RECORD_TYPE = 'plugin:auto-team/score'
const scoreRecordSchema = z.object({
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  manualGoal: z.boolean(),
  decision: z.enum(['team', 'solo']),
  goal: z.enum(['started', 'reused', 'none']),
})
const autoTeamProjectionStateSchema = z.object({
  score: scoreRecordSchema.optional(),
  failure: z.string().optional(),
})

/** Fold one committed event into the first frozen score record. */
function applyAutoTeamProjection(
  state: AutoTeamProjectionState,
  event: SessionEvent,
): AutoTeamProjectionState {
  const record = pluginRecordOf(event)
  if (record === undefined || record.type !== SCORE_RECORD_TYPE) {
    return state
  }
  if (state.score !== undefined) {
    return state
  }

  const parsed = scoreRecordSchema.safeParse(record.data)
  if (!parsed.success) {
    return { ...state, failure: parsed.error.message }
  }
  return { ...state, score: parsed.data }
}

/** Host-only projection definition for the auto-team score. */
const autoTeamProjectionDefinition = {
  key: 'autoTeam',
  stateSchema: autoTeamProjectionStateSchema,
  init: (): AutoTeamProjectionState => ({}),
  apply: applyAutoTeamProjection,
  stateVersion: 1,
} satisfies Omit<
  ProjectionDefinition<'autoTeam', AutoTeamProjectionState>,
  'wire'
>

export {
  applyAutoTeamProjection,
  autoTeamProjectionDefinition,
  type AutoTeamProjectionState,
}
