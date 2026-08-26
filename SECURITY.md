# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/fridthjof-labs/tidebot/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what an attacker can do, not just what looks wrong: Tidebot has write
access to pull requests and contents on every repository it is installed on, so
anything that lets an untrusted actor cause a merge, an approval, or a push is
in scope and will be treated as urgent.

## In scope

- Causing a merge, approval, or label change without the required
  `author_association`
- Making Tidebot act on configuration that is not on the default branch
- Making Tidebot edit or delete content it did not author
- Escaping the code fence or otherwise forging content in a Tidebot comment
- Credential or token disclosure through logs, comments, or error messages
- Denial of service against a shared instance, including patterns that exhaust
  the installation's API quota

## Out of scope

- Anything requiring write access to the repository already — a collaborator
  who can run `/plan` can already push a workflow
- Branch protection that the repository has not enabled
- Vulnerabilities in GitHub itself

The trust boundaries this project relies on are documented in
[docs/security.md](docs/security.md).
