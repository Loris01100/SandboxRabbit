/**
 * Jour / nuit. Un seul interrupteur : `color-scheme` sur <html>. Le CSS n'a que
 * des `light-dark()`, et les contrôles natifs (menus, cases, curseurs) suivent.
 * Sans rien en mémoire, c'est le réglage du système qui décide.
 */
const THEME = "sandbox-rabbit:theme";
const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;

function setTheme(mode: "light" | "dark" | ""): void {
  document.documentElement.style.colorScheme = mode;
  const night = mode ? mode === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  themeButton.textContent = night ? "☀" : "🌙";
  themeButton.title = night ? "Passer en mode jour" : "Passer en mode nuit";
  themeButton.setAttribute("aria-label", themeButton.title);
  if (mode) localStorage.setItem(THEME, mode);
  else localStorage.removeItem(THEME);
}

const storedTheme = localStorage.getItem(THEME);
setTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "");
themeButton.addEventListener("click", () => {
  setTheme(themeButton.textContent === "☀" ? "light" : "dark");
});
// Le système change d'avis (coucher du soleil) : on suit, tant que rien n'est imposé.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!localStorage.getItem(THEME)) setTheme("");
});
