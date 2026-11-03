"use server";

/**
 * Tar emot en inbjudan från /inbjudan/[token]. Tunt omslag kring acceptInvite
 * (src/server/actions/auth.ts → acceptInviteFlow), som validerar token,
 * e-post, giltighet och lösenord och skapar medlemskapet via RPC:n
 * accept_invitation som användaren.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { acceptInvite } from "@/server/actions/auth";
import { MESSAGES } from "@/server/auth/flows";

import type { AcceptState } from "./state";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function acceptInvitation(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = field(formData, "token");
  const password = field(formData, "password");
  const confirm = field(formData, "confirm");
  const tokenHash = field(formData, "token_hash");
  const linkType = field(formData, "type");
  const accessToken = field(formData, "access_token");
  const refreshToken = field(formData, "refresh_token");

  if (formData.has("confirm") && password !== confirm) {
    return { error: "Lösenorden är inte lika.", field: "confirm" };
  }
  const result = await acceptInvite(token, {
    password: password === "" ? undefined : password,
    emailTokenHash: tokenHash === "" ? undefined : tokenHash,
    emailLinkType: linkType === "invite" || linkType === "magiclink" ? linkType : undefined,
    emailTokens: accessToken === "" ? undefined : { accessToken, refreshToken },
  });
  if (!result.ok) {
    const isPasswordError =
      result.error.startsWith("Lösenordet") || result.error === MESSAGES.acceptPasswordNeeded;
    return {
      error: result.error,
      field: isPasswordError ? "password" : undefined,
      accountExists: result.error === MESSAGES.acceptAccountExists,
    };
  }
  // Den nya organisationen är aktiv (cookien sattes i flödet): hela appen räknas om.
  revalidatePath("/", "layout");
  redirect("/");
}
