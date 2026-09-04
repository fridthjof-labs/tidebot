import { Octokit } from '@octokit/rest'
import { vi } from 'vitest'

/**
 * A GitHub the tests can hold in memory, served to a real Octokit.
 *
 * Only the state and the routing are defined here. Request building,
 * pagination and error construction are Octokit's own, because a double that
 * reimplements them can disagree with the client the bot actually uses — and
 * a double that answers more agreeably than GitHub does hides bugs rather than
 * finding them.
 */

export type FakeComment = {
  id: number
  body: string
  /** Only the stale sweep reads this; tests that ignore it may omit it. */
  createdAt?: string
  user: { login: string; type?: string }
}

export type FakeCheckRun = {
  name: string
  conclusion: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string | null
}

export type FakeRepositoryLabel = {
  name: string
  color: string
  description: string | null
}

export type FakePullRequest = {
  number: number
  node_id?: string
  draft?: boolean
  state?: string
  title?: string | null
  body?: string | null
  mergeable?: boolean | null
  mergeable_state?: string | null
  additions?: number
  deletions?: number
  updated_at?: string | null
  merged_at?: string | null
  merge_commit_sha?: string | null
  base?: { ref?: string | null } | null
  head: {
    sha: string
    ref?: string | null
    repo?: { full_name?: string } | null
    repoFullName?: string | null
  }
  user?: { login?: string | null } | null
}

export type FakeGitHubState = {
  /** Labels currently on each issue, by issue number. */
  labels: Record<number, string[]>
  comments: FakeComment[]
  checkRuns: FakeCheckRun[]
  statuses: Array<{ context: string; state: string; created_at: string }>
  changedPaths: string[]
  pulls: FakePullRequest[]
  /** Labels that exist in the repository itself. */
  repositoryLabels: FakeRepositoryLabel[]
  /** Repository contents by path: a string is a file, an array a directory. */
  contents: Record<string, string | Array<{ name: string }>>
  /** Files a comparison reports, keyed by the head of the basehead pair. */
  compare: Record<
    string,
    Array<{ filename: string; status?: string; patch?: string; sha?: string }>
  >
  reviews: Array<{ id: number; user: { login: string }; state: string }>
  commitDate: string
  /** Set to make comment lookups fail the way a rate limit or outage does. */
  commentLookupError: { status: number; message: string } | null
}

export function state(
  overrides: Partial<FakeGitHubState> = {},
): FakeGitHubState {
  return {
    labels: {},
    comments: [],
    checkRuns: [],
    statuses: [],
    changedPaths: [],
    pulls: [],
    repositoryLabels: [],
    contents: {},
    compare: {},
    reviews: [],
    commitDate: '2026-01-01T00:00:00Z',
    commentLookupError: null,
    ...overrides,
  }
}

type Json = Record<string, unknown> | unknown[]

