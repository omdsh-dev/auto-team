/**
 * User-triggered reset command for the frozen auto-team score.
 *
 * @module @oh-my-dsh/auto-team/reset-command
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'

import type { AutoTeam } from './auto-team.ts'

/** Exact agent that invoked the command. */
interface CommandInvocation {
  readonly agent: Agent
  readonly rawInput: string
}

/** Result rendered directly by the dispatching UI. */
interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** Minimal command definition accepted by the host registry. */
interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: CommandInvocation) => CommandResult
}

/** Host command registry surface used by auto-team. */
interface CommandRuntime {
  readonly register: (definition: CommandDefinition) => () => void
}

/** Build the user-facing score reset command. */
function createResetCommand(autoTeam: AutoTeam): CommandDefinition {
  return {
    name: 'auto-team-reset',
    description: 'Clear the frozen Auto Team score for this session.',
    handler: (invocation) => {
      if (autoTeam.decisionOf(invocation.agent) === undefined) {
        return {
          kind: 'error',
          text: 'No frozen Auto Team score exists in this session.',
        }
      }

      autoTeam.reset(invocation.agent)
      const message = invocation.rawInput.trim()
      if (message.length > 0) {
        invocation.agent.steer(
          createMessage({
            role: 'user',
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
          }),
        )
      }
      return { kind: 'success' }
    },
  }
}

/** Structural guard for the optional host commands service. */
function isCommandRuntime(value: unknown): value is CommandRuntime {
  if (typeof value !== 'object' || value === null || !('register' in value)) {
    return false
  }
  return typeof value.register === 'function'
}

export { createResetCommand, isCommandRuntime, type CommandRuntime }
