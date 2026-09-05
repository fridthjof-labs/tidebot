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
      'README.md',
      'docs/install.md',
    ])

    for (const template of templates.filter((path) => path.endsWith('.yml'))) {
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

  it('keeps documented installs pinned to the release', () => {
    const version = `v${JSON.parse(read('package.json')).version}`
    for (const path of ['README.md', 'docs/install.md']) {
      const doc = read(path)
      const install = doc
        .split('<!-- x-release-please-start-version -->')[1]
        .split('<!-- x-release-please-end -->')[0]
      expect(install).toContain(`git clone --branch ${version} --depth 1`)
      expect(install).toContain('pnpm install --frozen-lockfile')
    }
  })

  it('packages the public CLI with source provenance and linked docs', () => {
    const pkg = JSON.parse(read('package.json'))

    expect(pkg.name).toBe('@fridthjof-labs/tidebot')
    expect(pkg.repository.url).toBe(
      'git+https://github.com/fridthjof-labs/tidebot.git',
    )
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true })
    expect(pkg.bin).toEqual({ tidebot: 'dist/cli/index.js' })
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

  it('creates GitHub releases without an unconfigured npm publish', () => {
    const workflow = read('.github/workflows/release.yml')

    expect(workflow).toContain('googleapis/release-please-action@')
    expect(workflow).not.toContain('npm publish')
  })
})
