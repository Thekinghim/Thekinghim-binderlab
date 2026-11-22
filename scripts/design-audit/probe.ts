/**
 * Mätningen i sidan. `probe` körs i webbläsaren med detect.ts-funktionerna i samma scope
 * (probeScript bygger skriptet av deras källkod), så den får inte heller använda importer.
 */

import * as detect from "./detect";

/** detect.ts-funktionerna som probe får som argument (i sidan: samma källkod). */
export type Helpers = typeof HELPERS;
const HELPERS = {
  parseFontFamilies: detect.parseFontFamilies,
  normalizeFamily: detect.normalizeFamily,
  classifyFont: detect.classifyFont,
  isWrongFont: detect.isWrongFont,
  isSpacedUppercase: detect.isSpacedUppercase,
  legacyClasses: detect.legacyClasses,
  legacyVariables: detect.legacyVariables,
  findBlankGaps: detect.findBlankGaps,
  isPackTooSmall: detect.isPackTooSmall,
  isTruncated: detect.isTruncated,
  shortText: detect.shortText,
};

export type FindingType =
  | "font"
  | "uppercase-spaced"
  | "legacy-class"
  | "legacy-variable"
  | "overflow-x"
  | "truncated"
  | "blank-area"
  | "pack-image-small"
  | "console-error"
  | "http-error";

export interface RawFinding {
  type: FindingType;
  /** Vad som är fel, t.ex. "Geist Mono" eller ".label text-subtle". */
  detail: string;
  text: string;
  selector: string;
  /** Elementets klasser, för att hitta komponenten i src. */
  className: string;
  /** Nyckel för att slå ihop likadana element (samma typ, detalj och klasser). */
  key: string;
}

export interface ProbeResult {
  findings: RawFinding[];
  textElements: number;
  documentHeight: number;
  scrollWidth: number;
  innerWidth: number;
  isV2Shell: boolean;
}

export interface ProbeOptions {
  phone: boolean;
  /** Högst så många fynd av samma nyckel markeras och rapporteras med exempel. */
  maxPerKey: number;
}

