CREATE TABLE IF NOT EXISTS prompts (
  prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_namespace   TEXT NOT NULL DEFAULT 'default',
  prompt_name        TEXT NOT NULL,
  prompt_version     INTEGER NOT NULL DEFAULT 1,
  prompt_lang        TEXT NOT NULL DEFAULT 'ru',
  prompt_text        TEXT NOT NULL,
  prompt_tags        TEXT NOT NULL DEFAULT '[]',
  prompt_is_active   INTEGER NOT NULL DEFAULT 1,
  prompt_is_default  INTEGER NOT NULL DEFAULT 0,
  prompt_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  prompt_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_ns_name_ver ON prompts(prompt_namespace, prompt_name, prompt_version);

CREATE INDEX IF NOT EXISTS ix_prompts_ns               ON prompts(prompt_namespace);
CREATE INDEX IF NOT EXISTS ix_prompts_lang             ON prompts(prompt_lang);
CREATE INDEX IF NOT EXISTS ix_prompts_active           ON prompts(prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_ns_lang_active   ON prompts(prompt_namespace, prompt_lang, prompt_is_active);
CREATE INDEX IF NOT EXISTS ix_prompts_default          ON prompts(prompt_namespace, prompt_lang, prompt_is_default);
