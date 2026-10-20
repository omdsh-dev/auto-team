/**
 * Live Cordis service adapters for the auto-team ports.
 *
 * @module @oh-my-dsh/auto-team/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

import { AutoTeam } from './auto-team.ts'
import type {
  GoalPort,
  ScoreRecord,
  ScoreStore,
  TeamPort,
} from './auto-team.ts'
import type { ResolvedConfig } from './config.ts'

/** Read the goal service or fail with a plugin-specific message. */
function goalService(ctx: Context): GoalService {
  const service = ctx.get('goals')
  if (service === undefined) {
    throw new Error('auto-team: goals service is unavailable')
  }
  return service
}

/** Read the Team service or fail with a plugin-specific message. */
function teamService(ctx: Context): TeamService {
  const service = ctx.get('agentTeams')
  if (service === undefined) {
    throw new Error('auto-team: agentTeams service is unavailable')
  }
  return service
}

/** Build the goal, team, and durable score ports from Cordis services. */
function createAutoTeam(ctx: Context, config: ResolvedConfig): AutoTeam {
  const goals: GoalPort = {
    get: (agent) => goalService(ctx).get(agent),
    create: (agent, request) => goalService(ctx).create(agent, request),
  }
  const team: TeamPort = {
    listMembers: (agent) => teamService(ctx).listMembers(agent),
    spawnReporter: async (agent, request) => {
      const result = await teamService(ctx).spawnTeammate(agent, {
        name: request.name,
        description: request.description,
        prompt: [{ type: 'text', text: request.prompt }],
        context: 'fresh',
        provider: request.provider,
        signal: request.signal,
      })
      return { name: result.member.name }
    },
  }
  const store: ScoreStore = {
    read: (agent): ScoreRecord | undefined =>
      ctx.get('sessionProjections')?.stateOf(agent.session, 'autoTeam')?.score,
    write: (agent, record) => {
      appendPluginRecord(agent.session, 'plugin:auto-team/score', record)
    },
  }
  return new AutoTeam({ goals, team, store }, config)
}

export { createAutoTeam }
