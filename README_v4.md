# VLMM Worker (Cloudflare) — Vision API proxy (BigModel + OpenRouter)

Тонкий edge‑прокси на Cloudflare Workers для визуально‑языковых моделей (VLM/VLMM). Принимает изображение (URL/файл/base64) и промпт, собирает OpenAI‑совместимые `messages`, вызывает выбранного провайдера (по умолчанию **BigModel GLM‑4.5V**), и отдаёт ответ JSON или стримом (SSE). Содержит модуль Prompts (D1 + KV) и служебные эндпоинты.

> Репозиторий содержит Cloudflare Worker. Фронтенд — отдельно (любая страница, отправляющая `POST` на эндпоинты воркера).

---

## Что уже умеет
- `POST /v1/vision/analyze` — синхронный JSON‑ответ.
- `POST /v1/vision/stream` — потоковый ответ (Server‑Sent Events, с ранним прогрессом).
- `GET /healthz` — проверка живости.
- `GET /about` — служебная информация (включённые фич‑флаги, список маршрутов, ссылка на OpenAPI).
- `GET /openapi.yaml` — спецификация OpenAPI.
- Prompts (D1 + KV):
  - `GET /v1/prompts`, `GET /v1/prompts/:id`, `GET /v1/prompts/default`
  - `POST /v1/prompts`, `PUT /v1/prompts/:id`, `PUT /v1/prompts/:id/default`
- Админ‑утилиты: `POST /admin/backup` — экспорт таблицы `prompts` в R2; плановый бэкап по `cron` (`scheduled`).
- Провайдеры: **BigModel** (`glm-4.5v`) и **OpenRouter** (любая vision‑модель). Переключение: `provider=bigmodel|openrouter`.
- Входные форматы: `multipart/form-data` (поле `file`) и `application/json` (`image_url` или `image_base64`).
- Параметры: `prompt`, `model`, `detail: low|high|auto`, `images[]` (несколько изображений), `thinking: enabled|disabled` (BigModel), `stream: true`.
- CORS: список origin’ов (env `ALLOWED_ORIGINS`) + значения из env‑секций Wrangler (dev/stage/prod).
- Безопасность (backend): Admin‑токен на запись (`X-Admin-Token`), (опц.) Bearer на чтение, (опц.) rate‑limit и nonce‑anti‑replay для записи.

---

## Быстрый старт

### 1) Установка
```bash
npm i
# (опционально) wrangler в dev‑зависимости
npm i -D wrangler
```

### 2) Секреты и переменные
Секреты задаются в окружении воркера (не в файлах).
```bash
# BigModel (обязателен, если используете провайдера bigmodel)
npx wrangler secret put BIGMODEL_API_KEY

# OpenRouter (опционален, только если используете openrouter)
npx wrangler secret put OPENROUTER_API_KEY

# Админ‑токен для записи/бэкапов
npx wrangler secret put ADMIN_TOKEN
```
Переменные (через `wrangler.jsonc → env.*.vars` или локально `.dev.vars`):
- Vision/атрибуция: `DEFAULT_MODEL`, `APP_URL`, `APP_TITLE`.
- CORS: `ALLOWED_ORIGINS` (через запятую).
- Prompts/D1+KV/R2: биндинги `vlm_api_db`, `PROMPT_CACHE`, `BACKUPS` настраиваются в `wrangler.jsonc` (см. пример ниже).
- Флаги безопасности и удобства:
  - `REQUIRE_READ_AUTH=1` + `READ_BEARER_TOKEN="..."` — требовать Bearer на чтение Prompts.
  - `WRITE_RL_LIMIT`, `WRITE_RL_WINDOW_SEC` — лимитирование записи (KV‑счётчик).
  - `ENABLE_NONCE_REQUIRED_FOR_WRITE=1`, `NONCE_TTL_SEC` — anti‑replay по заголовку `X-Nonce`.
  - `ENABLE_SCHEMA_BOOTSTRAP=1` — dev/test: best‑effort создание схемы D1 на `/v1/prompts*`.
  - `BACKUP_PREFIX` — префикс для ключей в R2 при бэкапах.

