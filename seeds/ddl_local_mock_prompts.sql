-- Local DDL + mock data for prompts table (Cloudflare D1 / SQLite)
-- WARNING: Drops and recreates the table. Use ONLY in local/dev.
-- Usage:
--   wrangler d1 execute vlm-api-db --file=./seeds/ddl_local_mock_prompts.sql

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS prompts;

-- Schema (kept consistent with migrations/0001 + 0002 + 0003)
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_namespace   TEXT NOT NULL DEFAULT 'default',
  prompt_name        TEXT NOT NULL,
  prompt_version     INTEGER NOT NULL DEFAULT 1,
  prompt_lang        TEXT NOT NULL DEFAULT 'ru',
  prompt_text        TEXT NOT NULL,
  prompt_tags        TEXT NOT NULL DEFAULT '[]',
  prompt_priority    INTEGER NOT NULL DEFAULT 0,   -- lower number = higher priority
  prompt_is_active   INTEGER NOT NULL DEFAULT 1,   -- 1/0
  prompt_is_default  INTEGER NOT NULL DEFAULT 0,   -- 1/0 (single per namespace+lang)
  prompt_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  prompt_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_ns_name_ver
  ON prompts(prompt_namespace, prompt_name, prompt_version);

CREATE INDEX IF NOT EXISTS ix_prompts_ns               ON prompts(prompt_namespace);
CREATE INDEX IF NOT EXISTS ix_prompts_lang             ON prompts(prompt_lang);
CREATE INDEX IF NOT EXISTS ix_prompts_active           ON prompts(prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_ns_lang_active   ON prompts(prompt_namespace, prompt_lang, prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_default          ON prompts(prompt_namespace, prompt_lang, prompt_is_default);

CREATE TRIGGER IF NOT EXISTS trg_prompts_updated_at
AFTER UPDATE ON prompts
FOR EACH ROW
BEGIN
  UPDATE prompts
  SET prompt_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE prompt_id = NEW.prompt_id;
END;

-- Mock data covering all fields and cases
-- Namespace: default, Lang: ru (with default)
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','order_parser_ru',1,'ru',
 'Вы — модуль извлечения структурированных данных из заказов...','["parser","ru","orders"]', 0,
 1, 1,
 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Same name with higher version, not default
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','order_parser_ru',2,'ru',
 'Версия 2: обновлённые инструкции...','["parser","ru","orders","v2"]', 1,
 1, 0,
 '2025-09-10T10:00:00.000Z', '2025-09-10T10:00:00.000Z'
);

-- Another RU prompt
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','general_qa_ru',1,'ru',
 'Вы — помощник по вопросам и ответам...','["qa","ru"]', 10,
 1, 0,
 '2025-09-11T08:00:00.000Z', '2025-09-11T08:00:00.000Z'
);

-- EN prompt with default
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','general_qa_en',1,'en',
 'You are a helpful Q&A assistant...','["qa","en"]', 5,
 1, 1,
 '2025-09-12T09:00:00.000Z', '2025-09-12T09:00:00.000Z'
);

-- Different namespace (vision), negative priority (higher prio)
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('vision','caption',1,'ru',
 'Опишите изображение кратко и точно.','["vision","caption","ru"]', -5,
 1, 0,
 '2025-09-13T12:00:00.000Z', '2025-09-13T12:00:00.000Z'
);

-- Inactive prompt
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','archived_example',1,'ru',
 'Неактивный пример.','["archived","ru"]', 99,
 0, 0,
 '2025-09-14T15:30:00.000Z', '2025-09-14T15:30:00.000Z'
);

-- Complex tags
INSERT INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_priority,
  prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default','tagged_example',1,'ru',
 'Пример с набором тэгов.','["ru","alpha","beta","gamma"]', 2,
 1, 0,
 '2025-09-15T10:00:00.000Z', '2025-09-15T10:00:00.000Z'
);

-- Ensure updated_at trigger works via an update
UPDATE prompts SET prompt_text = 'You are a helpful Q&A assistant (edited)...'
WHERE prompt_namespace = 'default' AND prompt_name = 'general_qa_en' AND prompt_version = 1;

PRAGMA foreign_keys = ON;

