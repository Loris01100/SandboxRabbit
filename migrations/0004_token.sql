-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
-- Jeton de suppression, tiré au sort à la sauvegarde et rendu une seule fois à
-- celui qui dépose le monde. Il ne ressort jamais des routes de lecture : sans
-- lui, n'importe qui pouvait vider la galerie. Les mondes d'avant ont NULL,
-- donc plus personne ne les supprime — le ménage nocturne s'en charge.
ALTER TABLE worlds ADD COLUMN token TEXT;
