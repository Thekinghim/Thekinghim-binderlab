/** Typer för scripts/extension/build.mjs (används av testerna). */
export interface BuildOptions {
  out?: string;
  zip?: string | null;
  awishOrigin?: string;
}
export function buildExtension(
  options: BuildOptions,
): Promise<{ out: string; zip: string | null; files: string[] }>;
