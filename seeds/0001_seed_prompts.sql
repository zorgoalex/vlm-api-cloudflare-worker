-- Idempotent seed for prompts
INSERT OR IGNORE INTO prompts(
  prompt_namespace, prompt_name, prompt_version, prompt_lang,
  prompt_text, prompt_tags, prompt_is_active, prompt_is_default,
  prompt_created_at, prompt_updated_at
) VALUES
('default', 'order_parser_ru', 1, 'ru', 'Вы — модуль извлечения структурированных данных из заказов...', '["parser","ru","orders"]', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('default', 'general_qa_ru', 1, 'ru', 'Вы — помощник по вопросам и ответам...', '["qa","ru"]', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

