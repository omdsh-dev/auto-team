import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type {
  SpawnTeammateResult,
  TeamMemberView,
  TeamMembership,
  TeamService,
} from '@deepseek-ai/dsh-experimental-agent-team'
import type { GoalService, GoalView } from '@deepseek-ai/dsh-goal'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {
  ToolDefinition,
  ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { Config, apply, inject, name } from '#src/index'

const plugin = { Config, apply, inject, name }
const SIGNAL = new AbortController().signal
const WORKTREE = `${process.cwd()}/.worktrees/worker`
const INSIDE = `${WORKTREE}/src/a.ts`
const OUTSIDE = `${process.cwd()}/src/a.ts`

function noop(): void {
  return undefined
}

interface FakeScope {
  readonly ctx: Context
  readonly listeners: Map<string, (...args: never[]) => unknown>
  readonly sections: unknown[]
  readonly tools: unknown[]
}

interface FakeAgent {
  readonly agent: Agent
  readonly scope: FakeScope
  readonly steer: ReturnType<typeof vi.fn>
  readonly session: Session
}

interface FakeCommand {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: {
    readonly agent: Agent
    readonly rawInput: string
  }) => unknown
}

function requireCommand(commands: readonly FakeCommand[]): FakeCommand {
  const [command] = commands
  if (command === undefined) {
    throw new Error('reset command was not registered')
  }
  return command
}

function firstCall(
  calls: readonly unknown[][] | undefined,
): readonly unknown[] {
  const [call] = calls ?? []
  if (call === undefined) {
    throw new Error('expected at least one call')
  }
  return call
}

interface Fakes {
  readonly goalsCreated: unknown[]
  readonly members: { name: string }[]
  readonly projection: { value?: unknown }
}

interface Runtime {
  readonly commands: FakeCommand[]
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly fakes: Fakes
  readonly lead: FakeAgent
  readonly worker: FakeAgent
}

function createScope(): FakeScope {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const sections: unknown[] = []
  const tools: unknown[] = []
  const ctx = {
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener)
      return noop
    },
    systemPrompt: {
      getSectionOrder: (_name: string) => 0,
      section: (section: unknown) => {
        sections.push(section)
        return noop
      },
    },
    tools: {
      register: (tool: unknown) => {
        tools.push(tool)
        return noop
      },
    },
  } as unknown as Context

  return { ctx, listeners, sections, tools }
}

function createFakeAgent(label: string): FakeAgent {
  // oxlint-disable-next-line eslint/new-cap -- SessionId is a brand function, not a constructor
  const session = Session.create(SessionId(`session-${label}`))
  const scope = createScope()
  const steer = vi.fn<(message: unknown) => void>()
  const agent = {
    id: session.id,
    session,
    ctx: scope.ctx,
    status: 'idle',
    steer,
  } as unknown as Agent

  return { agent, scope, steer, session }
}

function eventListener(
  scope: FakeScope,
  event: string,
): (...args: unknown[]) => unknown {
  const listener = scope.listeners.get(event)
  if (listener === undefined) {
    throw new Error(`runtime listener "${event}" was not installed`)
  }
  return listener as (...args: unknown[]) => unknown
}

