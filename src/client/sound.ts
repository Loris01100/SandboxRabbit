/**
 * Le son du bac, fabriqué sur place par Web Audio : aucun fichier à
 * télécharger (la page tient dans 80 Kio), rien qu'un peu de bruit qu'on
 * filtre. Une explosion est un bruit blanc dont un passe-bas se referme, le
 * feu des claquements épars, la lave un bruit brun très grave, la pluie un
 * souffle aigu, le tonnerre une explosion lente.
 *
 * Le bac ne joue rien lui-même : il dit ce qui est arrivé (`Heard` à chaque
 * frame, `Hum` avec les stats, sim/sandbox.ts) et la page en fait du son.
 * Le tirage d'ici vient de `crypto.getRandomValues()` : il ne touche que
 * l'oreille, jamais la partie.
 *
 * Chargé par audio.ts au premier geste du joueur, pas avant : un navigateur
 * refuse un contexte audio qui démarre sans geste, et la page initiale tient
 * dans son budget. Aucun DOM ni `AudioContext` au chargement : test/ui.ts
 * importe les fonctions pures.
 */
import type { Heard, Hum } from "./sim/sandbox.ts";

/** Les familles de sons, chacune avec son curseur dans l'onglet Son (`data-mix` d'index.html). */
export const MIX = ["booms", "thunder", "fire", "lava", "rain"] as const;
export type Mix = Record<(typeof MIX)[number], number>;

/** Flammes à partir desquelles le feu crépite à plein volume : un bel incendie de forêt. */
const FULL_FIRE = 3000;
/** Pareil pour la lave : une coulée qui remplit le bas d'un 320×180. */
const FULL_LAVA = 4000;
/** Explosions jouées à la fois, au plus : une chaîne de TNT en lance cent, l'oreille n'en entend qu'un grondement. */
const VOICES = 6;

/**
 * Volume d'un fond sonore selon le nombre de cellules qui le font, 0 à 1.
 * Logarithmique : la première bougie s'entend, et un incendie qui double ne
 * sonne pas deux fois plus fort — en linéaire, une flamme seule était muette.
 */
export function humLevel(cells: number, full: number): number {
  if (!(cells > 0)) return 0;
  return Math.min(1, Math.log1p(cells) / Math.log1p(full));
}

/** Volume de la pluie selon la météo (0 sec, 1 pluie, 2 orage, 3 gros orage) : l'orage ajoute des éclairs, à peine plus d'eau. */
export function rainLevel(weather: number): number {
  return [0, 0.5, 0.6, 0.75][weather] ?? 0;
}

/**
 * Une explosion à jouer : volume (0 à 1), durée en secondes et fréquence de
 * départ du passe-bas. Le plus gros rayon donne le ton ; le nombre
 * d'explosions de la frame n'ajoute qu'un peu de volume — une chaîne de TNT
 * sonne comme un gros coup, pas comme cent petits saturés.
 */
export function boomShape(booms: number, loudest: number): { gain: number; seconds: number; cutoff: number } {
  const size = Math.min(1, loudest / 16); // 16 : la bombe atomique (NUKE)
  return {
    gain: Math.min(1, 0.35 + 0.45 * size + 0.08 * Math.log2(Math.max(1, booms))),
    seconds: 0.35 + 2.2 * size * size,
    cutoff: 2600 - 1800 * size,
  };
}

