/**
 * Cordis integration for auto-team: per-Lead prompt, scoring tool, and
 * first-round stop enforcement.
 *
 * @module @oh-my-dsh/auto-team/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from './config.ts'
import type { PluginConfig, ResolvedConfig } from './config.ts'
import { autoTeamProjectionDefinition } from './projection.ts'
import { FIRST_ROUND_STEER_TEXT, policyText } from './prompt.ts'
import { createAutoTeam } from './services.ts'
import { createScoreTool } from './tool.ts'
import { installWorkerGuard } from './worker-guard.ts'

/** Auto-team instance type built from the live service adapters. */
type AutoTeam = ReturnType<typeof createAutoTeam>

/** Fakeable host boundary used by the baseline load message. */
interface PluginRuntime {
  info: (message: string) => void
  warn: (message: string) => void
}

/** Inputs for installing auto-team in one Lead agent scope. */
interface InstallLeadOptions {
  readonly agent: Agent
  readonly autoTeam: AutoTeam
  readonly config: ResolvedConfig
  readonly source: SessionStartSource | undefined
}

/** Create the production runtime adapter from a scoped Cordis context. */
function createPluginRuntime(ctx: Context): PluginRuntime {
  return {
    info: (message) => {
      ctx.logger.info(message)
    },
    warn: (message) => {
      ctx.logger.warn(message)
    },
  }
}

/** Install the prompt, scoring tool, and stop guard in one Lead scope. */
function installLead(options: InstallLeadOptions): () => void {
  const { agent, autoTeam, config, source } = options
  const systemPrompt: SystemPrompt = agent.ctx.systemPrompt
  const tools: ToolRuntime = agent.ctx.tools
  const disposers: (() => void)[] = []
  const register = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  try {
    register(
      systemPrompt.section({
        name: 'auto-team:policy',
        order: systemPrompt.getSectionOrder('TEAM_POLICY'),
        text: policyText(config.reportingAgentName, config.leadDeniedTools),
      }),
    )
    register(tools.register(createScoreTool(autoTeam)))

    if (source === 'startup' || source === 'clear') {
      const stop = agent.ctx.on('agent/turn-stopping', (payload) => {
        if (
          payload.agent !== agent
          || payload.turn !== 1
          || autoTeam.hasScore(agent)
        ) {
          return
        }
        agent.steer(
          createMessage({
            role: 'user',
            content: [{ type: 'text', text: FIRST_ROUND_STEER_TEXT }],
            source: { kind: 'user' },
          }),
        )
      })
      register((): void => {
        stop()
      })
    }

    if (config.enforceLeadNoCode) {
      const guard = agent.ctx.on('tools/pre-execute', async (exec, next) => {
        if (
          exec.agent !== agent
          || autoTeam.decisionOf(agent) !== 'team'
          || !config.leadDeniedTools.includes(exec.name)
        ) {
          // oxlint-disable-next-line typescript/return-await -- the tool waterfall expects the callback promise
          return await next()
        }
        return {
          kind: 'deny' as const,
          reason:
            'auto-team: the Lead must delegate code changes to an execution agent',
        }
      })
      register((): void => {
        guard()
      })
    }
  } catch (error) {
    for (const dispose of disposers.toReversed()) {
      dispose()
    }
    throw error
  }

  return (): void => {
    for (const dispose of disposers.toReversed()) {
      dispose()
    }
  }
}

/** Read the services needed by the install path without assuming load order. */
function servicesReady(ctx: Context): boolean {
  return (
    ctx.get('agentTeams') !== undefined
    && ctx.get('goals') !== undefined
    && ctx.get('tools') !== undefined
    && ctx.get('systemPrompt') !== undefined
  )
}

/** Apply auto-team to the host; unmanaged scopes stay untouched. */
function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  const runtime = createPluginRuntime(ctx)
  runtime.info(resolved.message)

  const autoTeam = createAutoTeam(ctx, resolved)
  const installed = new Map<Agent, () => void>()
  let warned = false
  let projectionRegistered = false

  const ensureProjection = (): void => {
    if (projectionRegistered) {
      return
    }
    const registry = ctx.get('sessionProjections')
    if (registry === undefined) {
      return
    }
    ctx.effect(
      () => registry.register(autoTeamProjectionDefinition),
      'auto-team.projection()',
    )
    projectionRegistered = true
  }

  ensureProjection()

  const install = (agent: Agent, source?: SessionStartSource): void => {
    if (installed.has(agent)) {
      return
    }
    ensureProjection()
    if (!servicesReady(ctx)) {
      if (!warned) {
        runtime.warn(
          'auto-team: host services are unavailable; waiting for agent and goal services',
        )
        warned = true
      }
      return
    }
    const membership = ctx.get('agentTeams')?.tryMembership(agent)
    if (membership === undefined) {
      return
    }
    if (membership.role === 'teammate') {
      if (membership.name !== resolved.reportingAgentName) {
        installed.set(
          agent,
          installWorkerGuard(agent, membership.root, autoTeam),
        )
      }
      return
    }
    const restored = ctx
      .get('sessionProjections')
      ?.stateOf(agent.session, 'autoTeam')?.score
    if (restored !== undefined && restored !== null) {
      autoTeam.restore(agent, restored)
    }
    installed.set(
      agent,
      installLead({ agent, autoTeam, config: resolved, source }),
    )
  }

  for (const agent of ctx.get('agents')?.list() ?? []) {
    install(agent)
  }
  ctx.on('agent/created', ({ agent, source }) => {
    install(agent, source)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on('internal/service', (name) => {
    if (
      name !== 'agentTeams'
      && name !== 'goals'
      && name !== 'tools'
      && name !== 'systemPrompt'
      && name !== 'sessionProjections'
    ) {
      return
    }
    ensureProjection()
    for (const agent of ctx.get('agents')?.list() ?? []) {
      install(agent)
    }
  })
  ctx.effect(
    (): (() => void) => (): void => {
      for (const dispose of installed.values()) {
        dispose()
      }
      installed.clear()
    },
    'auto-team.install()',
  )
}

export { apply, createPluginRuntime, type PluginRuntime }
