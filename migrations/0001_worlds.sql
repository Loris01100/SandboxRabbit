-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Comptées par `store.see`, sur le seul chemin de chargement de la galerie.
  views INTEGER NOT NULL DEFAULT 0,
  -- Objectif d'un monde-défi (« ge:12:600 »), NULL pour un monde ordinaire.
  goal TEXT
);
CREATE INDEX IF NOT EXISTS worlds_created_at ON worlds (created_at DESC);
