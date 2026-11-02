import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getMailer, mailerStatus, MailError, OutboxMailer } from "./report-mailer";

describe("OutboxMailer", () => {
  it("skriver mejl, text, HTML, bilagor och metadata till utkorgen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bl-outbox-"));
    const mailer = new OutboxMailer(dir, "Binderlab <rapporter@binderlab.local>");
    const sent = await mailer.send({
      to: "maria@example.se",
      subject: "Gallerian Väst, oktober 2026. Försäljningen ökade.",
      html: "<p>Hej</p>",
      text: "Hej Maria,",
      attachments: [
        {
          filename: "rapport okt.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([37, 80, 68, 70]),
        },
      ],
    });
    expect(sent.providerMessageId).toMatch(/^outbox:/);
    const [folder] = await readdir(dir);
    const files = (await readdir(path.join(dir, folder!))).sort();
    expect(files).toEqual([
      "message.eml",
      "message.html",
      "message.txt",
      "meta.json",
      "rapport_okt.pdf",
    ]);
    const eml = await readFile(path.join(dir, folder!, "message.eml"), "utf8");
    expect(eml).toContain("To: maria@example.se");
    expect(eml).toContain("Subject: =?UTF-8?B?");
    expect(eml).toContain('filename="rapport_okt.pdf"');
    const meta = JSON.parse(await readFile(path.join(dir, folder!, "meta.json"), "utf8"));
    expect(meta.attachments).toEqual([
      { filename: "rapport_okt.pdf", contentType: "application/pdf", size: 4 },
    ]);
  });

  it("stoppar rubrikinjektion och ogiltiga adresser", async () => {
    const mailer = new OutboxMailer(await mkdtemp(path.join(tmpdir(), "bl-outbox-")));
    await expect(
      mailer.send({ to: "a@b.se\r\nBcc: x@y.se", subject: "x", html: "", text: "" }),
    ).rejects.toBeInstanceOf(MailError);
    await expect(
      mailer.send({ to: "inte-en-adress", subject: "x", html: "", text: "" }),
    ).rejects.toBeInstanceOf(MailError);
  });
});

describe("val av leverantör", () => {
  it("utkorg som standard, Resend kräver nyckel och avsändare", () => {
    expect(mailerStatus({})).toMatchObject({ kind: "outbox", configured: true });
    expect(mailerStatus({ MAIL_PROVIDER: "resend" })).toMatchObject({
      kind: "resend",
      configured: false,
      missing: ["RESEND_API_KEY saknas", "MAIL_FROM saknas"],
    });
    expect(() => getMailer({ MAIL_PROVIDER: "resend" })).toThrow(MailError);
    expect(
      getMailer({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", MAIL_FROM: "B <r@b.se>" })
        .kind,
    ).toBe("resend");
    expect(mailerStatus({ MAIL_PROVIDER: "smtp" }).configured).toBe(false);
  });
});
