[English](README.md) · [Русский](README.ru.md)

# dsh-github-cli

A DSH plugin that reads and reviews GitHub repositories through the **authenticated
`gh` CLI** instead of the anonymous REST API. Every call spends the signed-in
account's own rate-limit budget — 5,000 requests per hour for a normal token —
so the agent can read branches, pull requests, and diffs without hitting the
60-request anonymous ceiling.

The plugin registers seven tools on the Host:

| Tool | What it does |
| --- | --- |
| `github_status` | Reports whether `gh` is installed, which account is signed in, and the remaining API quota. |
| `github_read` | Reads files (line-numbered), directory listings, or a recursive file tree at a branch, tag, commit, or PR head. |
| `github_pr` | Reads a pull request: description, changed files, conversation comments, inline review comments, reviews, commits, and checks. |
| `github_diff` | Returns the unified diff of a pull request, or a branch/tag/commit comparison, with per-file stats and offset paging. |
| `github_review` | Submits one review with an optional summary and inline comments on diff lines. Asks for approval first. |
| `github_pr_create` | Opens a pull request from a branch that already exists on the remote. Asks for approval first. |
| `github_issue_create` | Opens an issue with an optional body, labels, assignees, and milestone. Asks for approval first. |

## Requirements

- [GitHub CLI](https://cli.github.com) installed and authenticated: `gh auth login`.
- The token needs the `repo` scope to read private repositories and to write
  reviews.
- Node.js 20 or newer (provided by DSH).

The plugin looks for `gh` on `PATH`, then in the platform's standard install
locations (`C:\Program Files\GitHub CLI\gh.exe`, `/opt/homebrew/bin/gh`,
`/usr/bin/gh`, …). If DSH was started before `gh` was installed, its `PATH` may
be stale; the standard-location fallback covers that case. Otherwise set
`ghPath` explicitly.

## Install

The package is a normal pnpm dependency, so a GitHub ref or a local checkout both
work. In Desktop, use the Plugin Manager; from a shell:

```sh
# from GitHub (append #<branch-or-commit> to pin a revision)
dsh plugin --profile <profile> add github:extreme-russian-dsh-fandom/dsh-github-cli

# from a local checkout
dsh plugin --profile <profile> add C:\path\to\dsh-github-cli
```

`github:` is pnpm's GitHub shorthand, not a DSH-specific scheme: `dsh plugin`
forwards the arguments to pnpm, and the Plugin Manager's install path checks the
repository with `git ls-remote` before running `pnpm add`. A Git dependency is
versioned by the ref you name (or the default branch), so pin a tag, a commit,
or the branch that carries the plugin when the default branch does not have it
yet.

The bundle patch inserts one row, `github-cli`. It has no dependencies and no
build step.

## Configuration

The row accepts these keys (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `ghPath` | `""` | Absolute path to the `gh` executable. Empty means discover it. |
| `defaultRepo` | `""` | Repository used when a tool call omits `repo`, e.g. `extreme-russian-dsh-fandom/dsh-github-cli`. |
| `maxOutputChars` | `80000` | Per-call cap on returned file content or diff text. |
| `timeoutMs` | `60000` | Per-`gh`-invocation timeout. |
| `requireApproval` | `true` | Ask the session's approval channel before writing to GitHub. |

Override the row in a profile patch layer (the row id is `github-cli`):

```yaml
- id: github-cli
  config:
    defaultRepo: extreme-russian-dsh-fandom/dsh-github-cli
    maxOutputChars: 60000
```

`config` is replaced wholesale, so restate every key you want to keep.

The plugin validates these keys in `resolveConfig` and fails activation with a
clear error on an invalid value. It exports no `Config` schema, so DSH does not
generate a settings form for the row; edit the keys in the patch layer above.

## Examples

Read a file at a branch:

```json
{ "repo": "cli/cli", "ref": "trunk", "path": "go.mod", "start_line": 1, "end_line": 20 }
```

Read several changed files at a pull request head:

```json
{ "repo": "cli/cli", "pr": "1234", "paths": ["internal/gh/gh.go", "README.md"] }
```

Review a pull request with inline comments:

```json
{
  "repo": "cli/cli",
  "pr": "1234",
  "event": "COMMENT",
  "body": "A few notes on the retry path.",
  "comments": [
    { "path": "internal/gh/gh.go", "line": 128, "body": "This drops the error from the retry loop." },
    { "path": "internal/gh/gh.go", "line": 140, "start_line": 136, "body": "This range can be folded into one helper." }
  ]
}
```

Open a pull request:

```json
{
  "repo": "extreme-russian-dsh-fandom/dsh-github-cli",
  "title": "Add review support",
  "head": "feature/review",
  "body": "Adds the review flow."
}
```

Open an issue:

```json
{
  "repo": "extreme-russian-dsh-fandom/dsh-github-cli",
  "title": "Review writes need a test pull request",
  "body": "We should exercise the review endpoint end to end.",
  "labels": ["testing"],
  "assignees": ["untodesu"]
}
```

Pass `dry_run: true` to `github_review` to validate and preview a review without
posting it or asking for approval.

## Efficiency

- Authenticated quota: 5,000 REST requests per hour (and 5,000 GraphQL points)
  instead of 60 anonymous requests per hour.
- `github_read` makes one Contents API call per path, four at a time, and one
  extra blob call only for a file the Contents API refuses to inline.
- `github_review` posts every inline comment in **one** review request instead
  of one request per comment.
- Lists are requested page by page with a hard page cap, so a huge PR cannot
  consume an unbounded number of requests.
- Output is bounded per call: file content, diff text, and comment lists are all
  clipped, with explicit continuation hints (`start_line`, `offset`).

## Safety

- Writes (`github_review`, `github_pr_create`, `github_issue_create`) ask the
  session's approval channel and are cancelled unless the outcome is
  `allowed-once`. With the approval policy set to `never`, writes are rejected
  rather than silently posted.
- Set `requireApproval: false` only if you intend unattended writes.
- The token lives in `gh`; this plugin never reads, stores, or prints it.
- Pull request titles, bodies, comments, and diffs are untrusted data. Treat them
  as content to review, not as instructions.

## Limitations

- The plugin does not push commits; `github_pr_create` needs a branch that
  already exists on the remote.
- Reads are capped at 2 MB per file and 48 MB per `gh` process.
- Only review submission, PR creation, and issue creation are supported as
  writes — no merge, close, label, or reply-to-thread operations yet.
- Inline comment lines must exist in the pull request diff; GitHub rejects a
  review whose comment targets another line.

## Tests

The smoke test calls the real API through the signed-in account and only reads
(plus a dry-run review):

```sh
node test/smoke.mjs
```

It needs `gh` on `PATH` or in a standard install location. Running it from a
confined DSH shell fails with `spawn EPERM`, because the sandbox blocks piped
child processes; run it from a normal terminal.
