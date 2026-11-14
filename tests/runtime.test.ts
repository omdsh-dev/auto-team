import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { GoalService, GoalView } from '@deepseek-ai/dsh-goal'
import {
  Session,
  SessionId,
  appendPluginRecord,
} from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentActivation,
  SubagentActivationSpec,
  SubagentDescendantListEntry,
  SubagentResult,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type {
  ToolDefinition,
  ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import type { ScoreRecord } from '#src/auto-team'
import { Config, apply, inject, name } from '#src/index'
import type {
  AutoTeamProjectionState,
  autoTeamProjectionDefinition,
} from '#src/projection'

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
  readonly members: SubagentDescendantListEntry[]
  readonly projection: { value?: unknown }
  readonly published: Set<Agent>
  readonly roots: Map<Agent, Agent>
  readonly names: Map<Agent, string>
  readonly rootOf: ReturnType<typeof vi.fn<(agent: Agent) => Agent>>
  readonly starts: SubagentActivationSpec[]
  readonly started: ReturnType<
    typeof Promise.withResolvers<SubagentActivationSpec>
  >
  startup?: Promise<void>
  readonly result: ReturnType<typeof Promise.withResolvers<SubagentResult>>
  readonly disposeReporter: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly provider: { inheritsParentContext: boolean }
}

interface RuntimeOptions {
  readonly initialAgents?: boolean
  readonly lateServices?: boolean
  readonly publishWorker?: boolean
  readonly projectionReady?: Promise<void>
  readonly onProjectionRegister?: () => void
  readonly lead?: FakeAgent
  readonly restoredScore?: ScoreRecord
}

interface Runtime {
  readonly commands: FakeCommand[]
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly fakes: Fakes
  readonly lead: FakeAgent
  readonly worker: FakeAgent
  readonly mountServices: () => Promise<void>
  readonly publish: (agent: FakeAgent, memberName: string) => void
}

function createScope(): FakeScope {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const sections: unknown[] = []
  const tools: unknown[] = []
  const ctx = {
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener)
      return (): void => {
        listeners.delete(event)
      }
    },
    systemPrompt: {
      getSectionOrder: (_name: string) => 0,
      section: (section: unknown) => {
        sections.push(section)
        return (): void => {
          const index = sections.indexOf(section)
          if (index !== -1) {
            sections.splice(index, 1)
          }
        }
      },
    },
    tools: {
      register: (tool: unknown) => {
        tools.push(tool)
        return (): void => {
          const index = tools.indexOf(tool)
          if (index !== -1) {
            tools.splice(index, 1)
          }
        }
      },
    },
  } as unknown as Context
  return { ctx, listeners, sections, tools }
}

function createFakeAgent(
  label: string,
  meta: Partial<SessionHeader> = {},
): FakeAgent {
  // oxlint-disable-next-line eslint/new-cap -- SessionId is a brand function, not a constructor
  const id = SessionId(`session-${label}`)
  const blank = Session.create(id)
  const session = Session.create(id, [], { ...blank.header, ...meta })
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
    throw new Error(`runtime listener was not installed: ${event}`)
  }
  return listener as (...args: unknown[]) => unknown
}

function catalogEntry(
  parent: Agent,
  memberName: string,
): SubagentDescendantListEntry {
  return {
    kind: 'child',
    // oxlint-disable-next-line eslint/new-cap -- SessionId is a brand function, not a constructor
    id: SessionId(`catalog-${memberName}`),
    mode: 'continuable',
    label: memberName,
    name: memberName,
    parentId: parent.id,
    depth: 1,
    path: memberName,
    activity: 'inactive',
    hasChildren: false,
  }
}