Пример `.dev.vars` (не коммитить):
```
BIGMODEL_API_KEY="sk-..."
# OPENROUTER_API_KEY="sk-or-..."
DEFAULT_MODEL="glm-4.5v"
ALLOWED_ORIGINS="http://localhost:3333,http://127.0.0.1:3000"
APP_URL="http://localhost:3333"
APP_TITLE="VLMM Proxy (dev)"
ADMIN_TOKEN="<random-long-token>"
READ_BEARER_TOKEN="<optional-read-token>"
REQUIRE_READ_AUTH="0"
WRITE_RL_LIMIT="20"
WRITE_RL_WINDOW_SEC="60"
ENABLE_NONCE_REQUIRED_FOR_WRITE="0"
NONCE_TTL_SEC="300"
ENABLE_SCHEMA_BOOTSTRAP="1"
BACKUP_PREFIX="dev/d1/vlm-api-db/"
```

### 3) Ресурсы CF (D1/KV/R2)
```bash
# Логин в Cloudflare (однократно)
npx wrangler login

# D1
npx wrangler d1 create vlm-api-db

# KV (кэш промптов)
npx wrangler kv namespace create PROMPT_CACHE

# (опц.) R2 для бэкапов
# создайте бакет и пропишите биндинг BACKUPS в wrangler.jsonc
```
В `wrangler.jsonc` настройте биндинги для окружений `stage`/`production` (см. текущий файл в репозитории; биндинг D1 — `vlm_api_db`). Для локальных команд `wrangler d1 execute --local` рекомендуется также задать top‑level блок `d1_databases` с `binding: vlm_api_db`, `database_name: vlm-api-db` и заполненным `database_id`.

### 4) Локальный запуск
```bash
npx wrangler dev
# слушает http://127.0.0.1:8787
```
Добавьте локальный фронт в `ALLOWED_ORIGINS`.

### 5) Деплой
```bash
npx wrangler deploy
```
После деплоя адрес вида:
```
https://vlmm-worker.<your-subdomain>.workers.dev
```

---

## API

### Vision

#### POST `/v1/vision/analyze`
Вход: JSON или `multipart/form-data` (см. `README_v2.md` примеры). Поля: `provider`, `model`, `prompt`, `image_url`/`image_base64`/`images[]`, `detail`, `thinking`, `stream`.
Ответ: JSON в формате OpenAI Chat Completions.

#### POST `/v1/vision/stream`
Те же поля, но `text/event-stream`. Идут чанки OpenAI‑совместимого формата + наши прогресс‑события.

#### GET `/healthz`
Возвращает `ok`.

### Служебные
- `GET /about` — сведения о сборке/окружении, включенные фич‑флаги, список маршрутов.
- `GET /openapi.yaml` — спецификация OpenAPI (включает Prompts API).

### Prompts (D1 + KV)

- `GET /v1/prompts` — список. Параметры: `namespace`, `lang`, `active=0|1`, `q`, `tag`, `sort` (`priority_asc`|`priority_desc`|`name_asc`|`name_desc`|`updated_desc`, по умолчанию `priority_asc`), `limit` (<=100), `offset`. Сортировка по умолчанию: `priority ASC`, затем `name`, `version DESC`.
- `GET /v1/prompts/:id` — получить по id.
- `GET /v1/prompts/default?namespace=...&lang=...` — дефолт для пары.
- `POST /v1/prompts` — создать. Требуется `X-Admin-Token` (+ опц. nonce/лимит). Тело:
```json
{ "namespace":"default", "name":"example", "version":1, "lang":"ru", "text":"...", "priority":0, "tags":["ru"], "is_active":1, "make_default":false }
```
- `PUT /v1/prompts/:id` — обновить произвольные поля (`namespace|name|version|lang|text|tags|is_active`). Требуется `X-Admin-Token` (+ опц. nonce/лимит).
- Поле `priority` (меньше — выше приоритет) доступно при создании/обновлении.
- `PUT /v1/prompts/:id/default` — сделать дефолтом (только для активного); атомарно сбрасывает остальные дефолты для пары `(namespace, lang)`.

Кэширование: KV read‑through (`list:*` TTL≈60s, `id:*` и `default:*` TTL≈300s); инвалидация на запись.

Бэкапы: `POST /admin/backup` — сохраняет JSON‑дамп таблицы `prompts` в R2 (`BACKUPS`), ключ с префиксом `BACKUP_PREFIX`.

---

## Примеры cURL (кратко)

### Vision (JSON + BigModel)
```bash
curl -X POST "$WORKER/v1/vision/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "provider":"bigmodel",
    "model":"glm-4.5v",
    "prompt":"List the objects",
    "image_url":"https://cdn.bigmodel.cn/static/logo/register.png",
    "thinking":"enabled"
  }'
```

