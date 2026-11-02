import { describe, expect, it } from "vitest";

import { isAllowedPushEndpoint } from "./push-endpoint";

describe("isAllowedPushEndpoint (ingen SSRF via push)", () => {
  it("godtar webbläsarnas push-tjänster", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QK7q",
      "https://wns2-db5p.notify.windows.com/w/?token=x",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(true);
    }
  });

  it("nekar interna och okända adresser", () => {
    for (const url of [
      "https://127.0.0.1:5432/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:3200/api/cron/larm",
      "https://internal.example.com/hook",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.se/x",
      "https://evilfcm.googleapis.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://push.apple.com.example/x",
      "inte en adress",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false);
    }
  });
});