async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const lead = options.lead ?? createFakeAgent('lead')
  const worker = createFakeAgent('worker', {
    origin: 'subagent',
    parentSession: lead.agent.id,
  })
  if (options.restoredScore !== undefined) {
    appendPluginRecord(
      lead.session,
      'plugin:auto-team/score',
      options.restoredScore,
    )
  }
  const published = new Set<Agent>()
  const roots = new Map([[worker.agent, lead.agent]])
  const names = new Map([[worker.agent, 'worker']])
  const rootOf = vi.fn<(agent: Agent) => Agent>((agent): Agent => {
    if (agent.session.header.origin === 'subagent' && !published.has(agent)) {
      throw new SubagentError('activation not published yet', 'UNAUTHORIZED')
    }
    return roots.get(agent) ?? agent
  })
  const fakes: Fakes = {
    goalsCreated: [],
    members: [],
    projection: {},
    published,
    roots,
    names,
    rootOf,
    starts: [],
    started: Promise.withResolvers<SubagentActivationSpec>(),
    result: Promise.withResolvers<SubagentResult>(),
    disposeReporter: vi.fn<() => Promise<void>>(async () => undefined),
    provider: { inheritsParentContext: false },
  }
  const live: Agent[] = []
  if (options.initialAgents === true) {
    live.push(lead.agent, worker.agent)
    published.add(worker.agent)
  }
  const agents = {
    list: () => live,
    get: (id: SessionId) => live.find((agent) => agent.id === id),
  } as unknown as AgentRegistry
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
  const subagents = {
    rootOf,
    namesOf: (agent: Agent) => ({ self: names.get(agent) ?? 'lead' }),
    listDescendants: async (_id: SessionId, signal: AbortSignal) => {
      signal.throwIfAborted()
      return fakes.members
    },
    getProvider: () => ({
      ...fakes.provider,
      prepareContinuable: async (): Promise<Record<string, never>> => ({}),
    }),
    startActivation: async (
      spec: SubagentActivationSpec,
    ): Promise<SubagentActivation> => {
      fakes.starts.push(spec)
      fakes.started.resolve(spec)
      await fakes.startup
      fakes.members.push(catalogEntry(spec.parent, spec.name ?? 'reporter'))
      return {
        // oxlint-disable-next-line eslint/new-cap -- SessionId is a brand function, not a constructor
        childId: SessionId('session-reporter'),
        name: spec.name ?? 'reporter',
        result: fakes.result.promise,
        dispose: fakes.disposeReporter,
      }
    },
  } as unknown as SubagentRuntime
  const tools = { register: () => noop } as unknown as ToolRuntime
  const systemPrompt = {
    getSectionOrder: () => 0,
    section: () => noop,
  } as unknown as Context['systemPrompt']
  const sessionProjections = {
    register: async (definition: typeof autoTeamProjectionDefinition) => {
      fakes.projection.value = definition
      options.onProjectionRegister?.()
      await options.projectionReady
      return {
        stateOf: (): AutoTeamProjectionState => ({
          score: options.restoredScore,
        }),
      }
    },
  } as unknown as Context['sessionProjections']
  const commands: FakeCommand[] = []
  const commandRuntime = {
    register: (definition: FakeCommand): (() => void) => {
      commands.push(definition)
      return (): void => {
        const index = commands.indexOf(definition)
        if (index !== -1) {
          commands.splice(index, 1)
        }
      }
    },
  }
  const ctx = new Context()
  await ctx.plugin({
    apply(host: Context) {
      host.provide('agents', agents)
      host.provide('sessionProjections', sessionProjections)
      host.provide('commands', commandRuntime)
    },
  })
  const mountServices = async (): Promise<void> => {
    await ctx.plugin({
      apply(host: Context) {
        host.provide('subagents', subagents)
        host.provide('goals', goals)
        host.provide('tools', tools)
        host.provide('systemPrompt', systemPrompt)
      },
    })
  }
  if (options.lateServices !== true) {
    await mountServices()
  }
  const fiber = await ctx.plugin(plugin, {})
  const publish = (child: FakeAgent, memberName: string): void => {
    if (!live.includes(child.agent)) {
      live.push(child.agent)
    }
    published.add(child.agent)
    roots.set(child.agent, lead.agent)
    names.set(child.agent, memberName)
    ctx.events.emit('subagent/start', { id: child.agent.id, local: true })
  }
  if (options.initialAgents !== true) {
    live.push(lead.agent, worker.agent)
    ctx.events.emit('agent/created', { agent: lead.agent, source: 'startup' })
    ctx.events.emit('agent/created', { agent: worker.agent, source: 'startup' })
    if (options.publishWorker !== false) {
      publish(worker, 'worker')
    }
  }
  return { commands, ctx, fiber, fakes, lead, worker, mountServices, publish }
}

