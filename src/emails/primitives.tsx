import { createElement, type CSSProperties, type ReactNode } from "react";
import { SYMBOL_GRID, SYMBOL_PARTS } from "@/components/brand/wordmark";
import { EMAIL_COLOR, EMAIL_FONT, css, labelStyle } from "./theme";

/*
 * Byggstenar för e-post. Allt är tabeller med inline-stilar: Outlook för
 * Windows ritar med Word, Gmail tar bort <svg>, klasser och externa
 * stilmallar. Inga klasser används alls; den lilla <style> som finns i
 * dokumentet är en förbättring för klienter som klarar den, och mejlet
 * fungerar utan den.
 */

/** Attribut som Reacts typer saknar för <td> men som Outlook läser. */
function legacy(attrs: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = String(v);
  return out;
}

/** Layouttabell: role="presentation", inga mellanrum, ingen kant. */
export function Table({
  width = "100%",
  align,
  style,
  children,
}: {
  /** "auto" utelämnar width-attributet (tabellen krymper till innehållet). */
  width?: number | "100%" | "auto";
  align?: "left" | "center" | "right";
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <table
      role="presentation"
      width={width === "auto" ? undefined : width}
      align={align}
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ borderCollapse: "collapse", ...style }}
    >
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * Markerar en mobilanpassning för <style>-blocket i dokumentet
 * (attributselektor, eftersom mejlet inte har några klasser).
 */
export type MobileHook = "gutter" | "outer" | "h1" | "kpi" | "stack";

export function mobile(hook: MobileHook): Record<string, string> {
  return { "data-m": hook };
}

/** Monospace-etikett. */
export function Label({
  children,
  color = EMAIL_COLOR.subtle,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return <span style={{ ...labelStyle, color, ...style }}>{children}</span>;
}

/**
 * Sektionsrubrik i appens form: "02 / Per automat" till vänster,
 * metadata till höger. Raden under är en hårfin linje.
 */
export function SectionLabel({
  index,
  children,
  meta,
}: {
  index: number;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <Table>
      <tr>
        <td style={{ paddingBottom: "10px", borderBottom: `1px solid ${EMAIL_COLOR.line}` }}>
          <Label color={EMAIL_COLOR.fg}>{String(index).padStart(2, "0")}</Label>
          <Label color={EMAIL_COLOR.faint}>{" / "}</Label>
          <Label>{children}</Label>
        </td>
        {meta ? (
          <td
            align="right"
            style={{
              paddingBottom: "10px",
              borderBottom: `1px solid ${EMAIL_COLOR.line}`,
              whiteSpace: "nowrap",
            }}
          >
            <Label style={{ fontVariantNumeric: "tabular-nums" }}>{meta}</Label>
          </td>
        ) : null}
      </tr>
    </Table>
  );
}

/** Lodrätt mellanrum som håller i Outlook (tom cell med fast höjd). */
export function Spacer({ height }: { height: number }) {
  return (
    <Table>
      <tr>
        <td
          height={height}
          style={css({
            height: `${height}px`,
            fontSize: "0",
            lineHeight: "0",
            msoLineHeightRule: "exactly",
          })}
        >
          {" "}
        </td>
      </tr>
    </Table>
  );
}

/**
 * Knapp som fungerar utan CSS-stöd: färgen ligger på cellen, så även
 * Outlook ritar en yta. 4 px radie, mörk yta, ljus text.
 */
export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Table width="auto" style={{ borderCollapse: "separate" }}>
      <tr>
        <td
          {...legacy({ bgcolor: EMAIL_COLOR.inverseBg })}
          style={css({
            backgroundColor: EMAIL_COLOR.inverseBg,
            borderRadius: "4px",
            msoPaddingAlt: "11px 20px",
          })}
        >
          <a
            href={href}
            target="_blank"
            rel="noopener"
            style={{
              display: "inline-block",
              padding: "11px 20px",
              border: `1px solid ${EMAIL_COLOR.inverseBg}`,
              borderRadius: "4px",
              fontFamily: EMAIL_FONT.sans,
              fontSize: "14px",
              lineHeight: "20px",
              fontWeight: 500,
              color: EMAIL_COLOR.inverseFg,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {children}
          </a>
        </td>
      </tr>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Symbol och ordmärke
// ---------------------------------------------------------------------------

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Samma avrundning som Symbol i wordmark.tsx: varje kant till hel pixel. */
function snapPx(r: { x: number; y: number; w: number; h: number }, size: number): Rect {
  const s = size / SYMBOL_GRID;
  return {
    x0: Math.round(r.x * s),
    y0: Math.round(r.y * s),
    x1: Math.round((r.x + r.w) * s),
    y1: Math.round((r.y + r.h) * s),
  };
}

/** Delar som ritas i signalfärg (ringen som fäster kortet). */
const SIGNAL_PARTS: ReadonlySet<string> = new Set(["ring"]);

/**
 * Symbolen som ett rutnät av tabellceller med bakgrundsfärg, eftersom
 * Gmail och Outlook inte visar SVG. Geometrin läses från SYMBOL_PARTS,
 * så den följer ordmärket om det ändras. Cellerna delas där någon del
 * har en kant; varje cell får färgen från den del som täcker den.
 */
export function EmailSymbol({ size = 20 }: { size?: number }) {
  const parts = Object.entries(SYMBOL_PARTS).map(([name, r]) => ({
    rect: snapPx(r, size),
    color: SIGNAL_PARTS.has(name) ? EMAIL_COLOR.signal : EMAIL_COLOR.fg,
  }));
  const xs = [...new Set([0, size, ...parts.flatMap((p) => [p.rect.x0, p.rect.x1])])].sort(
    (a, b) => a - b,
  );
  const ys = [...new Set([0, size, ...parts.flatMap((p) => [p.rect.y0, p.rect.y1])])].sort(
    (a, b) => a - b,
  );
  const colorAt = (x: number, y: number) =>
    // Sista träffen vinner, som i SVG där ringen ritas ovanpå.
    parts.filter((p) => x >= p.rect.x0 && x < p.rect.x1 && y >= p.rect.y0 && y < p.rect.y1).pop()
      ?.color;

  const rows: ReactNode[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const y = ys[j]!;
    const h = ys[j + 1]! - y;
    const cells: ReactNode[] = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const x = xs[i]!;
      const w = xs[i + 1]! - x;
      const color = colorAt(x, y);
      cells.push(
        <td
          key={i}
          width={w}
          height={h}
          {...(color ? legacy({ bgcolor: color }) : {})}
          style={css({
            width: `${w}px`,
            height: `${h}px`,
            padding: "0",
            fontSize: "0",
            lineHeight: "0",
            msoLineHeightRule: "exactly",
            ...(color ? { backgroundColor: color } : {}),
          })}
        />,
      );
    }
    rows.push(<tr key={j}>{cells}</tr>);
  }

  return (
    <table
      role="presentation"
      width={size}
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ borderCollapse: "collapse", width: `${size}px`, height: `${size}px` }}
    >
      <tbody>{rows}</tbody>
    </table>
  );
}

