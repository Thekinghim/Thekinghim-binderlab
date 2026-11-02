/**
 * Maskinhälsa och tidslinje per automat.
 *
 * machineHealth(input, now) ger status per automat (i drift, misstänkt fel, fel, offline, tom,
 * okänt, inte i drift). Leverantörens maskindata används när den finns; annars härleds statusen
 * ur avvikande tystnad i försäljningen jämfört med samma veckodag och timme i historiken
 * (Poisson). machineTimeline slår ihop försäljning, lager, maskinhändelser och ärenden.
 * Rena funktioner utan I/O; `now` är den enda tidskällan.
 */

export {
  analyzeSilence,
  HEALTH_DEFAULTS,
  HEALTH_LABELS,
  HEALTH_RANK,
  historyStartMs,
  machineHealth,
  resolveHealthOptions,
  vendorState,
  type VendorState,
} from "./status";
export { machineTimeline } from "./timeline";
export { poissonCdf, poissonSf, poissonZero, probabilityToBp } from "./poisson";
export {
  buildHourCalendar,
  calendarHourAt,
  floorHour,
  hourSlotAt,
  localDayStartMs,
  slotOf,
  WEEK_SLOTS,
  type HourCalendar,
  type HourSlot,
} from "./calendar";
export {
  buildWeeklyProfile,
  expectedSales,
  milliToTenths,
  type Expectation,
  type SaleInstant,
  type WeeklyProfile,
} from "./profile";
export { durationText, hourRangeText, probabilityText, whenText } from "./text";
export type * from "./types";
