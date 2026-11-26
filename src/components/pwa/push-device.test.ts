import { describe, expect, it } from "vitest";

import { pushEndpointForLogout } from "./push-device";

type Container = Pick<ServiceWorkerContainer, "getRegistration">;

function containerWith(endpoint: string | null): Container {
  return {
    getRegistration: async () =>
      ({
        pushManager: {
          getSubscription: async () => (endpoint ? { endpoint } : null),
        },
      }) as unknown as ServiceWorkerRegistration,
  };
}

/** Utloggningen läser push-adressen utan att vänta på service workerns `.ready`. */
describe("pushEndpointForLogout", () => {
  it("ger telefonens push-adress", async () => {
    await expect(pushEndpointForLogout(containerWith("https://push.example/abc"))).resolves.toBe(
      "https://push.example/abc",
    );
  });

  it("null utan prenumeration, utan registrering och utan stöd", async () => {
    await expect(pushEndpointForLogout(containerWith(null))).resolves.toBeNull();
    await expect(
      pushEndpointForLogout({ getRegistration: async () => undefined }),
    ).resolves.toBeNull();
    await expect(pushEndpointForLogout(null)).resolves.toBeNull();
  });

  it("väntar aldrig längre än tidsgränsen och sväljer fel", async () => {
    const never: Container = { getRegistration: () => new Promise(() => {}) };
    const start = Date.now();
    await expect(pushEndpointForLogout(never, 20)).resolves.toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
    const broken: Container = { getRegistration: async () => Promise.reject(new Error("x")) };
    await expect(pushEndpointForLogout(broken)).resolves.toBeNull();
  });
});
