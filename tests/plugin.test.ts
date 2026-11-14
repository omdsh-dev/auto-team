import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'

import { createPluginHarness } from './harness.ts'

const TEST_TIMEOUT = 5000
const EXPECTED_SINGLE_CALL = 1

interface PluginExports {
  readonly name: unknown
  readonly inject: unknown
  readonly Config: unknown
  readonly apply: unknown
}

function isPluginExports(value: unknown): value is PluginExports {
  return (
    typeof value === 'object'
    && value !== null
    && 'name' in value
    && 'inject' in value
    && 'Config' in value
    && 'apply' in value
  )
}

function createLoader(): Loader {
  return new Loader(new Context())
}

function assertPluginExports(unwrapped: unknown, plugin: object): void {
  if (!isPluginExports(unwrapped)) {
    throw new TypeError('Loader did not return plugin exports')
  }
  expect(unwrapped).toBe(plugin)
  expect(unwrapped.name).toBe('auto-team')
  expect(unwrapped.inject).toStrictEqual(['sessionProjections'])
  expect(unwrapped.Config).toBeDefined()
  expect(unwrapped.apply).toBeTypeOf('function')
}

async function testPreservesPluginNamespace(): Promise<void> {
  expect.hasAssertions()
  const plugin = await import('#src/index')
  expect(['default' in plugin]).toStrictEqual([false])

  const loader = createLoader()
  const unwrapped: unknown = loader.unwrapExports(plugin)
  assertPluginExports(unwrapped, plugin)
}

async function testAppliesWithSchemaDefaults(): Promise<void> {
  expect.hasAssertions()
  const harness = await createPluginHarness()
  expect(harness.info).toHaveBeenCalledWith('auto-team loaded')
  await harness.dispose()
}

async function testAcceptsCompositionConfiguration(): Promise<void> {
  expect.hasAssertions()
  const harness = await createPluginHarness({ message: 'hello from a profile' })
  expect(harness.info).toHaveBeenCalledWith('hello from a profile')
  await harness.dispose()
}

async function testLogsOncePerActivation(): Promise<void> {
  expect.hasAssertions()
  const harness = await createPluginHarness({ message: 'once' })
  expect(harness.info).toHaveBeenCalledTimes(EXPECTED_SINGLE_CALL)
  await harness.dispose()
}

async function testAwaitsProjectionThroughLoader(): Promise<void> {
  const ctx = new Context()
  const info = vi.spyOn(ctx.logger, 'info').mockReturnValue()
  const loaderOwner = await ctx.plugin(Loader)
  let projectionOwner: Fiber | undefined = undefined
  try {
    await ctx.fiber.await()
    const loader = ctx.get('loader')
    if (loader === undefined) {
      throw new Error('Loader service did not activate')
    }
    loader.builtins['auto-team'] = await import('#src/index')
    const id = await loader.create({
      name: 'cordis:auto-team',
      config: { message: 'late projection ready' },
    })
    expect(info).not.toHaveBeenCalled()
    projectionOwner = await ctx.plugin(SessionProjectionRegistry)
    await loader.await()
    const loaded = loader.resolve(id).fiber
    if (loaded === undefined) {
      throw new Error('Loader did not mount auto-team')
    }
    loaded.assertActive()
    expect(info).toHaveBeenCalledWith('late projection ready')
    // oxlint-disable-next-line eslint/new-cap -- SessionId brands a string.
    const session = Session.create(SessionId('auto-team-loader-projection'))
    expect(
      ctx.get('sessionProjections')?.checkpoint(session).autoTeam,
    ).toBeDefined()
  } finally {
    await loaderOwner.dispose()
    await projectionOwner?.dispose()
    info.mockRestore()
  }
}

describe('@oh-my-dsh/auto-team', () => {
  it(
    'preserves the function-plugin namespace through Loader unwrapping',
    { timeout: TEST_TIMEOUT },
    testPreservesPluginNamespace,
  )

  it(
    'waits for projection availability through an actual Loader entry',
    { timeout: TEST_TIMEOUT },
    testAwaitsProjectionThroughLoader,
  )

  it(
    'applies with schema defaults',
    { timeout: TEST_TIMEOUT },
    testAppliesWithSchemaDefaults,
  )

  it(
    'accepts composition configuration',
    { timeout: TEST_TIMEOUT },
    testAcceptsCompositionConfiguration,
  )

  it(
    'logs once for one activation',
    { timeout: TEST_TIMEOUT },
    testLogsOncePerActivation,
  )
})
