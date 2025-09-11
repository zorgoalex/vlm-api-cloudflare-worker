-- Таблица промптов (универсальная БД vlm-api-db)
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_namespace   TEXT NOT NULL DEFAULT 'default',
  prompt_name        TEXT NOT NULL,
  prompt_version     INTEGER NOT NULL DEFAULT 1,
  prompt_lang        TEXT NOT NULL DEFAULT 'ru',
  prompt_text        TEXT NOT NULL,
  prompt_tags        TEXT NOT NULL DEFAULT '[]',   -- JSON-массив строк
  prompt_is_active   INTEGER NOT NULL DEFAULT 1,   -- 1/0
  prompt_is_default  INTEGER NOT NULL DEFAULT 0,   -- 1/0 (только один на namespace+lang)
  prompt_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  prompt_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Уникальность версии внутри (namespace, name)
CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_ns_name_ver
  ON prompts(prompt_namespace, prompt_name, prompt_version);

-- Индексы под фильтры
CREATE INDEX IF NOT EXISTS ix_prompts_ns               ON prompts(prompt_namespace);
CREATE INDEX IF NOT EXISTS ix_prompts_lang             ON prompts(prompt_lang);
CREATE INDEX IF NOT EXISTS ix_prompts_active           ON prompts(prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_ns_lang_active   ON prompts(prompt_namespace, prompt_lang, prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_default          ON prompts(prompt_namespace, prompt_lang, prompt_is_default);

-- (Опционально, если доступно) частичный уникальный индекс: один дефолт на (ns, lang)
-- CREATE UNIQUE INDEX IF NOT EXISTS ux_one_default_per_lang
--   ON prompts(prompt_namespace, prompt_lang)
--   WHERE prompt_is_default = 1;

-- Триггер на обновление updated_at
CREATE TRIGGER IF NOT EXISTS trg_prompts_updated_at
AFTER UPDATE ON prompts
FOR EACH ROW
BEGIN
  UPDATE prompts
  SET prompt_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE prompt_id = NEW.prompt_id;
END;
