/**
 * Läser färgtokens ur src/styles/tokens.css (på servern) och räknar kontrast
 * enligt WCAG 2.2. Ren TS utan React, så att tabellen på /design alltid
 * visar det som faktiskt står i källan.
 */

export type ThemeName = "dark" | "light";
export type ThemeTokens = Record<ThemeName, Record<string, string>>;

/** Plockar ut --bl-*-deklarationerna i det mörka (:root) och det ljusa blocket. */
export function parseThemeTokens(css: string): ThemeTokens {
  const block = (selector: RegExp) => {
    const m = selector.exec(css);
    if (!m) return {};
    const start = css.indexOf("{", m.index);
    const end = css.indexOf("}", start);
    const out: Record<string, string> = {};
    const body = css.slice(start + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const decl of body.split(";")) {
      const [k, ...v] = decl.split(":");
      const key = k?.trim();
      if (key?.startsWith("--bl-")) out[key] = v.join(":").trim();
    }
    return out;
  };
  return {
    dark: block(/:root,\s*\[data-theme="dark"\]\s*\{/),
    light: block(/\[data-theme="light"\]\s*\{/),
  };
}

type RGBA = [number, number, number, number];

function parseColor(value: string): RGBA | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1] ?? "";
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(
    v,
  );
  if (rgb) {
    const alpha = rgb[4]
      ? rgb[4].endsWith("%")
        ? parseFloat(rgb[4]) / 100
        : parseFloat(rgb[4])
      : 1;
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  return null;
}

/** Följer var(--x) inom samma läge. */
export function resolveToken(tokens: Record<string, string>, name: string, depth = 0): string {
  const v = tokens[name] ?? "";
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && depth < 4) return resolveToken(tokens, ref[1] ?? "", depth + 1);
  return v;
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: RGBA): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Kontrast mellan två tokenvärden. Genomskinliga färger läggs först på bakgrunden. */
export function contrast(fg: string, bg: string): number | null {
  const b = parseColor(bg);
  const f = parseColor(fg);
  if (!b || !f) return null;
  const solid = over(f, b);
  const l1 = luminance(solid);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Visningsvärde: hex i versaler, rgb() förkortat. */
export function displayValue(value: string): string {
  const v = value.trim();
  if (v.startsWith("#")) return v.toUpperCase();
  const c = parseColor(v);
  if (c && c[3] < 1) {
    const hex = c
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    return `#${hex} · ${Math.round(c[3] * 100)} %`;
  }
  return v;
}
