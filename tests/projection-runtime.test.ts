import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import {
  Session,
  SessionId,
  appendPluginRecord,
} from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'

import type { ScoreRecord } from '#src/auto-team'
import { autoTeamProjectionDefinition } from '#src/projection'
import type { AutoTeamProjectionState } from '#src/projection'

const FIRST_SCORE: ScoreRecord = {
  score: 0.9,
  threshold: 0.55,
  manualGoal: false,
  decision: 'team',
  goal: 'started',
}
const SECOND_SCORE: ScoreRecord = {
  score: 0.2,
  threshold: 0.55,
  manualGoal: false,
  decision: 'solo',
  goal: 'none',
}

interface ProjectionHarness {
  readonly handle: ProjectionHandle<AutoTeamProjectionState>
  readonly owner: Fiber
  readonly registry: SessionProjectionRegistry
  readonly dispose: () => Promise<void>
}

/**
 * Mount the real registry and await the projection on a separate consumer
 * fiber.
 */
async function createProjectionHarness(): Promise<ProjectionHarness> {
  const ctx = new Context()
  const provider = await ctx.plugin(SessionProjectionRegistry)
  const holder: { handle?: ProjectionHandle<AutoTeamProjectionState> } = {}
  const owner = await ctx.plugin({
    inject: ['sessionProjections'],
    async apply(host: Context): Promise<void> {
      holder.handle = await host.sessionProjections.register(
        autoTeamProjectionDefinition,
      )
    },
  })
  const registry = ctx.get('sessionProjections')
  if (holder.handle === undefined || registry === undefined) {
    await owner.dispose()
    await provider.dispose()
    throw new Error('projection registration did not publish a ready handle')
  }
  return {
    handle: holder.handle,
    owner,
    registry,
    async dispose(): Promise<void> {
      try {
        await owner.dispose()
      } finally {
        await provider.dispose()
      }
    },
  }
}

function detachedSession(label: string): Session {
  // oxlint-disable-next-line eslint/new-cap -- SessionId brands a string; it is not a constructor
  return Session.create(SessionId(`auto-team-projection-${label}`))
}

describe('auto-team projection on the rc.3 runtime', () => {
  it('awaits a typed handle and replays a score committed before registration', async () => {
    const session = detachedSession('late-registration')
    appendPluginRecord(session, 'plugin:auto-team/score', FIRST_SCORE)
    const harness = await createProjectionHarness()
    try {
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      const read = harness.handle.readerFor(session)
      appendPluginRecord(session, 'plugin:auto-team/reset', { at: 1 })
      expect(read()).toStrictEqual({})
    } finally {
      await harness.dispose()
    }
  })

  it('folds score-reset-score while freezing the first score between resets', async () => {
    const session = detachedSession('rescore')
    const harness = await createProjectionHarness()
    try {
      expect(harness.handle.stateOf(session)).toStrictEqual({})
      appendPluginRecord(session, 'plugin:auto-team/score', FIRST_SCORE)
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      appendPluginRecord(session, 'plugin:auto-team/score', SECOND_SCORE)
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      appendPluginRecord(session, 'plugin:auto-team/reset', { at: 2 })
      expect(harness.handle.stateOf(session)).toStrictEqual({})
      appendPluginRecord(session, 'plugin:auto-team/score', SECOND_SCORE)
      expect(harness.handle.stateOf(session).score).toStrictEqual(SECOND_SCORE)
      expect(harness.registry.checkpoint(session).autoTeam?.val).toStrictEqual({
        score: SECOND_SCORE,
      })
    } finally {
      await harness.dispose()
    }
  })

  it('checkpoints the host-only score without exposing a client wire or summary', async () => {
    const session = detachedSession('host-only')
    const harness = await createProjectionHarness()
    try {
      appendPluginRecord(session, 'plugin:auto-team/score', FIRST_SCORE)
      expect('wire' in autoTeamProjectionDefinition).toBeFalsy()
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      expect(harness.registry.snapshot(session).values).toStrictEqual({})
      expect([...harness.registry.summaryKeys()]).toStrictEqual([])
      const checkpoint = harness.registry.checkpoint(session)
      expect(checkpoint.autoTeam).toMatchObject({
        ver: autoTeamProjectionDefinition.stateVersion,
        val: { score: FIRST_SCORE },
      })
      const encodedCheckpoint = JSON.stringify(checkpoint)
      const restored: unknown = JSON.parse(encodedCheckpoint)
      expect(restored).toStrictEqual(checkpoint)
      appendPluginRecord(session, 'plugin:auto-team/reset', { at: 5 })
      const cleared = harness.registry.checkpoint(session)
      const encodedReset = JSON.stringify(cleared)
      const restoredReset: unknown = JSON.parse(encodedReset)
      expect(restoredReset).toStrictEqual(cleared)
    } finally {
      await harness.dispose()
    }
  })

  it('releases the fiber registration while retaining an on-demand reader', async () => {
    const session = detachedSession('fiber-release')
    const harness = await createProjectionHarness()
    try {
      appendPluginRecord(session, 'plugin:auto-team/score', FIRST_SCORE)
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      const before = harness.registry.checkpoint(session).autoTeam
      expect(before).toBeDefined()
      await harness.owner.dispose()
      appendPluginRecord(session, 'plugin:auto-team/reset', { at: 3 })
      expect(harness.registry.checkpoint(session).autoTeam).toStrictEqual(
        before,
      )
      expect(harness.handle.stateOf(session).score).toBeUndefined()
      expect(harness.registry.checkpoint(session).autoTeam?.val).toStrictEqual(
        expect.not.objectContaining({ score: FIRST_SCORE }),
      )
    } finally {
      await harness.dispose()
    }
  })

  it('releases an explicit handle before the owning fiber is disposed', async () => {
    const session = detachedSession('handle-release')
    const harness = await createProjectionHarness()
    try {
      appendPluginRecord(session, 'plugin:auto-team/score', FIRST_SCORE)
      expect(harness.handle.stateOf(session).score).toStrictEqual(FIRST_SCORE)
      const before = harness.registry.checkpoint(session).autoTeam
      await harness.handle.dispose()
      appendPluginRecord(session, 'plugin:auto-team/reset', { at: 4 })
      expect(harness.registry.checkpoint(session).autoTeam).toStrictEqual(
        before,
      )
      expect(harness.handle.readerFor(session)().score).toBeUndefined()
      await harness.handle.dispose()
    } finally {
      await harness.dispose()
    }
  })
})
