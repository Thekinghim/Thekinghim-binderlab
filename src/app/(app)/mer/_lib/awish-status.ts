/**
 * Mer → Kopplingar: Awish-radens läge. Samma källa som Datakällor: i en demo är kopplingen
 * avstängd ("Avstängt i demon", som Datakällor), och en synk som inte hörts av på länge är
 * inaktuell (som källans "Inaktuell"), inte ett fel. Ren, testas i awish-status.test.ts.
 */

import type { SyncInfo } from "@/server/data/core/types";

export interface AwishLinkStatus {
  /** "Ansluten" · "Inaktuell" · "Fel" · "Ej ansluten" · "Avstängt i demon" */
  readonly label: string;
  /** Punktens ton: ok = grön, warning = gul, critical = röd, neutral = grå. */
  readonly tone: "ok" | "warning" | "critical" | "neutral";
  /** Raden under namnet. */
  readonly sub: string;
}

export function awishLinkStatus(args: {
  sync: SyncInfo | null;
  /** Organisationen är en demo (null = okänt, behandlas som inte demo). */
  demo: boolean | null;
  /** "21:23" för synkens tid. */
  time: (iso: string) => string;
}): AwishLinkStatus {
  const { sync, time } = args;
  if (args.demo === true) {
    return { label: "Avstängt i demon", tone: "neutral", sub: "Inga anrop till Awish i demon" };
  }
  if (sync === null) return { label: "Ej ansluten", tone: "critical", sub: "Ingen datakälla" };
  if (sync.state === "failed") {
    return { label: "Fel", tone: "critical", sub: "Senaste synken misslyckades" };
  }
  const last = sync.syncedAt ? `senast ${time(sync.syncedAt)}` : null;
  if (sync.state === "stale") {
    return {
      label: "Inaktuell",
      tone: "warning",
      sub: last ? `Ingen synk på länge · ${last}` : "Ingen synk än",
    };
  }
  return {
    label: "Ansluten",
    tone: "ok",
    sub: last ? `Köp och fack, var 5:e minut · ${last}` : "Ingen synk än",
  };
}
