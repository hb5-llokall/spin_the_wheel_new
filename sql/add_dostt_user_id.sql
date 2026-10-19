ALTER TABLE players ALTER COLUMN mobile_number DROP NOT NULL;
ALTER TABLE players ADD COLUMN IF NOT EXISTS dostt_user_id INTEGER UNIQUE;
CREATE INDEX IF NOT EXISTS idx_players_dostt_user_id ON players(dostt_user_id);
