/**
 * Jour / nuit, réglé dans la fenêtre Paramètres. Un seul interrupteur :
 * `color-scheme` sur <html>. Le CSS n'a que des `light-dark()`, et les
 * contrôles natifs (menus, cases, curseurs) suivent. « Système » n'enregistre
 * rien : c'est alors le réglage du système qui décide, et la page le suit.
 */
import { forget, read, write } from "./ui.ts";

const THEME = "sandbox-rabbit:theme";
const themeSelect = document.querySelector<HTMLSelectElement>("#theme")!;

function setTheme(mode: string): void {
  document.documentElement.style.colorScheme = mode;
  themeSelect.value = mode;
  if (mode) write(THEME, mode);
  else forget(THEME);
}

const storedTheme = read(THEME);
setTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "");
themeSelect.addEventListener("change", () => setTheme(themeSelect.value));
