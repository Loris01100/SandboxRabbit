-- Appliquer : npx wrangler d1 migrations apply sandbox-rabbit --remote
-- Qui a déjà voté pour un monde, et qui l'a déjà regardé : un vote et une vue
-- par IP et par monde. On n'y garde jamais l'IP, seulement un SHA-256 de
-- l'IP, du monde et d'un sel (`who()` de src/worker/app.ts) : impossible d'y
-- retrouver quelqu'un, ou de suivre un même visiteur d'un monde à l'autre.
-- Avant, une seule IP revotait à volonté et gonflait les vues au rythme du
-- débit permis. Les lignes d'un monde effacé partent au ménage nocturne.
CREATE TABLE IF NOT EXISTS votes (
  world TEXT NOT NULL,
  voter TEXT NOT NULL,
  PRIMARY KEY (world, voter)
);
CREATE TABLE IF NOT EXISTS sightings (
  world TEXT NOT NULL,
  viewer TEXT NOT NULL,
  PRIMARY KEY (world, viewer)
);
