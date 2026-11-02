/**
 * Releaser: normaliserad släppkurva från tidigare släpp, förslag på inköpsmängd och
 * fördelning per automat före ett släpp, och utfall mot förslaget efteråt.
 */

export {
  horizonOf,
  releaseCurve,
  releaseProfiles,
  type ReleaseCurve,
  type ReleaseHistoryInput,
  type ReleaseProfile,
  type ReleaseRef,
} from "./curve";
export {
  suggestReleasePurchase,
  type ReleaseAllocation,
  type ReleaseSuggestion,
  type ReleaseSuggestionInput,
} from "./suggest";
export {
  releaseOutcome,
  type ReleaseMachineOutcome,
  type ReleaseOutcome,
  type ReleaseOutcomeInput,
  type ReleasePace,
} from "./outcome";