/** Körs i sidan. */
export function probe(opts: ProbeOptions, h: Helpers): ProbeResult {
  const findings: RawFinding[] = [];
  const perKey = new Map<string, number>();
  const marked: Element[] = [];

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 7) {
      const tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`${tag}#${node.id}`);
        break;
      }
      const classes = Array.from(node.classList)
        .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c))
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      let part = tag + classes;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(" > ");
  };

  const classOf = (el: Element): string =>
    typeof el.className === "string" ? el.className : (el.getAttribute("class") ?? "");

  const add = (
    type: FindingType,
    el: Element | null,
    detail: string,
    text: string,
    keyExtra = "",
  ): void => {
    const className = el ? classOf(el) : "";
    const key = `${type}|${detail}|${el ? el.tagName : ""}|${className}|${keyExtra}`;
    const n = perKey.get(key) ?? 0;
    perKey.set(key, n + 1);
    if (el && !marked.includes(el)) marked.push(el);
    if (n >= opts.maxPerKey) {
      // Bara räkningen: report.ts slår ihop på nyckeln.
      findings.push({ type, detail, text: "", selector: "", className, key });
      return;
    }
    findings.push({
      type,
      detail,
      text: h.shortText(text),
      selector: el ? cssPath(el) : "",
      className,
      key,
    });
  };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const check = (el as HTMLElement).checkVisibility;
    if (typeof check === "function") {
      return (el as HTMLElement).checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      });
    }
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const ownText = (el: Element): string => {
    let t = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) t += n.textContent ?? "";
    }
    if (!t.trim() && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      const input = el as HTMLInputElement;
      if (!["hidden", "checkbox", "radio", "range", "color", "file"].includes(input.type)) {
        t = input.value || input.placeholder || "";
      }
    }
    return t.trim();
  };

  const pinnedCache = new Map<Element, boolean>();
  const pinned = (el: Element | null): boolean => {
    if (!el || el === document.body) return false;
    const hit = pinnedCache.get(el);
    if (hit !== undefined) return hit;
    const pos = getComputedStyle(el).position;
    const value = pos === "fixed" || pos === "sticky" || pinned(el.parentElement);
    pinnedCache.set(el, value);
    return value;
  };

  // --- Textelement: typsnitt, versaler, avklippt text --------------------------------------
  const all = Array.from(document.body.querySelectorAll("*"));
  let textElements = 0;
  const contentIntervals: Array<[number, number]> = [];
  const sy = window.scrollY;
  for (const el of all) {
    if (el.closest("nextjs-portal, script, style, noscript, template")) continue;
    const text = ownText(el);
    const media = /^(IMG|SVG|CANVAS|VIDEO|svg)$/.test(el.tagName);
    if (!text && !media && !el.matches("input, select, textarea, button, [role='img']")) continue;
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // Fasta och klistrande delar (menyer, bottenrad) räknas inte som innehåll i en tom yta.
    if (!pinned(el)) contentIntervals.push([rect.top + sy, rect.bottom + sy]);
    if (!text) continue;
    textElements += 1;

    const font = h.classifyFont(s.fontFamily);
    const inHint = el.closest("kbd") !== null && el.closest("[data-ui='v2']") !== null;
    if (h.isWrongFont(font.kind, inHint)) {
      const label =
        h.normalizeFamily(font.family) + (font.kind === "monospace" ? " (monospace)" : "");
      add("font", el, label, text);
    }
    if (h.isSpacedUppercase(s.textTransform, s.letterSpacing, s.fontSize)) {
      const em = (parseFloat(s.letterSpacing) / parseFloat(s.fontSize)).toFixed(3);
      add("uppercase-spaced", el, `uppercase, letter-spacing ${em}em`, text);
    }
    const lineClamp =
      s.getPropertyValue("-webkit-line-clamp") || s.getPropertyValue("line-clamp") || "none";
    const box = el as HTMLElement;
    if (
      h.isTruncated({
        scrollWidth: box.scrollWidth,
        clientWidth: box.clientWidth,
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        overflowX: s.overflowX,
        textOverflow: s.textOverflow,
        lineClamp,
      }) &&
      !el.closest("[title]") &&
      !/sr-only/.test(classOf(el)) &&
      !el.closest("[aria-label]")
    ) {
      add("truncated", el, "avklippt utan title", box.textContent ?? text);
    }
  }

  // --- Gamla klasser och variabler (översta elementet i ett träd med samma klasser) -------
  for (const el of all) {
    if (el.closest("nextjs-portal, script, style, noscript, template")) continue;
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class");
    const legacy = cls ? h.legacyClasses(cls.split(/\s+/).filter(Boolean)) : [];
    const vars = h.legacyVariables(el.getAttribute("style") ?? "");
    if (legacy.length === 0 && vars.length === 0) continue;
    if (!visible(el)) continue;
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    if (legacy.length > 0) add("legacy-class", el, legacy.join(" "), text);
    if (vars.length > 0) add("legacy-variable", el, vars.join(" "), text);
  }

  // --- Packbilder under 32 px ------------------------------------------------------------
  for (const img of Array.from(document.querySelectorAll(".v2-pk, img[src*='/packs/']"))) {
    if (!visible(img)) continue;
    const hgt = img.getBoundingClientRect().height;
    if (h.isPackTooSmall(hgt)) {
      const parent = img.parentElement;
      add(
        "pack-image-small",
        img,
        `${Math.round(hgt)} px hög`,
        parent ? (parent.textContent ?? "") : "",
      );
    }
  }

  // --- Sidledes scroll på telefon -----------------------------------------------------------
  const doc = document.documentElement;
  const scrollWidth = doc.scrollWidth;
  if (opts.phone && scrollWidth > window.innerWidth) {
    const culprits: Element[] = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right <= window.innerWidth + 1 || r.width === 0) continue;
      let scroller = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) {
          scroller = true;
          break;
        }
      }
      if (scroller) continue;
      // Bara det yttersta elementet som sticker ut.
      if (culprits.some((c) => c.contains(el))) continue;
      culprits.push(el);
      if (culprits.length >= 5) break;
    }
    if (culprits.length === 0) {
      add("overflow-x", null, `sidan är ${scrollWidth} px bred (skärmen ${window.innerWidth})`, "");
    }
    for (const el of culprits) {
      const r = el.getBoundingClientRect();
      add(
        "overflow-x",
        el,
        `sidan är ${scrollWidth} px bred; elementet slutar vid ${Math.round(r.right)} px`,
        (el as HTMLElement).innerText ?? "",
      );
    }
  }

  // --- Tomma ytor --------------------------------------------------------------------------
  const documentHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
  for (const gap of h.findBlankGaps(contentIntervals, documentHeight, window.innerHeight)) {
    add(
      "blank-area",
      null,
      `tomt ${Math.round(gap.start)}–${Math.round(gap.end)} px (${Math.round(gap.end - gap.start)} px)`,
      "",
      String(Math.round(gap.start)),
    );
  }

  for (const el of marked) el.setAttribute("data-design-audit", "");

  return {
    findings,
    textElements,
    documentHeight,
    scrollWidth,
    innerWidth: window.innerWidth,
    isV2Shell: document.querySelector("[data-ui='v2']") !== null,
  };
}

/**
 * Skriptet som page.evaluate kör: detect.ts-funktionerna och probe i ett eget scope.
 * `__name` är esbuilds (tsx) hjälpare för funktionsnamn, som inte finns i sidan.
 */
export function probeScript(opts: ProbeOptions): string {
  const names = Object.keys(HELPERS) as Array<keyof Helpers>;
  return `(() => {
    var __name = (f) => f;
    ${names.map((n) => HELPERS[n].toString()).join("\n")}
    return (${probe.toString()})(${JSON.stringify(opts)}, { ${names.join(", ")} });
  })()`;
}
