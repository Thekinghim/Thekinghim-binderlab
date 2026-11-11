import type { Formatters } from "@/i18n";

/** Kronor utan ören när beloppet är jämnt: "213 kr", annars "213,21 kr". Ren. */
export function krAuto(f: Formatters, ore: number): string {
  return f.kronor(ore / 100, ore % 100 === 0 ? 0 : 2);
}
