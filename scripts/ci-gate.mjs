import { pathToFileURL } from 'node:url'

export const ALWAYS_REQUIRED = [
  'plan',
  'quality',
  'tests',
  'test-reports',
  'torrent-browser',
  'server-runtime',
  'rust-quality',
  'safari-native-host',
  'package-targets',
]
export const CONDITIONAL_JOBS = {
  snap: 'distributions',
  flatpak: 'distributions',
  'finalize-filesystems': 'filesystems',
  'finalize-nfs': 'filesystems',
  'finalize-smb': 'filesystems',
  'finalize-exfat': 'filesystems',
}

export const EVENT_CONDITIONAL_JOBS = {
  'media-selection-image': ({ eventName, headRef }) =>
    eventName === 'workflow_dispatch' ||
    headRef?.startsWith('feat/plugin_media_selection_') === true,
}

export function validateCiResults(needs, context = {}) {
  const plan = needs.plan?.outputs
  if (
    !['ui', 'full'].includes(plan?.profile) ||
    !['true', 'false'].includes(plan?.filesystems) ||
    plan?.distributions !== String(plan?.profile === 'full')
  ) {
    throw new Error('Missing or invalid CI plan')
  }
  const expected = new Set([
    ...ALWAYS_REQUIRED,
    ...Object.keys(CONDITIONAL_JOBS),
    ...Object.keys(EVENT_CONDITIONAL_JOBS),
  ])
  for (const name of Object.keys(needs)) {
    if (!expected.has(name)) throw new Error(`Unaccounted CI job: ${name}`)
  }
  for (const name of expected) {
    const required =
      ALWAYS_REQUIRED.includes(name) ||
      plan[CONDITIONAL_JOBS[name]] === 'true' ||
      EVENT_CONDITIONAL_JOBS[name]?.(context) === true
    const result = needs[name]?.result
    if (result !== (required ? 'success' : 'skipped')) {
      throw new Error(
        `${name}: expected ${required ? 'success' : 'skipped'}, got ${result}`
      )
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateCiResults(JSON.parse(process.env.CI_NEEDS), {
    eventName: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
  })
  console.log('All selected checks passed.')
}