/** Position stéréo d'une colonne du bac, de -0,8 (gauche) à 0,8 : jamais tout d'un côté, ça gêne au casque. */
export function panOf(x: number, width: number): number {
  if (!(width > 1)) return 0;
  return Math.max(-0.8, Math.min(0.8, ((2 * x) / (width - 1) - 1) * 0.8));
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let white: AudioBuffer | null = null;
let fireGain: GainNode | null = null;
let lavaGain: GainNode | null = null;
let rainGain: GainNode | null = null;
let enabled = true;
let volume = 0.5;
let playing = 0;
let hum: Hum = { fire: 0, lava: 0, rain: 0 };
/** Volume de chaque famille, 0 à 1, par-dessus le volume général. */
let mix: Mix = { booms: 1, thunder: 1, fire: 1, lava: 1, rain: 1 };

// Le bruit tire des centaines de milliers d'échantillons : remplir par blocs
// évite un appel à Web Crypto pour chacun, sous son plafond de 65 536 octets.
const draws = new Uint32Array(4096);
let drawIndex = draws.length;
function random(): number {
  if (drawIndex === draws.length) {
    crypto.getRandomValues(draws);
    drawIndex = 0;
  }
  return draws[drawIndex++] / 0x1_0000_0000;
}

/** Un tampon de `seconds` secondes rempli par `fill(i)` (mono). */
function buffer(c: AudioContext, seconds: number, fill: (i: number, rate: number) => number): AudioBuffer {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const data = b.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = fill(i, c.sampleRate);
  return b;
}

/** Un fond sonore en boucle : `source` → filtre → gain (à 0 tant que rien ne sonne) → master. */
function loop(c: AudioContext, b: AudioBuffer, type: BiquadFilterType, frequency: number): GainNode {
  const src = c.createBufferSource();
  src.buffer = b;
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const gain = c.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(master!);
  src.start();
  return gain;
}

/**
 * Crée le contexte, ou relance celui que le navigateur a suspendu. Appelé à
 * chaque geste du joueur (audio.ts) : sans geste, le contexte resterait
 * suspendu et chaque son serait perdu en silence.
 */
export function unlock(): void {
  if (!enabled) return;
  if (ctx) { if (ctx.state === "suspended" && !document.hidden) void ctx.resume(); return; }
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  white = buffer(ctx, 2, () => random() * 2 - 1);
  // Feu : des claquements épars, chacun une impulsion qui retombe en 3 ms.
  let pop = 0;
  const crackle = buffer(ctx, 3, (_i, rate) => {
    if (random() < 40 / rate) pop = 0.4 + random() * 0.6;
    pop *= 1 - 300 / rate;
    return (random() * 2 - 1) * (pop + 0.04);
  });
  // Lave : bruit brun (une marche au hasard qui se rappelle vers zéro), tout en grave.
  let walk = 0;
  const brown = buffer(ctx, 3, () => (walk = (walk + (random() * 2 - 1) * 0.02) * 0.995) * 3);
  fireGain = loop(ctx, crackle, "highpass", 900);
  lavaGain = loop(ctx, brown, "lowpass", 220);
  rainGain = loop(ctx, white, "bandpass", 2800);
  // Onglet caché : on se tait, et le contexte suspendu ne coûte plus rien.
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else if (enabled) void ctx.resume();
  });
  setHum(hum);
}

/** Coupe ou rend le son. */
export function soundOn(on: boolean): void {
  enabled = on;
  if (!ctx) return unlock();
  if (on && !document.hidden) void ctx.resume();
  else if (!on) void ctx.suspend();
}

/** Volume général, 0 à 1. */
export function soundVolume(v: number): void {
  volume = v;
  if (ctx && master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
}

/** Volume de chaque famille de sons, 0 à 1 : les fonds sonores suivent aussitôt, les coups au suivant. */
export function soundMix(next: Mix): void {
  mix = { ...next };
  setHum(hum);
}

/** Les fonds sonores, mis à jour deux fois par seconde (stats) : le fondu de 0,3 s couvre l'écart. */
export function setHum(next: Hum): void {
  hum = next;
  if (!ctx || !fireGain || !lavaGain || !rainGain) return;
  const t = ctx.currentTime;
  fireGain.gain.setTargetAtTime(0.5 * mix.fire * humLevel(next.fire, FULL_FIRE), t, 0.3);
  lavaGain.gain.setTargetAtTime(0.9 * mix.lava * humLevel(next.lava, FULL_LAVA), t, 0.3);
  rainGain.gain.setTargetAtTime(0.18 * mix.rain * rainLevel(next.rain), t, 0.6);
}

/** Un coup de bruit qui s'éteint : explosion ou tonnerre. */
function burst(gain: number, seconds: number, cutoff: number, floor: number, pan: number, delay = 0): void {
  // Coupé par son curseur : rien à jouer (et une rampe exponentielle ne part pas de zéro).
  if (!ctx || !master || !white || playing >= VOICES || gain < 0.001) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = white;
  src.loop = true;
  src.playbackRate.value = 0.7 + random() * 0.3;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(cutoff, t);
  filter.frequency.exponentialRampToValueAtTime(floor, t + seconds);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.008);
  env.gain.exponentialRampToValueAtTime(0.001, t + seconds);
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  src.connect(filter).connect(env).connect(panner).connect(master);
  playing++;
  src.onended = () => { playing--; };
  src.start(t);
  src.stop(t + seconds + 0.05);
}

/** Ce qu'une frame a fait d'audible : `width` place le son à gauche ou à droite. */
export function hear(heard: Heard | null, width: number): void {
  if (!heard || !ctx || !enabled || ctx.state !== "running") return;
  if (heard.booms > 0) {
    const { gain, seconds, cutoff } = boomShape(heard.booms, heard.loudest);
    burst(gain * mix.booms, seconds, cutoff, 40, panOf(heard.at, width));
  }
  if (heard.bolts > 0) {
    const pan = panOf(heard.boltAt, width);
    // Le claquement de l'éclair, puis le roulement qui arrive un peu après.
    burst(0.5 * mix.thunder, 0.15, 6000, 800, pan);
    burst(0.7 * mix.thunder, 2.8, 500, 30, pan, 0.25 + random() * 0.4);
  }
}
