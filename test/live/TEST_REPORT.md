# dsh-github-cli — отчёт о живом тестировании и исправлениях

Дата: 2026-11-05  
Профиль: `desktop`  
Плагин: `dsh-github-cli` 0.2.0 (`dsh.bundle.patch` → `cordis.patch.yml`)  
Окружение: Node.js v26.1.0, `gh` 2.94.0, аккаунт `Unchpokable`, scopes: `gist`, `read:org`, `repo`, `workflow`.  
Подопытный репозиторий: [Unchpokable/clanker-playground](https://github.com/Unchpokable/clanker-playground).  
Отчёт финального live-прогона: [report-latest.json](report-latest.json).

## 1. Установка и перезагрузка

Плагин установлен из workspace через `plugin_manager` (`install_bundle`, target —
`C:\Users\Unchp\source\repos\dsh-github-cli`). Результат: `application: applied`,
`warnings: []`, версия 0.2.0; в профиле зависимость
`dsh-github-cli -> link:...\source\repos\dsh-github-cli`.

После исправлений строка перезагружена через
`plugin_manager set_plugin target=include:github-cli enabled=false → true`
(`application: applied`). Нативно проверены `github_status`, `github_read`,
`github_file`, `github_search`, `github_issue list`, `github_pr view`,
`github_workspace status` **без `path`**, `github_workspace list/bind/unbind`.

## 2. Что запускалось

| Набор | Команда | Результат |
| --- | --- | --- |
| Unit-тесты плагина | `node --test --experimental-test-isolation=none "test/unit/*.test.mjs"` | **140 / 140 pass** |
| Live E2E | `node test/live/e2e.mjs` (full access: `gh`/`git` с piped stdio) | **145 pass, 4 warn, 0 fail, 0 skip** |
| Дымовой live-прогон | `node test/live/smoke.mjs` | установка, auth, запись, approval |

Live-набор делает реальные вызовы GitHub API через `gh`, создаёт ветки, PR,
issue, тег, релиз, workflow, клонирует и извлекает репозитории. Сделано 84
approval-запроса. Четыре `warn` — ожидаемые ограничения GitHub, не дефекты:
`access_add` владельца, review request владельцу, `rerun_failed` во время
старта run и `orgs/{user}` (это не организация).

## 3. Исправленные дефекты (проверено live)

### D1. `github_release` по тегу

`view` теперь использует `/releases/tags/{tag}`, а `edit`/`delete` резолвят тег
в numeric id через этот endpoint. Live-проверка: `view by tag`, `edit by tag`,
`delete by tag` — pass; numeric id тоже работает.

### D2. `github_issue transfer`

REST endpoint `POST /issues/{n}/transfer` на github.com отдаёт 404. Операция
переведена на GraphQL `transferIssue` с `issueId`/`repositoryId`, после mutation
issue перечитывается через REST. Live: issue #23 перенесён в scratch-репозиторий
как #1 и обратно в `clanker-playground` как #25 — pass.

### D3. `github_extract` с `destination.create: true`

`runOperation` теперь инициализирует сессию (`session.init`) до `prepare`, поэтому
`session.auth` и `session.cwd` заполнены. `createDestination` использует
`user/repos` для владельца-аккаунта (с fallback на `defaults.owner`). Live:
snapshot-extract в новый `clanker-extract-*` с `create: true` создал репозиторий,
запушил `a.txt` и `b.txt` — pass; затем link и cleanup.

### D4. `github_workspace` без `path`

После инициализации сессии локальные операции берут `session.cwd`, а не cwd
процесса Host. Нативный `github_workspace status` без `path` теперь возвращает
`C:\Users\Unchp\source\repos\dsh-github-cli: main`; live-проверка из клона без
`path` — pass.

### D5. `github_repo edit` с topics

Ответ `edit` теперь содержит новые topics; добавлена поддержка topics-only
(раньше `Nothing to edit`, теперь PUT topics + GET repo). Live: `edited topics`
возвращаются и сохраняются — pass.

### D6. Retry/backoff на 5xx/429

`apiRequest` ретраит GET/HEAD при 5xx/сетевых ошибках (3 попытки, backoff,
`Retry-After`, cap 15s). 429 ретраится для любого метода. GraphQL queries
ретраят 5xx; mutations — нет. Покрыто unit-тестами (503 GET, 503 POST, 429).

## 4. Покрытие по инструментам

| Инструмент | Проверено вживую | Не проверено / ограничение |
| --- | --- | --- |
| `github_status` | auth, scopes, quota, `gh`/`git`, `git-lfs`, сервисы DSH, cwd, bindings | — |
| `github_read` | корень, файл с диапазоном, несколько `paths`, рекурсивное дерево, head PR | приватные репозитории, LFS |
| `github_file` | `read`, `stat` файла/каталога, `write`, `copy`, `move`, `delete`, атомарный `commit`, protected branch, overwrite без `sha` | base64, symlink/mode, `base_sha` conflict, большие файлы |
| `github_ref` | `list` ветвей/тегов, `view`, `create` ветки/тега, `delete`, отказ default branch | protected branch delete |
| `github_pr` | `view` со всеми секциями, `list`, `update`, `comment`, `label`, `reviewers` (negative), `ready`/`draft`, `update_branch`, `close`/`reopen`, squash-`merge` с удалением ветки | reviewer с другим аккаунтом, merge conflict, branch protection |
| `github_diff` | PR diff с `paths`/`offset`, сравнение `base...head` | большие diff, бинарники |
| `github_review` | dry-run, `COMMENT` с inline-range | `APPROVE`/`REQUEST_CHANGES` (свой PR), невалидная строка |
| `github_pr_create` | draft PR, PR для close/reopen | fork (`owner:branch`), base ≠ default |
| `github_issue` | `create`, `view`, `list`, `update`, `comment`, `label`, `assign`, `milestone`, `lock`/`unlock`, `close`/`reopen`, **`transfer` (GraphQL)** | — |
| `github_issue_create` | compatibility alias + close | — |
| `github_actions` | `workflows`, `workflow`, `runs`, `run` c jobs, `dispatch`, `rerun`, `cancel`, `logs`, `artifacts`, `download_artifact`, `secrets_set/list/delete`, `variables_set/list/delete`, `permissions_get/set`, `runners_list`, cache delete | `rerun_failed` с реально упавшим job, environment/org secrets, runner tokens, `from_file` |
| `github_repo` | `create`, `view`, `list`, `edit` (metadata/topics), `topics`, `archive`/`unarchive`, `rename` + back, `access_list`, negative `access_add`, delete policy gate | `delete` apply (нет `delete_repo`), `transfer` (нет второго owner), template, успешные access_add/set/remove |
| `github_org` | `list`, `view` user (ожидаемый 404) | invite/remove/teams/settings (нет админ-прав) |
| `github_api` | REST GET + `select`, GraphQL query, POST label, DELETE label/tag, `allow_write`, `allowGenericApi` gate | GraphQL mutation, HEAD, `accept`, DELETE без allowAdmin |
| `github_extract` | `plan` snapshot, **`apply` snapshot с create destination**, `link` plan/apply/PR, `cleanup`, `status`, multi-path `plan` (`filter-repo`) | apply preserve/subtree-split, multi-path apply (нет `git-filter-repo`), LFS, cleanupOnFailure |
| `github_release` | `create`, `upload`, **`view`/`edit`/`delete` по тегу**, numeric id, `list`, `download` | draft/release notes, `clobber`, `pattern` |
| `github_search` | `users`, `repositories`, `issues`, `code` | code search 0 (индексация), repositories/issues lag |
| `github_workspace` | `clone` (depth 1), `status` (явный и **без path**), `list`, `checkout`, `sync`, `worktree` от commit, `bind`/`unbind` | checkout PR, sync rebase/merge, `allow_dirty`, clone без `workspaceRoot` |

Отдельно проверены гейты: approval `allowed-once`, отклонение, `allowDestructive:
false`, `allowAdmin: false`, `allowGenericApi: "read"`, неверный `confirm`.

## 5. Что не проверено и почему

- **Организации**: нет прав администратора ни в одной из 3 организаций; invite,
  remove, teams, team repos, settings не запускались.
- **`github_repo delete`**: у токена нет scope `delete_repo` (403); проверен только
  policy gate. Тестовые репозитории **архивированы**, не удалены.
- **`github_repo transfer`**: нужен второй owner/организация с правами.
- **Успешные access_add/access_set/access_remove**: владелец не может быть
  collaborator; нужен второй аккаунт.
- **`github_extract`**: apply preserve/subtree-split, multi-path apply (нет
  `git-filter-repo`), LFS-путь, cleanupOnFailure.
- **PR**: merge conflict, branch protection, merge queue, review `APPROVE`/
  `REQUEST_CHANGES` на чужом PR, reviewers с другим аккаунтом.
- **Actions**: environment/org secrets, `from_file`, runner tokens, успешный
  `rerun_failed` на реально упавшем job, artifact patterns.
- **Файлы**: base64, symlink/mode `100755`/`120000`, `base_sha` conflict, большие
  файлы и лимиты.
- **Прочее**: приватные репозитории, GitHub Enterprise/иной host, `ghPath`,
  `git-lfs`-репозитории, нативный approval-диалог DSH (в live-наборе —
  детерминированный тестовый approval-сервис).

## 6. Состояние после теста

- `clanker-playground`: `has_issues` возвращён в `false`, только `main`; тестовые
  файлы, ветки, тег, релиз, label и milestone удалены. Issues от тестов остались
  закрытыми (REST не удаляет issues), история Actions run осталась.
- Тестовые `clanker-plugin-e2e-*` и `clanker-extract-*` архивированы: удаление
  недоступно без `delete_repo`.
- Локальный workdir финального прогона: `.dsh/e2e-mw3gaxe7` (в `.gitignore`).

## 7. Изменённые файлы

- `lib/ops/registry.js` — `session.init(exec)` перед операцией.
- `lib/session.js` — `currentDirectory` запоминает cwd.
- `lib/git/extract.js` — `user/repos` + fallback на `defaults.owner`, понятная
  ошибка без аккаунта.
- `lib/ops/release.js` — резолв тега через `/releases/tags/{tag}`.
- `lib/ops/issue.js` — GraphQL `transferIssue`.
- `lib/ops/repo.js` — topics в ответе и topics-only edit.
- `lib/gh/rest.js` — retry/backoff для 5xx/429 и `Retry-After`.
- `lib/gh/graphql.js` — retry для queries, без retry для mutations.
- `test/unit/*` — 9 новых регрессионных тестов (140 всего).
- `test/live/e2e.mjs` — live-проверки исправлений; `TEST_REPORT.md`.

## 8. Как повторить

```sh
# unit
node --test --experimental-test-isolation=none "test/unit/*.test.mjs"

# live (нужен full access: gh/git с pipe)
node test/live/e2e.mjs
```

Live-скрипт сам создаёт scratch-репозиторий, прогоняет сценарии, восстанавливает
настройки target-репозитория и пишет `test/live/report-<run>.json` +
`report-latest.json`.
