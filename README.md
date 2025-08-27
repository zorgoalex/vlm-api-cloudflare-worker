# VLMM API: Cloudflare Worker + OpenRouter + Front (Vercel)

Мини-платформа для визуально-языковых моделей (VLMM): тонкий API-прокси на Cloudflare Workers, который принимает изображение, отправляет его в модель через OpenRouter и возвращает ответ. Фронтенд (Next.js на Vercel) — простая форма загрузки и просмотра результата.

---

## 🎯 Задача

* Принять изображение от клиента (JPG/PNG/WebP/GIF).
* Передать его в VLMM через OpenRouter API (`/api/v1/chat/completions`).
* Вернуть текстовый ответ (JSON) либо поток (SSE).
* Развернуть API на бесплатном Cloudflare Workers и фронт на Vercel.
* Не светить ключи модели в браузере.

---

## 🧩 Решение (кратко)

* **Cloudflare Worker** принимает:

  * `multipart/form-data` → поле `file` + `prompt`
  * `application/json` → `{ image_url }` **или** `{ image_base64 }` + `prompt`
* Воркер собирает OpenAI-совместимые `messages` (text + `image_url`) и вызывает OpenRouter.
* Ответ проксируется как обычный JSON (или как `text/event-stream` при стриме).
* **Фронт (Next.js)** шлёт `FormData` на воркер и показывает `choices[0].message.content`.

---

## 🏗️ Архитектура

```
Browser (Vercel, Next.js)
     │  FormData / JSON
     ▼
Cloudflare Worker  ──► OpenRouter ──► VLMM (напр., qwen2.5-vl / gpt-4o-mini / gemini-flash)
     ▲                     │
     └────── JSON / SSE ◄──┘
```

---

## 📁 Структура репозитория

```
/vlmm-worker/           # Cloudflare Worker (API-прокси)
  src/index.ts
  wrangler.jsonc
  .dev.vars             # только для локальной разработки (не коммитить)

/frontend/              # Next.js (App Router) - демо-фронт
  app/layout.tsx
  app/page.tsx
  next.config.mjs
  package.json
```

> Имена папок можно поменять — важно скорректировать Root Directory в настройках Vercel.

---

## 🔌 REST API (эндпоинты воркера)

### `POST /v1/vision/analyze` — синхронный ответ JSON

* **multipart/form-data**

  * `file`: изображение (`image/jpeg|png|webp|gif`)
  * `prompt`: строка (опц.)
  * `model`: строка (опц., дефолт см. `DEFAULT_MODEL`)
  * `detail`: `low|auto|high` (опц.)
* **application/json**

  ```json
  {
    "prompt": "Что на фото?",
    "image_url": "https://...jpg",
    // или вместо image_url:
    // "image_base64": "<BASE64 без префикса>",
    "model": "openai/gpt-4o-mini",
    "detail": "auto",
    "stream": false
  }
  ```

**Ответ (пример, укорочено):**

```json
{
  "id": "gen-...",
  "model": "qwen/...",
  "choices": [
    { "message": { "role": "assistant", "content": "..." } }
  ],
  "usage": { "prompt_tokens": 123, "completion_tokens": 45 }
}
```

### `POST /v1/vision/stream` — стрим ответа (SSE)

Те же поля, но `stream: true`. Возвращает `text/event-stream` с чанками (`choices[].delta.content`).

### `GET /healthz`

Проверка живости: `{"ok": true}`.

---

## ⚙️ Установка и запуск

### 1) Worker (Cloudflare)

**Зависимости**

```bash
npm i
npm i -D wrangler
```

**Секреты**

* Прод/превью:

  ```bash
  npx wrangler secret put OPENROUTER_API_KEY
  ```
* Локально (dev): создать файл `.dev.vars`:

  ```
  OPENROUTER_API_KEY="sk-or-..."
  DEFAULT_MODEL="qwen/qwen2.5-vl-72b-instruct:free"
  APP_URL="https://<ваш-фронт>.vercel.app"
  APP_TITLE="VLMM Proxy"
  ```

**Конфиг `wrangler.jsonc` (пример)**

```jsonc
{
  "name": "vlmm-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-08-25",
  "vars": {
    "DEFAULT_MODEL": "qwen/qwen2.5-vl-72b-instruct:free",
    "APP_URL": "https://<ваш-фронт>.vercel.app",
    "APP_TITLE": "VLMM Proxy"
  }
}
```

