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

  it('packages the public CLI with source provenance and linked docs', () => {
    const pkg = JSON.parse(read('package.json'))

    expect(pkg.name).toBe('@fridthjof-labs/tidebot')
    expect(pkg.repository.url).toBe(
      'git+https://github.com/fridthjof-labs/tidebot.git',
    )
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true })
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'dist',
        'templates',
        'docs',
        'README.md',
        'SECURITY.md',
        'CONTRIBUTING.md',
      ]),
    )
  })

  it('publishes release tags through npm OIDC with provenance', () => {
    const workflow = read('.github/workflows/release.yml')

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('npm publish --provenance --access public')
    expect(workflow).toContain(
      'ref: ${{ needs.release-please.outputs.tag_name }}',
    )
  })
})
