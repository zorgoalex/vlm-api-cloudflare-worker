CREATE TRIGGER IF NOT EXISTS trg_prompts_updated_at
AFTER UPDATE ON prompts
FOR EACH ROW
BEGIN
  UPDATE prompts
  SET prompt_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE prompt_id = NEW.prompt_id;
END;
