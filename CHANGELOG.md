# Changelog

## Unreleased

### Fixed

- Initialize the plugin session before an operation runs. `github_workspace`
  without an explicit path now uses the session working directory instead of the
  Host process cwd, and `github_extract` with `destination.create: true` creates
  a user-owned repository through `user/repos` instead of `orgs/{owner}/repos`.
- `github_release view/edit/delete` accepts a tag name again: tags resolve through
  `/releases/tags/{tag}`, while numeric ids keep using `/releases/{id}`.
- `github_issue transfer` uses the GraphQL `transferIssue` mutation; the REST
  transfer endpoint returns 404 on github.com.
- `github_repo edit` returns the new topic list and supports a topics-only edit.
- REST GET/HEAD requests retry transient 5xx and network failures, and 429 is
  retried for any method with `Retry-After` respected (capped at 15s). GraphQL
  queries retry server errors; mutations do not.

### Tests

- Unit suite: 140 tests, including regressions for release tags, GraphQL issue
  transfer, repository topics, session initialization, and REST retries.
- Live E2E: 145 pass, 4 expected warnings, 0 fail against
  `Unchpokable/clanker-playground`.

## 0.2.0 — development

The first GitHub control-plane milestone. The original seven tools remain
compatible; the plugin now registers eighteen tools.

### Added

- Session context: cwd → repository binding, defaults, TTL cache, journal.
- Typed `Config` schema (`@deepseek-ai/schemastery`) with backward-compatible keys.
- Operation registry with risk tiers, plan/apply, approval, confirm, and journal.
- REST transport with `gh api --include` status/headers, rate-limit parsing, and GraphQL.
- Capability probes for `gh`, `git`, `git-filter-repo`, `git-lfs`, and DSH services.
- Repository tools: list/view/create/edit/archive/unarchive/topics/access/transfer/rename/delete.
- File tools: read/stat/write/delete/move/copy/commit (atomic Git Data API).
- Ref tools: list/view/create/delete for branches and lightweight tags.
- Workspace tools: bind/list/status/clone/checkout/sync/worktree through
  `ctx.subprocess` and the sandbox.
- PR tools: list/update/close/reopen/ready/draft/comment/label/reviewers/update_branch/merge.
- Issue tools: list/view/create/update/close/reopen/comment/label/assign/milestone/lock/transfer.
- Actions tools: workflows/runs/dispatch/rerun/cancel/logs/artifacts, secrets, variables, caches.
- Organization tools: members, teams, team repository access, settings whitelist.
- Generic `github_api` escape hatch, read-only by default.
- `github_extract`: plan/apply/link/cleanup/status for history-preserving and
  snapshot extraction, multi-path `filter-repo`, LFS preflight/fetch/push, and a
  submodule link PR.
- Release tools and search.
- 131 unit tests; legacy compatibility tests for the original PR/issue/review helpers.

### Security

- Destructive operations require `allowDestructive`, approval, `apply`, and a
  matching `confirm` when a plan provides one.
- Admin operations require `allowAdmin`; secrets accept values only from
  `from_file`/`from_env` and forward them over stdin.
- Tokens are never read or printed; diagnostics are redacted; writes go through
  the sandbox for local git.

### Known limitations

- Live write tests require a dedicated test organization; the DSH sandbox blocks
  piped child processes (`spawn EPERM`) in this development shell.
- `github_extract` submodule history is not copied (gitlinks only); deep LFS
  handling requires `git-lfs` installed.
- The package version stays `0.2.0` until the final 1.0 tag.
