import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates',
)

/** Directories worth an `area/` label in a repository laid out as a monorepo. */
const AREA_CANDIDATES = [
  'apps',
  'packages',
  'services',
  'libs',
  'cmd',
  'internal',
  'infra',
  'tools',
  'docs',
]

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Propose area rules from the tree that is actually there: one rule per child
 * of a workspace directory (`apps/site` → `area/site`), otherwise one rule per
 * recognised top-level directory. A guess the user edits beats an empty list
 * they never fill in.
 */
export async function detectAreaRules(
  root: string,
): Promise<Array<{ prefix: string; label: string }>> {
  const rules: Array<{ prefix: string; label: string }> = []

  for (const candidate of AREA_CANDIDATES) {
    const path = join(root, candidate)
    if (!(await isDirectory(path))) {
      continue
    }

    if (
      candidate === 'apps' ||
      candidate === 'packages' ||
      candidate === 'services'
    ) {
      const children = await readdir(path, { withFileTypes: true })
      for (const child of children) {
        if (child.isDirectory() && !child.name.startsWith('.')) {
          rules.push({
            prefix: `${candidate}/${child.name}/`,
            label: `area/${child.name}`,
          })
        }
      }
      continue
    }

    rules.push({ prefix: `${candidate}/`, label: `area/${candidate}` })
  }

  if (await isDirectory(join(root, '.github'))) {
    rules.push({ prefix: '.github/', label: 'area/ci' })
  }

  return rules
}

/** Check names already declared by the repository's own workflows. */
export async function detectCheckNames(root: string): Promise<string[]> {
  const workflowDir = join(root, '.github/workflows')
  if (!(await isDirectory(workflowDir))) {
    return []
  }

  const names = new Set<string>()
  for (const entry of await readdir(workflowDir)) {
    if (!/\.ya?ml$/.test(entry)) {
      continue
    }
    const raw = await readFile(join(workflowDir, entry), 'utf8')
    const workflowName = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    for (const match of raw.matchAll(/^ {4}name:\s*(.+)$/gm)) {
      const jobName = match[1].trim().replace(/^['"]|['"]$/g, '')
      if (workflowName && !jobName.includes('${{')) {
        names.add(`${workflowName} / ${jobName}`)
      }
    }
  }
  return [...names].sort()
}

function renderConfig(
  template: string,
  areaRules: Array<{ prefix: string; label: string }>,
  checkNames: string[],
): string {
  let output = template

  if (areaRules.length > 0) {
    const block = [
      'area:',
      '  rules:',
      ...areaRules.map(
        (rule) => `    - prefix: ${rule.prefix}\n      label: ${rule.label}`,
      ),
    ].join('\n')
    output = output.replace(
      /# Label pull requests by the part of the tree they touch\.\n(# area:\n(?:#.*\n)*)/,
      `# Label pull requests by the part of the tree they touch.\n${block}\n\n`,
    )
  }

  if (checkNames.length > 0) {
    // Listed as comments, not values: which of a repository's checks are
    // merge-blocking is a decision, and guessing it wrong would either block
    // every merge or wave through a check that was meant to gate.
    output = output.replace(
      '  requiredContexts: []',
      [
        '  # Checks found in this repository — uncomment the ones that must',
        '  # pass before Tidebot merges:',
        ...checkNames.map((name) => `  #   - ${name}`),
        '  requiredContexts: []',
      ].join('\n'),
    )
  }

  return output
}

export type InitResult = {
  written: string[]
  skipped: string[]
}

export async function initRepository(options: {
  root: string
  withActionsRuntime: boolean
  withStaleSweep: boolean
  withSignedRebase: boolean
  force: boolean
}): Promise<InitResult> {
  const { root, force } = options
  const written: string[] = []
  const skipped: string[] = []

  const write = async (relative: string, contents: string): Promise<void> => {
    const target = join(root, relative)
    if (!force && (await exists(target))) {
      skipped.push(relative)
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, 'utf8')
    written.push(relative)
  }

  const [areaRules, checkNames, template] = await Promise.all([
    detectAreaRules(root),
    detectCheckNames(root),
    readFile(join(TEMPLATES, 'tidebot.yaml'), 'utf8'),
  ])

  await write(
    '.github/tidebot.yaml',
    renderConfig(template, areaRules, checkNames),
  )

  const workflows: Array<[boolean, string]> = [
    [options.withActionsRuntime, 'tidebot.yml'],
    [options.withStaleSweep, 'tidebot-stale.yml'],
    [options.withSignedRebase, 'tidebot-rebase.yml'],
  ]
  for (const [enabled, name] of workflows) {
    if (!enabled) {
      continue
    }
    await write(
      `.github/workflows/${name}`,
      await readFile(join(TEMPLATES, 'workflows', name), 'utf8'),
    )
  }

  return { written, skipped }
}
