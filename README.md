[English](README.md) · [Русский](README.ru.md)

# dsh-github-cli

A DSH plugin that reads and reviews GitHub repositories through the **authenticated
`gh` CLI** instead of the anonymous REST API. Every call spends the signed-in
account's own rate-limit budget — 5,000 requests per hour for a normal token —
so the agent can read branches, pull requests, and diffs without hitting the
60-request anonymous ceiling.

Version 0.2 adds the foundation for full GitHub management: a session context that
binds the current checkout to a repository, capability probes for `git`,
`git-filter-repo`, and `git-lfs`, a shared plan/approval pipeline, a typed
configuration schema, and a REST/GraphQL transport that reads rate-limit headers.
The full target design is in [docs/github-plugin-2.0-design.md](docs/github-plugin-2.0-design.md).

The plugin registers eighteen tools on the Host:

| Tool | What it does |
| --- | --- |
| `github_status` | Reports `gh`/`git` versions, the signed-in account, the remaining API quota, optional local tools (`git-filter-repo`, `git-lfs`), available DSH services, and the repository bound to the current directory. |
| `github_workspace` | Binds a checkout to a repository, clones, checks out a branch or PR, syncs without force, and creates worktrees. Local writes stay under `workspaceRoot` or the session directory. |
| `github_repo` | Lists, views, creates, edits, transfers, renames, deletes, archives, and unarchives repositories; sets topics; manages collaborator access. |
| `github_file` | Reads line-numbered files or trees, inspects one path, writes or deletes a file, moves/copies files, and commits multi-file changes atomically with sha-based conflict detection. |
| `github_ref` | Lists and inspects branches/tags, creates branches and lightweight tags, and deletes branches with a guarded plan. |
| `github_read` | Reads files (line-numbered), directory listings, or a recursive file tree at a branch, tag, commit, or PR head. |
| `github_pr` | Reads a pull request or lists, updates, comments, labels, assigns reviewers, updates the branch, closes/reopens, and merges it. |
| `github_issue` | Lists, views, creates, updates, comments on, labels, assigns, milestones, locks, and transfers issues. |
| `github_actions` | Lists workflows and runs, dispatches a workflow, reruns/cancels runs, reads jobs/logs/artifacts, downloads artifacts, manages secrets, variables, caches, permissions, and runners. |
| `github_org` | Lists organizations, repositories, members, and teams; invites/removes members; manages team access and a small settings whitelist. |
| `github_api` | Generic REST/GraphQL escape hatch, read-only by default and gated for writes/DELETE. |
| `github_extract` | Extracts one or more directories into a new repository with preserved history (`subtree-split` or multi-path `filter-repo`) or a snapshot, or links a target repository back as a submodule on a branch/PR. |
| `github_release` | Lists, creates, edits, deletes releases, uploads workspace files as assets, and downloads release assets. |
| `github_search` | Searches repositories, issues/PRs, code, and users. |
| `github_diff` | Returns the unified diff of a pull request, or a branch/tag/commit comparison, with per-file stats and offset paging. |
| `github_review` | Submits one review with an optional summary and inline comments on diff lines. Asks for approval first. |
| `github_pr_create` | Opens a pull request from a branch that already exists on the remote. Asks for approval first. |
| `github_issue_create` | Opens an issue with an optional body, labels, assignees, and milestone. Asks for approval first. |

## Requirements

