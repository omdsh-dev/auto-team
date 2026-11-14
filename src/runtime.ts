/**
 * Cordis integration for auto-team: per-Lead prompt, scoring tool, and
 * unconditional no-score stop enforcement.
 *
 * @module @oh-my-dsh/auto-team/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from './config.ts'
import type { PluginConfig, ResolvedConfig } from './config.ts'
import { autoTeamProjectionDefinition } from './projection.ts'
import { NO_SCORE_STEER_TEXT, policyText } from './prompt.ts'
import { createResetCommand, isCommandRuntime } from './reset-command.ts'
import { createAutoTeam } from './services.ts'
import { registerScoreTool } from './tool.ts'
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
  const { agent, autoTeam, config } = options
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
    if (!autoTeam.hasScore(agent)) {
      register(registerScoreTool(tools, autoTeam))
    }

    const stop = agent.ctx.on('agent/turn-stopping', (payload) => {
      if (payload.agent !== agent || autoTeam.hasScore(agent)) {
        return
      }
      agent.steer(
        createMessage({
          role: 'user',
          content: [{ type: 'text', text: NO_SCORE_STEER_TEXT }],
          source: { kind: 'user' },
        }),
      )
    })
    register((): void => {
      stop()
    })

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
    ctx.get('subagents') !== undefined
    && ctx.get('agents') !== undefined
    && ctx.get('goals') !== undefined
    && ctx.get('tools') !== undefined
    && ctx.get('systemPrompt') !== undefined
  )
}

/** Apply auto-team after its host-only score projection is ready. */
async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const resolved = resolveConfig(config)
  const runtime = createPluginRuntime(ctx)
  runtime.info(resolved.message)
  const projection = await ctx.sessionProjections.register(
    autoTeamProjectionDefinition,
  )
  const autoTeam = createAutoTeam(ctx, resolved, projection)
  const installed = new Map<Agent, () => void>()
  let warned = false
  let resetCommandRegistered = false

  const ensureResetCommand = (): void => {
    if (resetCommandRegistered) {
      return
    }
    const commands: unknown = ctx.get('commands')
    if (!isCommandRuntime(commands)) {
      return
    }
    const command = createResetCommand(autoTeam, (agent) => {
      ctx.effect(
        () => registerScoreTool(agent.ctx.tools, autoTeam),
        'auto-team.reset-score-tool()',
      )
    })
    ctx.effect(() => commands.register(command), 'auto-team.reset-command()')
    resetCommandRegistered = true
  }

  const install = (agent: Agent): void => {
    if (installed.has(agent)) {
      return
    }
    if (!servicesReady(ctx)) {
      if (!warned) {
        runtime.warn(
          'auto-team: host services are unavailable; waiting for agent and goal services',
        )
        warned = true
      }
      return
    }
    const subagents = ctx.get('subagents')
    if (subagents === undefined) {
      return
    }
    let root = agent
    try {
      root = subagents.rootOf(agent)
    } catch (error) {
      // Startup scans can see an Agent whose activation is not published yet.
      if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
        return
      }
      throw error
    }
    if (root !== agent) {
      if (subagents.namesOf(agent).self !== resolved.reportingAgentName) {
        installed.set(agent, installWorkerGuard(agent, root, autoTeam))
      }
      return
    }
    const restored = projection.stateOf(agent.session).score
    if (restored !== undefined) {
      autoTeam.restore(agent, restored)
    }
    installed.set(agent, installLead({ agent, autoTeam, config: resolved }))
  }

  ctx.effect(
    (): (() => void) => (): void => {
      for (const dispose of installed.values()) {
        dispose()
      }
      installed.clear()
    },
    'auto-team.install()',
  )
  ctx.on('agent/created', ({ agent }) => {
    // Agent creation precedes the subagent manager's ownership publication.
    if (agent.session.header.origin !== 'subagent') {
      install(agent)
    }
  })
  ctx.on('subagent/start', (info) => {
    if (!info.local) {
      return
    }
    const agent = ctx.get('agents')?.get(info.id)
    if (agent !== undefined) {
      install(agent)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.on('internal/service', (name) => {
    if (
      name !== 'subagents'
      && name !== 'agents'
      && name !== 'goals'
      && name !== 'tools'
      && name !== 'systemPrompt'
      && name !== 'commands'
    ) {
      return
    }
    ensureResetCommand()
    for (const agent of ctx.get('agents')?.list() ?? []) {
      install(agent)
    }
  })
  ensureResetCommand()
  for (const agent of ctx.get('agents')?.list() ?? []) {
    install(agent)
  }
}

export { apply, createPluginRuntime, type PluginRuntime }