/** Symbol + "Binderlab" i Geist Semibold, "lab" i grått. Samma mått som Wordmark size="md". */
export function EmailWordmark() {
  return (
    <Table width="auto">
      <tr>
        <td valign="middle" style={{ paddingRight: "8px" }}>
          <EmailSymbol size={20} />
        </td>
        <td
          valign="middle"
          style={{
            fontFamily: EMAIL_FONT.sans,
            fontSize: "19px",
            lineHeight: "20px",
            fontWeight: 600,
            letterSpacing: "-0.57px",
            color: EMAIL_COLOR.fg,
            whiteSpace: "nowrap",
          }}
        >
          Binder<span style={{ color: EMAIL_COLOR.subtle }}>lab</span>
        </td>
      </tr>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Outlook-tabeller
// ---------------------------------------------------------------------------

/*
 * Outlook för Windows förstår inte max-width, så mejlet låses till 600 px
 * med en tabell inom villkorskommentarer (<!--[if mso]>). React kan inte
 * skriva kommentarer, så komponenterna lämnar markörer som
 * finalizeMsoMarkers byter ut i den färdiga strängen.
 */
const MSO_OPEN = "x-bl-mso-open";
const MSO_CLOSE = "x-bl-mso-close";

export function MsoOpen({ width }: { width: number }) {
  return createElement(MSO_OPEN, { "data-width": width });
}

export function MsoClose() {
  return createElement(MSO_CLOSE);
}

export function finalizeMsoMarkers(html: string): string {
  return html
    .replace(
      new RegExp(`<${MSO_OPEN} data-width="(\\d+)"></${MSO_OPEN}>`, "g"),
      (_, w: string) =>
        `<!--[if mso]><table role="presentation" align="center" width="${w}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`,
    )
    .replace(
      new RegExp(`<${MSO_CLOSE}></${MSO_CLOSE}>`, "g"),
      "<!--[if mso]></td></tr></table><![endif]-->",
    );
}
