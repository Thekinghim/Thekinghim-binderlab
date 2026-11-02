/**
 * Kom igång för serverkomponenter: checklistan för den inloggade användarens
 * organisation. Logiken finns i ./status.ts (läser under RLS) och ./model.ts (rena
 * funktioner).
 *
 *   const status = await onboardingStatus(ctx.organization.id);
 *   if (!status.complete) return <OnboardingChecklist status={status} canEdit={ctx.canEdit} />;
 *
 * Komponenten finns i src/app/(app)/kom-igang/_components/onboarding-checklist.tsx.
 */

import "server-only";

import { cache } from "react";

import { AuthorizationError, requireUser } from "@/server/session";

import type { OnboardingStatus } from "./model";
import { loadOnboardingStatusFor, ONBOARDING_ROLES } from "./status";

export {
  PRICE_COVERAGE_TARGET_BP,
  type OnboardingStatus,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingStepState,
} from "./model";
export { ONBOARDING_ROLES } from "./status";

/**
 * Checklistan för organisationen, räknad ur datan. Kräver rollen ägare, admin eller
 * läsare (kontrolleras mot databasen); kastar annars AuthorizationError("forbidden").
 * Memoiseras per förfrågan.
 */
export const onboardingStatus = cache(async (orgId: string): Promise<OnboardingStatus> => {
  const user = await requireUser();
  return loadOnboardingStatusFor(user, orgId);
});

/** Som onboardingStatus, men null för roller som inte ser checklistan (påfyllaren). */
export async function optionalOnboardingStatus(orgId: string): Promise<OnboardingStatus | null> {
  try {
    return await onboardingStatus(orgId);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
}

/** Ser rollen checklistan? */
export function canSeeOnboarding(role: string): boolean {
  return (ONBOARDING_ROLES as readonly string[]).includes(role);
}
