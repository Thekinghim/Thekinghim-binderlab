import { StateMessage } from "@/components/ui/state-message";
import type { MailerStatus } from "@/server/mail/report-mailer";
import type { PdfStatus } from "@/server/pdf/render";

/**
 * Ärligt läge för de externa tjänsterna bakom utskicket: e-post (Resend eller lokal
 * utkorg), PDF (headless Chromium) och lagring. Visas bara när något inte är som i drift.
 */
export function ServiceLines({
  status,
}: {
  status: {
    mail: MailerStatus;
    pdf: PdfStatus;
    storage: { kind: "local" | "supabase"; configured: boolean; missing: string[] };
  };
}) {
  const lines: { key: string; message: string; detail: string }[] = [];
  if (status.mail.kind === "outbox") {
    lines.push({
      key: "mail",
      message: "E-post skickas inte härifrån: utskicken sparas i den lokala utkorgen.",
      detail: "Sätt MAIL_PROVIDER=resend, RESEND_API_KEY och MAIL_FROM för riktiga utskick.",
    });
  } else if (!status.mail.configured) {
    lines.push({
      key: "mail",
      message: "Resend är valt men inte konfigurerat, så inget kan skickas.",
      detail: `${status.mail.missing.join(", ")}.`,
    });
  }
  if (!status.pdf.configured) {
    lines.push({
      key: "pdf",
      message: "PDF kan inte skapas på servern. Utskrift från webbläsaren fungerar.",
      detail: `${status.pdf.missing.join(", ")}.`,
    });
  }
  if (!status.storage.configured) {
    lines.push({
      key: "storage",
      message: "Lagringen för PDF:er saknar inställningar.",
      detail: `${status.storage.missing.join(", ")}.`,
    });
  }
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-line rounded-md border border-dashed border-line-strong">
      {lines.map((l) => (
        <StateMessage
          key={l.key}
          kind="not-configured"
          compact
          message={l.message}
          detail={l.detail}
        />
      ))}
    </div>
  );
}
