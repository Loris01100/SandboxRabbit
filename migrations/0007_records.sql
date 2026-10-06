-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
-- Le classement des défis livrés : un temps (en ticks de simulation, pas
-- l'horloge murale, qu'aucun rejeu ne prouve), le pseudo de qui l'a fait, et
-- son rejeu (`film`, compressé par `pack()` de src/client/replay.ts). Le
-- Worker ne le vérifie pas : chaque visiteur rejoue les records qu'il affiche
-- (src/client/sim/verdict.ts). Le ménage nocturne garde les meilleurs de
-- chaque défi.
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  name TEXT NOT NULL,
  ticks INTEGER NOT NULL,
  film TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_by_time ON records (challenge, ticks, created_at);
