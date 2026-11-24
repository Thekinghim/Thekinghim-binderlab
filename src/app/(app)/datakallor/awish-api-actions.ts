"use server";

/**
 * Datakällor → Awish API: testa anslutning och signering, kvittera ett versionsbyte och
 * välj om påfyllning och varor går via webbpanelen eller API:t. Ägare och admin; en demo
 * anropar aldrig Awish (kontrolleras också i tjänsterna).
 */

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { AuthorizationError } from "@/server/access";
import { controlErrorMessage } from "@/server/awish/control/errors";
import {
  acknowledgeAwishVersion,
  probeEndpointFor,
  probeSigning,
  setAwishWritesVia,
  chooseInsecureEndpointFor,
  type SimpleResult,
} from "@/server/awish/control/version";
import { safeErrorForLog } from "@/server/errors";

import { currentViewer } from "./_lib/session";

type Via = "web" | "api" | "api_then_web";

async function guarded(fn: () => Promise<SimpleResult>): Promise<SimpleResult> {
  try {
    const result = await fn();
    revalidatePath("/datakallor");
    return result;
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) {
      return { ok: false, message: "Det här får bara ägare och admin göra." };
    }
    console.error("[awish-api]", safeErrorForLog(error));
    return { ok: false, message: controlErrorMessage(error) };
  }
}

export async function testAwishEndpoint(): Promise<SimpleResult> {
  return guarded(async () => probeEndpointFor(await currentViewer()));
}

export async function testAwishSigning(): Promise<SimpleResult> {
  return guarded(async () => probeSigning(await currentViewer()));
}

export async function acknowledgeAwishVersionAction(): Promise<SimpleResult> {
  return guarded(async () => acknowledgeAwishVersion(await currentViewer()));
}

export async function setAwishWritesViaAction(input: {
  slot?: Via;
  goods?: Via;
}): Promise<SimpleResult> {
  return guarded(async () => setAwishWritesVia(await currentViewer(), input));
}

export async function chooseInsecureEndpointAction(): Promise<SimpleResult> {
  return guarded(async () => chooseInsecureEndpointFor(await currentViewer()));
}
