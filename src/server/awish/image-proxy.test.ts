/** Bildvägen för Awishs bilder är ingen öppen proxy: bara adresser servern signerat. */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { awishImageSrc, verifyAwishImage, AWISH_IMAGE_ROUTE } = await import("./image-proxy");

describe("awishImageSrc / verifyAwishImage", () => {
  it("signerar en bild från Awish och godtar bara samma adress", () => {
    const src = awishImageSrc("https://dash.awish.vip/storage/a.png")!;
    expect(src.startsWith(`${AWISH_IMAGE_ROUTE}?`)).toBe(true);
    const q = new URL(src, "http://x").searchParams;
    expect(verifyAwishImage(q.get("u"), q.get("s"))?.href).toBe(
      "https://dash.awish.vip/storage/a.png",
    );
    expect(verifyAwishImage("http://169.254.169.254/latest", q.get("s"))).toBeNull();
    expect(verifyAwishImage(q.get("u"), "x".repeat(32))).toBeNull();
    expect(verifyAwishImage(q.get("u"), null)).toBeNull();
  });

  it("ingen bild, fel protokoll eller inloggning i adressen: ingen bildväg", () => {
    expect(awishImageSrc(null)).toBeNull();
    expect(awishImageSrc("")).toBeNull();
    expect(awishImageSrc("file:///etc/passwd")).toBeNull();
    expect(awishImageSrc("javascript:alert(1)")).toBeNull();
    expect(awishImageSrc("https://user:pw@example.com/a.png")).toBeNull();
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
    const signed = bads.map((b) => new URL(awishImageSrc(b)!, "http://x").searchParams);
    vi.stubEnv("NODE_ENV", "production");
    try {
      bads.forEach((bad, i) => {
        expect(awishImageSrc(bad), bad).toBeNull();
        expect(verifyAwishImage(signed[i]!.get("u"), signed[i]!.get("s")), bad).toBeNull();
      });
      expect(awishImageSrc("https://cdn.awish.vip/a.png")).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