### Prompts (create)
```bash
curl -X POST "$WORKER/v1/prompts" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{
    "namespace":"default","name":"order_parser_ru","version":1,
    "lang":"ru","text":"...","tags":["parser","ru"],
    "is_active":1,"make_default":true
  }'
```

---

## Миграции

- Схема БД включает все актуальные поля, в том числе `prompt_priority` (INTEGER NOT NULL DEFAULT 0). Полные определения — в `migrations/0001_prompts.sql` и последующих файлах миграций.
- Примените миграции, чтобы гарантировать актуальную схему:
  - Dev/local:
    - `wrangler d1 execute vlm-api-db --file=./migrations/0001_prompts.sql`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0002_prompts_trigger.sql`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0003_prompts_priority.sql`
  - Stage/Prod:
    - `wrangler d1 execute vlm-api-db --file=./migrations/0001_prompts.sql --env stage`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0002_prompts_trigger.sql --env stage`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0003_prompts_priority.sql --env stage`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0001_prompts.sql --env production`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0002_prompts_trigger.sql --env production`
    - `wrangler d1 execute vlm-api-db --file=./migrations/0003_prompts_priority.sql --env production`
- В dev окружении можно включить `ENABLE_SCHEMA_BOOTSTRAP=1` — воркер автоматически создаёт/обновляет схему при обращении к `/v1/prompts*`.

---

## Troubleshooting
- 401 Unauthorized — проверьте `X-Admin-Token` (запись) или Bearer (если `REQUIRE_READ_AUTH=1`).
- CORS‑ошибка — проверьте `ALLOWED_ORIGINS` и источник запроса.
- 413 Payload Too Large — уменьшите изображение (рекомендуется ≤10 MB).
- Ошибки BigModel/OpenRouter — проверьте ключи и формат `messages`.

---

## 🗺️ TODO / дорожная карта

### Безопасность и доступ
- [x] Admin‑токен на запись (Prompts, backup)
- [x] (опц.) Bearer на чтение Prompts (`REQUIRE_READ_AUTH`)
- [x] (опц.) Rate limiting записи (KV) + nonce anti‑replay
- [ ] HMAC‑подпись тела (позже)
- [ ] Cloudflare Turnstile на write‑операции (позже)

### Надёжность и UX
- [ ] UI стрима (SSE) на фронте: постепенный вывод, cancel, автоскролл, копирование
- [ ] Роутер моделей/провайдеров с фолбэком и health‑check
- [ ] Валидация изображений на фронте (preview, resize, EXIF)

### Наблюдаемость
- [x] Структурные логи + `request_id`
- [ ] Метрики (latency/usage), экспорт (Logs/Analytics)
- [ ] Кэш Vision‑ответов (KV/R2) по хэшу ввода

### Документация и тесты
- [x] `/about` + OpenAPI YAML (`/openapi.yaml`)
- [x] CI: typecheck + tests + deploy (stage/main)
- [ ] E2E (Playwright) и превью‑деплой

### D1: модуль Prompts
- [x] D1 `vlm-api-db` + KV `PROMPT_CACHE`
- [x] Миграции (`migrations/0001_*.sql`, `0002_*trigger.sql`)
- [x] API: `GET/POST/PUT`, default‑логика, поиск/пагинация
- [x] Кэш KV (read‑through) + инвалидация
- [x] Seed/backup (скрипты `db:*`, R2 + cron)
- [ ] Фронт‑форма (вне scope бэкенда)
- [ ] Семантический поиск (Vectorize) — бэклог

---

## ✅ Статус
- ✔ Worker задеплоен на Cloudflare.
- ✔ Vision API: JSON + multipart, SSE (стриминг), мульти‑изображения `images[]`.
- ✔ Prompts API (D1 + KV) реализован, документация OpenAPI доступна, есть `/about`.
- ✔ Скрипты для миграций/сидов и R2‑бэкапов; плановые бэкапы по cron.

## Лицензия
MIT.

---

## Regex Cleanup (новое в v4)

Этот раздел описывает публикацию конфигурации регулярного выражения для «очистки» ответа модели. Конфиг доступен публично через `GET /about` в поле `config.regex_cleanup` и позволяет фронтенду централизованно применять единый фильтр к тексту ответа.

- Назначение: удалить/скрыть служебные строки вида `System: ...`, `Debug: ...`, и т.п. из итогового текста.
- Подход: бэкенд отдает только параметры regex; само применение выполняет фронтенд.

