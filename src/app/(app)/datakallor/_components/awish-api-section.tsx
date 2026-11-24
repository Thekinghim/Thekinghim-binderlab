import { TLS_LOST_MESSAGE } from "@/server/awish/control/endpoint";
import { awishApiCardFor } from "@/server/awish/control/version";
import type { Viewer } from "@/server/data/core/loaders";

import { AwishApiCard, type AwishApiCardView } from "./awish-api-card";

/**
 * Datakällor → kortet "Awish API" (Version, anslutning, signering, skrivvägar). Bara för
 * ägare och admin; ett fel här får aldrig fälla sidan.
 */
export async function AwishApiSection({ viewer, timeZone }: { viewer: Viewer; timeZone: string }) {
  let view: AwishApiCardView | null = null;
  try {
    const card = await awishApiCardFor(viewer);
    if (card.demo || !card.connected || !card.state) {
      view = card.demo ? { demo: true } : null;
    } else {
      const s = card.state;
      view = {
        demo: false,
        version: s.version,
        previousVersion: s.previousVersion,
        versionSeenAt: s.versionSeenAt?.toISOString() ?? null,
        versionNeedsAck: card.versionNeedsAck,
        endpoint: s.endpoint,
        endpointError: s.endpointError,
        tlsLost: s.endpoint === "tls" && s.endpointError === TLS_LOST_MESSAGE,
        signStatus: s.signStatus,
        signError: s.signError,
        slotWritesVia: s.slotWritesVia,
        goodsWritesVia: s.goodsWritesVia,
        timeZone,
      };
    }
  } catch {
    view = null;
  }
  if (!view) return null;
  return <AwishApiCard view={view} />;
}
