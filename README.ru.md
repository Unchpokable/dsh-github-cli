[English](README.md) · [Русский](README.ru.md)

# dsh-github-cli

DSH-плагин, который читает репозитории и пишет ревью в GitHub через
**авторизованный `gh` CLI**, а не через анонимный REST API. Каждый вызов
расходует квоту аккаунта, под которым выполнен вход: 5000 запросов в час для
обычного токена. Поэтому агент может читать ветки, пулл-реквесты и диффы, не
упираясь в анонимный лимит в 60 запросов в час.

Версия 0.2 добавляет фундамент полноценного управления GitHub: контекст сессии
с привязкой текущего чекаута к репозиторию, проверку возможностей `git`,
`git-filter-repo` и `git-lfs`, общий pipeline plan/approval, типизированную схему
конфигурации и REST/GraphQL-транспорт, который читает заголовки rate limit.
Полный проект — в [docs/github-plugin-2.0-design.md](docs/github-plugin-2.0-design.md).

Плагин регистрирует на хосте восемнадцать инструментов:

| Инструмент | Что делает |
| --- | --- |
| `github_status` | Показывает версии `gh` и `git`, аккаунт, остаток квоты API, доступность `git-filter-repo` и `git-lfs`, сервисы DSH и репозиторий, привязанный к текущему каталогу. |
| `github_workspace` | Привязывает чекаут к репозиторию, клонирует, переключает ветку или PR, синхронизирует без force и создаёт worktree. Локальные записи остаются внутри `workspaceRoot` или каталога сессии. |
| `github_repo` | Список, просмотр, создание, редактирование, transfer, rename, delete, archive; темы и доступ коллабораторов. |
| `github_file` | Читает файлы с номерами строк и деревья, показывает один путь, записывает/удаляет файл, перемещает/копирует файлы и атомарно коммитит multi-file изменения с проверкой sha. |
| `github_ref` | Список и просмотр веток/тегов, создание веток и лёгких тегов, удаление веток по guarded-плану. |
| `github_read` | Читает файлы, каталоги и рекурсивное дерево для ветки, тега, коммита или головы PR. |
| `github_pr` | Читает PR или выполняет list/update/comment/label/reviewers/update_branch/close/reopen/merge. |
| `github_issue` | List/view/create/update/comment/label/assign/milestone/lock/transfer для issues. |
| `github_actions` | Workflows и runs, dispatch, rerun/cancel, jobs/логи/артефакты, скачивание артефактов, секреты, переменные, кэши, permissions и runners. |
| `github_org` | Организации, репозитории, участники, команды, доступ команд и whitelist настроек. |
| `github_api` | Generic REST/GraphQL escape hatch: read-only по умолчанию, с гейтами для write/DELETE. |
| `github_extract` | Выносит один или несколько каталогов в новый репозиторий с сохранением истории (`subtree-split` или multi-path `filter-repo`) либо снапшотом, или привязывает target repo обратно как submodule в ветке/PR. |
| `github_release` | Список, создание, редактирование, удаление релизов, загрузка файлов как assets и скачивание assets. |
| `github_search` | Поиск репозиториев, issues/PR, кода и пользователей. |
| `github_diff` | Unified diff PR или сравнения веток/тегов/коммитов со статистикой и пагинацией. |
| `github_review` | Отправляет одно ревью с inline-комментариями; сначала спрашивает подтверждение. |
| `github_pr_create` | Открывает PR из существующей удалённой ветки; сначала спрашивает подтверждение. |
| `github_issue_create` | Открывает issue с описанием, метками, исполнителями и вехой; сначала спрашивает подтверждение. |
| `github_read` | Читает файлы (с номерами строк), содержимое каталогов или рекурсивное дерево файлов для ветки, тега, коммита или головы пулл-реквеста. |
| `github_pr` | Читает пулл-реквест: описание, изменённые файлы, комментарии обсуждения, inline-комментарии ревью, ревью, коммиты и проверки. |
| `github_diff` | Возвращает unified diff пулл-реквеста или сравнения веток, тегов и коммитов со статистикой по файлам и постраничной выдачей по `offset`. |
| `github_review` | Отправляет одно ревью с необязательным резюме и inline-комментариями к строкам диффа. Сначала запрашивает подтверждение. |
| `github_pr_create` | Открывает пулл-реквест из ветки, которая уже существует на удалённом репозитории. Сначала запрашивает подтверждение. |
| `github_issue_create` | Открывает issue с необязательным описанием, метками, исполнителями и вехой. Сначала запрашивает подтверждение. |

