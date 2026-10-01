/**
 * La porte du son, côté page. Le synthétiseur (sound.ts) n'est chargé qu'au
 * premier geste du joueur : un navigateur refuse de jouer avant, et ses 3 Ko
 * n'ont rien à faire dans ce qui s'affiche d'abord — la CI y tient un budget
 * (84 Kio), que la page frôlait déjà. D'ici là, on retient les réglages et le
 * fond sonore ; ce qui explose avant le premier clic n'est pas joué.
 */
import type { Heard, Hum } from "./sim/sandbox.ts";

type Sound = typeof import("./sound.ts");

let sound: Sound | null = null;
let loading = false;
let on = true;
let level = 0.5;
let hum: Hum = { fire: 0, lava: 0, rain: 0 };

/** À appeler une fois, depuis main.ts. Chaque geste relance aussi un contexte que le navigateur aurait suspendu. */
export function initSound(): void {
  const wake = (): void => {
    if (!on) return;
    if (sound) { sound.unlock(); return; }
    if (loading) return;
    loading = true;
    void import("./sound.ts").then((m) => {
      sound = m;
      m.soundVolume(level);
      m.setHum(hum);
      m.soundOn(on);
    });
  };
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, wake, { capture: true });
}

/** Coupe ou rend le son (case du panneau, touche `m`). */
export function soundOn(v: boolean): void {
  on = v;
  sound?.soundOn(v);
}

/** Volume général, 0 à 1. */
export function soundVolume(v: number): void {
  level = v;
  sound?.soundVolume(v);
}

/** Le fond sonore, relevé avec les stats du bac. */
export function setHum(next: Hum): void {
  hum = next;
  sound?.setHum(next);
}

/** Ce qu'une frame a fait d'audible. */
export function hear(heard: Heard | null, width: number): void {
  if (heard) sound?.hear(heard, width);
}