async function createRuntime(): Promise<Runtime> {
  const lead = createFakeAgent('lead')
  const worker = createFakeAgent('worker')
  const fakes: Fakes = {
    goalsCreated: [],
    members: [],
    projection: {},
  }

  const agents = { list: () => [] } as unknown as AgentRegistry
  const goals = {
    get: () => undefined,
    create: (_agent: Agent, request: { objective: string }) => {
      fakes.goalsCreated.push(request)
      return {
        objective: request.objective,
        phase: 'active',
        maxGoalRounds: 256,
      } as unknown as GoalView
    },
  } as unknown as GoalService
  const agentTeams = {
    tryMembership: (agent: Agent) => {
      if (agent === lead.agent) {
        return {
          root: lead.agent,
          id: 'team-1',
          role: 'lead',
          name: 'lead',
        } as unknown as TeamMembership
      }
      if (agent === worker.agent) {
        return {
          root: lead.agent,
          id: 'team-1',
          role: 'teammate',
          name: 'worker',
        } as unknown as TeamMembership
      }
      return undefined
    },
    listMembers: () =>
      fakes.members.map((member) => ({
        id: 'member',
        name: member.name,
        role: 'teammate',
        status: 'active',
        diagnostics: [],
      })) as unknown as TeamMemberView[],
    spawnTeammate: async (_agent: Agent, request: { name: string }) => {
      fakes.members.push({ name: request.name })
      return {
        member: {
          id: 'reporter',
          name: request.name,
          role: 'teammate',
          status: 'active',
          diagnostics: [],
        },
      } as unknown as SpawnTeammateResult
    },
  } as unknown as TeamService
  const tools = {
    register: () => noop,
  } as unknown as ToolRuntime
  const systemPrompt = {
    getSectionOrder: () => 0,
    section: () => noop,
  } as unknown as SystemPrompt
  const sessionProjections = {
    register: (definition: unknown) => {
      fakes.projection.value = definition
      return noop
    },
    stateOf: () => undefined,
  } as unknown as SessionProjectionRegistry
  const commands: FakeCommand[] = []
  const commandRuntime = {
    register: (definition: FakeCommand): (() => void) => {
      commands.push(definition)
      return noop
    },
  }

  const ctx = new Context()
  // Provide the host services from a sibling fiber, as the real profile does.
  // A plugin row may only reach them through `ctx.get`, not property access.
  await ctx.plugin({
    apply(host: Context) {
      host.provide('agents', agents)
      host.provide('agentTeams', agentTeams)
      host.provide('goals', goals)
      host.provide('tools', tools)
      host.provide('systemPrompt', systemPrompt)
      host.provide('sessionProjections', sessionProjections)
      host.provide('commands', commandRuntime)
    },
  })
  const fiber = await ctx.plugin(plugin, {})
  ctx.events.emit('agent/created', { agent: lead.agent, source: 'startup' })
  ctx.events.emit('agent/created', { agent: worker.agent, source: 'startup' })

  return { commands, ctx, fiber, fakes, lead, worker }
}

describe('auto-team runtime installation', () => {
  it('installs the policy, tool, projection, and stop guard', async () => {
    const runtime = await createRuntime()
    try {
      expect(runtime.fakes.projection.value).toMatchObject({ key: 'autoTeam' })
      expect(runtime.lead.scope.sections).toHaveLength(1)
      const section = runtime.lead.scope.sections[0] as { text: string }
      expect(section.text).toContain('Auto Team policy')
      expect(runtime.lead.scope.tools).toHaveLength(1)
      expect((runtime.lead.scope.tools[0] as ToolDefinition).name).toBe(
        'auto_team_score',
      )
      expect(
        runtime.lead.scope.listeners.has('agent/turn-stopping'),
      ).toBeTruthy()

      const stop = eventListener(
        runtime.lead.scope,
        'agent/turn-stopping',
      ) as (payload: {
        readonly agent: Agent
        readonly turn: number
        readonly signal: AbortSignal
      }) => void
      stop({ agent: runtime.lead.agent, turn: 1, signal: SIGNAL })
      expect(runtime.lead.steer).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.fiber.dispose()
    }
  })
})

