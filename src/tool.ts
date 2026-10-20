/**
 * Model-facing scoring tool. The numeric score and threshold are never part of
 * the tool result.
 *
 * @module @oh-my-dsh/auto-team/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { AutoTeam } from './auto-team.ts'

/** Build the one-shot scoring tool for a Lead agent scope. */
function createScoreTool(autoTeam: AutoTeam): ToolDefinition {
  return defineTool({
    name: 'auto_team_score',
    description:
      'Record the first-round difficulty assessment and return the team or solo decision. Call once before any other action; the decision is frozen for the task.',
    parameters: {
      scope: {
        type: 'integer',
        required: true,
        enum: [1, 2, 3, 4, 5],
        description: 'Expected change scope, from 1 low to 5 high.',
      },
      parallelism: {
        type: 'integer',
        required: true,
        enum: [1, 2, 3, 4, 5],
        description:
          'How much independent work can run in parallel, from 1 low to 5 high.',
      },
      ambiguity: {
        type: 'integer',
        required: true,
        enum: [1, 2, 3, 4, 5],
        description:
          'How much requirements or design uncertainty remains, from 1 low to 5 high.',
      },
      risk: {
        type: 'integer',
        required: true,
        enum: [1, 2, 3, 4, 5],
        description:
          'How costly a wrong change would be, from 1 low to 5 high.',
      },
      expected_steps: {
        type: 'integer',
        required: true,
        enum: [1, 2, 3, 4, 5],
        description: 'Expected length of the task, from 1 short to 5 long.',
      },
      objective: {
        type: 'string',
        required: true,
        description:
          'The task goal in its ordinary, universal meaning. Used only when auto-team starts a goal.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision: {
            type: 'string',
            required: true,
            enum: ['team', 'solo'],
          },
          goal: {
            type: 'string',
            required: true,
            enum: ['started', 'reused', 'none'],
          },
          reporter: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { agent } = exec
      if (agent === undefined) {
        throw new Error('auto_team_score requires a calling Agent')
      }
      const result = await autoTeam.score(agent, {
        assessment: {
          scope: args.scope,
          parallelism: args.parallelism,
          ambiguity: args.ambiguity,
          risk: args.risk,
          expectedSteps: args.expected_steps,
        },
        objective: args.objective,
        signal: exec.signal,
      })
      return result
    },
  })
}

export { createScoreTool }
