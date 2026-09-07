import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url)
const TEMPLATE_DIR = new URL('../templates/workflows/', import.meta.url)

function workflows(dir: URL): Array<{ name: string; body: string }> {
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({
      name: file,
      body: readFileSync(new URL(file, dir), 'utf8'),
    }))
}

/** `uses:` references to third-party actions, excluding reusable workflows. */
function actionRefs(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/)?.[1])
    .filter((ref): ref is string => Boolean(ref))
    .filter((ref) => !ref.startsWith('./'))
    .filter((ref) => !ref.includes('/.github/workflows/'))
}

describe('workflow supply chain', () => {
  it('pins every third-party action to a commit SHA', () => {
    // A tag can be moved to point at different code, and these jobs hold the
    // App private key and the signing key. This is the check that catches a
    // well-meaning `@v5` creeping back in.
    for (const { name, body } of [
      ...workflows(WORKFLOW_DIR),
      ...workflows(TEMPLATE_DIR),
    ]) {
      for (const ref of actionRefs(body)) {
        expect(
          ref,
          `${name} uses ${ref}, which is not pinned to a commit SHA`,
        ).toMatch(/@[0-9a-f]{40}$/)
      }
    }
  })

  it('names the version beside each pin, so upgrades are reviewable', () => {
    for (const { name, body } of workflows(WORKFLOW_DIR)) {
      for (const line of body.split('\n')) {
        if (/^\s*(?:-\s*)?uses:\s*\S+@[0-9a-f]{40}/.test(line)) {
          expect(line, `${name}: ${line.trim()}`).toMatch(/#\s*v?\d/)
        }
      }
    }
  })

  it('never grants a workflow more than it needs by omitting permissions', () => {
    // An omitted `permissions:` inherits the repository default, which can be
    // write-all. Every workflow states what it takes.
    for (const { name, body } of workflows(WORKFLOW_DIR)) {
      expect(body, `${name} does not declare permissions`).toMatch(
        /^permissions:/m,
      )
    }
  })
})

describe('release deploys the Worker', () => {
  const release = readFileSync(new URL('release.yml', WORKFLOW_DIR), 'utf8')

  it('has a deploy job that runs only when a release was created', () => {
    // Without this, a merged release PR cuts a tag and nothing ships; the
    // Worker stays on whatever was last deployed by hand.
    expect(release).toMatch(/^\s+deploy:\s*$/m)
    expect(release).toMatch(
      /needs\.release-please\.outputs\.release_created == 'true'/,
    )
  })

  it('deploys the tag that was released, not whatever main is at', () => {
    expect(release).toMatch(
      /ref:\s*\$\{\{\s*inputs\.tag \|\| needs\.release-please\.outputs\.tag_name\s*\}\}/,
    )
    expect(release).toMatch(/wrangler deploy --env=""/)
  })

  it('can deploy a named tag on dispatch, for a release that shipped nothing', () => {
    // release-please does not cut a release for a `ci:` or `chore:` commit,
    // so the job that introduced deploys could not deploy the release before it.
    expect(release).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tag:/)
    expect(release).toMatch(/inputs\.tag != ''/)
  })
})

describe('worker config', () => {
  const wrangler = readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  )
  const releaseWorkflow = readFileSync(
    new URL('release.yml', WORKFLOW_DIR),
    'utf8',
  )

  it('pins no account, so any organization can deploy its own instance', () => {
    // A pinned account_id makes this file single-tenant: a second
    // organization cannot deploy the shipped config at all, and ends up
    // maintaining a divergent copy of every binding.
    expect(wrangler).not.toMatch(/"account_id"/)
  })

  it('declares no routes, leaving Custom Domains to whoever owns the account', () => {
    // A route here reattaches the hostname on every deploy, fighting whatever
    // infrastructure config believes it owns that Custom Domain.
    expect(wrangler).not.toMatch(/"routes"/)
  })

  it('still forces the deploy target to be stated', () => {
    // Removing the pin removes a guard: this Worker holds a GitHub App private
    // key, and a Cloudflare token can reach more than one account. The check
    // script replaces the literal, and the release workflow has to run it.
    expect(releaseWorkflow).toMatch(/scripts\/check-deploy-target\.sh/)
    expect(releaseWorkflow).toMatch(
      /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*vars\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/,
    )
  })
})
