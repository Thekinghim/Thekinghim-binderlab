import type { SVGProps } from "react";

/**
 * Egen ikonuppsättning, ritad på ett 16-rutnät med 1.25px linje och
 * raka ändar. Inga ikonbibliotek, så att formspråket hålls ihop.
 */
const paths = {
  // Passmärken i fyra hörn och en punkt i mitten: hela fältet i ett ögonkast.
  // Inte fyra rutor, och tydligt skild från stapelikonen "sales".
  overview: "M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M7.25 7.25h1.5v1.5h-1.5z",
  sales: "M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3",
  machine: "M3.5 1.5h9v13h-9zM3.5 10.5h9M5.5 4h3.5M5.5 6.5h3.5M11 4v1M11 6.5v1M6 12.5h4",
  inventory: "M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6",
  // Tre staplade lådor: vårt lager (Enkel vy), skild från paketet "inventory" (Mystery).
  stock: "M2 8.5h5.5v5H2zM8.5 8.5H14v5H8.5zM5.25 2.5h5.5v5h-5.5z",
  margin: "M2.5 13.5L6 8l3 2.5 4.5-7M10.5 3.5h3v3",
  // Tre reglage med greppen i olika lägen (inte ett kugghjul, som annars liknar "sun").
  settings: "M2 4h7M11 4h3M9 2.5h2v3H9zM2 8h2M6 8h8M4 6.5h2v3H4zM2 12h8M12 12h2M10 10.5h2v3h-2z",
  design: "M2.5 2.5h11v11h-11zM2.5 6.5h11M6.5 6.5v7",
  search: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.3 10.3l3.2 3.2",
  close: "M3.5 3.5l9 9M12.5 3.5l-9 9",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  check: "M3 8.5l3 3 7-7",
  chevronDown: "M4 6l4 4 4-4",
  chevronRight: "M6 4l4 4-4 4",
  chevronLeft: "M10 4l-4 4 4 4",
  sortAsc: "M8 3.5v9M4.5 7L8 3.5 11.5 7",
  sortDesc: "M8 3.5v9M4.5 9L8 12.5 11.5 9",
  sortNone: "M5 6l3-3 3 3M5 10l3 3 3-3",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  download: "M8 2.5v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
  filter: "M2 3.5h12M4.5 8h7M7 12.5h2",
  menu: "M2 4.5h12M2 8h12M2 11.5h12",
  arrowUpRight: "M5 11l6-6M6 5h5v5",
  alert: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.5v1",
  info: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 7v4.5M8 4.5v1",
  sun: "M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  // Tre kvadrater på 1.5px, ritas med rak ände (se SOLID_SQUARES).
  more: "M2.75 8h1.5M7.25 8h1.5M11.75 8h1.5",
  external: "M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4",
  logout: "M6 2.5H2.5v11H6M10 5l3 3-3 3M13 8H6",
  report: "M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h2.5",
  columns: "M2.5 2.5h11v11h-11zM6.17 2.5v11M9.83 2.5v11",
  print: "M4.5 5.5v-4h7v4M4.5 11.5H2v-6h12v6h-2.5M4.5 9h7v5.5h-7z",
  // Uppdatera: en båge nästan runt och en pilspets uppe till höger.
  refresh: "M13.5 8A5.5 5.5 0 1 1 11.9 4.1M12.5 1.5v3h-3",
} as const;

export type IconName = keyof typeof paths;

type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  size?: number;
  /** Om ikonen bär betydelse utan text intill, ange en etikett. */
  label?: string;
};

/**
 * Ikoner vars streck är 1.5px långa och ska bli exakta 1.5px-kvadrater:
 * linjebredd 1.5 med rak (butt) ände. Aldrig runda prickar.
 */
const SOLID_SQUARES: ReadonlySet<IconName> = new Set<IconName>(["more"]);

export function Icon({ name, size = 16, label, strokeWidth = 1.25, ...rest }: IconProps) {
  const squares = SOLID_SQUARES.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={squares ? 1.5 : strokeWidth}
      strokeLinecap={squares ? "butt" : "square"}
      strokeLinejoin="miter"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
