/**
 * Live Cordis service adapters for the auto-team ports.
 *
 * @module @oh-my-dsh/auto-team/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {
  SubagentActivation,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'

import { AutoTeam } from './auto-team.ts'
import type {
  GoalPort,
  ReporterRequest,
  ScoreStore,
  TeamMember,
  TeamPort,
} from './auto-team.ts'
import type { ResolvedConfig } from './config.ts'
import type { AutoTeamProjectionState } from './projection.ts'

/** Read the goal service or fail with a plugin-specific message. */
function goalService(ctx: Context): GoalService {
  const service = ctx.get('goals')
  if (service === undefined) {
    throw new Error('auto-team: goals service is unavailable')
  }
  return service
}

/** Read the subagent service without assuming profile load order. */
function teamService(ctx: Context): SubagentRuntime {
  const service = ctx.get('subagents')
  if (service === undefined) {
    throw new Error('auto-team: subagents service is unavailable')
  }
  return service
}

/** Observe detached completion without waking or injecting the Lead. */
async function observeReporter(
  ctx: Context,
  activation: SubagentActivation,
): Promise<void> {
  try {
    await activation.result
  } catch (error) {
    ctx.logger.warn('auto-team: reporter activation failed', error)
  }
}

/** Start a fresh local reporter; its own Session is the user's conversation. */
async function spawnReporter(
  ctx: Context,
  agent: Agent,
  request: ReporterRequest & { readonly lifetime: AbortSignal },
): Promise<TeamMember> {
  const service = teamService(ctx)
  const provider = service.getProvider(request.provider)
  if (
    provider?.prepareContinuable === undefined
    || provider.inheritsParentContext
  ) {
    throw new Error(
      'auto-team: reporter requires a fresh local subagent provider',
    )
  }
  const signal = AbortSignal.any([request.signal, request.lifetime])
  signal.throwIfAborted()
  const activation = await service.startActivation({
    parent: agent,
    provider: request.provider,
    name: request.name,
    label: request.description,
    prompt: [{ type: 'text', text: request.prompt }],
    delivery: 'caller',
    signal,
  })
  // oxlint-disable-next-line typescript/no-floating-promises -- The activation completes independently; the observer catches rejection.
  observeReporter(ctx, activation)
  try {
    request.lifetime.throwIfAborted()
    ctx.effect(
      () => async (): Promise<void> => {
        await activation.dispose()
      },
      'auto-team.reporter()',
    )
  } catch (error) {
    await activation.dispose()
    throw error
  }
  return { name: request.name }
}

/** Build the goal, team, and durable score ports from Cordis services. */
function createAutoTeam(
  ctx: Context,
  config: ResolvedConfig,
  projection: ProjectionHandle<AutoTeamProjectionState>,
): AutoTeam {
  const lifetime = new AbortController()
  ctx.effect(
    () => (): void => {
      lifetime.abort()
    },
    'auto-team.reporter-startup()',
  )
  const goals: GoalPort = {
    get: (agent) => goalService(ctx).get(agent),
    create: (agent, request) => goalService(ctx).create(agent, request),
  }
  const team: TeamPort = {
    listMembers: async (agent, signal) => {
      const entries = await teamService(ctx).listDescendants(agent.id, signal)
      return entries.flatMap((entry) => {
        if (
          entry.kind !== 'child'
          || entry.parentId !== agent.id
          || entry.mode !== 'continuable'
          || entry.name === undefined
        ) {
          return []
        }
        return [{ name: entry.name }]
      })
    },
    spawnReporter: async (agent, request) => {
      const member = await spawnReporter(ctx, agent, {
        ...request,
        lifetime: lifetime.signal,
      })
      return member
    },
  }
  const store: ScoreStore = {
    read: (agent) => projection.stateOf(agent.session).score,
    write: (agent, record) => {
      appendPluginRecord(agent.session, 'plugin:auto-team/score', record)
    },
    reset: (agent) => {
      appendPluginRecord(agent.session, 'plugin:auto-team/reset', {
        at: Date.now(),
      })
    },
  }
  return new AutoTeam({ goals, team, store }, config)
}

export { createAutoTeam }
