/**
 * Worker write/edit gate: a successful worktree is required, and when the host
 * returns its path, edits must stay inside it.
 *
 * @module @oh-my-dsh/auto-team/worker-guard
 */

import path from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'

import type { AutoTeam } from './auto-team.ts'

/** Read a write or edit file path from its tool arguments. */
function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('file_path' in args)) {
    return undefined
  }
  const filePath = args.file_path
  if (typeof filePath === 'string') {
    return filePath
  }
  return undefined
}

/** Read the worktree path from a create_worktree canonical value. */
function worktreePathOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('path' in value)) {
    return undefined
  }
  const worktreePath = value.path
  if (typeof worktreePath === 'string') {
    return worktreePath
  }
  return undefined
}

/** Whether target resolves inside root. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/** Require one execution teammate to work inside its own worktree. */
function installWorkerGuard(
  agent: Agent,
  root: Agent,
  autoTeam: AutoTeam,
): () => void {
  let hasWorktree = false
  let worktreePath: string | undefined = undefined
  const disposers: (() => void)[] = []
  const register = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  try {
    const pre = agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (
        exec.agent === agent
        && autoTeam.decisionOf(root) === 'team'
        && (exec.name === 'write' || exec.name === 'edit')
      ) {
        if (!hasWorktree) {
          return {
            kind: 'deny' as const,
            reason:
              'auto-team: create your own worktree with create_worktree before editing files',
          }
        }
        if (worktreePath !== undefined) {
          const filePath = filePathOf(exec.arguments)
          if (filePath === undefined) {
            return {
              kind: 'deny' as const,
              reason:
                'auto-team: write and edit require a file_path so the worktree guard can verify it',
            }
          }
          if (!path.isAbsolute(filePath)) {
            return {
              kind: 'deny' as const,
              reason:
                'auto-team: use an absolute file path inside your registered worktree',
            }
          }
          if (!isInside(worktreePath, filePath)) {
            return {
              kind: 'deny' as const,
              reason: `auto-team: edit path is outside your worktree: ${worktreePath}`,
            }
          }
        }
      }
      // oxlint-disable-next-line typescript/return-await -- the tool waterfall expects the callback promise
      return await next()
    })
    register((): void => {
      pre()
    })

    const post = agent.ctx.on(
      'tools/post-execute',
      async (exec, result, next) => {
        if (
          exec.agent === agent
          && exec.name === 'create_worktree'
          && !result.isError
        ) {
          hasWorktree = true
          const registered = worktreePathOf(result.value)
          if (registered !== undefined) {
            worktreePath = registered
          }
        }
        // oxlint-disable-next-line typescript/return-await -- the tool waterfall expects the callback promise
        return await next()
      },
    )
    register((): void => {
      post()
    })
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

export { installWorkerGuard }
