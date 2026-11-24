// theme module (step 4.1): the one place client code gets colors and fonts.
// repo-root theme.json is the authority (palette copied from the prototype);
// the react UI reads the CSS variables applyTheme() sets on :root, the canvas
// renderer imports `theme` directly. no hardcoded hex outside this pair.
import theme from "../../theme.json";

export { theme };

// hex color -> rgba() string with the given alpha (accent-derived shades)
export function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// set every UI CSS variable on :root; called once before the react root mounts.
// theme.ui keys are the variable names themselves (kebab-case, no -- prefix).
export function applyTheme(): void {
  const root = document.documentElement.style;
  root.setProperty("--bg", theme.background);
  root.setProperty("--accent", theme.accent);
  // toast/label border shade derived from the accent (prototype: rgba(accent,.5))
  root.setProperty("--accent-dim", rgba(theme.accent, 0.5));
  // join-screen toggle track when on (prototype: rgba(accent,.85))
  root.setProperty("--accent-strong", rgba(theme.accent, 0.85));
  // SUIT button fill (prototype: rgba(accent,.12), notes/002)
  root.setProperty("--accent-faint", rgba(theme.accent, 0.12));
  root.setProperty("--font-mono", theme.fonts.mono);
  root.setProperty("--font-sans", theme.fonts.sans);
  for (const [k, v] of Object.entries(theme.ui)) root.setProperty(`--${k}`, v);
}
