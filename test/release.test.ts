import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

describe('release configuration', () => {
  it('starts from the released package version', () => {
    const manifest = JSON.parse(read('.release-please-manifest.json'))
    const pkg = JSON.parse(read('package.json'))

    expect(manifest['.']).toBe(pkg.version)
  })

  it('keeps every distributed workflow pin on the released version', () => {
    const manifest = JSON.parse(read('.release-please-manifest.json'))
    const config = JSON.parse(read('release-please-config.json'))
    const version = `v${manifest['.']}`
    const templates: string[] = config.packages['.']['extra-files']

    expect(templates).toEqual([
      'templates/workflows/tidebot-rebase.yml',
      'templates/workflows/tidebot-stale.yml',
      'templates/workflows/tidebot.yml',
    ])

    for (const template of templates) {
      const pinLines = read(template)
        .split('\n')
        .filter((line) => /(?:@|ref:\s*)v\d+\.\d+\.\d+/.test(line))

      expect(pinLines.length).toBeGreaterThan(0)
      for (const line of pinLines) {
        expect(line).toContain(version)
        expect(line).toContain('x-release-please-version')
      }
    }
  })
})
