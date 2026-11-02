"use server";

/**
 * Server actions för Butiker. Tunna omslag: organisationen är alltid den aktiva (läses
 * på servern, aldrig från klienten), rollen kontrolleras mot databasen här
 * (requireContextRole) och igen i varje funktion i ./_lib/service (bara ägare och admin),
 * och allt körs under RLS. Indata valideras med zod i tjänsten. Triggarna loggar
 * ändringarna i audit_log.
 *
 * Avtal och placeringar avgör butiksersättningen, så en ändring påverkar Hem, Att göra,
 * Lönsamhet, Automater, Avtal, Ekonomi och rapporterna: hela appen räknas om
 * (revalidateAppData).
 */

import { unstable_rethrow } from "next/navigation";

import type { ActionResult } from "@/server/auth/flows";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import {
  createAgreementFor,
  createStoreFor,
  createStoreRecipientFor,
  deleteStoreRecipientFor,
  setStoreArchivedFor,
  updateAgreementFor,
  updateStoreFor,
  updateStoreRecipientFor,
  type Viewer,
} from "./_lib/service";
import { currentViewer } from "./_lib/session";

async function run<T>(fn: (viewer: Viewer) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let viewer: Viewer;
  try {
    await requireContextRole(OPERATOR_ROLES);
    viewer = await currentViewer();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) {
      return { ok: false, error: "Bara ägare och admin kan ändra butiker." };
    }
    throw error;
  }
  const result = await fn(viewer);
  if (result.ok) revalidateAppData();
  return result;
}

/** Lägger till en butik. Returnerar id (för länken till butikens sida). */
export async function createStore(input: {
  name: string;
  address?: string;
  city?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  isExample?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  return run((v) => createStoreFor(v, input));
}

/** Ändrar butikens namn, adress, kontaktuppgifter och exempelmarkering. */
export async function updateStore(input: {
  storeId: string;
  name: string;
  address?: string;
  city?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  isExample?: boolean;
}): Promise<ActionResult> {
  return run((v) => updateStoreFor(v, input));
}

/** Arkiverar eller återställer en butik. */
export async function setStoreArchived(input: {
  storeId: string;
  archived: boolean;
}): Promise<ActionResult> {
  return run((v) => setStoreArchivedFor(v, input));
}

/**
 * Nytt avtal från och med ett datum. Provision i procent ("12,5") och hyra i kronor per
 * månad ("750"); minst en av dem. Avtalet som gäller dagen före avslutas dagen före.
 */
export async function createAgreement(input: {
  storeId: string;
  validFrom: string;
  validTo?: string;
  commission?: string;
  rent?: string;
  note?: string;
}): Promise<ActionResult<{ id: string; closedId: string | null }>> {
  return run((v) => createAgreementFor(v, input));
}

/** Rättar ett avtals provision, hyra, anteckning och sista dag. */
export async function updateAgreement(input: {
  agreementId: string;
  validTo?: string;
  commission?: string;
  rent?: string;
  note?: string;
}): Promise<ActionResult<{ storeId: string }>> {
  return run((v) => updateAgreementFor(v, input));
}

/** Lägger till en mottagare av butikens månadsrapport. */
export async function createStoreRecipient(input: {
  storeId: string;
  name: string;
  email: string;
}): Promise<ActionResult<{ id: string }>> {
  return run((v) => createStoreRecipientFor(v, input));
}

/** Ändrar en mottagare, eller pausar och återaktiverar den. */
export async function updateStoreRecipient(input: {
  recipientId: string;
  name: string;
  email: string;
  active: boolean;
}): Promise<ActionResult> {
  return run((v) => updateStoreRecipientFor(v, input));
}

/** Tar bort en mottagare som inte fått några rapporter. */
export async function deleteStoreRecipient(input: { recipientId: string }): Promise<ActionResult> {
  return run((v) => deleteStoreRecipientFor(v, input));
}
