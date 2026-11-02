/**
 * Scenarier: "vad händer om …". Rena funktioner ovanpå src/domain.
 *
 * - `newMachineScenario`: ny automat i en butik som liknar butik X (uppskattning).
 * - `priceChangeScenario`: vinsten om priset på en titel ändras med N kr, med elasticitet.
 */

export { newMachineScenario, type NewMachineScenarioInput } from "./new-machine";
export {
  DEFAULT_ELASTICITIES,
  priceChangeScenario,
  type PriceChangeBase,
  type PriceChangeRow,
  type PriceChangeScenario,
  type PriceChangeScenarioInput,
} from "./price-change";
