import { describe, expect, it } from 'vitest'

import { reporterPrompt } from '#src/prompt'

describe('auto-team reporter prompt', () => {
  it('addresses the user and treats the Lead as a relay', () => {
    const prompt = reporterPrompt()
    expect(prompt).toContain('Your reader is the user')
    expect(prompt).toContain('The Lead relays each update')
    expect(prompt).toContain('send_message({ target: "lead"')
    expect(prompt).toContain('code changes belong to execution agents')
  })
})
