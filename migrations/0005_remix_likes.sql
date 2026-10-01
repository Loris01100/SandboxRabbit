-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
-- Remix : le monde dont celui-ci est repris (chargé depuis la galerie, modifié,
-- resauvegardé). NULL pour un monde parti de zéro. Pas de clé étrangère : le
-- parent peut être effacé par le ménage nocturne, l'enfant garde son lien et la
-- galerie dit « d'un monde disparu ».
ALTER TABLE worlds ADD COLUMN parent TEXT;
-- Votes (« J'aime ») : un compteur, comme les vues. Les mondes les plus aimés
-- sont gardés par le ménage nocturne au même titre que les plus vus.
ALTER TABLE worlds ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
