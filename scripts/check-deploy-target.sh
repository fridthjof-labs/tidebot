#!/usr/bin/env bash
# Refuse a deploy that has not said which Cloudflare account it targets.
#
# wrangler.jsonc carries no account_id, so this Worker can be deployed by any
# organization that runs its own instance. That is the point, and it is also
# the risk: a Cloudflare API token can reach more than one account, and this
# Worker holds a GitHub App private key. A Worker holding that key must exist
# in exactly one account, chosen on purpose.
#
# So the account has to be stated, and stated in a shape that is obviously an
# account ID rather than an empty string a shell expanded from a missing
# variable. wrangler would otherwise either pick the token's only account --
# fine until the token gains a second one -- or fail with a message that reads
# like a configuration bug rather than a safety stop.
set -euo pipefail

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  cat >&2 <<'MSG'
CLOUDFLARE_ACCOUNT_ID is not set.

Tidebot's wrangler.jsonc deliberately pins no account so that each
organization deploys its own instance. Export the account you mean to deploy
to, or set it as a repository variable in the workflow that deploys:

  CLOUDFLARE_ACCOUNT_ID=<32 hex characters> pnpm deploy:workers
MSG
  exit 1
fi

if ! printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | grep -Eq '^[0-9a-f]{32}$'; then
  echo "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hexadecimal characters, got: ${CLOUDFLARE_ACCOUNT_ID}" >&2
  exit 1
fi

echo "Deploying to Cloudflare account ${CLOUDFLARE_ACCOUNT_ID}"
