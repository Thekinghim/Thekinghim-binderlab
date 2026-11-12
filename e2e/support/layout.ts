/**
 * Layoutkontrollen för mobil (körs i sidan med page.evaluate): sidan går inte att skrolla i
 * sidled, inget sticker ut ur sin förälder och tryckytor är minst 44 × 44 px. Se
 * e2e/11-mobil-layout.e2e.test.ts för reglerna och undantagen.
 */

export interface Problem {
  readonly kind: "sidled" | "utanför" | "liten";
  readonly what: string;
}

/** Körs i sidan: allt som är fel med layouten på den här skärmen. */
export function inspect(): Problem[] {
  const MIN = 44;
  const problems: Problem[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > Math.min(window.innerWidth, window.screen.width)) {
    problems.push({
      kind: "sidled",
      what: `sidan är ${doc.scrollWidth} px bred på en ${Math.min(window.innerWidth, window.screen.width)} px skärm`,
    });
  }
  const main = document.querySelector("main") ?? document.body;

  function describeEl(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const label =
      el.getAttribute("aria-label") ??
      (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
    return `${tag}${cls ? `.${cls}` : ""} "${label}"`;
  }

  function hidden(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") return true;
    // Skärmläsartext (sr-only) klipps till 1 px.
    if (s.clipPath === "inset(50%)" || (s.position === "absolute" && r.width <= 1)) return true;
    return el.closest("[aria-hidden='true'], [inert]") !== null;
  }

  // 2. Element som sticker ut ur sin förälder.
  const scrolls = (s: CSSStyleDeclaration) =>
    s.overflowX === "auto" ||
    s.overflowX === "scroll" ||
    s.overflowX === "hidden" ||
    s.overflowX === "clip";
  for (const el of Array.from(main.querySelectorAll("*"))) {
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const parent = el.parentElement;
    if (!parent || hidden(el)) continue;
    const s = getComputedStyle(el);
    if (s.position === "absolute" || s.position === "fixed") continue;
    const ps = getComputedStyle(parent);
    if (scrolls(ps) || ps.display === "contents") continue;
    // Tabellceller mäts mot sin tabell (raden kan vara smalare i vissa motorer).
    if (s.display.startsWith("table") && s.display !== "table") continue;
    const r = el.getBoundingClientRect();
    // En skrollruta som går ut i sidans marginal (kant till kant på mobilen) är med flit, så
    // länge den håller sig på skärmen.
    if (
      scrolls(s) &&
      r.left >= -0.5 &&
      r.right <= Math.min(window.innerWidth, window.screen.width) + 0.5
    )
      continue;
    const p = parent.getBoundingClientRect();
    const over = Math.max(r.right - p.right, p.left - r.left);
    if (over > 1.5) {
      problems.push({
        kind: "utanför",
        what: `${describeEl(el)} sticker ut ${Math.round(over)} px ur ${describeEl(parent)}`,
      });
    }
  }

  // 3. Små tryckytor.
  const targets = main.querySelectorAll<HTMLElement>(
    "a[href], button, summary, select, textarea, input:not([type='hidden']), [role='button'], [role='tab'], [role='radio'], [role='switch'], [role='checkbox']",
  );
  const seen = new Set<Element>();

  function pseudoBox(el: Element, which: "::before" | "::after", base: DOMRect) {
    const s = getComputedStyle(el, which);
    if (s.content === "none" || s.content === "normal" || s.position !== "absolute") return null;
    const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : NaN);
    const [t, b, l, rr] = [px(s.top), px(s.bottom), px(s.left), px(s.right)];
    const h = Number.isFinite(t) && Number.isFinite(b) ? base.height - t - b : px(s.height);
    const w = Number.isFinite(l) && Number.isFinite(rr) ? base.width - l - rr : px(s.width);
    return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
  }

  function inlineInText(el: HTMLElement): boolean {
    if (el.tagName !== "A") return false;
    if (getComputedStyle(el).display !== "inline") return false;
    const parent = el.parentElement;
    if (!parent) return false;
    // Löptext: föräldern har egen text utöver länken.
    return Array.from(parent.childNodes).some(
      (n) => n !== el && n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 1,
    );
  }

  for (const raw of Array.from(targets)) {
    let el: HTMLElement = raw;
    // En kryssruta eller radioknapp trycks via sin etikett.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      const label =
        el.closest("label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      if (label instanceof HTMLElement) el = label;
    }
    // Ett element inne i en annan tryckyta (t.ex. en etikett runt en kryssruta) mäts en gång.
    if (seen.has(el)) continue;
    seen.add(el);
    if (hidden(el) || inlineInText(el)) continue;
    if (el instanceof HTMLButtonElement && el.closest("a[href]")) continue;
    if (el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    let w = r.width;
    let h = r.height;
    for (const which of ["::before", "::after"] as const) {
      const box = pseudoBox(el, which, r);
      if (box) {
        w = Math.max(w, box.w);
        h = Math.max(h, box.h);
      }
    }
    if (w + 0.5 < MIN || h + 0.5 < MIN) {
      problems.push({
        kind: "liten",
        what: `${describeEl(el)} är ${Math.round(w)} × ${Math.round(h)} px`,
      });
    }
  }
  return problems;
}