### Контракт `/about`
В ответ добавлен блок:

```jsonc
{
  // ...существующие поля
  "config": {
    "regex_cleanup": {
      "pattern": "^(?:System|Meta|Debug|SSE|Event|Disclaimer)\\s*:.*$",
      "flags": "gmi",
      "source": "kv | secret | default",
      "updated_at": "2025-09-29T10:00:00Z"
    }
  }
}
```

- `pattern`: шаблон JS‑регэкспа (строка).
- `flags`: строка флагов (см. ниже).
- `source`: откуда взяты значения — `kv` (KV), `secret` (Secrets/Env), `default` (зашитые дефолты).
- `updated_at`: момент формирования ответа (информативно).

Включение публикации — фичефлаг `ENABLE_REGEX_CONFIG=1`.

### Источники конфигурации (приоритет)
1) Cloudflare KV (`binding: VLM_CONFIG`):
   - `vision:regex:pattern`
   - `vision:regex:flags`
2) Secrets/Env:
   - `REGEX_CLEANUP_PATTERN`
   - `REGEX_CLEANUP_FLAGS`
3) Дефолт (вшитый):
   - pattern: `^(?:System|Meta|Debug|SSE|Event|Disclaimer)\s*:.*$`
   - flags: `gmi`

Если в KV/Secrets задан только один из параметров, недостающий берётся из альтернативного источника или из дефолта.

### Флаги регулярных выражений
Флаги — это второй аргумент конструктора `new RegExp(pattern, flags)` в JavaScript.

- `g`: глобальный поиск — находит все совпадения.
- `m`: многострочный режим — `^` и `$` работают на границах строк.
- `i`: регистр‑независимо — игнорирует регистр символов.
- `s`: dotAll — `.` матчит также перевод строки.
- `u`: Unicode — корректная обработка юникода, `\u{...}`.
- `y`: “липкий” поиск от текущей позиции (обычно не нужен здесь).
- `d`: индексы совпадений (для очистки не требуется).

Рекомендация по умолчанию: `gmi` — глобально, построчно, регистр‑независимо.
Добавляйте `s`, если используете `.` для матчинга многострочных блоков.

### Пример использования на фронтенде

```ts
// meta.config.regex_cleanup получен с /about
const { pattern, flags } = meta.config.regex_cleanup;
const re = new RegExp(pattern, flags);
const cleaned = originalText.replace(re, '').trim();
```

### Настройка (Wrangler/окружение)

- Биндинги KV (stage/prod) — в `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "PROMPT_CACHE", "id": "..." },
  { "binding": "VLM_CONFIG",   "id": "<KV-ID>" }
]
```

- Секреты (альтернатива источнику KV):

```bash
wrangler secret put REGEX_CLEANUP_PATTERN
wrangler secret put REGEX_CLEANUP_FLAGS
```

- Включить публикацию:

```bash
# .dev.vars или env.vars
ENABLE_REGEX_CONFIG="1"
```

- Положить значения в KV:

```bash
wrangler kv:key put --binding=VLM_CONFIG vision:regex:pattern "^(?:System|Meta|Debug|SSE|Event|Disclaimer)\\s*:.*$"
wrangler kv:key put --binding=VLM_CONFIG vision:regex:flags   "gmi"
```

### Валидация и кеширование
- Бэкенд валидирует параметры через `new RegExp(pattern, flags)`. При ошибке — возвращает как есть (без падения `/about`).
- Параметры кешируются в памяти воркера на короткий TTL (≈180с), чтобы снизить обращения к KV/Secrets.

### Быстрая проверка

```bash
curl "$WORKER/about" | jq .config.regex_cleanup
# ↳ ожидаем поля pattern/flags/source/updated_at
```

### TODO: Тесты для Regex Cleanup

- Проверить наличие блока в `/about` при `ENABLE_REGEX_CONFIG=1`.
- Смоделировать источник Secrets: задать `REGEX_CLEANUP_PATTERN`/`REGEX_CLEANUP_FLAGS` → `source: "secret"`.
- Смоделировать источник KV: мокнуть `env.VLM_CONFIG.get` для `vision:regex:*` → `source: "kv"`.
- Негатив: невалидные `pattern`/`flags` не приводят к 500; блок возвращается как есть.
- (Опц.) Кеш: зафиксировать, что значения стабильны в пределах TTL; можно проверить по логам/spy.
