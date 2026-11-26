/**
 * Spara en fil från appen. På telefonen (grov pekare) öppnas delningsarket med filen
 * (navigator.share({ files })): där finns "Spara i Filer", Mail och AirDrop, och appen på
 * hemskärmen lämnas inte för en tom flik. Annars, och när delning inte går, en vanlig
 * nedladdning via en länk.
 */

/** Vägen filen tar: delningsarket eller en nedladdning. */
export type SaveRoute = "share" | "download";

/** Delningsarket när enheten pekar med fingret och kan dela just den här filen. */
export function saveRoute(
  nav: { canShare?: (data: ShareData) => boolean } | undefined,
  coarse: boolean,
  file: File,
): SaveRoute {
  if (!coarse || !nav || typeof nav.canShare !== "function") return "download";
  try {
    return nav.canShare({ files: [file] }) ? "share" : "download";
  } catch {
    return "download";
  }
}

/** Filnamnet ur Content-Disposition, annars `fallback`. */
export function fileNameFrom(header: string | null, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(header ?? "");
  return match?.[1] ?? fallback;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari på iPhone behöver länken en stund efter klicket.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Sparar filen. "cancelled" när personen stängde delningsarket (då ingen notis). Kan
 * telefonen inte dela efter hämtningen (Safari kräver ett färskt tryck) blir det en
 * nedladdning i stället.
 */
export async function saveFile(blob: Blob, name: string): Promise<"saved" | "cancelled"> {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  if (
    saveRoute(typeof navigator === "undefined" ? undefined : navigator, coarse, file) === "share"
  ) {
    try {
      await navigator.share({ files: [file], title: name });
      return "saved";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // NotAllowedError m.fl.: ladda ner som vanligt.
    }
  }
  download(blob, name);
  return "saved";
}
