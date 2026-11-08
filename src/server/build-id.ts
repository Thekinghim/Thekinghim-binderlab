import "server-only";

import { cookies } from "next/headers";

import { BUILD_ID, TEST_BUILD_COOKIE, resolveBuildId } from "@/lib/build-id";

/**
 * Byggets id som den här servern kör. I drift alltid det inbakade (BUILD_ID); i next dev kan
 * e2e-testerna låtsas att ett nytt bygge driftsatts med kakan TEST_BUILD_COOKIE.
 */
export async function liveBuildId(): Promise<string> {
  let testOverride: string | undefined;
  if (process.env.NODE_ENV === "development") {
    testOverride = (await cookies()).get(TEST_BUILD_COOKIE)?.value;
  }
  return resolveBuildId({
    baked: BUILD_ID,
    testOverride,
    nodeEnv: process.env.NODE_ENV,
    appEnv: process.env.APP_ENV,
  });
}
