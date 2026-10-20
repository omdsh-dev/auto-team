/**
 * Standalone function plugin for DeepSeek Harness.
 *
 * @module @oh-my-dsh/auto-team
 */

/** Cordis plugin name; keep this stable after publishing. */
const name = 'auto-team'

/** Services that must exist before the plugin is applied. */
const inject: string[] = []

export { Config } from './config.ts'
export type { PluginConfig, ResolvedConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { PluginRuntime } from './runtime.ts'
export { inject, name }
