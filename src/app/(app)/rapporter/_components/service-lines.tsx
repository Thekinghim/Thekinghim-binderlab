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
  // Namnen på miljövariablerna är tekniska uppgifter: de står bakom "Visa detaljer".
  const lines: { key: string; message: string; detail: string; settings: string }[] = [];
  if (status.mail.kind === "outbox") {
    lines.push({
      key: "mail",
      message: "E-post är av: utskicken sparas lokalt.",
      detail: "Riktiga utskick kräver en e-postleverantör.",
      settings: "MAIL_PROVIDER=resend, RESEND_API_KEY, MAIL_FROM",
    });
  } else if (!status.mail.configured) {
    lines.push({
      key: "mail",
      message: "E-post är inte inställd. Inget skickas.",
      detail: "Inställningarna för e-post saknas.",
      settings: status.mail.missing.join(", "),
    });
  }
  if (!status.pdf.configured) {
    lines.push({
      key: "pdf",
      message: "PDF kan inte skapas här. Skriv ut från webbläsaren.",
      detail: "Inställningarna för PDF saknas.",
      settings: status.pdf.missing.join(", "),
    });
  }
  if (!status.storage.configured) {
    lines.push({
      key: "storage",
      message: "PDF:er kan inte sparas.",
      detail: "Inställningar saknas.",
      settings: status.storage.missing.join(", "),
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
          diagnostics={l.settings ? [{ label: "Inställningar", value: l.settings }] : undefined}
        />
      ))}
    </div>
  );
}
