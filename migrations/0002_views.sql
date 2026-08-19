-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
ALTER TABLE worlds ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
