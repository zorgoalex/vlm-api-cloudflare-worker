# VLMM Worker (Cloudflare) — Vision API proxy (BigModel + OpenRouter)

Тонкий edge‑прокси на Cloudflare Workers для визуально‑языковых моделей (VLM/VLMM). Принимает изображение (URL/файл/base64) и промпт, собирает OpenAI‑совместимые `messages`, вызывает выбранного провайдера (по умолчанию **BigModel GLM‑4.5V**), и отдаёт ответ JSON или стримом (SSE).

> Репозиторий сейчас содержит **только воркер**. Демо‑фронт можно подключить отдельно — любая страница, которая шлёт `POST` на эндпоинты воркера.

---

## Что уже умеет
- `POST /v1/vision/analyze` — синхронный JSON‑ответ.
- `POST /v1/vision/stream` — потоковый ответ (Server‑Sent Events).
- `GET /healthz` — проверка живости.
- Провайдеры: **BigModel** (`glm-4.5v`) и **OpenRouter** (любая vision‑модель). Переключение: `provider=bigmodel|openrouter` в теле или query.
- Входные форматы: `multipart/form-data` (поле `file`) и `application/json` (`image_url` или `image_base64`).
- Параметры: `prompt`, `model`, `detail: low|high|auto`, `images[]` (мульти‑изображения), `thinking: enabled|disabled` (только BigModel), `stream: true`.
- CORS: разрешён список origin’ов (env `ALLOWED_ORIGINS`).

---

## Быстрый старт

### 1) Установка
```bash
npm i
# (опционально) wrangler в dev‑зависимости
npm i -D wrangler
```

### 2) Секреты и переменные
Секреты хранятся только в среде воркера, не в файлах.
```bash
# BigModel (обязателен, если используете провайдера bigmodel)
npx wrangler secret put BIGMODEL_API_KEY

# OpenRouter (опционален — только если используете openrouter)
npx wrangler secret put OPENROUTER_API_KEY
```
Переменные (через `wrangler.jsonc → vars` или для локалки `.dev.vars`):
- `DEFAULT_MODEL` — дефолтная модель (например, `glm-4.5v` или `qwen/qwen2.5-vl-72b-instruct`).
- `ALLOWED_ORIGINS` — список разрешённых origin’ов, через запятую (например, `http://localhost:3333,http://127.0.0.1:3000`).
- `APP_URL`, `APP_TITLE` — (для OpenRouter) атрибуция в заголовках.

Пример `.dev.vars` (не коммитить):
```
BIGMODEL_API_KEY="sk-..."
# OPENROUTER_API_KEY="sk-or-..."
DEFAULT_MODEL="glm-4.5v"
ALLOWED_ORIGINS="http://localhost:3333,http://127.0.0.1:3000"
APP_URL="http://localhost:3333"
APP_TITLE="VLMM Proxy (dev)"
```

### 3) Локальный запуск
```bash
npx wrangler dev
# слушает http://127.0.0.1:8787
```
Чтобы «жёстко» разрешить локальный фронт на `http://localhost:3333`, добавьте его в `ALLOWED_ORIGINS`.

### 4) Деплой
```bash
npx wrangler deploy
```
После деплоя будет доступен адрес вида:
```
https://vlmm-worker.<your-subdomain>.workers.dev
```
*(имя сервиса берётся из `wrangler.jsonc: name`)*

---

## API

### POST `/v1/vision/analyze`
**Вход**
- **JSON**
```jsonc
{
  "provider": "bigmodel",      // bigmodel | openrouter (по умолчанию bigmodel)
  "model": "glm-4.5v",         // перекрывает DEFAULT_MODEL
  "prompt": "Что на фото?",
  "image_url": "https://.../img.jpg", // http(s) или data:URL
  // либо вместо image_url:
  // "image_base64": "<RAW_BASE64>",   // без префикса data:
  "images": ["https://.../img1.jpg", "https://.../img2.jpg"],
  "detail": "auto",              // low | high | auto
  "thinking": "enabled",         // только для BigModel
  "stream": false
}
```
- **multipart/form-data**
  - `file` — изображение (`image/jpeg|png|webp|gif`)
  - `prompt`, `model`, `provider`, `detail`, `thinking` — опционально

**Ответ (упрощённо)**
```json
{
  "id": "...",
  "model": "glm-4.5v",
  "choices": [ { "message": { "role": "assistant", "content": "..." } } ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 }
}
```

### POST `/v1/vision/stream`
Те же поля, но отдаёт `text/event-stream`. В поток идут чанки совместимые с OpenAI (`choices[].delta.content`).

### GET `/healthz`
Возвращает `ok`.

---

## Примеры cURL

### JSON + BigModel
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

### multipart (локальный файл)
```bash
curl -X POST "$WORKER/v1/vision/analyze" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@/path/to/image.jpg" \
  -F "prompt=Опиши картинку" \
  -F "provider=bigmodel" -F "model=glm-4.5v" -F "detail=high"
```

### Стрим (SSE)
```bash
curl -N -X POST "$WORKER/v1/vision/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "bigmodel",
    "model": "glm-4.5v",
    "prompt": "Explain the chart",
    "image_url": "https://cdn.bigmodel.cn/static/logo/api-key.png",
    "stream": true
  }'
```

### Переключение на OpenRouter
```bash
curl -X POST "$WORKER/v1/vision/analyze?provider=openrouter" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen2.5-vl-72b-instruct",
    "prompt": "Summarize",
    "image_url": "https://.../img.jpg"
  }'
```

---