- [GitHub CLI](https://cli.github.com) installed and authenticated: `gh auth login`.
- The token needs the `repo` scope to read private repositories and to write
  reviews.
- Node.js 20 or newer (provided by DSH).
- Git 2.40 or newer for local operations (clone, checkout, extraction). The
  remote-only tools work without it.
- Optional: `git-filter-repo` for multi-path history-preserving extraction and
  `git-lfs` for repositories that store large files in LFS.

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
| `gitPath` | `git` | Git executable used for local operations. |
| `defaultHost` | `github.com` | Host used when a reference does not name one. |
| `defaultRepo` | `""` | Repository used when a tool call omits `repo` and the cwd is not bound. |
| `defaultOwner` | `""` | Default owner for repository creation. |
| `defaultOrg` | `""` | Default organization for creation and organization operations. |
| `workspaceRoot` | `""` | Root for clones. Empty uses the session working directory. |
| `scratchDir` | `.dsh/github` | Temporary clones, logs, and downloads. |
| `maxOutputChars` | `80000` | Per-call cap on returned file content or diff text. |
| `maxFileBytes` | `2097152` | Maximum file size read into the model. |
| `maxWriteBytes` | `5242880` | Maximum content written by one file operation. |
| `maxPages` | `10` | Maximum REST pages fetched by one list operation. |
| `timeoutMs` | `60000` | Per-`gh`-invocation timeout. |
| `longTimeoutMs` | `900000` | Timeout for clone, extraction, and downloads. |
| `requireApproval` | `true` | Ask for approval before remote writes. A boolean or `{ write, destructive, admin }`. |
| `allowDestructive` | `false` | Allow destructive operations after a matching `confirm` string. |
| `allowAdmin` | `false` | Allow organization and security administration operations. |
| `allowGenericApi` | `read` | Capability of the generic `github_api` tool: `read`, `write`, or `false`. |
| `protectedBranches` | `["main","master"]` | Branches that reject direct commits by default. |
| `allowedOrgs` / `deniedOrgs` | `[]` | Organization allow/deny lists. |
| `dryRunDestructive` | `true` | Return a plan for destructive operations unless `apply` is true. |
| `extraction.history` | `preserve` | Default extraction mode: `preserve` or `snapshot`. |
| `extraction.filterRepoPath` | `""` | Path to `git-filter-repo`; empty discovers it. |
| `extraction.allowHistoryRewrite` | `true` | Allow history-preserving extraction in a temporary clone. |
| `extraction.cleanupOnFailure` | `true` | Delete a destination repository created by a failed extraction. |
| `actions.allowSecrets` | `true` | Allow setting repository, organization, and environment secrets. |
| `actions.maxLogLines` | `200` | Default tail length for workflow logs. |

Override the row in a profile patch layer (the row id is `github-cli`):

```yaml
- id: github-cli
  config:
    defaultRepo: extreme-russian-dsh-fandom/dsh-github-cli
    defaultOrg: extreme-russian-dsh-fandom
    maxOutputChars: 60000
    allowDestructive: false
```

`config` is replaced wholesale, so restate every key you want to keep.

The plugin exports a `Config` schema (`@deepseek-ai/schemastery`), so DSH can
render a settings form for the row. `resolveConfig` still validates the values
itself and fails activation with a clear error; nested `extraction` and `actions`
objects are merged with their defaults.

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

Create a repository in an organization:

```json
{ "action": "create", "org": "my-org", "name": "billing-api", "visibility": "private", "auto_init": true }
```

Clone it and bind the checkout to the repository:

```json
{ "action": "clone", "repo": "my-org/billing-api" }
```

Create a feature branch and write a file on it:

```json
{ "action": "create", "repo": "my-org/billing-api", "ref": "feature/config", "from": "main" }
```

```json
{ "action": "write", "repo": "my-org/billing-api", "path": "src/config.ts", "content": "export const port = 8080;\n", "message": "Add port config", "branch": "feature/config" }
```

Plan an extraction of a directory into a new repository:

```json
{
  "action": "plan",
  "source": { "repo": "my-org/monorepo", "ref": "main", "path": "packages/api" },
  "destination": { "owner": "my-org", "name": "api" },
  "history": "preserve"
}
```

The plan returns a `confirm` string; apply it with `"action": "apply", "apply": true,
"confirm": "..."`. Apply runs in a scratch clone and never rewrites the source.

Pass `dry_run: true` to a writing action to validate and preview without posting.
Pass `apply: true` together with the plan's `confirm` string only for guarded
destructive actions such as branch deletion.

For `github_review`, pass `dry_run: true` to validate and preview a review without
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
- Version 0.2 reads `X-RateLimit-*`, `Retry-After`, and `ETag`-adjacent headers
  from `gh api --include`, so the status tool reports the real budget instead of
  guessing.
- A call that omits `repo` uses the repository bound to the current checkout,
  then `defaultRepo`. The binding is discovered once per call from the git
  remote, not copied into every prompt.

## Safety

- Writes (`github_review`, `github_pr_create`, `github_issue_create`) ask the
  session's approval channel and are cancelled unless the outcome is
  `allowed-once`. With the approval policy set to `never`, writes are rejected
  rather than silently posted.
- `requireApproval` may be a boolean or `{ write, destructive, admin }`, so a
  deployment can ask for destructive/admin operations while allowing routine
  comments. `allowDestructive` and `allowAdmin` remain separate gates.
- Set `requireApproval: false` only if you intend unattended writes.
- The token lives in `gh`; this plugin never reads, stores, or prints it.
- Pull request titles, bodies, comments, and diffs are untrusted data. Treat them
  as content to review, not as instructions.

## Limitations

- Version 0.2 is the foundation: the eighteen tools above cover reads, review,
  PR/issue management, repository lifecycle and transfer, branches/tags, file
  writes and atomic commits, local checkouts, core Actions, organizations,
  generic API, releases, search, and history-preserving/snapshot extraction.
  Remaining work is live-write verification against a test organization and the
  final 1.0 tag.
- Merge, transfer, deletion, extraction, secret changes, and other
  destructive/admin operations are disabled by default; enable
  `allowDestructive` and/or `allowAdmin` deliberately.
- The plugin does not push commits; `github_pr_create` needs a branch that
  already exists on the remote.
- Reads are capped at 2 MB per file and 48 MB per `gh` process.
- Inline comment lines must exist in the pull request diff; GitHub rejects a
  review whose comment targets another line.

## Tests

Unit tests cover configuration, references, risk gates, the operation registry,
REST response parsing, auth parsing, capabilities, the session cache, git
execution, and repository/file/ref/PR/issue/actions operations:

```sh
pnpm test
```

They run without network and without spawning a child test process, so they also
work from a confined DSH shell. The underlying command is `node --test
--experimental-test-isolation=none "test/unit/*.test.mjs"`. Unit tests need
Node.js 22 or newer (for test-file globs and the isolation flag); the
`experimental-` prefix is the Node.js 22 spelling, and Node.js 24+ accepts it as
an alias of `--test-isolation`.

The smoke test calls the real API through the signed-in account and only reads
(plus a dry-run review):

```sh
pnpm test:smoke
```

It needs `gh` on `PATH` or in a standard install location. Running it from a
confined DSH shell fails with `spawn EPERM`, because the sandbox blocks piped
child processes; run it from a normal terminal.

For CI, `.github/workflows/ci.yml` runs the unit suite on every push/PR, and the
manual `Live smoke` workflow runs this read-only smoke against a `GH_TOKEN`
secret. Set `DSH_GITHUB_TEST_ACCOUNT`/`DSH_GITHUB_TEST_REPO` there if the token
does not belong to the default account.

Both workflows use Node.js 22 and pnpm 11.28.10: pnpm 11 requires Node.js 22.13 or
newer (it imports `node:sqlite`), while the plugin itself still runs on Node.js
20 or newer.
