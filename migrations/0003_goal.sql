-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
-- Objectif d'un monde-défi, encodé « ge:12:600 » (au moins 600 cellules de la
-- matière 12). NULL pour un monde ordinaire.
ALTER TABLE worlds ADD COLUMN goal TEXT;
