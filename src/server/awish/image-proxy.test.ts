/** Bildvägen för Awishs bilder är ingen öppen proxy: bara adresser servern signerat. */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { awishImageSrc, verifyAwishImage, AWISH_IMAGE_ROUTE } = await import("./image-proxy");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("awishImageSrc / verifyAwishImage", () => {
  it("signaturen är bunden till organisationen: en annan organisation får 404", () => {
    const src = awishImageSrc(ORG, "https://dash.awish.vip/storage/a.png")!;
    const q = new URL(src, "http://x").searchParams;
    expect(verifyAwishImage(ORG, q.get("u"), q.get("s"))).not.toBeNull();
    expect(verifyAwishImage(OTHER, q.get("u"), q.get("s"))).toBeNull();
    expect(verifyAwishImage("", q.get("u"), q.get("s"))).toBeNull();
    expect(awishImageSrc("", "https://dash.awish.vip/storage/a.png")).toBeNull();
  });

  it("signerar en bild från Awish och godtar bara samma adress", () => {
    const src = awishImageSrc(ORG, "https://dash.awish.vip/storage/a.png")!;
    expect(src.startsWith(`${AWISH_IMAGE_ROUTE}?`)).toBe(true);
    const q = new URL(src, "http://x").searchParams;
    expect(verifyAwishImage(ORG, q.get("u"), q.get("s"))?.href).toBe(
      "https://dash.awish.vip/storage/a.png",
    );
    expect(verifyAwishImage(ORG, "http://169.254.169.254/latest", q.get("s"))).toBeNull();
    expect(verifyAwishImage(ORG, q.get("u"), "x".repeat(32))).toBeNull();
    expect(verifyAwishImage(ORG, q.get("u"), null)).toBeNull();
  });

  it("ingen bild, fel protokoll eller inloggning i adressen: ingen bildväg", () => {
    expect(awishImageSrc(ORG, null)).toBeNull();
    expect(awishImageSrc(ORG, "")).toBeNull();
    expect(awishImageSrc(ORG, "file:///etc/passwd")).toBeNull();
    expect(awishImageSrc(ORG, "javascript:alert(1)")).toBeNull();
    expect(awishImageSrc(ORG, "https://user:pw@example.com/a.png")).toBeNull();
  });

  it("i drift: aldrig interna adresser (servern hämtar bilden själv)", () => {
    const bads = [
      "http://169.254.169.254/latest/meta-data/a.png",
      "http://127.0.0.1:3000/a.png",
      "http://localhost/a.png",
      "http://10.0.0.5/a.png",
      "http://192.168.1.2/a.png",
      "http://172.16.0.1/a.png",
      "http://[::1]/a.png",
      "http://0.0.0.0/a.png",
    ];
    // Lokalt (låtsas-panelen på 127.0.0.1) signeras de; i drift godtas de inte ens signerade.
    const signed = bads.map((b) => new URL(awishImageSrc(ORG, b)!, "http://x").searchParams);
    vi.stubEnv("NODE_ENV", "production");
    try {
      bads.forEach((bad, i) => {
        expect(awishImageSrc(ORG, bad), bad).toBeNull();
        expect(verifyAwishImage(ORG, signed[i]!.get("u"), signed[i]!.get("s")), bad).toBeNull();
      });
      expect(awishImageSrc(ORG, "https://cdn.awish.vip/a.png")).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