**Запуск**

```bash
# локально (читает .dev.vars)
npx wrangler dev

# продакшен
npx wrangler deploy
```

**Проверки**

```bash
curl https://<name>.<subdomain>.workers.dev/healthz
curl -X POST "https://<name>.<subdomain>.workers.dev/v1/vision/analyze" \
  -H "content-type: application/json" \
  -d '{"prompt":"Что на фото?","image_url":"https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg"}'
```

### 2) Frontend (Next.js, Vercel)

**Локально**

```bash
cd frontend
npm install
echo NEXT_PUBLIC_WORKER_URL=http://127.0.0.1:8787 > .env.local
npm run dev
# http://localhost:3000
```

**Vercel**

* Project → **Environment Variables**:

  ```
  NEXT_PUBLIC_WORKER_URL = https://<name>.<subdomain>.workers.dev
  ```
* **Root Directory** = `frontend` (если фронт не в корне).
* Build: `npm run build`, Install: `npm ci`, Output: (пусто).
* Node 18/20.
* Redeploy.

---

## 🔒 CORS и безопасность

* Разрешайте только свой фронт и localhost:

  ```ts
  const ALLOWED_ORIGINS = new Set([
    "http://localhost:3000",
    "https://<ваш-фронт>.vercel.app"
  ]);
  ```
* Файлы ограничивайте по типу и размеру (например, ≤ 10 MB).
* **Никаких** ключей OpenRouter в браузере — только `OPENROUTER_API_KEY` как secret у воркера.

---

## 🧪 Примеры запросов

**multipart**

```bash
curl -X POST "https://<worker>/v1/vision/analyze" \
  -F "file=@/path/to/img.jpg;type=image/jpeg" \
  -F "prompt=Опиши изображение"
```

**JSON + URL**

```bash
curl -X POST "https://<worker>/v1/vision/analyze" \
  -H "content-type: application/json" \
  -d '{"prompt":"Что на фото?","image_url":"https://.../cat.jpg"}'
```

**Stream (SSE)**

```bash
curl -N -X POST "https://<worker>/v1/vision/stream" \
  -H "content-type: application/json" \
  -d '{"prompt":"Подробно опиши","image_url":"https://.../cat.jpg","stream":true}'
```

---

## 🧯 Troubleshooting

* **401 `No auth credentials found`** — не подхватился секрет.

  * Проверь `npx wrangler secret list` (должно быть имя `OPENROUTER_API_KEY`).
  * Для `dev` нужен `.dev.vars` и перезапуск `wrangler dev`.
* **CORS ошибка в браузере** — проверь список разрешённых origin’ов в воркере.
* **Vercel 404** — проверь Root Directory, что распознан Next.js и запускается `next build`.
* **413** — файл слишком большой; уменьшите изображение.

---

## 🗺️ TODO / дорожная карта

* [ ] **Авторизация** клиента (Bearer-токен или HMAC-подпись к воркеру).
* [ ] **Rate limiting** / защита от абуза (Cloudflare Turnstile / IP-квоты).
* [ ] **UI стрима** на фронте (SSE, постепенный вывод).
* [ ] Выбор **модели** на фронте; фолбэк при недоступности (router по списку).
* [ ] Лимиты/валидация на фронте (preview, resize/компрессия перед отправкой).
* [ ] Стандартизировать ошибки (карта кодов 4xx/5xx, user-friendly сообщения).
* [ ] **Логирование** и `request_id`, метрики (usage, latency, provider).
* [ ] Кэширование ответов/трассировка (опционально KV/R2).
* [ ] Поддержка **нескольких изображений** в одном запросе.
* [ ] E2E-тесты (Playwright) + CI (lint/build).
* [ ] Страница /about + простая документация API (OpenAPI YAML).
* [ ] Ограничение CORS по средам (dev/prod) через переменные.

---

## ✅ Статус

* ✔ Worker задеплоен на Cloudflare.
* ✔ API отвечает по JSON/multipart и поддерживает SSE.
* ✔ Фронт собирается локально и на Vercel, умеет отправлять картинки и показывать ответы.

Готово — можно использовать как лёгкий «шлюз» к любым VLMM в OpenRouter и развивать дальше.