describe('auto-team runtime scoring and guards', () => {
  it('scores once, then blocks Lead writes', async () => {
    const runtime = await createRuntime()
    try {
      const tool = runtime.lead.scope.tools[0] as ToolDefinition
      const result = await tool.execute(
        {
          scope: 5,
          parallelism: 5,
          ambiguity: 5,
          risk: 5,
          expected_steps: 5,
          objective: 'ship the feature',
        },
        {
          agent: runtime.lead.agent,
          signal: SIGNAL,
        } as unknown as ToolRunContext,
      )

      expect(result).toStrictEqual({
        decision: 'team',
        goal: 'started',
        reporter: 'reporter',
      })
      expect(runtime.fakes.goalsCreated).toHaveLength(1)
      expect(runtime.fakes.members).toHaveLength(1)

      const pre = eventListener(runtime.lead.scope, 'tools/pre-execute') as (
        exec: { readonly agent: Agent; readonly name: string },
        next: () => Promise<{ readonly kind: string }>,
      ) => Promise<unknown>
      const decision = await pre(
        { agent: runtime.lead.agent, name: 'write' },
        async () => ({ kind: 'allow' }),
      )
      expect(decision).toStrictEqual({
        kind: 'deny',
        reason: expect.any(String),
      })
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('registers and runs the user reset command', async () => {
    const runtime = await createRuntime()
    try {
      const tool = runtime.lead.scope.tools[0] as ToolDefinition
      await tool.execute(
        {
          scope: 5,
          parallelism: 5,
          ambiguity: 5,
          risk: 5,
          expected_steps: 5,
          objective: 'ship the feature',
        },
        {
          agent: runtime.lead.agent,
          signal: SIGNAL,
        } as unknown as ToolRunContext,
      )

      expect(runtime.commands).toHaveLength(1)
      const command = requireCommand(runtime.commands)
      expect(command.name).toBe('auto-team-reset')

      const silent = await command.handler({
        agent: runtime.lead.agent,
        rawInput: '',
      })
      expect(silent).toStrictEqual({ kind: 'success' })
      expect(runtime.lead.steer).not.toHaveBeenCalled()

      await tool.execute(
        {
          scope: 5,
          parallelism: 5,
          ambiguity: 5,
          risk: 5,
          expected_steps: 5,
          objective: 'ship the feature',
        },
        {
          agent: runtime.lead.agent,
          signal: SIGNAL,
        } as unknown as ToolRunContext,
      )
      const withMessage = await command.handler({
        agent: runtime.lead.agent,
        rawInput: '  continue with the next step  ',
      })
      expect(withMessage).toStrictEqual({ kind: 'success' })
      expect(runtime.lead.steer).toHaveBeenCalledTimes(1)
      const [steered] = firstCall(runtime.lead.steer.mock.calls)
      expect(steered).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'continue with the next step' }],
      })
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('requires a worker worktree and keeps edits inside it', async () => {
    const runtime = await createRuntime()
    try {
      const tool = runtime.lead.scope.tools[0] as ToolDefinition
      await tool.execute(
        {
          scope: 5,
          parallelism: 5,
          ambiguity: 5,
          risk: 5,
          expected_steps: 5,
          objective: 'ship the feature',
        },
        {
          agent: runtime.lead.agent,
          signal: SIGNAL,
        } as unknown as ToolRunContext,
      )

      const pre = eventListener(runtime.worker.scope, 'tools/pre-execute') as (
        exec: {
          readonly agent: Agent
          readonly name: string
          readonly arguments?: unknown
        },
        next: () => Promise<{ readonly kind: string }>,
      ) => Promise<unknown>
      const post = eventListener(
        runtime.worker.scope,
        'tools/post-execute',
      ) as (
        exec: { readonly agent: Agent; readonly name: string },
        result: { readonly isError: boolean; readonly value?: unknown },
        next: () => Promise<{ readonly kind: string }>,
      ) => Promise<unknown>

      const denied = await pre(
        { agent: runtime.worker.agent, name: 'write' },
        async () => ({ kind: 'allow' }),
      )
      expect(denied).toStrictEqual({ kind: 'deny', reason: expect.any(String) })

      await post(
        { agent: runtime.worker.agent, name: 'create_worktree' },
        { isError: false, value: { path: WORKTREE } },
        async () => ({ kind: 'accept' }),
      )
      const outside = await pre(
        {
          agent: runtime.worker.agent,
          name: 'write',
          arguments: { file_path: OUTSIDE },
        },
        async () => ({ kind: 'allow' }),
      )
      expect(outside).toStrictEqual({
        kind: 'deny',
        reason: expect.any(String),
      })

      const allowed = await pre(
        {
          agent: runtime.worker.agent,
          name: 'write',
          arguments: { file_path: INSIDE },
        },
        async () => ({ kind: 'allow' }),
      )
      expect(allowed).toStrictEqual({ kind: 'allow' })
    } finally {
      await runtime.fiber.dispose()
    }
  })
})