async function score(runtime: Runtime, signal = SIGNAL): Promise<unknown> {
  const tool = runtime.lead.scope.tools[0] as ToolDefinition
  return tool.execute(
    {
      scope: 5,
      parallelism: 5,
      ambiguity: 5,
      risk: 5,
      expected_steps: 5,
      objective: 'ship the feature',
    },
    { agent: runtime.lead.agent, signal } as unknown as ToolRunContext,
  )
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

      const stop = eventListener(
        runtime.lead.scope,
        'agent/turn-stopping',
      ) as (payload: {
        readonly agent: Agent
        readonly turn: number
        readonly signal: AbortSignal
      }) => void
      stop({ agent: runtime.lead.agent, turn: 5, signal: SIGNAL })
      expect(runtime.lead.steer).toHaveBeenCalledTimes(1)
      const [forced] = firstCall(runtime.lead.steer.mock.calls)
      expect(forced).toMatchObject({
        role: 'user',
        content: [
          {
            type: 'text',
            text: expect.stringContaining('no score is recorded'),
          },
        ],
      })
      runtime.lead.steer.mockClear()
      expect(runtime.lead.scope.tools).toHaveLength(1)
      const rescoringTool = runtime.lead.scope.tools[0] as ToolDefinition

      await rescoringTool.execute(
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

describe('auto-team rc3 lifecycle and reporter', () => {
  it('awaits projection registration before exposing policy or score tools', async () => {
    const lead = createFakeAgent('await-projection')
    const ready = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const pending = createRuntime({
      lead,
      projectionReady: ready.promise,
      onProjectionRegister: () => {
        entered.resolve(undefined)
      },
    })
    await entered.promise
    expect(lead.scope.sections).toHaveLength(0)
    expect(lead.scope.tools).toHaveLength(0)
    ready.resolve(undefined)
    const runtime = await pending
    try {
      expect(lead.scope.sections).toHaveLength(1)
      expect(lead.scope.tools).toHaveLength(1)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('does not query a new subagent root before its start publication', async () => {
    const runtime = await createRuntime({ publishWorker: false })
    try {
      expect(runtime.fakes.rootOf).not.toHaveBeenCalledWith(
        runtime.worker.agent,
      )
      expect(runtime.worker.scope.listeners.size).toBe(0)
      runtime.publish(runtime.worker, 'worker')
      expect(runtime.fakes.rootOf).toHaveBeenCalledWith(runtime.worker.agent)
      expect(
        runtime.worker.scope.listeners.has('tools/pre-execute'),
      ).toBeTruthy()
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('scans existing roots and published workers at plugin startup', async () => {
    const runtime = await createRuntime({ initialAgents: true })
    try {
      expect(runtime.lead.scope.tools).toHaveLength(1)
      expect(
        runtime.worker.scope.listeners.has('tools/pre-execute'),
      ).toBeTruthy()
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('installs existing agents when optional runtime services arrive late', async () => {
    const runtime = await createRuntime({
      initialAgents: true,
      lateServices: true,
    })
    try {
      expect(runtime.lead.scope.tools).toHaveLength(0)
      await runtime.mountServices()
      expect(runtime.lead.scope.tools).toHaveLength(1)
      expect(
        runtime.worker.scope.listeners.has('tools/pre-execute'),
      ).toBeTruthy()
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('restores the frozen score before deciding whether to register a score tool', async () => {
    const runtime = await createRuntime({
      restoredScore: {
        score: 0,
        threshold: 0.55,
        manualGoal: false,
        decision: 'solo',
        goal: 'none',
      },
    })
    try {
      expect(runtime.lead.scope.sections).toHaveLength(1)
      expect(runtime.lead.scope.tools).toHaveLength(0)
      eventListener(
        runtime.lead.scope,
        'agent/turn-stopping',
      )({ agent: runtime.lead.agent })
      expect(runtime.lead.steer).not.toHaveBeenCalled()
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('only steers the exact unscored lead at every turn number', async () => {
    const runtime = await createRuntime()
    try {
      const stop = eventListener(runtime.lead.scope, 'agent/turn-stopping')
      stop({ agent: runtime.worker.agent, turn: 1, signal: SIGNAL })
      expect(runtime.lead.steer).not.toHaveBeenCalled()
      stop({ agent: runtime.lead.agent, turn: 999, signal: SIGNAL })
      expect(runtime.lead.steer).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('exempts only the direct reporter, not a worker named reporter below another worker', async () => {
    const runtime = await createRuntime()
    try {
      const reporter = createFakeAgent('reporter', { origin: 'subagent' })
      const nested = createFakeAgent('nested-reporter', { origin: 'subagent' })
      runtime.publish(reporter, 'reporter')
      runtime.publish(nested, 'worker/reporter')
      expect(reporter.scope.tools).toHaveLength(0)
      expect(reporter.scope.listeners.size).toBe(0)
      expect(nested.scope.listeners.has('tools/pre-execute')).toBeTruthy()
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('starts a fresh caller-delivered reporter without waiting for its result', async () => {
    const runtime = await createRuntime()
    try {
      await score(runtime)
      expect(runtime.fakes.starts).toHaveLength(1)
      expect(runtime.fakes.starts[0]).toMatchObject({
        parent: runtime.lead.agent,
        provider: 'spawn',
        name: 'reporter',
        delivery: 'caller',
        label: 'User-facing status reporter for the auto team',
        prompt: [
          {
            type: 'text',
            text: expect.stringContaining('Your reader is the user'),
          },
        ],
      })
      expect(runtime.lead.scope.tools).toHaveLength(0)
    } finally {
      await runtime.fiber.dispose()
    }
    expect(runtime.fakes.disposeReporter).toHaveBeenCalledTimes(1)
  })

  it('reuses an existing direct continuable reporter', async () => {
    const runtime = await createRuntime()
    try {
      runtime.fakes.members.push(catalogEntry(runtime.lead.agent, 'reporter'))
      await score(runtime)
      expect(runtime.fakes.starts).toHaveLength(0)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('does not reuse a same-named descendant owned by another parent', async () => {
    const runtime = await createRuntime()
    try {
      runtime.fakes.members.push({
        ...catalogEntry(runtime.worker.agent, 'reporter'),
        depth: 2,
        path: 'worker/reporter',
      })
      await score(runtime)
      expect(runtime.fakes.starts).toHaveLength(1)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('rejects a provider that inherits the lead conversation', async () => {
    const runtime = await createRuntime()
    try {
      runtime.fakes.provider.inheritsParentContext = true
      await expect(score(runtime)).rejects.toThrow(
        'fresh local subagent provider',
      )
      expect(runtime.fakes.starts).toHaveLength(0)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('observes rejected reporter results without injecting or steering the lead', async () => {
    const runtime = await createRuntime()
    const warn = vi.spyOn(runtime.fiber.ctx.logger, 'warn').mockReturnValue()
    try {
      await score(runtime)
      runtime.fakes.result.reject(new Error('reporter failed'))
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith(
        'auto-team: reporter activation failed',
        expect.any(Error),
      )
      expect(runtime.lead.steer).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await runtime.fiber.dispose()
    }
  })

  it('cancels discovery before spawning when the score call is aborted', async () => {
    const runtime = await createRuntime()
    const cancel = new AbortController()
    try {
      const pending = score(runtime, cancel.signal)
      cancel.abort(new Error('stop scoring'))
      await expect(pending).rejects.toThrow('stop scoring')
      expect(runtime.fakes.starts).toHaveLength(0)
    } finally {
      await runtime.fiber.dispose()
    }
  })

  it('cancels pending reporter startup and disposes a late fulfillment after unload', async () => {
    const runtime = await createRuntime()
    const startup = Promise.withResolvers<undefined>()
    runtime.fakes.startup = startup.promise
    const pending = score(runtime)
    const spec = await runtime.fakes.started.promise
    await runtime.fiber.dispose()
    expect(spec.signal.aborted).toBeTruthy()
    startup.resolve(undefined)
    await expect(pending).rejects.toThrow('This operation was aborted')
    expect(runtime.fakes.disposeReporter).toHaveBeenCalledTimes(1)
  })

  it('owns the replacement score tool after a silent reset until plugin unload', async () => {
    const runtime = await createRuntime()
    await score(runtime)
    expect(runtime.lead.scope.tools).toHaveLength(0)
    const result = await requireCommand(runtime.commands).handler({
      agent: runtime.lead.agent,
      rawInput: '',
    })
    expect(result).toStrictEqual({ kind: 'success' })
    expect(runtime.lead.scope.tools).toHaveLength(1)
    expect(runtime.lead.steer).not.toHaveBeenCalled()
    await runtime.fiber.dispose()
    expect(runtime.lead.scope.tools).toHaveLength(0)
    expect(runtime.lead.scope.sections).toHaveLength(0)
    expect(runtime.lead.scope.listeners.size).toBe(0)
    expect(runtime.worker.scope.listeners.size).toBe(0)
    expect(runtime.commands).toHaveLength(0)
    expect(runtime.fakes.disposeReporter).toHaveBeenCalledTimes(1)
  })
})
