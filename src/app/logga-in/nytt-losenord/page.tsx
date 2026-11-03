import type { Metadata } from "next";

import { AuthFrame } from "../auth-frame";
import { NewPasswordForm } from "./new-password-form";

export const metadata: Metadata = { title: "Nytt lösenord" };

/**
 * Landningssidan för "Glömt lösenord?"-länken. Supabases standardmall lämnar
 * sessionen i fragmentet; formuläret skickar den tillsammans med det nya
 * lösenordet (setPasswordFromLinkFlow).
 */
export default function NewPasswordPage() {
  return (
    <AuthFrame eyebrow={<span>Inloggning</span>} title="Nytt lösenord.">
      <NewPasswordForm />
    </AuthFrame>
  );
}
