import type { Metadata } from "next";

import { LanguageChoice } from "@/components/shell/simple-shell";
import { Card, CardBody } from "@/components/v2/card";
import { KeyValues } from "@/components/v2/key-values";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { getServerEnv } from "@/lib/env";
import { loadContext } from "@/server/data/core";

import { PasswordForm } from "../_components/password-form";
import { ROLE_LABEL } from "../anvandare/model";

export const metadata: Metadata = { title: "Mitt konto" };

/**
 * Mitt konto: e-post, roll och byte av lösenord. Alla roller (loadContext kräver bara
 * inloggning och medlemskap). Lösenordet byts via auth-providern (changePasswordFlow).
 */
export default async function AccountPage() {
  const ctx = await loadContext();
  let canEmailLink = false;
  try {
    canEmailLink = getServerEnv().AUTH_PROVIDER === "supabase";
  } catch {
    // Felkonfigurerad miljö: bara byte med nuvarande lösenord.
  }
  return (
    <V2Page title="Mitt konto" sub={<b>{ctx.user.displayName ?? ctx.user.email}</b>}>
      <SubNav />
      <div className="v2-cols">
        <div className="v2-stack">
          <Card title={<span id="losenord">Byt lösenord</span>}>
            <CardBody>
              <PasswordForm canEmailLink={canEmailLink} />
            </CardBody>
          </Card>
        </div>
        <div className="v2-stack">
          <Card title="Kontot">
            <CardBody>
              <KeyValues
                items={[
                  { label: "E-post", value: ctx.user.email },
                  { label: "Roll", value: ROLE_LABEL[ctx.role] },
                  { label: "Organisation", value: ctx.organization.name },
                ]}
              />
            </CardBody>
          </Card>
          <Card
            title={<span id="sprak">Language / Språk</span>}
            actions={<span className="lk">Gäller hela appen för dig</span>}
          >
            <CardBody>
              <LanguageChoice />
            </CardBody>
          </Card>
        </div>
      </div>
    </V2Page>
  );
}
