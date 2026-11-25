/**
 * Är felet ett tillfälligt nätfel (en nedladdning som bröts) snarare än ett programfel?
 *
 * Safari: "TypeError: Load failed". Chrome: "TypeError: Failed to fetch". Firefox:
 * "NetworkError when attempting to fetch resource.". React Flight när strömmen bryts:
 * "Connection closed.". En kodfil från ett äldre bygge som inte finns kvar: ChunkLoadError
 * eller "Importing a module script failed." (Safari). Sådana fel går över av ett nytt
 * försök; ett programfel gör det inte.
 */
const PATTERNS = [
  /^load failed\b/i,
  /^failed to fetch\b/i,
  /^networkerror\b/i,
  /network connection was lost/i,
  /^network request failed/i,
  /connection closed/i,
  // Produktionsbygget av React: "Minified React error #412" = Connection closed.
  /react\.dev\/errors\/412\b/i,
  /minified react error #412\b/i,
  /loading (css )?chunk [^ ]+ failed/i,
  /failed to load chunk/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /failed to fetch dynamically imported module/i,
];

export function isTransientLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown; digest?: unknown };
  // Fel från servern (med fel-id) är aldrig ett nätfel i telefonen.
  if (typeof e.digest === "string" && e.digest) return false;
  if (e.name === "ChunkLoadError") return true;
  const message = typeof e.message === "string" ? e.message.trim() : "";
  return message !== "" && PATTERNS.some((p) => p.test(message));
}

/** En kodfil som inte kunde hämtas (gammalt bygge): bara en hel omladdning hjälper. */
export function isChunkLoadError(error: unknown): boolean {
  if (!isTransientLoadError(error)) return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === "ChunkLoadError") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /chunk|module script|dynamically imported module/i.test(message);
}