## Требования

- [GitHub CLI](https://cli.github.com) установлен и авторизован: `gh auth login`.
- Токену нужен scope `repo`, чтобы читать приватные репозитории и писать ревью.
- Node.js 20 или новее (поставляется вместе с DSH).
- Git 2.40 или новее для локальных операций (clone, checkout, extraction).
  Remote-only инструменты работают и без него.
- Опционально: `git-filter-repo` для multi-path extraction с сохранением истории
  и `git-lfs` для репозиториев, где большие файлы хранятся в LFS.

Плагин ищет `gh` в `PATH`, затем в стандартных местах установки на платформе
(`C:\Program Files\GitHub CLI\gh.exe`, `/opt/homebrew/bin/gh`,
`/usr/bin/gh`, …). Если DSH был запущен до установки `gh`, его `PATH` может
быть устаревшим; поиск в стандартных местах покрывает этот случай. В остальных
случаях задайте `ghPath` явно.

## Установка

Плагин — обычная зависимость pnpm, поэтому подойдёт GitHub-ссылка или локальный
каталог. В Desktop используйте Plugin Manager; из терминала:

```sh
# с GitHub (добавьте #<ветка-или-коммит>, чтобы закрепить ревизию)
dsh plugin --profile <profile> add github:untodesu/dsh-github-cli

# из локального каталога
dsh plugin --profile <profile> add C:\path\to\dsh-github-cli
```

`github:` — это сокращение pnpm, а не специальная схема DSH: `dsh plugin`
передаёт аргументы в pnpm, а Plugin Manager при установке проверяет репозиторий
через `git ls-remote` перед `pnpm add`. Git-зависимость фиксируется выбранной
ревизией (или веткой по умолчанию), поэтому указывайте тег, коммит или ветку с
плагином, если в ветке по умолчанию его ещё нет.

Патч bundle вставляет одну запись, `github-cli`. Зависимостей и шага сборки нет.

## Конфигурация

Запись принимает следующие ключи (все необязательные):

| Ключ | По умолчанию | Значение |
| --- | --- | --- |
| `ghPath` | `""` | Абсолютный путь к `gh`. Пусто — искать автоматически. |
| `gitPath` | `git` | Git для локальных операций. |
| `defaultHost` | `github.com` | Хост, если ссылка его не указывает. |
| `defaultRepo` | `""` | Репозиторий, если `repo` не указан и cwd не привязан. |
| `defaultOwner` | `""` | Владелец по умолчанию для создания репозиториев. |
| `defaultOrg` | `""` | Организация по умолчанию. |
| `workspaceRoot` | `""` | Корень для клонов. Пусто — рабочий каталог сессии. |
| `scratchDir` | `.dsh/github` | Временные клоны, логи и загрузки. |
| `maxOutputChars` | `80000` | Лимит текста, возвращаемого за один вызов. |
| `maxFileBytes` | `2097152` | Максимальный размер файла для чтения в модель. |
| `maxWriteBytes` | `5242880` | Максимальный размер содержимого одной записи. |
| `maxPages` | `10` | Максимум страниц REST за одну операцию списка. |
| `timeoutMs` | `60000` | Таймаут одного вызова `gh`. |
| `longTimeoutMs` | `900000` | Таймаут clone, extraction и загрузок. |
| `requireApproval` | `true` | Подтверждение перед удалёнными записями: boolean или `{ write, destructive, admin }`. |
| `allowDestructive` | `false` | Разрешить destructive-операции после совпадающего `confirm`. |
| `allowAdmin` | `false` | Разрешить администрирование организации и безопасности. |
| `allowGenericApi` | `read` | Возможности `github_api`: `read`, `write` или `false`. |
| `protectedBranches` | `["main","master"]` | Ветки, куда прямые коммиты запрещены по умолчанию. |
| `allowedOrgs` / `deniedOrgs` | `[]` | Allowlist/denylist организаций. |
| `dryRunDestructive` | `true` | Для destructive-операций возвращать план, пока не передан `apply`. |
| `extraction.history` | `preserve` | Режим extraction по умолчанию: `preserve` или `snapshot`. |
| `extraction.filterRepoPath` | `""` | Путь к `git-filter-repo`; пусто — искать. |
| `extraction.allowHistoryRewrite` | `true` | Разрешить history-preserving extraction во временном клоне. |
| `extraction.cleanupOnFailure` | `true` | Удалять destination repo, созданный неудачным extraction. |
| `actions.allowSecrets` | `true` | Разрешить установку секретов repo/org/environment. |
| `actions.maxLogLines` | `200` | Длина tail для логов workflow по умолчанию. |

Переопределите запись в слое патча профиля (id записи — `github-cli`):

```yaml
- id: github-cli
  config:
    defaultRepo: untodesu/dsh-github-cli
    defaultOrg: untodesu
    maxOutputChars: 60000
    allowDestructive: false
```

`config` заменяется целиком, поэтому перечисляйте все ключи, которые хотите
сохранить.

Плагин экспортирует схему `Config` (`@deepseek-ai/schemastery`), поэтому DSH
может построить форму настроек для записи. `resolveConfig` по-прежнему сам
проверяет значения и при ошибке завершает активацию с понятным сообщением;
вложенные объекты `extraction` и `actions` дополняются значениями по умолчанию.

## Примеры

Прочитать файл в ветке:

```json
{ "repo": "cli/cli", "ref": "trunk", "path": "go.mod", "start_line": 1, "end_line": 20 }
```

Прочитать несколько изменённых файлов на голове пулл-реквеста:

```json
{ "repo": "cli/cli", "pr": "1234", "paths": ["internal/gh/gh.go", "README.md"] }
```

Оставить ревью пулл-реквеста с inline-комментариями:

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

Открыть пулл-реквест:

```json
{
  "repo": "untodesu/dsh-github-cli",
  "title": "Add review support",
  "head": "feature/review",
  "body": "Adds the review flow."
}
```

Открыть issue:

```json
{
  "repo": "untodesu/dsh-github-cli",
  "title": "Review writes need a test pull request",
  "body": "We should exercise the review endpoint end to end.",
  "labels": ["testing"],
  "assignees": ["untodesu"]
}
```

Создать репозиторий в организации:

```json
{ "action": "create", "org": "my-org", "name": "billing-api", "visibility": "private", "auto_init": true }
```

Склонировать и привязать чекаут к репозиторию:

```json
{ "action": "clone", "repo": "my-org/billing-api" }
```

Создать ветку и записать файл в неё:

```json
{ "action": "create", "repo": "my-org/billing-api", "ref": "feature/config", "from": "main" }
```

```json
{ "action": "write", "repo": "my-org/billing-api", "path": "src/config.ts", "content": "export const port = 8080;\n", "message": "Add port config", "branch": "feature/config" }
```

Запланировать вынос каталога в новый репозиторий:

```json
{
  "action": "plan",
  "source": { "repo": "my-org/monorepo", "ref": "main", "path": "packages/api" },
  "destination": { "owner": "my-org", "name": "api" },
  "history": "preserve"
}
```

План вернёт строку `confirm`; примените её с `"action": "apply", "apply": true,
"confirm": "..."`. Apply работает во временном клоне и не переписывает source.

Передайте `dry_run: true` в изменяющую операцию, чтобы проверить и предпросмотреть
её без записи. Для guarded destructive-операций (например, удаления ветки)
передайте `apply: true` вместе с `confirm` из плана.

Для `github_review` передайте `dry_run: true`, чтобы проверить и предпросмотреть
ревью, не публикуя его и не запрашивая подтверждение.

## Эффективность

- Авторизованная квота: 5000 REST-запросов в час (и 5000 баллов GraphQL) вместо
  60 анонимных запросов в час.
- `github_read` делает один вызов Contents API на путь, по четыре одновременно,
  и один дополнительный вызов blob только для файла, который Contents API
  отказывается отдавать целиком.
- `github_review` отправляет все inline-комментарии **одним** запросом ревью,
  а не отдельным запросом на каждый комментарий.
- Списки запрашиваются постранично с жёстким ограничением числа страниц, поэтому
  огромный пулл-реквест не может израсходовать неограниченное число запросов.
- Вывод ограничен на каждый вызов: содержимое файлов, текст диффа и списки
  комментариев обрезаются с явными подсказками для продолжения (`start_line`,
  `offset`).
- Версия 0.2 читает `X-RateLimit-*`, `Retry-After` и соседние с `ETag` заголовки
  через `gh api --include`, поэтому `github_status` показывает реальный остаток,
  а не догадку.
- Если `repo` не указан, вызов использует репозиторий, привязанный к текущему
  чекауту, затем `defaultRepo`. Привязка определяется из git remote, а не
  копируется в каждый промпт.

## Безопасность

- Записи (`github_review`, `github_pr_create`, `github_issue_create`) запрашивают
  канал подтверждения сессии и отменяются, если результат не `allowed-once`.
  При политике подтверждения `never` записи отклоняются, а не публикуются молча.
- `requireApproval` может быть boolean или `{ write, destructive, admin }`, чтобы
  спрашивать только для destructive/admin, а обычные комментарии пропускать.
  `allowDestructive` и `allowAdmin` остаются отдельными гейтами.
- Устанавливайте `requireApproval: false`, только если вам нужны записи без
  участия человека.
- Токен хранится в `gh`; плагин никогда не читает, не сохраняет и не выводит его.
- Заголовки, описания, комментарии и диффы пулл-реквестов — недоверенные данные.
  Относитесь к ним как к содержимому для ревью, а не как к инструкциям.

## Ограничения

- Версия 0.2 — фундамент: восемнадцать инструментов выше покрывают чтение, ревью,
  управление PR/issues, жизненный цикл и transfer repo, ветки/теги, запись файлов
  и атомарные коммиты, локальные чекауты, базовые Actions, организации, generic
  API, релизы, поиск и extraction с сохранением истории или снапшотом. Остались
  live-write проверки на test org и финальный тег 1.0.
- Merge, transfer, удаление, extraction, изменение секретов и другие
  destructive/admin-операции по умолчанию выключены; включайте
  `allowDestructive`/`allowAdmin` осознанно.
- Плагин не пушит коммиты; `github_pr_create` требует существующую удалённую ветку.
- Чтение ограничено 2 МБ на файл и 48 МБ на процесс `gh`.
- Строки inline-комментариев должны присутствовать в диффе PR; GitHub отклоняет
  ревью, если комментарий указывает на другую строку.

## Тесты

Unit-тесты покрывают конфигурацию, ссылки на репозитории, risk-гейты, реестр
операций, разбор ответов REST, разбор `gh auth status`, capabilities, кэш
сессии, запуск git и операции repo/file/ref/PR/issue/actions:

```sh
pnpm test
```

Они не ходят в сеть и не запускают дочерний тестовый процесс, поэтому работают и
из ограниченной оболочки DSH. Внутри используется
`node --test --test-isolation=none "test/unit/*.test.mjs"`.

Smoke-тест обращается к реальному API через авторизованный аккаунт и только
читает (плюс пробное ревью в режиме dry-run):

```sh
pnpm test:smoke
```

Ему нужен `gh` в `PATH` или в стандартном месте установки. Запуск из
ограниченной оболочки DSH завершается с `spawn EPERM`, потому что песочница
блокирует дочерние процессы с pipe-каналами; запускайте тест из обычного
терминала.

Для CI `.github/workflows/ci.yml` гоняет unit-набор на каждый push/PR, а ручной
workflow `Live smoke` запускает этот read-only smoke с секретом `GH_TOKEN`.
Если токен принадлежит другому аккаунту, задайте `DSH_GITHUB_TEST_ACCOUNT` и
`DSH_GITHUB_TEST_REPO`.

Оба workflow используют Node.js 22 и pnpm 11.28.10: pnpm 11 требует Node.js 22.13
или новее (он импортирует `node:sqlite`), а сам плагин по-прежнему работает на
Node.js 20 или новее.
