import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { prepareFlatpakNodeLock } from '../../scripts/prepare-flatpak-node-lock.mjs'

const bootstrap = `lockfileVersion: '9.0'
packages:
  pnpm@12.4.1:
    resolution: {integrity: sha512-bootstrap}
`
const application = `lockfileVersion: '9.0'
packages:
  react@19.3.0:
    resolution: {integrity: sha512-application}
`

describe('prepareFlatpakNodeLock', () => {
  it('retains both bootstrap and application integrity metadata', () => {
    expect(
      load(prepareFlatpakNodeLock(`${bootstrap}---\n${application}`))
    ).toEqual({
      lockfileVersion: '9.0',
      packages: {
        'pnpm@12.4.1': { resolution: { integrity: 'sha512-bootstrap' } },
        'react@19.3.0': { resolution: { integrity: 'sha512-application' } },
      },
    })
  })

  it('exports remote sources while keeping vendored tarballs in the install lock', () => {
    const source = `${application}  '@motrix/plugin-api@file:vendor/sdk/api.tgz':
    resolution: {integrity: sha512-local, tarball: 'file:vendor/sdk/api.tgz'}
  remote@1.0.0:
    resolution: {integrity: sha512-remote, tarball: 'https://example.com/remote.tgz'}
`
    const directory = mkdtempSync(path.join(tmpdir(), 'flatpak-node-lock-'))
    const input = path.join(directory, 'pnpm-lock.yaml')
    const output = path.join(directory, 'export.yaml')
    try {
      writeFileSync(input, source)
      execFileSync(process.execPath, [
        'scripts/prepare-flatpak-node-lock.mjs',
        input,
        output,
      ])
      expect(readFileSync(input, 'utf8')).toBe(source)
      expect(load(readFileSync(output, 'utf8'))).toEqual({
        lockfileVersion: '9.0',
        packages: {
          'react@19.3.0': { resolution: { integrity: 'sha512-application' } },
          'remote@1.0.0': {
            resolution: {
              integrity: 'sha512-remote',
              tarball: 'https://example.com/remote.tgz',
            },
          },
        },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts legacy single-document locks and identical shared sources', () => {
    expect(prepareFlatpakNodeLock(bootstrap)).toBe(
      prepareFlatpakNodeLock(`${bootstrap}---\n${bootstrap}`)
    )
  })

  it('fails closed on conflicting integrity metadata or unknown formats', () => {
    expect(() =>
      prepareFlatpakNodeLock(
        `${bootstrap}---\n${bootstrap.replace('sha512-bootstrap', 'sha512-other')}`
      )
    ).toThrow('Conflicting pnpm source metadata: pnpm@12.4.1')
    expect(() => prepareFlatpakNodeLock('')).toThrow('Empty pnpm lockfile')
    expect(() => prepareFlatpakNodeLock("lockfileVersion: '10.0'\n")).toThrow(
      'requires pnpm lockfile v9'
    )
    expect(() => prepareFlatpakNodeLock("lockfileVersion: '9.0'\n")).toThrow(
      'missing its packages table'
    )
  })
})
