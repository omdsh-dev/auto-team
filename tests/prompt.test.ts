import { describe, expect, it } from 'vitest'

import { reporterPrompt } from '#src/prompt'

describe('auto-team reporter prompt', () => {
  it('addresses the user directly and returns after one turn', () => {
    const prompt = reporterPrompt()
    expect(prompt).toContain('Your reader is the user')
    expect(prompt).toContain('The Lead monitors the team on its own schedule')
    expect(prompt).toContain('Write the result in your reply to the user')
    expect(prompt).toContain('code changes belong to execution agents')
    expect(prompt).toContain('Each turn ends after one update or one answer')
    expect(prompt).toContain('read list_agents once')
    expect(prompt).not.toContain('team_task_list')
  })
})
