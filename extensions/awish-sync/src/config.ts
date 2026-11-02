/**
 * Tilläggets fasta inställningar. scripts/extension/build.mjs kan byta AWISH_ORIGIN vid
 * bygget (bara för tester mot en låtsas-Awish, --awish-origin); den publicerade zip-filen
 * läser alltid https://dash.awish.vip.
 */

export const AWISH_ORIGIN = "https://dash.awish.vip";
/** Orderlistan i Awish-panelen. */
export const ORDERS_PATH = "/dashboard/orders/index";
/** Startsidan för inloggning (länken i popupen). */
export const AWISH_LOGIN_URL = `${AWISH_ORIGIN}/`;

export const VERSION = "1.0.0";

/** Alarmet som startar synken. */
export const ALARM_NAME = "binderlab-sync";
export const SYNC_INTERVAL_MINUTES = 10;

/** Lugn takt mot Awish: en sida i sekunden. */
export const PAGE_DELAY_MS = 1000;
/** Rader per batch till Binderlab (servern tar högst 500). */
export const BATCH_SIZE = 200;
/** Rader per sida i Awish orderlista. */
export const AWISH_PAGE_SIZE = 20;
/** Så många sidor efter det första kända ordernumret läses ändå (överlapp). */
export const OVERLAP_PAGES = 1;
/** Högst så många sidor i en vanlig (inte hela historiken) synk. */
export const MAX_INCREMENTAL_PAGES = 2000;
/** Hur länge ett misslyckat försök att hitta JSON-API:t gäller innan det provas igen. */
export const API_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;
