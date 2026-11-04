# dsh-github-cli 2.0: проект полноценного GitHub-плагина

**Статус:** проект (design doc). Phase 0–3 и hardening реализованы в версии 0.2.0, включая multi-path filter-repo, LFS preflight, releases/search; остались live-write проверки на test org и финальный тег 1.0. Код плагина расширяется по этому документу.

**Область:** `C:\Users\Unchp\source\repos\dsh-github-cli` (форк `Unchpokable/dsh-github-cli`, upstream `untodesu/dsh-github-cli`).

**Цель:** превратить плагин из «чтение репозитория + ревью PR» в GitHub control plane, которым агент управляет из одной сессии: создаёт и переносит репозитории, правит файлы и ветки, выносит код в отдельные репозитории, работает с организациями, командами и Actions.

**Оглавление:** [0. Коротко](#0-коротко) · [1. Что есть сейчас](#1-что-есть-сейчас) · [2. Целевой продукт](#2-целевой-продукт) · [3. Архитектура](#3-архитектура) · [4. Инструменты](#4-поверхность-инструментов) · [5. Сценарии](#5-флагманские-сценарии) · [6. Модель данных](#6-модель-данных) · [7. Безопасность](#7-безопасность) · [8. Тестирование](#8-тестирование) · [9. Совместимость](#9-совместимость-и-миграция) · [10. Дорожная карта](#10-дорожная-карта) · [11. Риски](#11-риски) · [12. Решения и статус](#12-подтверждённые-решения-и-статус-реализации)

---

## 0. Коротко

| Сейчас | Цель 2.0 |
| --- | --- |
| 7 инструментов: статус, чтение, PR, diff, review, create PR, create issue | 15 доменных инструментов (включая существующие diff/review и generic API) + 2 опциональных |
| Только `gh` CLI и REST | `gh` (REST/GraphQL) + локальный `git` через `ctx.subprocess` |
| Чтение и три точечных write-операции | Полный жизненный цикл repo/file/branch/PR/issue/actions/org |
| Одно подтверждение на любой write | Уровни риска, `plan/apply`, typed confirm, dry-run |
| Нет контекста сессии | `GitHubSession`: привязка cwd → repo, дефолты, capabilities, журнал |
| Нет схемы конфига и формы настроек | `Config`-схема + обратная совместимость |
| Нет тестов на write | Unit + contract + local-git + live-read + gated live-write |

**Ключевые решения:**

1. **Доменные инструменты с `action`**, а не 60 отдельных tool'ов и не один «магический» `github`. Один tool = один домен (repo, file, pr, actions, org…), `action` — операция внутри домена.
2. **Operation registry** — единый слой описания операций: параметры, риск, scopes, preflight, plan, apply, render, approval. Инструменты — тонкие диспетчеры.
3. **Два транспорта:** `gh` для аутентификации/API, локальный `git` для истории, клонов, subtree/filter-repo и push. Токен никогда не читается плагином.
4. **`plan` → approval → `apply`** для всего, что меняет удалённое состояние; разрушительные операции дополнительно требуют `confirm`-строку и `allowDestructive`.
5. **Флагман — `github_extract`:** вынос пути (или набора путей) в новый репозиторий с сохранением истории или снапшотом, с опциональной обратной привязкой через submodule/subtree и с rollback-планом.
6. **Обратная совместимость:** старые инструменты и их аргументы продолжают работать; `github_read`, `github_pr_create`, `github_issue_create` остаются алиасами.

---

## 1. Что есть сейчас

### 1.1 Файлы и ответственность

| Файл | Строк | Ответственность |
| --- | ---: | --- |
| `index.js` | 497 | Конфиг, регистрация 7 инструментов, approval-хелпер, `github_status` |
| `gh.js` | 449 | Поиск `gh`, запуск процессов, REST (`apiText`/`apiJson`/`apiList`), парсинг repo/PR, ошибки |
| `read.js` | 476 | Contents API: файлы, каталоги, рекурсивное дерево, лимиты вывода |
| `pr.js` | 669 | Чтение PR, diff, сравнение refs, создание PR |
| `review.js` | 289 | Валидация и отправка review с inline-комментариями одним запросом |
| `issue.js` | 135 | Валидация и создание issue |
| `test/smoke.mjs` | 331 | Живые read-only тесты + dry-run review |
| `locale/*.json` | — | Только meta-title/description, без i18n инструментов |
| `cordis.patch.yml` | — | Одна host-строка `github-cli` |

### 1.2 Сильные стороны, которые сохраняем

- **Своя квота.** Все вызовы идут через авторизованный `gh`, а не через анонимный API.
- **Ограниченный вывод.** Файлы, diff, комментарии и списки обрезаются с подсказками продолжения (`start_line`, `offset`).
- **Approval перед write.** Уже есть корректная работа с `ctx.get('approval')` и fail-closed.
- **Недоверенный контент.** В описаниях PR явно сказано, что текст — данные, а не инструкции.
- **Нет зависимостей.** Чистый ESM, без сборки; это ценно для установки через pnpm/Git.
- **Аккуратные ошибки.** `githubError` уже различает 401/403/404/rate limit.
- **`isConcurrencySafe`.** Read-инструменты помечены конкурентно-безопасными, write — нет.

### 1.3 Ограничения, мешающие цели

| Ограничение | Следствие |
| --- | --- |
| Нет локального `git` | Нельзя клонировать, делать checkout, push, subtree split, filter-repo |
| Нет записи файлов | Нельзя править код, перемещать файлы, делать коммиты |
| Нет repo-операций | Нельзя создать/перенести/переименовать/удалить репозиторий |
| Нет Actions/org | Нельзя запускать workflow, работать с секретами, командами, участниками |
| Нет GraphQL | Сложные вложенные выборки (review threads, teams) требуют REST-обходов |
| Нет контекста сессии | Каждый вызов требует `repo`; нет привязки к cwd, нет дефолтной организации |
| Нет plan/apply | Опасные операции нельзя предпросмотреть; нет idempotency и rollback |
| Нет заголовков ответа | Нельзя отслеживать rate limit, ETag, `Retry-After` |
| Нет схемы конфига | Нет формы настроек в DSH; только ручной YAML |
| Нет тестов на write | Изменения в write-путях не покрыты |

### 1.4 Что переиспользуем и что рефакторим

**Переиспользуем как есть или с малой правкой:**

- `resolveGh`, `run`, `apiText`, `apiJson`, `apiList`, `parseRepo`, `parsePull`, `shortSha`, `formatBytes`, `isoSeconds`.
- `githubError` — расширяем, но сохраняем текущие сообщения для старых кодов.
- `read.js` — оставляем как реализацию `github_file action=read`.
- `pr.js` — чтение PR и diff остаются; создание PR переезжает в operation registry.
- `review.js` — остаётся; добавляем только общий approval/риск-слой.
- `issue.js` — создание issue становится одной из операций `github_issue`.

**Рефакторим:**

- `gh.js` → `lib/gh/` (exec, auth, rest, graphql, errors, pagination).
- `index.js` → регистрация инструментов + конфиг; логика уходит в `lib/`.
- Конфиг → `lib/config.js` с валидацией и обратной совместимостью.
- Добавляем `lib/session.js`, `lib/ops/`, `lib/git/`, `lib/tools/`, `lib/render/`.

---

## 2. Целевой продукт

### 2.1 Сценарии (jobs-to-be-done)

| Сценарий | Что должен уметь агент |
| --- | --- |
| «Создай репозиторий под этот код и запушь» | Создать repo (user/org), инициализировать/склонировать, сделать первый коммит и push, выставить default branch и защиту |
| «Перенеси репозиторий в организацию» | Проверить права, сделать transfer, обновить локальные remotes, проверить последствия, дать checklist |
| «Вынеси `packages/api` в отдельный репозиторий с историей» | Построить план, оценить объём, выбрать стратегию (subtree/filter-repo/snapshot), создать repo, запушить историю, при желании подключить обратно submodule/subtree и открыть PR |
| «Перемести файлы/каталог» | Сделать атомарный commit через Git Data API или локальный git, не затронув чужие изменения |
| «Добавь человека в команду и дай доступ к репо» | Найти org/team, проверить роль, добавить, выдать permission, показать результат |
| «Запусти workflow и покажи, что упало» | Dispatch, дождаться run, вернуть статус, job'ы, tail логов, ссылки |
| «Положи секрет в repo/org/environment» | Set без утечки значения в контекст, argv и логи; list только имена |
| «Открой PR, отревьюй, смержи» | Создать PR, поставить review, проверить checks, merge с защитой от гонки |
| «Где я и что мне доступно?» | Показать host/account/scopes/capabilities/привязки cwd → repo |

### 2.2 Принципы

1. **Additive, не rewrite.** Старые инструменты и их аргументы не ломаются.
2. **Одна сессия.** Репозиторий определяется из `repo` → привязки cwd → `defaultRepo`; повторный `repo` не обязателен.
3. **Сначала план.** Любая изменяющая операция умеет `dry_run`; разрушительная — по умолчанию возвращает план, пока не передан `apply: true`.
4. **Удалённое — через API, локальное — через git.** Плагин не притворяется git-клиентом; он делает GitHub-специфичные и многошаговые операции.
5. **Ничего не пишем в чужое рабочее дерево без явного запроса.** Для истории и экспериментов — временные клоны и worktree.
6. **Вывод ограничен, работа — нет.** Большие логи/артефакты/деревья уходят в файлы и jobs, в контекст — сводка.
7. **Least privilege.** Preflight scopes/permissions; ошибка объясняет, какой scope или роль нужны.
8. **Идемпотентность где возможна.** Create проверяет существование; commit — `base_sha`; merge — head SHA.
9. **Секреты не попадают в контекст.** Только stdin, только имена, redaction в ошибках.
10. **Одна точка расширения.** Новая операция = дескриптор в registry, а не новый пласт логики в `index.js`.

### 2.3 Границы (non-goals v1)

- Создание организации через API — GitHub этого не позволяет; организация создаётся вручную, плагин управляет существующей.
- Администрирование GitHub Enterprise Server (site admin), billing, GitHub Apps, OAuth Apps.
- Projects v2, Discussions, Packages, Pages, Webhooks — во v2+; в v1 — только read-only через `github_api`, если очень нужно.
- Автоматический merge queue, provisioning runners, code signing.
- Переписывание истории исходного репозитория. Extraction работает только во временном клоне; исходный repo не переписывается.
- Замена общим `git`/`bash`: произвольные команды остаются за `bash`/`pwsh`, плагин даёт GitHub-семантику и безопасные многошаговые сценарии.

---

## 3. Архитектура

### 3.1 Слои

```text
┌──────────────────────────────────────────────────────────────┐
│ Model                                                        │
│  github_status · github_workspace · github_repo · github_file│
│  github_ref · github_pr · github_issue · github_review       │
│  github_actions · github_org · github_extract · github_api   │
└───────────────────────────┬──────────────────────────────────┘
                            │ JSON Schema args + exec.signal
┌───────────────────────────▼──────────────────────────────────┐
│ Tool layer                                                   │
│  validate action · build presentCall · render result         │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Operation registry                                           │
│  descriptor: risk/scopes/prepare/plan/apply/render           │
│  pipeline: resolve → preflight → plan → approval → apply     │
│            → verify → journal → render                       │
└──────────┬───────────────────────────────────┬───────────────┘
           │                                   │
┌──────────▼──────────┐              ┌─────────▼───────────────┐
│ GitHubSession       │              │ Capabilities             │
│  bindings, defaults │              │  gh/git/filter-repo/lfs  │
│  cache, journal     │              │  scopes, permissions     │
└──────────┬──────────┘              └─────────┬───────────────┘
           │                                   │
┌──────────▼──────────┐              ┌─────────▼───────────────┐
│ gh transport        │              │ git transport            │
│  REST + GraphQL     │              │  local via ctx.subprocess│
│  via user's gh      │              │  + sandbox/fs            │
└─────────────────────┘              └──────────────────────────┘
```

### 3.2 Транспорты

| Транспорт | Для чего | Почему |
| --- | --- | --- |
| `gh` REST (`gh api`) | 90% операций: repo, file, PR, issue, actions, org, search | Аутентификация, host selection, scopes, знакомый формат ошибок |
| `gh` GraphQL (`gh api graphql`) | review threads, teams, сложные вложенные выборки, Projects v2 | Один запрос вместо N+1; недоступно в REST |
| `gh` convenience (`gh repo clone`, `gh pr checkout`, `gh secret set`, `gh run download`, `gh release upload`) | Операции, где `gh` уже инкапсулирует криптографию/загрузку | Не дублируем libsodium, upload-протокол, credential helper |
| локальный `git` | clone, fetch, branch, worktree, commit, push, subtree split, filter-repo, archive | История и файлы — территория git; API не умеет историю |
| прямой HTTP | **запрещён** | Токен живёт в `gh`; плагин не читает и не передаёт его |

**Граница sandbox.** `gh`-вызовы, которые только читают/пишут через API, могут идти через существующий `run()` (он сохраняет окружение и не трогает файлы). Всё, что пишет в файловую систему (`git`, `gh run download`, `gh release download`), идёт через `ctx.subprocess` + sandbox или `ctx.fs` — иначе запись обойдёт file policy.

**Host selection.** Модель репозитория всегда несёт host, но в v1 поддерживается только github.com. GHES не входит в v1; `gh api --hostname` и разбор remote оставлены в транспорте, чтобы добавить его позже без переделки ссылок.

**Заголовки.** `gh api --include` отдаёт статус и HTTP-заголовки; из них читаем `X-RateLimit-*`, `ETag`, `Retry-After`, `X-GitHub-SSO`. Тело отделяем от заголовков в `rest.js`.

**Почему не только `gh` CLI-команды.** `gh repo create`, `gh pr create` и т.п. удобны, но не покрывают все поля (visibility, teams, custom properties, rulesets), не дают одинакового JSON и plan/apply. Поэтому база — `gh api`, а convenience-команды — точечно.

**Почему не только REST.** Review threads, team membership, Projects v2 и сложные связи требуют GraphQL; REST-обходы дают N+1 и хрупкий код.

### 3.3 GitHubSession

Один объект на активацию плагина (создаётся в `apply`), общий для всех инструментов:

```js
class GitHubSession {
  host;                 // github.com | ghe.example.com
  account;              // login
  scopes;               // из gh auth status, если известны
  rateLimit;            // core/search/graphql + reset
  cwd;                  // текущая директория сессии
  bindings;             // Map<absolutePath, { repo, host, remote, branch }>
  defaults;             // { repo, owner, org }
  capabilities;         // { gh, git, filterRepo, lfs, subprocess, jobs }
  cache;                // TTL-кэш GET-ответов
  journal;              // последние операции
}
```

**Определение repo:**

1. Явный `repo` в аргументах.
2. `repo` из URL PR/issue.
3. Привязка текущего cwd (или ближайшего родителя) к git-remote.
4. `defaultRepo` из конфига.
5. Иначе — ошибка с подсказкой: `pass repo or run github_workspace action=bind`.

**Привязка cwd → repo.** `git -C <cwd> remote -v`; приоритет `origin`, затем `upstream`; нормализация SSH/HTTPS (`git@github.com:owner/repo.git` → `github.com/owner/repo`). После `clone`/`checkout`/`worktree` привязка создаётся автоматически, а `ctx.workingDirectory.set` переводит сессию в новый каталог (как в `dsh-experimental-worktree`).

**Дефолты.** `defaultOwner`/`defaultOrg` из конфига; `defaultRepo` — для обратной совместимости. `github_status` показывает, что реально используется.

**Жизненный цикл.** `apply` создаёт сессию, но не ходит в сеть: первый `github_status`/любой tool лениво запускает `gh auth status` и probes. `ctx.effect` при dispose aborts in-flight операции и чистит TTL-кэш; временные каталоги не удаляются автоматически, если в них может быть результат (их чистит `github_extract cleanup`).

**Кэш.** Только GET: repo metadata (60 с), branches/tags (30 с), rate limit (30 с), user/org (5 мин). Инвалидация по префиксу при write. Секреты и auth не кэшируются.

**Журнал.** Кольцевой буфер на 200 записей: `{ id, at, operation, repo, risk, planHash, approval, result, rollback }`. Хранится в памяти; опционально пишется в `<workspace>/.dsh/github/journal.jsonl` (без секретов). Нужен для «что я только что сделал», отладки и undo-подсказок.

### 3.4 Operation registry

Каждая операция описывается декларативно:

```js
// lib/ops/repo.js
defineOperation({
  tool: 'github_repo',
  action: 'transfer',
  risk: 'destructive',
  scopes: ['repo'],
  summary: (a) => `Transfer ${a.repo} to ${a.new_owner}`,
  validate(a) { /* action-specific required/forbidden fields */ },
  async prepare(ctx, a) { /* resolve repo, permissions, target org, warnings */ },
  async plan(ctx, p) { /* effects, api calls, confirm, irreversible */ },
  async apply(ctx, p, signal) { /* POST /transfer, update remotes, verify */ },
  render: renderRepoTransfer,
});
```

**Pipeline `runOperation`:**

1. `validate` — action-specific правила, взаимоисключения, лимиты.
2. `prepare` — resolve repo/host, preflight permissions/scopes, собрать факты.
3. `plan` — объект `Plan`: `effects`, `api`, `commands`, `warnings`, `confirm`, `irreversible`.
4. `risk gate` — R0/R1 без approval; R2+ approval; R3/R4 — ещё `allowDestructive`/`allowAdmin`, `apply: true`, `confirm`.
5. `apply` — выполнение с `exec.signal`, проверка предусловий (SHA/ETag), компенсирующие действия.
6. `verify` — прочитать состояние после записи; не считать «200 OK» доказательством.
7. `journal` — запись.
8. `render` — компактный текст + `next`.

**Зачем registry, а не просто функции:**

- одинаковые approval/plan/ошибки/лимиты для 100+ операций;
- тесты на операцию, а не на tool;
- каталог операций можно генерировать в документацию;
- `github_api` и будущие домены подключаются без переписывания `index.js`;
- проще добавлять `undo`/`rollback` и аудит.

### 3.5 Риск-модель

| Уровень | Примеры | Approval | Дополнительно |
| --- | --- | --- | --- |
| **R0 read** | status, view, list, diff, logs, search | нет | — |
| **R1 local write** | clone, checkout, worktree, bind, sync | нет (file policy) | Только внутри workspace/scratch |
| **R2 remote write** | create repo, commit file, open PR, comment, dispatch workflow | да | `dry_run` доступен |
| **R3 destructive** | transfer, rename, delete repo, delete branch, force-push, merge | да | `apply: true` + `confirm`; `allowDestructive` |
| **R4 admin/security** | org settings, member removal, secrets set, runner tokens, visibility → public | да | `apply: true` + `confirm`; `allowAdmin` |

**Правила:**

- R3/R4 без `apply: true` возвращают план и **ничего не делают**.
- `confirm` — точная строка, например `owner/repo`, `owner/repo -> new-owner`, `DELETE owner/repo`. Модель обязана её передать; approval-промпт показывает ту же строку.
- `requireApproval` может быть `true`/`false` или объектом `{ write, destructive, admin }`; destructive/admin не отключаются одним `false`, пока не выставлены `allowDestructive`/`allowAdmin`.
- `dry_run: true` — всегда доступен и не требует approval.
- Protected/default branch: прямой commit/push запрещён по умолчанию; предложить ветку + PR. Разрешение — `allow_protected_branch: true` + approval.

### 3.6 Конфигурация

Все старые ключи сохраняются. Новые — опциональны.

| Ключ | По умолчанию | Смысл |
| --- | --- | --- |
| `ghPath` | `""` | Путь к `gh`; пусто — искать |
| `gitPath` | `git` | Путь к `git` |
| `defaultHost` | `github.com` | Хост по умолчанию |
| `defaultRepo` | `""` | Репозиторий по умолчанию |
| `defaultOwner` | `""` | Владелец по умолчанию для create |
| `defaultOrg` | `""` | Организация по умолчанию |
| `workspaceRoot` | `""` | Корень для клонов; пусто — cwd сессии |
| `scratchDir` | `.dsh/github` | Временные клоны, логи, артефакты |
| `maxOutputChars` | `80000` | Лимит текста в контекст |
| `maxFileBytes` | `2097152` | Лимит чтения файла |
| `maxWriteBytes` | `5242880` | Лимит содержимого одного write |
| `maxPages` | `10` | Максимум страниц API |
| `timeoutMs` | `60000` | Обычный вызов |
| `longTimeoutMs` | `900000` | Clone/filter-repo/artifact |
| `requireApproval` | `true` | Approval для write |
| `allowDestructive` | `false` | Разрешить R3 |
| `allowAdmin` | `false` | Разрешить R4 |
| `allowGenericApi` | `read` | `read`/`write`/`false` для `github_api` |
| `protectedBranches` | `["main","master"]` | Защита от прямых коммитов |
| `allowedOrgs` | `[]` | Whitelist org (пусто — все) |
| `deniedOrgs` | `[]` | Blacklist org |
| `dryRunDestructive` | `true` | R3/R4 по умолчанию plan-only |
| `extraction.history` | `preserve` | `preserve`/`snapshot` |
| `extraction.filterRepoPath` | `""` | Путь к `git-filter-repo` |
| `actions.allowSecrets` | `true` | Разрешить set/list secrets |
| `actions.allowRunnerTokens` | `false` | Не отдавать registration tokens |

**Схема.** Для формы настроек DSH нужен `Config` (Schemastery, как в `dsh-experimental-worktree`). Подтверждено: используем `@deepseek-ai/schemastery`; `@deepseek-ai/cosmokit` добавлен прямым dependency из-за pnpm-раскладки. `resolveConfig` остаётся для собственных сообщений об ошибках и вложенных defaults.

### 3.7 Результаты, ошибки, лимиты

**Единый конверт результата:**

```js
{
  ok: true,
  operation: 'repo.create',
  repo: 'my-org/api',
  url: 'https://github.com/my-org/api',
  summary: 'Created my-org/api (private)',
  data: { /* компактно, без сырых JSON-дампов */ },
  warnings: [],
  next: [
    { tool: 'github_workspace', args: { action: 'clone', repo: 'my-org/api' }, reason: 'clone the new repository' },
  ],
  applied: true,
  journal_id: 'op_...',
}
```

**План:**

```js
{
  ok: true,
  operation: 'repo.transfer',
  applied: false,
  plan: {
    id: 'plan_...',
    risk: 'destructive',
    summary: 'Transfer Unchpokable/dsh-github-cli to my-org',
    effects: ['Owner changes', 'Old URLs redirect', 'Local remotes must be updated'],
    api: [{ method: 'POST', path: '/repos/.../transfer', body: { new_owner: 'my-org' } }],
    commands: [],
    irreversible: false,
    confirm: 'Unchpokable/dsh-github-cli -> my-org',
    warnings: ['Actions secrets, packages and Pages need verification after transfer'],
  },
  next: [{ tool: 'github_repo', args: { action: 'transfer', apply: true, confirm: '...' }, reason: 'apply' }],
}
```

**Коды ошибок:** `auth`, `scope`, `permission`, `not_found`, `conflict`, `validation`, `rate_limit`, `unsupported`, `network`, `timeout`, `cancelled`, `partial`, `policy`.

`partial` — критично для многошаговых сценариев: repo создан, push упал; PR создан, submodule не добавился. Результат содержит `steps: [{name, status, detail}]` и `rollback`-подсказки.

**Лимиты:**

- списки: 100 элементов по умолчанию, `cursor`;
- diff: offset-пагинация (как сейчас);
- логи: tail 200 строк / 20k символов; полный лог — в файл;
- артефакты: в файл, не в контекст;
- дерево: 1000 записей, `truncated`;
- файл: 2 MB чтения, 5 MB write (больше — через `git`/release asset);
- API: `maxPages`, таймауты, отмена.

### 3.8 Локальный git и sandbox

Паттерн взят из `dsh-experimental-worktree`:

```js
const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
const command = [await ctx.subprocess.resolveExecutable(config.gitPath, undefined, signal), ...args];
const argv = policy.mode === 'danger-full-access'
  ? command
  : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv;
const child = ctx.subprocess.spawn({
  argv,
  cwd,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
  env: { GIT_TERMINAL_PROMPT: '0' },
  graceMs: 5000,
  signal,
});
try {
  const { exitCode } = await child.done;
} finally {
  child.terminate();
}
```

**Почему так, а не `child_process.spawn`:** sandbox confinement, managed process range (Windows tree kill), bounded output, cancellation. Текущий `run()` убивает только прямой процесс; `filter-repo`/`git` могут оставить детей.

**Env:**

- `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GH_PAGER=cat`, `NO_COLOR=1`;
- очищать `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` (как worktree), чтобы не подменяли конфиг;
- **не** очищать credential helper/SSH: push должен работать через `gh auth setup-git` или SSH;
- если пользователь использует `GH_TOKEN`, передать его явно в `env` для `gh` (subprocess scrub'ает credential-shaped env); никогда не логировать.

**Пути:** `ctx.fs.resolve` + `processPath`; запрет `..`, абсолютных путей вне workspace, symlink-escape; case-collision проверка на Windows/macOS.

**Долгие операции:** `ctx.jobs` (если смонтирован) — clone, filter-repo, artifact download, ожидание run. Tool возвращает `job_id` + `next`; иначе — синхронно с `longTimeoutMs` и предупреждением.

### 3.9 Интеграция с DSH

| Сервис | Использование |
| --- | --- |
| `ctx.tools` | Регистрация инструментов; `defineTool` (DSH 2.x) или текущий raw schema |
| `ctx.approval` | R2–R4; `request({agent, toolName, callId, reason, signal})` |
| `ctx.subprocess` | Локальный git; обязательно для write в workspace |
| `ctx.sandboxPolicy` + `ctx.sandbox` | Confinement команд git |
| `ctx.fs` | Чтение/запись файлов, resolve/processPath, lstat |
| `ctx.workingDirectory` | `ensure`, `set` после clone/checkout/worktree |
| `ctx.jobs` | Фоновые длинные операции (опционально) |
| `ctx.commands` | Опционально: `/gh status`, `/gh use`, `/gh clone` |
| `ctx.effect` | Очистка кэшей/временных каталогов при dispose |

**Зависимости.** `inject = ['tools']` остаётся обязательным; `subprocess`, `fs`, `sandboxPolicy`, `workingDirectory`, `jobs`, `commands` — опциональные через `ctx.get`, чтобы remote-only сценарии работали в headless-композиции без локальных сервисов. Локальные операции без `subprocess` дают понятную ошибку.

### 3.10 Структура файлов

```text
index.js                     # entry: name/inject/apply, регистрация tools, Config
lib/
  config.js                  # resolveConfig + обратная совместимость
  session.js                 # GitHubSession, bindings, defaults, journal
  capabilities.js            # gh/git/filter-repo/lfs/subprocess probes
  risk.js                    # R0–R4, approval/confirm/plan gates
  result.js                  # envelope, render helpers, next steps
  errors.js                  # taxonomy + githubError extension + redaction
  gh/
    exec.js                  # run/resolveGh (из gh.js)
    auth.js                  # status, hosts, scopes, setup-git
    rest.js                  # apiText/apiJson/apiList + headers
    graphql.js               # graphql(query, variables)
    paginate.js              # cursor/Link
  git/
    exec.js                  # sandboxed git runner
    local.js                 # clone/checkout/branch/worktree/status
    remote.js                # fetch/push/ls-remote
    extract.js               # subtree/filter-repo/snapshot engine
    tree.js                  # ls-tree, stats, LFS/submodule detection
  ops/
    registry.js              # defineOperation/runOperation
    repo.js
    file.js
    ref.js
    pr.js
    issue.js
    actions.js
    org.js
    extract.js
    api.js
  tools/
    status.js
    workspace.js
    repo.js
    file.js
    ref.js
    pr.js
    issue.js
    actions.js
    org.js
    extract.js
    api.js
  render/
    common.js
    repo.js
    file.js
    pr.js
    actions.js
    org.js
    extract.js
test/
  unit/                      # pure validation/plan/render
  contract/                  # fake gh/git argv fixtures
  local/                     # real git in temp dirs
  live/                      # read-only + gated write
  fixtures/
```

### 3.11 Альтернативы и почему отклонены

| Альтернатива | Почему не выбрана |
| --- | --- |
| 60+ отдельных tool'ов на каждую операцию | Схемы съедают контекст, модель путается в именах, KV-cache нестабилен |
| Один `github` с `op: string` и `params: object` | Нет типизации/валидации, нет подсказок по аргументам, ошибки поздно |
| Только `gh` CLI-команды | Не покрывают все поля/JSON, нет plan/apply, разные версии `gh` |
| Только REST | Не умеет историю, subtree, filter-repo, push; extraction невозможен |
| Только локальный git | Требует клон и рабочее дерево; remote-only сценарии (issue, actions, org) не работают |
| `filter-repo` всегда | Тяжёлая зависимость (Python), медленно; для одного каталога хватает `subtree split` |
| `ctx.github` как Cordis-сервис сразу | Лишняя зависимость/жизненный цикл; сначала внутренний `GitHubSession`, сервис — при необходимости |
| File write только через локальный git | Трогает рабочее дерево, требует credential helper; API безопаснее по умолчанию |

---

## 4. Поверхность инструментов

### 4.1 Принципы группировки

- **Один tool = один домен.** Модель знает, куда идти: репозиторий, файл, PR, Actions, организация.
- **`action` — операция домена.** Это дешевле по схеме, чем 60 tool'ов, и понятнее, чем один `github` с сотней op.
- **`action` — единственный дискриминатор.** Под-операции оформляются отдельными actions (`secrets_set`, `team_members_add`), а не вложенным `action` внутри `action`: иначе модель путает уровни, а валидация становится неоднозначной.
- **Редкие/неподдерживаемые операции — `github_api`.** Escape hatch, а не разрастание схемы.
- **Старые имена — алиасы.** Не ломаем существующие промпты и привычки.

### 4.2 Каталог

| Tool | Назначение | Основные actions | Риск | Фаза |
| --- | --- | --- | --- | --- |
| `github_status` | Кто я, где, что доступно | — | R0 | 0 |
| `github_workspace` | Локальные чекауты и привязки | status, bind, list, clone, checkout, sync, worktree, unbind | R1 | 1 |
| `github_repo` | Репозитории | list, view, create, publish, edit, transfer, rename, delete, archive, unarchive, topics, access_list, access_add, access_remove, access_set | R2–R4 | 1/3 |
| `github_file` | Файлы и коммиты | read, list, tree, stat, write, delete, move, copy, commit, download, upload | R2 | 1 |
| `github_ref` | Ветки и теги | list, view, create, delete, protect, unprotect, rename, compare | R2–R3 | 1/2 |
| `github_pr` | Pull requests | view, list, create, update, merge, close, reopen, ready, draft, comment, reply, resolve, label, reviewers, update_branch, files, commits, checks | R2–R3 | 2 |
| `github_issue` | Issues | view, list, create, update, close, reopen, comment, label, assign, milestone, lock, unlock, transfer | R2 | 2 |
| `github_review` | Ревью PR | существующий | R2 | 0 |
| `github_actions` | Actions | workflows, workflow, dispatch, enable, disable, runs, run, rerun, cancel, logs, artifacts, download_artifact, secrets_list, secrets_set, secrets_delete, variables_list, variables_set, variables_delete, caches_list, caches_delete, permissions_get, permissions_set, runners_list | R2–R4 | 2 |
| `github_org` | Организации | list, view, repos, members, invite, remove, teams, team, team_create, team_members_list, team_members_add, team_members_remove, team_repos_list, team_repos_add, team_repos_remove, settings_get, settings_set, rulesets_list, rulesets_view | R2–R4 | 3 |
| `github_extract` | Вынос кода | plan, apply, status, link, cleanup | R3 | 3 |
| `github_api` | Escape hatch | REST/GraphQL | R0/R4 | 3 |
| `github_diff` | Diff (существующий) | — | R0 | 0 |
| `github_release` | Релизы (v2) | list, view, create, edit, delete, upload, download | R2–R3 | v2 |
| `github_search` | Поиск (v2) | code, repos, issues, users | R0 | v2 |

### 4.3 Детализация actions

#### `github_status`

Аргументы: `{ refresh?: boolean, include?: ('auth'|'rate'|'capabilities'|'workspace')[] }`.

Возвращает: `gh`/`git` версии и пути, host/account/scopes, `rate_limit` (core/search/graphql), `capabilities` (`filter_repo`, `lfs`, `subprocess`, `working_directory`, `jobs`), `bindings`, `defaults`, `warnings`.

Это первый вызов в новой сессии. Он же объясняет, чего не хватает: `gh auth login`, `gh auth refresh -s ...`, `git lfs install`, `git filter-repo`.

#### `github_workspace`

| Action | Аргументы | Поведение |
| --- | --- | --- |
| `status` | `path?` | Привязка, ветка, dirty, ahead/behind, remotes |
| `list` | — | Все известные чекауты |
| `bind` | `path?, repo?` | Привязать каталог к repo; определить host/remote |
| `unbind` | `path?` | Убрать привязку |
| `clone` | `repo, path?, branch?, depth?, sparse?, submodules?` | `gh repo clone`/`git clone`; привязать; опционально `set_cwd` |
| `checkout` | `repo, ref?/pr?, branch?, worktree?` | `gh pr checkout` или `git switch`; worktree — через git |
| `sync` | `repo?, path?, mode?` | `fetch` + `pull --ff-only`/`rebase`; никогда force |
| `worktree` | `repo?, path?, name?, from?` | Создать worktree, привязать, `set_cwd` |

Все локальные операции — R1, без GitHub approval, но под file policy. `clone` в `scratchDir` или `workspaceRoot`; путь по умолчанию — `<workspaceRoot>/<owner>/<name>`.

#### `github_repo`

| Action | Ключевые аргументы | Примечания |
| --- | --- | --- |
| `list` | `owner?/org?, visibility?, archived?, topic?, limit?` | По user/org; пагинация |
| `view` | `repo, include?` | metadata, permissions, topics, default branch, protection |
| `create` | `name, owner?/org?, visibility, description?, auto_init?, template?, gitignore?, license?, team_id?` | `POST /user/repos` или `/orgs/{org}/repos`; template → `/generate` |
| `publish` | `source_path, name?, owner?, visibility?, branch?, message?` | Создать repo + `git init` (если нужно) + commit + push; не делать при dirty без `allow_dirty` |
| `edit` | `repo, description?, homepage?, topics?, visibility?, archived?, default_branch?, has_*` | Смена visibility на public — R4 |
| `transfer` | `repo, new_owner, team_ids?, confirm` | R3; preflight прав; post: remotes + checklist |
| `rename` | `repo, new_name, confirm` | R3; redirects; remotes |
| `delete` | `repo, confirm, archive_first?` | R3; `allowDestructive`; предложить archive |
| `archive`/`unarchive` | `repo` | R2 |
| `topics` | `repo, topics[]` | `PUT /topics` |
| `access_list` | `repo` | Collaborators/teams |
| `access_add` | `repo, user?/team?, permission` | R2/R4 |
| `access_remove` | `repo, user?/team?, confirm` | R4 |
| `access_set` | `repo, user?/team?, permission` | R4; изменение существующего доступа |

#### `github_file`

| Action | Ключевые аргументы | Примечания |
| --- | --- | --- |
| `read` | `repo, ref?/pr?, path?/paths?, start_line?, end_line?` | Совместим с `github_read` |
| `list` | `repo, ref?, path?, recursive?` | Каталог/дерево |
| `tree` | `repo, ref?, path?, recursive?, max_entries?` | Явное дерево |
| `stat` | `repo, ref?, path` | size, sha, type, lines |
| `write` | `repo, path, content, message, branch?, sha?, encoding?, mode?` | Один commit; `sha` — optimistic concurrency |
| `delete` | `repo, path, message, branch?, sha?` | Contents API DELETE; для batch — tree `sha: null` |
| `move` | `repo, from, to, message, branch?, overwrite?` | Blob + новый tree + commit |
| `copy` | `repo, from, to, message, branch?, overwrite?` | То же без удаления |
| `commit` | `repo, branch?, message, changes[], base_sha?` | Атомарный multi-file через Git Data API |
| `download` | `repo, ref?, path, dest?, max_bytes?` | В файл workspace, не в контекст |
| `upload` | `repo, path, source, message, branch?, overwrite?` | Из workspace; лимит; LFS не поддерживается |

**Механика write.** Один файл — Contents API (`PUT`/`DELETE`) с `sha`. Несколько файлов/перемещение/режим — Git Data API: ref → base tree → blobs → tree → commit → `PATCH ref` с `force:false`. Это даёт один атомарный коммит и корректные `100644`/`100755`/symlink. Если ref сдвинулся — `conflict`, повтор только при `on_conflict: 'retry'` и отсутствии пересечений.

#### `github_ref`

`list`, `view`, `create`, `delete`, `protect`, `unprotect`, `rename`, `compare`.

Защита: `protect` принимает `required_reviews`, `required_checks`, `enforce_admins`, `restrictions`, `require_code_owner_reviews`. `delete` защищённой/default ветки — R3 + confirm. `compare` — это уже существующий diff-механизм.

#### `github_pr`

`view` — текущий `github_pr` (description/files/comments/commits/checks), `action` по умолчанию `view`, если передан `pr`.

| Action | Аргументы | Примечания |
| --- | --- | --- |
| `list` | `repo?, state?, author?, label?, base?, head?, review_requested?, draft?, limit?` | Списки |
| `create` | `repo, title, head, base?, body?, draft?` | Алиас `github_pr_create` |
| `update` | `repo, pr, title?, body?, base?` | R2 |
| `merge` | `repo, pr, method?, commit_title?, commit_message?, delete_branch?, sha?` | R3; `sha` = head для гонки; checks/reviews preflight |
| `close`/`reopen` | `repo, pr` | R2 |
| `ready`/`draft` | `repo, pr` | R2 |
| `comment` | `repo, pr, body` | R2 |
| `reply` | `repo, pr, comment_id, body` | REST replies |
| `resolve`/`unresolve` | `repo, pr, thread_id?` | GraphQL review threads |
| `label` | `repo, pr, add?/remove?/set?` | R2 |
| `reviewers` | `repo, pr, add_users?, add_teams?, remove_users?, remove_teams?` | R2 |
| `update_branch` | `repo, pr` | `PUT /update-branch` |
| `files`/`commits`/`checks` | `repo, pr` | Read |

#### `github_issue`

`view`, `list`, `create`, `update`, `close`, `reopen`, `comment`, `label`, `assign`, `milestone`, `lock`, `unlock`, `transfer`.

`github_issue_create` — алиас `create`. `update` использует `PATCH /issues/{n}`; `state_reason` — `completed`/`not_planned`; `transfer` — `POST /issues/{n}/transfer`.

#### `github_actions`

| Action | Аргументы | Примечания |
| --- | --- | --- |
| `workflows` | `repo` | Список workflow |
| `workflow` | `repo, workflow` | id/имя/файл |
| `dispatch` | `repo, workflow, ref, inputs?, wait?` | `POST /dispatches`; `wait` — job/poll |
| `enable`/`disable` | `repo, workflow` | R2 |
| `runs` | `repo, workflow?, branch?, status?, event?, actor?, limit?` | Список |
| `run` | `repo, run_id, include_jobs?` | Статус, jobs, steps |
| `rerun` | `repo, run_id, failed_only?` | `POST /rerun`/`rerun-failed-jobs` |
| `cancel` | `repo, run_id` | R2 |
| `logs` | `repo, run_id, job_id?, mode?, tail?` | `tail` — в контекст; `download` — в файл |
| `artifacts` | `repo, run_id?` | Список |
| `download_artifact` | `repo, artifact_id?/run_id?, name?, dest?` | `gh run download`; в файл |
| `secrets_list` | `repo, scope?, environment?, org?` | R0/R4; только имена/даты |
| `secrets_set` | `repo, name, from_file, scope?, environment?, org?` | R4; значение читается из файла и уходит в stdin |
| `secrets_delete` | `repo, name, scope?, environment?, org?` | R4 |
| `variables_list` | `repo, scope?, environment?, org?` | R0/R4 |
| `variables_set` | `repo, name, value?, from_file?, scope?, environment?, org?` | R2/R4; значения переменных не секретны |
| `variables_delete` | `repo, name, scope?, environment?, org?` | R2/R4 |
| `caches_list` | `repo` | R0 |
| `caches_delete` | `repo, key?/id?, confirm?` | R2 |
| `permissions_get` | `repo` | R0 |
| `permissions_set` | `repo, enabled?, allowed_actions?, default_workflow_permissions?` | R4 |
| `runners_list` | `repo?/org?` | R0; registration tokens — v2, по умолчанию нет |

**Secrets.** `gh secret set NAME` читает значение из stdin; `gh variable set NAME` — аналогично. Значение **не передаётся аргументом tool'а**: только `from_file` (путь внутри workspace) или `from_env` (имя переменной окружения). Это важно, потому что аргументы tool-вызова попадают в историю сессии. `list` — только имена/`updated_at`. `scope` — `repo`/`org`/`environment`; для org нужен `admin:org`.

**Логи.** `gh run view --log` может быть огромным. `tail` берёт последние N строк; `download` пишет полный лог в `scratchDir/logs/<run>.txt` через spill/стрим и возвращает путь/размер. В контекст — только tail и ссылка.

#### `github_org`

| Action | Аргументы | Примечания |
| --- | --- | --- |
| `list` | — | `GET /user/orgs` |
| `view` | `org` | metadata, plan, permissions |
| `repos` | `org, type?, sort?, limit?` | Список |
| `members` | `org, role?, limit?` | Список |
| `invite` | `org, login, role?` | `POST /invitations`; R4 |
| `remove` | `org, login, confirm` | R4; confirm = login |
| `teams` | `org` | Список |
| `team` | `org, team_slug` | Детали, members |
| `team_create` | `org, name, description?, privacy?, parent_team_id?` | R4 |
| `team_members_list` | `org, team_slug` | R0/R4 |
| `team_members_add` | `org, team_slug, login, role?` | R4 |
| `team_members_remove` | `org, team_slug, login, confirm` | R4 |
| `team_repos_list` | `org, team_slug` | R0/R4 |
| `team_repos_add` | `org, team_slug, repo, permission` | R4 |
| `team_repos_remove` | `org, team_slug, repo, confirm` | R4 |
| `settings_get` | `org` | R0/R4 |
| `settings_set` | `org, ...` | R4; только whitelisted поля |
| `rulesets_list` | `org` | v2 |
| `rulesets_view` | `org, ruleset_id` | v2 |

Создание организации — вручную (API не поддерживает); `github_org` работает с существующей.

#### `github_extract`

| Action | Аргументы | Примечания |
| --- | --- | --- |
| `plan` | `source, destination {owner,name,visibility?,create?}, history?, paths?, link?, remove_from_source?, include_tags?, lfs?, branch?` | Считает статистику, стратегию, риски; ничего не пишет; `create:false` — перенос в существующий repo |
| `apply` | `plan_id` или те же аргументы + `apply: true, confirm` | R3; создаёт repo, push, опционально link/PR |
| `status` | `plan_id?` | Шаги, прогресс, ошибки |
| `link` | `source_repo, path, target_repo, mode?, ref?, squash?` | submodule/subtree + PR |
| `cleanup` | `plan_id` | Удалить временные каталоги; опционально неудачный destination |

#### `github_api`

`{ method?, path?, query?, body?, accept?, paginate?, max_pages?, graphql?, variables?, select?, allow_write?, confirm? }`.

- По умолчанию только GET/GraphQL query.
- Write — `allow_write: true` + `allowGenericApi: 'write'` + approval.
- `DELETE` — R4 + confirm.
- Path только относительный (`/repos/...`), без host; host — из сессии/конфига.
- Рендер: JSON с ограничением; `data` можно спроецировать через `select` (простой JSON pointer), чтобы не тащить гигантские ответы.

### 4.4 Совместимость и алиасы

| Старое | Новое | Поведение |
| --- | --- | --- |
| `github_read` | `github_file action=read` | Тот же результат; tool остаётся зарегистрированным |
| `github_pr` | `github_pr action=view` | `action` опционален; старые args работают |
| `github_pr_create` | `github_pr action=create` | Тот же approval/результат |
| `github_issue_create` | `github_issue action=create` | То же |
| `github_diff` | без изменений | Остаётся отдельным read-tool |
| `github_review` | без изменений | Остаётся отдельным write-tool |
| `github_status` | расширенный output | Новые поля additive |

**Депрекация:** алиасы живут до 1.0; в 1.0 — предупреждение в описании, в 2.0 — удаление (если решим).

### 4.5 Соглашения по аргументам

- `repo` — `owner/name`, URL или пусто (сессия/дефолт).
- `action` — единственный дискриминатор операции; вложенных `action` нет.
- `ref` — branch/tag/SHA; `pr` — номер/URL; взаимоисключающие.
- `path` — repo-relative, `/`, без `..`, без absolute.
- `branch` — целевая ветка; для read по умолчанию default branch, для write — default branch, если не указано иное; не угадываем текущую ветку.
- `dry_run` — не писать; `apply` — подтвердить R3/R4; `confirm` — точная строка.
- `limit` — 1..100; `cursor` — из предыдущего ответа.
- `include` — секции, чтобы не тащить всё.
- `via` — `api` (по умолчанию) или `local` для file write.
- `on_conflict` — `fail` (по умолчанию) / `retry`.
- `from_file`/`from_env` — единственный способ передать секрет; `value` для секретов запрещён.

### 4.6 Примеры

Создать репозиторий в организации:

```json
{
  "action": "create",
  "org": "my-org",
  "name": "billing-api",
  "visibility": "private",
  "description": "Billing API",
  "auto_init": true,
  "topics": ["api", "billing"]
}
```

Перенести репозиторий:

```json
{
  "action": "transfer",
  "repo": "Unchpokable/dsh-github-cli",
  "new_owner": "my-org",
  "confirm": "Unchpokable/dsh-github-cli -> my-org"
}
```

Вынести код:

```json
{
  "action": "plan",
  "source": { "repo": "my-org/monorepo", "ref": "main", "path": "packages/api" },
  "destination": { "owner": "my-org", "name": "api" },
  "history": "preserve",
  "link": "submodule",
  "remove_from_source": false
}
```

Записать файл:

```json
{
  "action": "write",
  "repo": "my-org/api",
  "path": "src/config.ts",
  "content": "export const port = 8080;\n",
  "message": "Add port config",
  "branch": "feature/config",
  "sha": "0f1e2d..."
}
```

Запустить workflow:

```json
{
  "action": "dispatch",
  "repo": "my-org/api",
  "workflow": "deploy.yml",
  "ref": "main",
  "inputs": { "environment": "staging" },
  "wait": true
}
```

---

## 5. Флагманские сценарии

### 5.1 Создание репозитория

**Режимы:**

1. **Пустой** — `auto_init: false`, затем clone/init/push.
2. **С README** — `auto_init: true`, сразу есть default branch.
3. **Из шаблона** — `template: "owner/template"`, `POST /generate`.
4. **Публикация локального кода** — `publish`: создать пустой repo, `git init` при необходимости, `git add`, commit, push, set default branch.

**Preflight:**

- `owner`/`org`: существует, есть право создавать repos, `allowedOrgs`/`deniedOrgs`.
- Имя: GitHub naming rules, не занято, не reserved.
- Visibility: `private` по умолчанию; `public` — предупреждение о секретах/лицензии.
- Template: существует и является template.
- Org: `team_id` (если нужен), custom properties (v2).
- Локальный источник: git repo (или пустой каталог), clean (или `allow_dirty`), нет конфликтующего `.git`, remote либо отсутствует, либо указывает на этот же repo.

**План:** API call, начальный commit, default branch, protection (опционально), clone URL, next steps.

**Apply:** создать → (если publish) init/commit/push → verify `GET /repos/{owner}/{name}` и `GET /branches/{default}` → привязать cwd → вернуть URL.

**Ошибки:** имя занято → `conflict` с предложением; нет прав → `permission` с ролью; push отклонён → `partial` с инструкцией (repo создан, push не прошёл).

### 5.2 Transfer и rename

**Transfer** (`POST /repos/{owner}/{repo}/transfer`):

- Preflight: admin на repo, членство/роль в целевой org, `team_ids` при необходимости, `allowDestructive`, `confirm`.
- План: effects, API call, redirects, список того, что проверить после (Actions secrets/variables/environments, packages, Pages, webhooks, deploy keys, teams, rulesets, forks, stars, traffic). Не утверждать, что всё переносится автоматически — план делает preflight и выдаёт checklist.
- Apply: transfer → `GET /repos/{new_owner}/{repo}` → обновить локальные remotes (`origin`/`upstream`) → проверить default branch/protection → вернуть old/new URL.
- Rollback: обратный transfer возможен только при правах у нового владельца; иначе — manual. `irreversible: false` с оговоркой.

**Rename** (`PATCH /repos/{owner}/{repo}` `{name}`):

- Redirects старых URL; обновить remotes; предупредить о packages/Pages/Actions, если они ссылаются на имя.
- R3 + confirm `owner/old -> owner/new`.

**Отличие от extraction:** transfer меняет владельца целого repo; extraction создаёт новый repo из части кода. Не смешивать в одном action.

### 5.3 Вынос кода в суб-репозиторий (`github_extract`)

#### Термины

- **Extract/split** — создать новый репозиторий из каталога/набора путей текущего.
- **Snapshot** — только текущее содержимое, без истории.
- **History-preserving** — сохранить коммиты, которые трогали путь (хэши меняются).
- **Link** — подключить новый repo обратно: git submodule или git subtree.
- **Move code** — перенести код в существующий repo (не создавая новый): `destination.create: false`.

#### Варианты стратегии

| Стратегия | Когда | Плюсы | Минусы |
| --- | --- | --- | --- |
| `subtree-split` | один каталог, нужна история | быстрее `filter-repo`, не нужен Python | merge-история упрощается; теги не сохраняются |
| `filter-repo` | несколько путей, сложная история, переименования | гибкие `--path`/`--path-rename`, сохраняет больше | нужен `git-filter-repo`; медленнее; хэши меняются |
| `snapshot` | «начать с чистого листа» | быстро, предсказуемо | истории нет; авторство только в одном import-коммите |
| `archive` | нужен только tarball | без git | не создаёт repo |

#### Алгоритм

```text
1. Preflight
   - source repo/ref/path существуют; sha зафиксирован
   - worktree чистый (или allow_dirty + stash)
   - destination name свободен; права в owner/org
   - git version, filter-repo (если нужен), LFS (если нужен)
   - статистика: commits, files, bytes, large files, LFS, submodules, symlinks, case collisions
2. Plan
   - strategy, steps, commands, api calls
   - warnings: commit hashes change, tags not preserved, LFS, submodules
   - confirm: "src:path -> owner/name"
3. Apply (в scratchDir, не в рабочем дереве)
   a. temporary clone/mirror source (--no-local/--no-hardlinks)
   b. subtree split / filter-repo / git archive
   c. create destination repo (auto_init:false, чтобы не было merge)
   d. git init/pull, remote add, push branches/tags
   e. LFS push, если нужно
   f. verify: tree hash tip, commit count, default branch, API state
   g. optional link: submodule/subtree + PR в source
4. Cleanup / rollback
   - temp dirs удалить
   - если destination создан нами и push не удался — удалить только по cleanup_on_failure
   - если PR создан нами и link не удался — закрыть PR
5. Journal
```

#### План (пример)

```json
{
  "operation": "extract.plan",
  "plan": {
    "id": "plan_extract_01",
    "risk": "destructive",
    "summary": "Extract packages/api from my-org/monorepo into my-org/api",
    "strategy": "subtree-split",
    "source": { "repo": "my-org/monorepo", "ref": "main", "sha": "abc123", "path": "packages/api" },
    "destination": { "owner": "my-org", "name": "api", "visibility": "private" },
    "stats": { "commits": 142, "files": 87, "bytes": 5242880, "large_files": [], "lfs": false, "submodules": [] },
    "effects": [
      "Create my-org/api",
      "Push 142 rewritten commits to main",
      "Optionally add my-org/api as a submodule at packages/api and open a PR"
    ],
    "warnings": [
      "Commit hashes will change",
      "Tags are not preserved by subtree split",
      "Source history is not rewritten"
    ],
    "confirm": "my-org/monorepo:packages/api -> my-org/api",
    "irreversible": false
  }
}
```

#### Обратная привязка

- **Submodule:** `git submodule add <dest-url> <path>` после удаления старого пути; commit + PR. Плюс: явная граница репозиториев. Минус: `.gitmodules`, clone с `--recurse-submodules`, PR удаляет много файлов.
- **Subtree:** `git subtree add --prefix <path> <dest-url> <ref> --squash` (или без squash). Плюс: код остаётся в дереве. Минус: история/размер, `git subtree pull` в будущем.
- **Без link:** source не трогаем; пользователь сам решает, удалять ли каталог.

#### Безопасность extraction

- Никогда не запускать `filter-repo` в рабочем дереве пользователя: только свежий клон в `scratchDir`.
- Никогда не force-push в source.
- Не удалять source-путь без `remove_from_source: true` + отдельного approval/PR.
- Проверять path traversal, symlink-escape, case collisions, `.git` внутри пути.
- Large files > 100 MB — abort с предложением LFS/исключить; иначе push всё равно отвергнет GitHub.
- LFS: `git lfs fetch --all` до, `git lfs push --all` после; если LFS не установлен — abort.
- Submodules: сохранить `.gitmodules`, переписать URL при необходимости; warn, что история submodule не переносится.
- Secrets: предупредить, что push protection GitHub может отклонить; опционально `gitleaks`/`trufflehog`, если установлены.

#### Производительность

- `filter-repo` на больших репозиториях — минуты; запускать как job, progress из stderr, лимит вывода.
- `git subtree split` кэширует split-точки; не использовать `--rejoin` в source (портит историю).
- Проверять свободное место; чистить scratch после успеха/ошибки.
- Для повторного plan использовать сохранённый sha; если source сдвинулся — пересчитать.

### 5.4 Организации

- **Создание org** — вручную; API не позволяет. Плагин проверяет и говорит об этом.
- **Участники:** list/invite/remove; роли `admin`/`member`; `admin:org`.
- **Команды:** create, members, repos + permission; вложенность `parent_team_id`.
- **Доступ к repo:** team → repo permission (`pull`/`triage`/`push`/`maintain`/`admin`).
- **Настройки org:** только whitelisted поля; R4; план показывает diff.
- **Rulesets:** v2; list/view в v1.
- **Аудит:** v2 (enterprise audit log).

**Preflight:** `GET /user/memberships/orgs/{org}` → role; `GET /orgs/{org}/memberships/{user}`; для team — `GET /orgs/{org}/teams/{team}/memberships/{user}`. Ошибка 403 → hint про `admin:org` и SSO.

### 5.5 Actions

- **Dispatch:** `POST /actions/workflows/{id}/dispatches` `{ref, inputs}`; вернуть `run_id`; `wait` — poll `GET /runs/{id}` с backoff, максимум `longTimeoutMs`; в фоне — job.
- **Runs:** list/view; jobs/steps; conclusion mapping.
- **Logs:** tail или download; ANSI strip; redaction; не тащить zip в контекст.
- **Artifacts:** list + download в workspace; `gh run download`; вернуть путь/размер.
- **Secrets/variables:** stdin, list names only; org/environment scopes; R4.
- **Caches:** list/delete; R2.
- **Permissions:** get/set; R4.
- **Runners:** list only; registration tokens — v2, off by default.

### 5.6 Файлы и коммиты

**Чтение** — существующий `read.js`; добавляем `stat`, `download`.

**Запись (API):**

- один файл: Contents API, `sha` для overwrite; branch;
- multi-file/move/copy: Git Data API, один commit;
- protected branch: запрет по умолчанию;
- binary: base64; `encoding: 'base64'` в аргументах;
- mode: `100644`/`100755`/`120000`; смена mode — только Git Data API;
- conflict: `sha` mismatch → `conflict` с текущим sha;
- dry-run: показать список изменений и diff для текстовых файлов;
- verify: `GET /commits/{sha}` + `GET /contents/{path}?ref=...`.

**Запись (local):** `via: 'local'` — если есть привязка и чистый worktree; писать через `ctx.fs`, commit/push через git; hooks/подпись сохраняются; по умолчанию `--no-verify` для автоматических коммитов, `run_hooks: true` — опционально. Не смешивать с чужими изменениями: проверять `git status --porcelain`, отказ при dirty без `allow_dirty`.

**Почему API по умолчанию:** не трогает рабочее дерево, атомарно, не требует credential helper; минус — нет hooks/подписи/LFS. Выбор `via` фиксируется в плане.

### 5.7 PR, review, merge

- **Создание:** текущий `github_pr_create`; head уже на remote; base default.
- **Review:** текущий `github_review`; один запрос; inline lines из diff.
- **Merge:** preflight `mergeable`, `mergeable_state`, checks, reviews; `PUT /merge` с `sha` head; `delete_branch` только если не default/protected; R3.
- **Threads:** GraphQL `reviewThreads`, `resolveReviewThread`/`unresolveReviewThread`; reply через REST.
- **Checks:** существующий `listChecks`; добавить ожидание/логи.

### 5.8 «Одна сессия»

1. `github_status` — понять host/account/scopes/capabilities/привязки.
2. Первый вызов в repo: `repo` из cwd/remote или `defaultRepo`.
3. `github_workspace clone` — привязать и войти в каталог.
4. Дальше `repo` можно не передавать; `github_status` показывает активную привязку.
5. `github_workspace checkout pr=...` / `worktree` — переключение без потери контекста.
6. `github_workspace sync` — безопасный fetch/pull.
7. Журнал: `github_status include=workspace` или `github_workspace status` — что делали.

---

## 6. Модель данных

### 6.1 Сущности

```ts
type RepoRef = { host: string; owner: string; name: string };

type RepoBinding = {
  path: string;            // absolute
  repo: RepoRef;
  remote: string;          // origin/upstream
  branch: string | null;
  dirty: boolean;
};

type Capabilities = {
  gh: { path: string; version: string };
  git: { path: string; version: string };
  filterRepo: boolean;
  lfs: boolean;
  subprocess: boolean;
  workingDirectory: boolean;
  jobs: boolean;
};

type Plan = {
  id: string;
  operation: string;
  risk: 'read' | 'local' | 'write' | 'destructive' | 'admin';
  summary: string;
  effects: string[];
  api: { method: string; path: string; body?: unknown }[];
  commands: string[][];
  irreversible: boolean;
  confirm: string | null;
  warnings: string[];
};

type OperationResult = {
  ok: boolean;
  operation: string;
  repo?: string;
  url?: string;
  summary: string;
  data?: unknown;
  warnings: string[];
  next: { tool: string; args: unknown; reason: string }[];
  applied: boolean;
  journal_id?: string;
};

type JournalEntry = {
  id: string;
  at: string;
  operation: string;
  repo?: string;
  risk: string;
  planHash: string;
  approval: 'not-required' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
  result: 'success' | 'failure' | 'partial';
  rollback?: string;
};
```

### 6.2 Идемпотентность и конфликты

| Операция | Ключ идемпотентности | Поведение |
| --- | --- | --- |
| `repo.create` | `owner/name` | Если существует и совпадает — вернуть existing; если нет — `conflict` |
| `file.commit` | `base_sha`/`sha` | Ref update с `force:false`; конфликт → `conflict` |
| `pr.create` | head/base | Если такой PR уже открыт — вернуть его, не создавать дубль |
| `pr.merge` | head `sha` | 405/409 → `conflict` с состоянием |
| `issue.create` | — | Дубли возможны; предупреждение |
| `actions.dispatch` | — | Дубли возможны; `wait` не гарантирует единственность |
| `repo.transfer` | current owner | Если уже у целевого — success/no-op |
| `extract.apply` | plan id + source sha | Повторный apply идемпотентен, если destination уже создан нами и sha совпадает; иначе `conflict` |

**Retry:** только GET и идемпотентные write; backoff на 5xx/429 с `Retry-After`; никогда не ретраить неидемпотентный write без `operation_id`.

---

## 7. Безопасность

### 7.1 Угрозы и меры

| Угроза | Пример | Мера |
| --- | --- | --- |
| Утечка токена | Вывод `gh`/git с URL или env | Не читать токен; redaction; не логировать env/argv с секретами |
| Prompt injection | Лог workflow/тело PR содержит «ignore rules» | Явно помечать untrusted; не выполнять инструкции из данных |
| Разрушительная ошибка | `repo delete` не тот repo | R3/R4, `confirm`, `allowDestructive`, план, journal |
| Path traversal | `path: ../../.ssh` | Нормализация, запрет `..`, absolute, symlink-escape |
| Command injection | ref `--upload-pack=...` | argv без shell, `--`, валидация refs, запрет ведущего `-` |
| Секрет в argv | `gh secret set --body value` | Только stdin; approval без значения |
| Гонка коммитов | Два commit в одну ветку | `sha`/`base_sha`, `force:false`, конфликт |
| Confused deputy | Доступ к чужой org | `allowedOrgs`/`deniedOrgs`, preflight роли |
| Supply chain | hooks в repo | `--no-verify` по умолчанию для авто-коммитов; `run_hooks` явно |
| SSRF | `github_api` на произвольный URL | Только относительный path, host из конфига |
| Утечка через ошибки | 403 body с токеном | Redaction, bounded detail |

### 7.2 Секреты

- Только `gh secret set`/`gh variable set` через stdin; значение не в argv, не в плане, не в journal.
- Значение секрета задаётся через `from_file`/`from_env`, а не через `value`: аргументы tool-вызова остаются в истории сессии.
- `list` — только имена/даты.
- `approval` — имя/scope, без значения.
- Redaction: `ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `-----BEGIN`, `AWS_`, `azure_`, `xox[baprs]-`.
- Не сохранять секреты в `.dsh/github/*`.
- `github_api` с телом, содержащим секрет, — предупреждение; лучше не использовать для секретов.

### 7.3 Approval UX

Промпт должен содержать:

1. Операцию и риск.
2. Repo/org и целевой объект.
3. Что изменится (effects).
4. Необратимость и rollback.
5. `confirm`-строку, которую надо передать.
6. Предупреждения (secrets/packages/Pages/Actions).

Пример:

```text
GitHub destructive write: repo.transfer

Repository: Unchpokable/dsh-github-cli
New owner:  my-org
Effects: owner changes; old URLs redirect; local remotes must be updated.
Check after: Actions secrets/variables, packages, Pages, webhooks, team access.
Reversible: only with admin rights on both sides.
Confirm: Unchpokable/dsh-github-cli -> my-org
```

### 7.4 Защита от разрушительных действий

- `allowDestructive: false` по умолчанию; `delete`/`transfer`/`force-push` недоступны, пока не включено.
- `allowAdmin: false` по умолчанию; org settings/member removal/secrets/runner tokens — только после явного включения.
- `dryRunDestructive: true`: R3/R4 без `apply` возвращают план.
- Protected/default branch: прямой commit/push запрещён; `allow_protected_branch` + approval.
- `repo.delete`: сначала archive; `confirm` = `owner/name`; рекомендуется экспортировать/проверить данные перед удалением.
- Никаких «умных» массовых удалений: только поштучно, с планом.
- Journal + `next` с rollback-подсказками.

---

## 8. Тестирование

### 8.1 Матрица

| Уровень | Что проверяет | Сеть | Где |
| --- | --- | --- | --- |
| Unit | validate/plan/render/error mapping | нет | `node --test`, sandbox |
| Contract | argv к `gh`/`git`, JSON payload, pagination | нет (fake) | `node --test` |
| Local git | clone/commit/branch/worktree/extract | нет (temp repos) | обычный shell |
| Live read | auth/read/PR/diff/review dry-run | да | обычный shell |
| Live write | create repo/file/PR/actions/org/extract | да, gated | отдельный test org |
| Safety | approval reject/cancel, confirm, path traversal, secret redaction | нет | unit/contract |
| Performance | большие деревья/diff/логи, paging | да/нет | отдельно |

### 8.2 Как тестировать без реального GitHub

- **Dependency injection:** `createGhTransport({ run })`, `createGitRunner({ run })`; unit tests передают fake `run`, который возвращает фикстуры и записывает argv.
- **Fake executable:** `test/fixtures/fake-gh.mjs` + `.cmd`-обёртка для Windows; `ghPath` указывает на неё. Проверяет stdin/argv, отдаёт JSON.
- **Local git:** реальный `git` в `mkdtemp`; создаём коммиты, ветки, теги, merge; проверяем `rev-list`, `ls-tree`, `cat-file`.
- **Extraction:** destination — локальный bare repo (`file://`), без GitHub; проверяем tree hash tip, commit count, отсутствие лишних путей, LFS/submodule сценарии (skip, если нет).
- **Live write:** `GITHUB_TEST_ORG` + `GITHUB_TEST_REPO`; создаём `dsh-test-<uuid>`, в конце удаляем; при отсутствии env — skip. Никаких реальных repo пользователя.
- **Approval:** stub `ctx.approval.request` → `allowed-once`/`rejected`/`cancelled`/`unavailable`; проверяем, что write не вызван.
- **Sandbox:** unit-тесты не требуют `ctx.subprocess`; local-git тесты запускаются вне DSH (в DSH sandbox дочерние процессы с pipe могут дать EPERM, как отмечено в README).

### 8.3 Обязательные тесты

- Все старые smoke-тесты проходят без изменений.
- `github_status` показывает capabilities и bindings.
- `repo.create` user/org/template; `publish` с чистым и грязным worktree.
- `file.write` create/update/delete/move/commit; conflict по `sha`; protected branch.
- `pr.merge` с checks/reviews; `sha` mismatch; delete branch.
- `actions.dispatch` + `wait`; logs tail/download; secret set (fake) без утечки.
- `org.team_repos_add` permission; member remove confirm.
- `extract` single/multi-path, preserve/snapshot, link submodule/subtree, failure cleanup.
- `github_api` read/write gate; path validation.
- Redaction: токены в stderr не попадают в результат.
- Path safety: `..`, absolute, symlink, case collision.
- Approval: reject/cancel/unavailable → нет write.

### 8.4 CI

- Matrix: Windows + Linux (macOS — по возможности).
- `node --test` для unit/contract; local git — с установленным git.
- Live — отдельный workflow/manual, с секретом `GH_TOKEN` тестового аккаунта; не на каждом PR.
- Линтер не обязателен (проект без сборки), но `node --check` для файлов.

---

## 9. Совместимость и миграция

- **Semver:** 0.2.0 — foundation + repo/file/workspace; 0.3.0 — PR/issue/actions; 0.4.0 — org/extract; 1.0.0 — стабильные схемы, алиасы с deprecation.
- **Старые инструменты:** не удалять до 1.0; сохранять имена, аргументы, форму результата.
- **Конфиг:** старые ключи работают; новые опциональны; неизвестные ключи — предупреждение, не ошибка (для forward-compat).
- **Ошибки:** сохранить текущие тексты для 401/403/404/rate limit; новые коды добавить в `data.error.code`.
- **Локаль:** meta обновить; tool descriptions — английский (модель), README — RU/EN.
- **Пакет:** `files` дополнить `lib/`; `exports` не менять; `dsh.bundle.patch` не менять.
- **Cordis row:** id `github-cli` остаётся; config расширяется.
- **Зависимости:** `@deepseek-ai/schemastery` — только если делаем `Config`; иначе zero-dep.
- **Откат:** новая версия не мигрирует данные; journal/кэш можно удалить; старые tool-вызовы работают.

---

## 10. Дорожная карта

### Phase 0 — Foundation (S/M)

- Разнести `gh.js` на `lib/gh/*`; добавить headers/pagination/GraphQL.
- `GitHubSession`, `capabilities`, `risk`, `result`, `errors`, `journal`.
- `Config` v2 с обратной совместимостью (или manual).
- Обёртки `runOperation`, approval/plan.
- Тесты: старые smoke + unit на parse/validate/render.

**Выход:** старые 7 инструментов работают; новые внутренние слои готовы; `github_status` расширен.

### Phase 1 — Repos, files, workspace (L)

- `github_repo`: list/view/create/edit/archive/topics/access; delete/transfer/rename добавлены в Phase 3.
- `github_file`: read/write/delete/move/copy/commit/download/upload.
- `github_workspace`: bind/list/clone/checkout/sync/worktree/status.
- Локальный git runner через `ctx.subprocess` + sandbox.
- Protected branch guard, dry-run, conflict handling.
- Тесты: local git + contract + live read.

**Выход:** можно создать repo, склонировать, поправить файлы, сделать commit/push, привязать cwd.

### Phase 2 — PR, issues, actions (L)

- `github_pr`: list/create/update/merge/close/reopen/comment/reply/resolve/label/reviewers/update_branch.
- `github_issue`: полный набор.
- `github_actions`: workflows/runs/dispatch/rerun/cancel/logs/artifacts, `secrets_*`, `variables_*`, `caches_*`, `permissions_*`.
- Jobs для длинных операций; bounded logs/artifacts.
- Тесты: merge, dispatch, secret redaction.

**Выход:** полный цикл PR + CI из одной сессии.

### Phase 3 — Orgs, transfer, extraction, API (L)

- `github_org`: members/teams/access/settings (rulesets — list/view).
- `github_repo`: transfer/rename/delete.
- `github_extract`: plan/apply/status/link/cleanup.
- `github_api`: REST/GraphQL escape hatch.
- `github_release`/`github_search` — опционально.
- Тесты: extract matrix, transfer, org roles.

**Выход:** «создать → перенести → вынести код → подключить обратно» работает end-to-end.

### Phase 4 — Hardening / 1.0 (M)

- README/примеры/локаль; `Config` UI; опциональные `/gh` команды.
- Performance: cache, pagination, concurrency, rate-limit backoff.
- Deprecation aliases; semver 1.0.
- Full test matrix, security review.

**Выход:** стабильный 1.0, документация, обратная совместимость.

### Критерии приёмки по вехам

| Веха | Критерии |
| --- | --- |
| M0 | Старые тесты зелёные; `github_status` показывает capabilities/bindings; approval/plan unit-тесты |
| M1 | Создать repo (user/org/template), склонировать, записать/переместить файл, commit/push; protected branch отказ |
| M2 | Создать PR, review, merge с checks; dispatch workflow + logs; secret set без утечки |
| M3 | Transfer repo; org team access; extract с историей + submodule; cleanup при сбое |
| M4 | 1.0: документация, все тесты, алиасы, отсутствие регрессий |

---

## 11. Риски

| Риск | Вероятность | Влияние | Митигация |
| --- | --- | --- | --- |
| `git-filter-repo` не установлен / нет Python | Средняя | Высокое | Preflight; fallback `subtree-split`/`snapshot`; понятная ошибка |
| Огромный repo / долгий split | Средняя | Высокое | Jobs, progress, `longTimeoutMs`, disk check, abort |
| LFS/submodules ломают extraction | Средняя | Высокое | Preflight, fetch/push LFS, warn/abort, тесты |
| Windows path/CRLF/case | Высокая | Среднее | Нормализация, case-collision, тесты на Windows |
| Process tree не убивается | Средняя | Среднее | `ctx.subprocess` managed range; grace/terminate |
| Нет прав/scopes | Высокая | Среднее | Preflight, actionable hint, `gh auth refresh` |
| Секреты в логах/ошибках | Средняя | Высокое | stdin, redaction, тесты, никогда не логировать env |
| Случайное destructive | Средняя | Критическое | R3/R4, confirm, allow-флаги, plan, journal |
| Rate limit / secondary limit | Средняя | Среднее | Cache, page caps, backoff, `github_status` |
| Схема инструментов разрослась | Средняя | Среднее | Домены + action, лимит описаний, legacy aliases |
| DSH API drift | Низкая | Высокое | Pin peer versions, integration tests, optional services |
| `gh` version drift | Средняя | Среднее | Feature probe, minimum version, fallback REST |
| Approval fatigue | Средняя | Среднее | Risk tiers, dry-run, batch? (осторожно), config |
| Тесты пишут в реальные repo | Низкая | Критическое | Gated test org, cleanup, никаких реальных repo |
| Перенос repo ломает integrations | Средняя | Высокое | Post-transfer checklist, verify, не обещать автоматику |

---

## 12. Подтверждённые решения и статус реализации

### 12.1 Решения (подтверждены)

1. **Scope:** делаем все фазы 0–4, без остановки на M1.
2. **Зависимости:** `@deepseek-ai/schemastery` разрешена (официальный пакет DeepSeek); `@deepseek-ai/cosmokit` добавлен прямым dependency, потому что pnpm-раскладка не давала schemastery разрешить его транзитивно.
3. **Destructive:** разрешаем transfer/delete и аналогичные операции, но только при `allowDestructive: true` + approval + `apply: true` + совпадающий `confirm`. По умолчанию выключено.
4. **Extraction:** `preserve` по умолчанию; `snapshot` — только явным `history: "snapshot"`.
5. **Hosts:** github.com в v1. GHES не входит в v1; модель host сохранена, чтобы не закрывать дверь.
6. **Org creation:** остаётся ручным (REST API не создаёт организации).
7. **Интерфейс:** tool-first; `/gh` команды — опционально в phase 4.
8. **Secrets:** set/list поддержать; значения только `from_file`/`from_env` → stdin; runner tokens — нет.
9. **File write:** API по умолчанию, `via: "local"` — опция.
10. **Один аккаунт на host**; multi-account — позже.

### 12.2 Phase 0 — реализовано в 0.2.0

- `lib/config.js` — `Config` (Schemastery), defaults, nested merge, old-key compatibility.
- `lib/errors.js` — `GitHubError`, HTTP/REST taxonomy, redaction, `Retry-After`.
- `lib/result.js` — envelopes, plan/result helpers, bounded text.
- `lib/risk.js` — R0–R4, approval policy, `allowDestructive`/`allowAdmin`, `apply`/`confirm` gates.
- `lib/repo.js` — `owner/name`, URL, SSH/HTTPS remote, GHES host parsing, PR references.
- `lib/gh/exec.js` — original `run`/`resolveGh`/`ghCommand` plus non-throwing `ghRun`.
- `lib/gh/rest.js` — `gh api --include` status/headers/body, rate-limit parsing, paging.
- `lib/gh/graphql.js` — JSON-input GraphQL.
- `lib/gh/auth.js` — multi-host `gh auth status`, scopes, no token retention.
- `lib/capabilities.js` — `gh`, `git`, `git-filter-repo`, `git-lfs`, DSH services.
- `lib/session.js` — cwd → repo binding, defaults, TTL cache, journal.
- `lib/ops/registry.js` — `defineOperation`/`runOperation` pipeline with approval and plan.
- `github_status` now reports capabilities and the cwd binding; `repo` is inferred from the binding when omitted.
- `test/unit/*.test.mjs` — 74 tests; run with `pnpm test` (`--test-isolation=none`, so it works in the DSH sandbox).
- The live smoke test still requires a normal terminal; the DSH sandbox blocks piped child processes with `spawn EPERM`.

### 12.3 Phase 1 — частично реализовано

Реализовано:
- `github_workspace`: bind/list/status/clone/checkout/sync/worktree через `ctx.subprocess` + sandbox.
- `github_repo`: list/view/create/edit/archive/unarchive/topics, access_list/add/set/remove.
- `github_file`: read/stat/write/delete/move/copy/commit; multi-file commit and move/copy use the Git Data API.
- `github_ref`: list/view/create/delete для веток и лёгких тегов; удаление защищённой/default ветки запрещено.
- `lib/git/exec.js` — sandboxed git runner; `lib/ops/workspace.js`, `repo.js`, `file.js`, `ref.js`; `lib/tools/*`.
- 131 unit-тестов (config, risk, registry, REST, repo/file/ref/PR/issue/actions/org/api/extract/release/search operations, git runner, legacy compatibility).

Осталось до конца Phase 1:
- Интеграционные live-тесты записи на отдельном test org.

### 12.4 Phase 2 — ядро реализовано

- `github_pr` actions: list/update/close/reopen/ready/draft/comment/label/reviewers/update_branch/merge; merge — R3 с confirm и head SHA.
- `github_issue` actions: list/view/create/update/close/reopen/comment/label/assign/milestone/lock/unlock/transfer.
- `github_actions` actions: workflows/workflow/runs/run/dispatch/rerun/rerun_failed/cancel/logs/artifacts/secrets_list/secrets_set/secrets_delete/variables_list/variables_set/variables_delete/caches_list/caches_delete.
- `secrets_set` принимает значение только из `from_file`/`from_env`, передаёт его в `gh secret set` через stdin и требует `allowAdmin` + `apply` + `confirm`.
- 131 unit-тестов.

Осталось до конца Phase 2:
- `download_artifact`, `permissions_*`, `runners_list`.
- Live-write тесты Actions/PR на test org.

### 12.5 Phase 3 — частично реализовано

- `github_repo`: transfer/rename/delete с confirm, обновлением привязок и post-transfer checklist.
- `github_org`: list/view/repos/members/invite/remove/teams/team/team_create/team_members_*/team_repos_*/settings_get/settings_set.
- `github_api`: generic REST/GraphQL, read-only по умолчанию, write/DELETE с policy-гейтами.
- `github_extract`: plan/apply/link/cleanup/status; single-path `subtree-split`, multi-path `filter-repo`, snapshot, scratch clone, destination create, push, cleanup; `link` заменяет каталог gitlink-ом на новой ветке и открывает PR; LFS-атрибуты детектируются и требуют `git lfs fetch/push`.
- `github_release`: list/view/create/edit/delete/upload/download.
- `github_search`: repositories/issues/code/users.
- 131 unit-тестов.

Осталось:
- Live-write тесты на отдельном test org (среда DSH блокирует piped child processes).
- Финальный тег 1.0 и deprecation-политика алиасов.

---

## Приложение A. Пример Plan/Result для extraction

**Plan:**

```json
{
  "ok": true,
  "operation": "extract.plan",
  "applied": false,
  "plan": {
    "id": "plan_extract_7f3a",
    "risk": "destructive",
    "summary": "Extract packages/api from my-org/monorepo into my-org/api (history preserved)",
    "strategy": "subtree-split",
    "source": { "repo": "my-org/monorepo", "ref": "main", "sha": "a1b2c3d", "path": "packages/api" },
    "destination": { "owner": "my-org", "name": "api", "visibility": "private" },
    "stats": { "commits": 142, "files": 87, "bytes": 5242880, "large_files": [], "lfs": false, "submodules": [] },
    "effects": [
      "Create my-org/api",
      "Push 142 rewritten commits to main",
      "Add my-org/api as a submodule at packages/api and open a PR"
    ],
    "warnings": [
      "Commit hashes will change",
      "Tags are not preserved by subtree split",
      "Source history is not rewritten"
    ],
    "confirm": "my-org/monorepo:packages/api -> my-org/api",
    "irreversible": false
  },
  "next": [
    {
      "tool": "github_extract",
      "args": {
        "action": "apply",
        "source": { "repo": "my-org/monorepo", "ref": "main", "path": "packages/api" },
        "destination": { "owner": "my-org", "name": "api" },
        "history": "preserve",
        "apply": true,
        "confirm": "my-org/monorepo:packages/api -> my-org/api"
      },
      "reason": "apply the extraction plan"
    }
  ]
}
```

**Result:**

```json
{
  "ok": true,
  "operation": "extract.apply",
  "repo": "my-org/api",
  "url": "https://github.com/my-org/api",
  "summary": "Extracted packages/api into my-org/api (142 commits, 87 files)",
  "data": {
    "destination": "my-org/api",
    "default_branch": "main",
    "commits": 142,
    "files": 87,
    "link": { "mode": "submodule", "pr": "https://github.com/my-org/monorepo/pull/123" },
    "cleanup": "scratch removed"
  },
  "warnings": ["Submodule clone requires --recurse-submodules"],
  "next": [
    { "tool": "github_workspace", "args": { "action": "clone", "repo": "my-org/api" }, "reason": "work on the new repository" }
  ],
  "applied": true,
  "journal_id": "op_extract_7f3a"
}
```

## Приложение B. Ссылки и ориентиры

- GitHub REST API: `https://docs.github.com/rest`
- GitHub GraphQL API: `https://docs.github.com/graphql`
- GitHub CLI manual: `https://cli.github.com/manual/`
- `git subtree`: `https://git-scm.com/docs/git-subtree`
- `git-filter-repo`: `https://github.com/newren/git-filter-repo`
- DSH packages, на которые опирается дизайн: `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-user-approval`, `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-experimental-worktree`.

---

## Итог

Плагин уже хорошо делает одну вещь: безопасно читает GitHub и пишет ревью через авторизованный `gh`, не разоряя квоту. Чтобы он стал полноценным control plane, не нужно переписывать всё: нужно добавить **слой операций**, **контекст сессии**, **локальный git** и **доменные инструменты**. Три флагманских сценария — create, transfer, extract — строятся на одном и том же pipeline `plan → approval → apply → verify → journal`, поэтому их можно добавлять постепенно, не ломая существующие инструменты.
