/**
 * Besöksplan: veckoplan över automater som behöver besök, packlista per besök och dag (från
 * lager och försäljningstakt) och ordning efter avstånd (närmaste granne + 2-opt) när
 * koordinater finns, annars efter brådska. Rena funktioner utan I/O.
 */

export { kmText, planVisits, VISIT_DEFAULTS } from "./plan";
export { distanceMeters, EARTH_RADIUS_M, planRoute, type Route, type RoutePoint } from "./route";
export type * from "./types";
export {
  channelText,
  compareChannels,
  fillLevelOf,
  fillLevels,
  fillPercent,
  fillTone,
  type FillLevel,
} from "./fill";
