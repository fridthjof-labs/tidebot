export type Args = {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | true>()

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const [name, inline] = token.slice(2).split('=', 2)
    if (inline !== undefined) {
      flags.set(name, inline)
      continue
    }

    const next = rest[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
      continue
    }
    flags.set(name, true)
  }

  return { command, positional, flags }
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

export function boolFlag(args: Args, name: string): boolean {
  return args.flags.has(name)
}

export function requireFlag(args: Args, name: string): string {
  const value = flag(args, name)
  if (!value) {
    throw new Error(`--${name} is required`)
  }
  return value
}

export function parseRepoFlag(value: string): { owner: string; repo: string } {
  const [owner, repo] = value.split('/')
  if (!owner || !repo) {
    throw new Error(`--repo must be owner/repo, got "${value}"`)
  }
  return { owner, repo }
}
