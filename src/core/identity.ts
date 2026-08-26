import type { App } from '@octokit/app'

export type BotIdentity = {
  appId: number
  slug: string
  name: string
  /** The `<slug>[bot]` login GitHub attributes this App's actions to. */
  login: string
}

let cached: Promise<BotIdentity> | null = null

/**
 * Ask GitHub who this App is instead of hard-coding a name. Everything that
 * needs the bot's own identity — ignoring its own comments, matching pull
 * requests it opened — reads it from here, so the same build runs under any
 * App registration.
 */
export async function resolveBotIdentity(app: App): Promise<BotIdentity> {
  if (!cached) {
    const pending = (async (): Promise<BotIdentity> => {
      const { data } = await app.octokit.request('GET /app')
      const slug = data?.slug ?? 'tidebot'
      return {
        appId: data?.id ?? 0,
        slug,
        name: data?.name ?? slug,
        login: `${slug}[bot]`,
      }
    })()
    cached = pending
    pending.catch(() => {
      cached = null
    })
  }

  return cached
}

export function resetBotIdentityCache(): void {
  cached = null
}

/** Expand the `${bot}` placeholder configs use to mean "this App". */
export function expandBotPlaceholder(
  values: string[] | undefined,
  identity: Pick<BotIdentity, 'login' | 'slug'>,
): string[] {
  return (values ?? []).map((value) =>
    value
      .replace(/\$\{bot\}/g, identity.login)
      .replace(/\$\{slug\}/g, identity.slug),
  )
}
