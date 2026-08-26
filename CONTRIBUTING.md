# Contributing

```bash
pnpm install
pnpm check      # lint, typecheck, tests with coverage thresholds
pnpm serve      # local webhook receiver on :3000
```

Node 24 and pnpm 11 (`mise install` picks both up from `mise.toml`).

## How the code is laid out

```
src/
  core/            runtime-agnostic; knows nothing about how it was invoked
    bot.ts         the one path every pull-request-shaped event funnels through
    webhooks.ts    GitHub event -> context -> handler, plus the owner gate
    context.ts     BotContext: which repo, under which config, as whom
    config/        defaults, layering, and the per-repository loader
    github/        the Octokit adapter, split by resource
    lib/           pure decision logic — no I/O, no Octokit
    plugins/       one file per behaviour; each takes a BotContext
  runtime/         worker.ts | node.ts | action.ts — three ways in, one core
  cli/             init, labels, doctor, keygen, app create
```

The layering rule: **`lib/` never imports Octokit.** Decisions live there and are
tested directly; `plugins/` does the I/O around them. If you find yourself
mocking a lot to test a rule, the rule probably belongs in `lib/`.

## Invariants

These are load-bearing. Each has a test that fails if it is broken, in
`test/security.test.ts` and `test/bot.test.ts`:

1. **Config is read from the default branch**, never from a pull request's
   head. `getContent` is called with no `ref`. A PR must not be able to change
   the rules that govern it.
2. **The bot only edits and deletes its own comments** — matched by author
   *and* marker. `issues: write` lets an App modify anyone's comment.
3. **Commands are line-anchored**, and skip code fences and blockquotes.
   `/help` output lists every command; quoting it must not run them.
4. **Nothing merges on a check the repository did not declare.** Defaults are
   empty; new behaviour ships off.

[docs/security.md](docs/security.md) explains why each one exists.

## Adding a plugin

1. Put the decision in `src/core/lib/<name>.ts` as a pure function.
2. Put the I/O in `src/core/plugins/<name>.ts`, taking `(ctx, pullNumber, pr)`.
3. Add a `plugins.<name>` switch in `types.ts` and default it to **`false`** in
   `config/defaults.ts` if it needs repository-specific knowledge.
4. Call it from `bot.ts`, and only fetch changed paths or check runs when it is
   actually enabled — every call is charged to a quota the whole installation
   shares.
5. Document it in [docs/config.md](docs/config.md).

## Tests

Coverage is gated on `src/core/config/**` and `src/core/lib/**`, not globally.
The adapter and runtime layers are exercised end-to-end through
`test/routing.test.ts` and `test/bot.test.ts`; asserting that a mock was called
raises a coverage number without proving anything.

Prefer a test that fails for a reason you can name. Comments in the test should
say what breaks in the real world, not restate the assertion.

## Style

Biome handles formatting and linting — `pnpm lint:fix`. Beyond that: match the
surrounding code, keep comments about *why* rather than *what*, and let the
type checker do the narrowing instead of `!` or `as`.

## Releasing

`templates/workflows/*` pin the reusable workflows to a tag, in two places —
the `uses:` ref and the `with: ref:` that selects the checked-out code. Both
move together when you cut a release. See
[docs/security.md](docs/security.md#the-reusable-workflows-are-pinned-in-two-places).
