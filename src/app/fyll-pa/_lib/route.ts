/**
 * Adresserna i Fyll på: /fyll-pa (listan) och /fyll-pa/<automat>. Rent och klientsäkert
 * (testas i route.test.ts). Båda adresserna visar samma rutt (src/lib/rewrites.ts);
 * automaten läses ur adressen, på servern (page.tsx) och i webbläsaren (FillApp).
 */

export const FILL_BASE = "/fyll-pa";

const UUID = /^[0-9a-f-]{36}$/i;

/** Automatens id ur en sökväg (/fyll-pa/<id>), annars null (listan eller något annat). */
export function machineIdFrom(pathname: string | null | undefined): string | null {
  if (!pathname?.startsWith(`${FILL_BASE}/`)) return null;
  const id = pathname.slice(FILL_BASE.length + 1).split("/")[0] ?? "";
  return UUID.test(id) ? id : null;
}

/** Det senaste trycket i Fyll på: en automat (id) eller listan (null). */
export interface FillNav {
  readonly machineId: string | null;
}

/**
 * Automaten som visas (null = listan). Det senaste trycket (`nav`: en automat i listan,
 * Automater, Klar) gäller direkt. Adressen byts i samma ögonblick, men Next uppdaterar sin
 * bild av adressen (usePathname) först när en pågående hämtning är klar, och fram till dess
 * stod automatens skärm kvar med Klar-knappen. Utan något tryck (sidan just öppnad, eller
 * bakåt/framåt i webbläsaren) gäller adressen; före hydreringen den automat som servern
 * renderade sidan för.
 */
export function shownMachineId(args: {
  readonly nav: FillNav | null;
  readonly hydrated: boolean;
  readonly pathname: string | null | undefined;
  readonly initialMachineId: string | null;
}): string | null {
  if (args.nav) return args.nav.machineId;
  return args.hydrated ? machineIdFrom(args.pathname) : args.initialMachineId;
}