function ok(body: Json, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A page plus the Link header Octokit follows to ask for the next one. */
function paged<T>(all: T[], url: URL): Response {
  const perPage = Number(url.searchParams.get('per_page') ?? '30')
  const page = Number(url.searchParams.get('page') ?? '1')
  const slice = all.slice((page - 1) * perPage, page * perPage)

  if (page * perPage >= all.length) {
    return ok(slice)
  }
  const next = new URL(url)
  next.searchParams.set('page', String(page + 1))
  return ok(slice, { link: `<${next}>; rel="next"` })
}

export function fakeGitHub(initial: Partial<FakeGitHubState> = {}) {
  const db = state(initial)
  let nextCommentId =
    db.comments.reduce((max, comment) => Math.max(max, comment.id), 0) + 1

  /** Observation only. The behaviour lives in the routes below. */
  const spy = {
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    merge: vi.fn(),
    updatePull: vi.fn(),
    updateIssue: vi.fn(),
    updateBranch: vi.fn(),
    createReview: vi.fn(),
    dismissReview: vi.fn(),
    createIssue: vi.fn(),
    dispatchWorkflow: vi.fn(),
    compare: vi.fn(),
  }

  /** Every request Octokit actually made, for asserting on traffic. */
  const requests: Array<{ method: string; path: string }> = []

  const labelsOf = (issue: number) => (db.labels[issue] ??= [])

  const serialisePull = (pull: FakePullRequest) => ({
    node_id: pull.node_id ?? `PR_${pull.number}`,
    number: pull.number,
    draft: pull.draft ?? false,
    state: pull.state ?? 'open',
    title: pull.title ?? 'A change',
    body: pull.body ?? '',
    mergeable: pull.mergeable ?? true,
    mergeable_state: pull.mergeable_state ?? 'clean',
    labels: labelsOf(pull.number).map((name) => ({ name })),
    additions: pull.additions ?? 1,
    deletions: pull.deletions ?? 0,
    updated_at: pull.updated_at ?? '2026-01-01T00:00:00Z',
    merged_at: pull.merged_at ?? null,
    merge_commit_sha: pull.merge_commit_sha ?? null,
    base: { ref: pull.base?.ref ?? 'main' },
    head: {
      ...pull.head,
      repo: pull.head.repo ?? {
        full_name: pull.head.repoFullName ?? 'acme/widget',
      },
    },
    user: pull.user ?? { login: 'someone' },
  })

  // GitHub sends `created_at`, not the shape that is convenient to author.
  const serialiseComment = (comment: FakeComment) => ({
    id: comment.id,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.test/c/${comment.id}`,
    user: comment.user,
  })

  async function route(
    method: string,
    url: URL,
    body: Record<string, never>,
  ): Promise<Response> {
    const path = url.pathname
    const segments = path.split('/').filter(Boolean)
    // Everything after /repos/{owner}/{repo}.
    const rest = segments.slice(3)
    const tail = rest.join('/')

    if (segments.length === 3) {
      return ok({ default_branch: 'main', private: false })
    }

    if (rest[0] === 'issues' && rest[1] === 'comments') {
      const id = Number(rest[2])
      const comment = db.comments.find((entry) => entry.id === id)
      if (!comment) {
        return fail(404, 'Not Found')
      }
      if (method === 'PATCH') {
        spy.updateComment({ comment_id: id, body: body.body })
        comment.body = String(body.body)
        return ok(serialiseComment(comment))
      }
      if (method === 'DELETE') {
        spy.deleteComment({ comment_id: id })
        db.comments.splice(db.comments.indexOf(comment), 1)
        return new Response(null, { status: 204 })
      }
    }

    if (rest[0] === 'issues' && rest[2] === 'comments') {
      const issue = Number(rest[1])
      if (method === 'GET') {
        if (db.commentLookupError) {
          return fail(
            db.commentLookupError.status,
            db.commentLookupError.message,
          )
        }
        const ordered =
          url.searchParams.get('direction') === 'desc'
            ? [...db.comments].reverse()
            : db.comments
        return paged(ordered.map(serialiseComment), url)
      }
      spy.createComment({ issue_number: issue, body: body.body })
      const id = nextCommentId++
      db.comments.push({
        id,
        body: String(body.body),
        createdAt: new Date(2026, 0, 1, 0, id).toISOString(),
        user: { login: 'tidebot[bot]', type: 'Bot' },
      })
      return ok(serialiseComment(db.comments[db.comments.length - 1]))
    }

    if (rest[0] === 'issues' && rest[2] === 'labels') {
      const issue = Number(rest[1])
      const current = labelsOf(issue)
      if (method === 'GET') {
        return ok(current.map((name) => ({ name })))
      }
      if (method === 'POST') {
        const labels = (body.labels ?? []) as unknown as string[]
        spy.addLabels({ issue_number: issue, labels })
        for (const label of labels) {
          if (!current.includes(label)) {
            current.push(label)
          }
        }
        return ok(current.map((name) => ({ name })))
      }
      if (method === 'DELETE') {
        const name = decodeURIComponent(rest.slice(3).join('/'))
        spy.removeLabel({ issue_number: issue, name })
        const index = current.indexOf(name)
        if (index === -1) {
          return fail(404, 'Label does not exist')
        }
        current.splice(index, 1)
        return ok(current.map((label) => ({ name: label })))
      }
    }

    if (rest[0] === 'issues' && rest.length === 2 && method === 'PATCH') {
      spy.updateIssue({ issue_number: Number(rest[1]), ...body })
      return ok({})
    }

    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'POST') {
        spy.createIssue(body)
        return ok({ number: 999, html_url: 'https://github.test/i/999' })
      }
      return paged([], url)
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return paged(db.repositoryLabels, url)
      }
      if (method === 'POST') {
        spy.createLabel(body)
        db.repositoryLabels.push(body as unknown as FakeRepositoryLabel)
        return ok({})
      }
      spy.updateLabel(body)
      return ok({})
    }

    if (rest[0] === 'pulls') {
      const number = Number(rest[1])
      const pull = db.pulls.find((entry) => entry.number === number)

      if (rest.length === 1) {
        const wanted = url.searchParams.get('state') ?? 'open'
        return paged(
          db.pulls
            .filter((entry) => (entry.state ?? 'open') === wanted)
            .map(serialisePull),
          url,
        )
      }
      if (!pull) {
        return fail(404, 'Not Found')
      }
      if (rest.length === 2) {
        if (method === 'PATCH') {
          spy.updatePull({ pull_number: number, body: body.body })
          if (body.body !== undefined) {
            pull.body = String(body.body)
          }
          return ok(serialisePull(pull))
        }
        return ok(serialisePull(pull))
      }
      if (rest[2] === 'files') {
        return paged(
          db.changedPaths.map((filename) => ({ filename })),
          url,
        )
      }
      if (rest[2] === 'merge') {
        spy.merge({ pull_number: number, ...body })
        return ok({ merged: true })
      }
      if (rest[2] === 'update-branch') {
        spy.updateBranch({ pull_number: number })
        return new Response(JSON.stringify({ message: 'Updating' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (rest[2] === 'reviews' && rest.length === 3) {
        if (method === 'POST') {
          spy.createReview({ pull_number: number, ...body })
          return ok({})
        }
        return ok(db.reviews)
      }
      if (rest[2] === 'reviews') {
        spy.dismissReview({ pull_number: number, ...body })
        return ok({})
      }
    }

    if (rest[0] === 'commits' && rest[2] === 'pulls') {
      return paged(
        db.pulls
          .filter((entry) => entry.head?.sha === rest[1])
          .map(serialisePull),
        url,
      )
    }
    if (rest[0] === 'commits' && rest[2] === 'check-runs') {
      return ok({ total_count: db.checkRuns.length, check_runs: db.checkRuns })
    }
    if (rest[0] === 'commits' && rest[2] === 'statuses') {
      return ok(db.statuses)
    }
    if (rest[0] === 'compare') {
      const head = decodeURIComponent(rest.slice(1).join('/')).split('...')[1]
      spy.compare({ basehead: decodeURIComponent(rest.slice(1).join('/')) })
      const files = db.compare[head ?? '']
      return files ? ok({ files }) : fail(404, 'Not Found')
    }
    if (rest[0] === 'contents') {
      const entry = db.contents[decodeURIComponent(rest.slice(1).join('/'))]
      if (entry === undefined) {
        return fail(404, 'Not Found')
      }
      return ok(
        Array.isArray(entry)
          ? entry
          : {
              type: 'file',
              content: Buffer.from(entry, 'utf8').toString('base64'),
            },
      )
    }
    if (rest[0] === 'git' && rest[1] === 'commits') {
      return ok({ committer: { date: db.commitDate } })
    }
    if (rest[0] === 'deployments') {
      return paged([], url)
    }
    if (rest[0] === 'actions') {
      spy.dispatchWorkflow({ path, ...body })
      return new Response(null, { status: 204 })
    }
    if (rest[0] === 'collaborators') {
      return ok({ permission: 'write' })
    }

    return fail(404, `No fake route for ${method} /${tail}`)
  }

  const octokit = new Octokit({
    auth: 'test',
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = (init?.method ?? 'GET').toUpperCase()
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        requests.push({ method, path: url.pathname })
        return route(method, url, body)
      },
    },
  })

  /** Make comment lookups fail the way a rate limit or an outage does. */
  function failCommentLookups(error: { status: number; message: string }) {
    db.commentLookupError = error
  }

  return { octokit, db, spy, requests, failCommentLookups }
}
