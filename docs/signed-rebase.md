# Signed rebase

`/rebase` defaults to GitHub's update-branch API, which merges the base branch
into the pull request branch. That works everywhere and needs nothing, at the
cost of a merge commit in the history of every long-running branch.

`commands.updateBranchMethod: signed-rebase` replaces it with a real linear
rebase whose commits GitHub marks **Verified**.

## Why this needs a machine user

The obvious implementation — have the App rebase — does not work, for two
reasons that are worth stating so nobody re-derives them:

1. **GitHub's automatic bot-commit signing does not apply to a rebase.** GitHub
   signs commits an App creates only when the App is *both* author and
   committer, with no custom author, committer, or signature. A rebase
   preserves the original author, which is exactly the excluded case. This is
   also why `updatePullRequestBranch(REBASE)` produces unsigned commits.

2. **A GPG key cannot be registered against an App's `[bot]` identity.** There
   is no setting for it. Every working example of signed bot commits uses a
   regular GitHub user account with a GPG key on that account.

So the committer has to be a real GitHub user. The original author is
preserved, and GitHub verifies the signature against the committer's account,
so rebased commits show Verified while still crediting whoever wrote them.

A rebase also needs `git` and `gpg` on a filesystem, which a Cloudflare Worker
does not have. Tidebot therefore dispatches a workflow in the target repository
and lets the runner do the work.

## Setup

### 1. Choose the committer account

Any user account with a verified email works, including your own: rebased
commits then show you as committer and the original author as author. A
machine user keeps the bot's rebases out of your name. Either way, give the
account write access to the repositories that will use signed rebase. Use an email address
you control; it must be **verified on that account**, because GitHub matches
the signature's key to a user by the committer email.

This is the one step nothing can automate for you.

### 2. Generate the signing key

```bash
pnpm tidebot keygen --name "Tidebot" --email "tidebot@example.com"
```

This generates an ed25519 signing key locally and writes two files:

- `tidebot-signing-key.pub.asc` — add at <https://github.com/settings/gpg/new>
  while signed in as the machine user.
- `tidebot-signing-key.asc` — the private half.

Neither is sent anywhere. Add `--passphrase` if you want the private key
encrypted at rest in the secret store.

### 3. Store the secrets

On the repository or organisation:

| Secret | Value |
| --- | --- |
| `TIDEBOT_GPG_PRIVATE_KEY` | contents of `tidebot-signing-key.asc` |
| `TIDEBOT_GPG_PASSPHRASE` | only if you set one |
| `TIDEBOT_APP_ID` | so the push re-triggers CI (see below) |
| `TIDEBOT_PRIVATE_KEY` | the App's private key |

| Variable | Value |
| --- | --- |
| `TIDEBOT_GIT_USER_NAME` | the machine user's name |
| `TIDEBOT_GIT_USER_EMAIL` | the email verified on that account |

Delete the two local key files once they are stored.

### 4. Add the workflow

```bash
pnpm tidebot init --dir path/to/repo --signed-rebase
```

This writes `.github/workflows/tidebot-rebase.yml`, a thin caller for the
reusable workflow in this repository. Commit it on the default branch — a
`workflow_dispatch` target must exist there before it can be dispatched.

### 5. Turn it on

```yaml
commands:
  updateBranchMethod: signed-rebase
```

`pnpm tidebot doctor` fails loudly if this is set and the workflow is missing.

## What happens on `/rebase`

1. Tidebot dispatches `tidebot-rebase.yml` with the pull request number,
   using its own token: `workflow_dispatch` is one of the events
   `GITHUB_TOKEN` may trigger, so the App needs no Actions permission.
2. The job mints an App installation token, reads the head and base refs, and
   refuses immediately if the pull request comes from a fork.
3. It imports the GPG key, sets the machine user as committer, and runs
   `git rebase --gpg-sign=<key> origin/<base>`.
4. It pushes with `--force-with-lease`.
5. On conflict it aborts, leaves the branch untouched, and comments with a link
   to the run.

Pushing with the App's installation token is what makes CI re-run on the
rebased commits. A push made with the job's own `GITHUB_TOKEN` deliberately
does not trigger workflows, which would leave the branch rebased but its checks
stale — so the App credentials are effectively required here even though the
workflow will run without them.

## Limitations

- **Forks.** The App has no push access to a contributor's fork. Tidebot
  refuses before dispatching and says so on the pull request.
- **Force-push.** A rebase rewrites the branch. Anyone with it checked out
  needs `git pull --rebase`. This is inherent, not a Tidebot choice.
- **Branch protection.** If the branch is protected against force-pushes, the
  push fails. Allow the App, or stay on `merge`.
- **`--force-with-lease`** means a rebase racing a human push loses rather than
  overwriting it.

## If Verified does not appear

Check, in order:

1. The email in `TIDEBOT_GIT_USER_EMAIL` is verified on the machine user
   account — not just present, verified.
2. The public key is on that same account.
3. The key has not expired.
4. The commit's committer really is the machine user: `git log --format=%cn%ce`.

GitHub verifies against the committer, not the author, so a mismatch in the
author's email is not the problem.
