import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface PublishWorkflow {
  on: Record<string, { branches?: string[] } | null>
  permissions: Record<string, string>
  jobs: {
    publish: {
      if: string
      permissions: Record<string, string>
      steps: Array<{
        name?: string
        uses?: string
        run?: string
        with?: Record<string, unknown>
      }>
    }
  }
}

const workflow = load(
  readFileSync('.github/workflows/media-selection-ghcr.yml', 'utf8')
) as PublishWorkflow

describe('fork GHCR publication boundary', () => {
  it('publishes only from the owned fork without pull-request triggers', () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      'push',
      'workflow_dispatch',
    ])
    expect(workflow.on.push?.branches).toEqual([
      'main',
      'feat/plugin_media_selection_20261123',
    ])
    expect(workflow.jobs.publish.if).toBe(
      "github.repository == 'Zyphoriate/Motrix'"
    )
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.publish.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    })
  })

  it('smokes the built image before registry credentials or publication', () => {
    const steps = workflow.jobs.publish.steps
    const build = steps.findIndex((step) =>
      step.run?.includes('docker buildx build')
    )
    const smoke = steps.findIndex((step) =>
      step.run?.includes('node scripts/smoke-server-image.mjs')
    )
    const login = steps.findIndex((step) =>
      step.uses?.startsWith('docker/login-action@')
    )
    const publish = steps.findIndex((step) => step.run?.includes('docker push'))
    expect(build).toBeGreaterThanOrEqual(0)
    expect(smoke).toBeGreaterThan(build)
    expect(login).toBeGreaterThan(smoke)
    expect(publish).toBeGreaterThan(login)
    expect(steps[login]?.with).toMatchObject({
      registry: 'ghcr.io',
      password: '${{ secrets.GITHUB_TOKEN }}',
    })
    expect(
      steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with
    ).toEqual({ 'persist-credentials': false })
  })
})