## Поведение, детали реализации
- Если пришло `image_base64`, воркер сам оборачивает в `data:image/jpeg;base64, ...`.
- Если загрузили `file` через multipart — конвертирует файл в data:URL.
- Поле `detail` добавляется в `image_url.detail` (когда поддерживается провайдером).
- Для BigModel доступен флаг `thinking: enabled|disabled` (включает/отключает рассуждения).
- Для `stream` воркер проксирует поток без изменения структуры событий.
- Модель по умолчанию — из `DEFAULT_MODEL`; если не задана, берётся `glm-4.5v` (для BigModel) или `qwen/qwen2.5-vl-72b-instruct` (для OpenRouter).

---

## CORS и безопасность
- Список разрешённых источников задаётся через `ALLOWED_ORIGINS` (через запятую). Примеры:
  - локально: `http://localhost:3333,http://127.0.0.1:3000`
  - прод: `https://your-frontend.app`
- На предпросмотр/локалке используйте `.dev.vars`.
- **Ключи провайдеров никогда не отправляйте в браузер** — только как секреты воркера.

---

## Структура проекта (текущее)
```
/ (корень воркера)
  ├── src/index.ts                  # код воркера (эндпоинты, провайдеры, CORS)
  ├── wrangler.jsonc                # конфиг сервиса (name, main, vars, observability)
  ├── worker-configuration.d.ts     # типы окружения (сгенерировано Wrangler)
  ├── tsconfig.json                 # TS-компиляция под Workers runtime
  └── README.md                     # этот файл
```

---

## Troubleshooting
- **401 No auth credentials** — не установлен секрет провайдера (`BIGMODEL_API_KEY` или `OPENROUTER_API_KEY`).
- **CORS‑ошибка в браузере** — проверьте `ALLOWED_ORIGINS` и источник запроса.
- **413 Payload Too Large** — уменьшите изображение до лимита (рекомендуется ≤10 MB).
- **BigModel 4xx/5xx** — проверьте валидность токена и формат `messages`.

---

## 🗺️ TODO / дорожная карта

### Безопасность и доступ
* [ ] **Авторизация** запросов к воркеру: Bearer‑токен (per‑project) + опционально HMAC‑подпись тела.
* [ ] **CORS по окружениям** (dev/stage/prod) через переменные и env‑секции Wrangler.
* [ ] **Rate limiting** и защита от абуза: Cloudflare Turnstile (человек), квоты по IP/ключу, базовый anti‑replay.

### Надёжность и UX
* [ ] **UI стрима** (SSE): постепенный вывод токенов, индикатор статуса, кнопка Cancel, автоскролл и копирование.
* [ ] **Выбор модели/провайдера** на фронте + **фолбэк** при недоступности (роутер с приоритетами и health‑check).
* [ ] **Валидация изображений** на фронте: preview, ограничение размеров/форматов, resize/компрессия перед отправкой, очистка EXIF.
* [ ] **Стандартизировать ошибки**: единый JSON‑формат, карта кодов 4xx/5xx, дружелюбные сообщения пользователю.

### Наблюдаемость
* [ ] **Логирование** (structured JSON) и `request_id`/`trace_id`; уровни (info/warn/error), sampling для стрима.
* [ ] **Метрики**: счётчики usage, latency по провайдеру/модели, размеры входов; экспорт (Logs, Analytics Engine / RUM).
* [ ] **Кэширование ответов** (опционально): KV/R2 с TTL, ключ по хэшу картинки+промпта; трассировка кэша (HIT/MISS).

### Мультимедиа
* [ ] **Несколько изображений** — доработки фронта: мультитач/drag‑drop, сортировка, per‑image `detail`, превью и удаление.

### Документация и тесты
* [ ] `/about` + **OpenAPI YAML** (линк с /about, пример коллекции Insomnia).
* [ ] CI: ESLint/TypeCheck + build + E2E (Playwright) с секретами через CF Environments, превью‑деплой.

---

### D1: модуль Prompts (источник истины + KV‑кэш)
* [ ] **Создать D1‑БД** `vlm-api-db` (универсальная для проекта) и KV‑namespace `PROMPT_CACHE`.
* [ ] **Миграция `0001_prompts.sql`** (таблица `prompts` с полями `prompt_*`, индексы по namespace/lang/active/default, триггер на `prompt_updated_at`).
* [ ] **API**: `GET /v1/prompts`, `GET /v1/prompts/:id`, `GET /v1/prompts/default`, `POST /v1/prompts`, `PUT /v1/prompts/:id`, `PUT /v1/prompts/:id/default`.
* [ ] **Доступ**: заголовок `X-Admin-Token` (секрет в воркере), отдельная секция CORS для админ‑UI.
* [ ] **Кэш KV (read‑through)**: ключи `list:<ns>:<lang|*>:<active|*>` (TTL~60s), `id:<id>` (TTL~300s), `default:<ns>:<lang>` (TTL~300s); корректная инвалидация при CRUD.
* [ ] **Фронт‑форма**: поля *название*, *текст*, чекбокс *default*; поддержка версий, переключение active, редактирование `tags`.
* [ ] **Поиск**: `q` по name/text; `tag` через JSON1 (`json_each`), пагинация (limit/offset или cursor).
* [ ] **Seed/backup**: сид начальных промптов; экспорт/импорт D1 (CLI); хранение экспортов в R2.
* [ ] **Уникальный default**: частичный уникальный индекс (если доступен) или транзакционная логика в воркере.
* [ ] **Будущее**: интеграция Vectorize для семантического поиска по промптам.

---

## ✅ Статус

* ✔ Worker задеплоен на Cloudflare.
* ✔ API отвечает по JSON и multipart, поддерживает SSE (стриминг).
* ✔ Поддержка **нескольких изображений** в одном запросе уже реализована (`images[]`).
* ✔ (если фронт подключён во внешнем репозитории) фронт собирается локально и/или на Vercel, умеет отправлять изображения и отображать ответы.

## Лицензия
MIT.

