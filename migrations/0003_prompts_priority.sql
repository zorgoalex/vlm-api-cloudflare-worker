-- Add priority field to prompts: lower value = higher priority
ALTER TABLE prompts ADD COLUMN prompt_priority INTEGER NOT NULL DEFAULT 0;

