/**
 * Spärren som avgör om en organisation verkligen är demon innan demoverktygen
 * rör den (seeden skriver i den, --aterstall/--radera raderar den helt).
 *
 * Slug och namn räcker inte: appen sätter slug ur namnet (slugFromName), så en
 * kund som döper sin organisation till "Nordljus (demo)" får slug
 * "nordljus-demo". Demon känns därför igen på vem som skapade den och vilka
 * som är medlemmar, inte bara på slug:
 *
 * - slug är en av demons egna (DEMO_SLUGS) och namnet innehåller "(demo",
 * - organisationen skapades av demons ägare (organizations.created_by),
 * - demons ägare är ägare i den, och
 * - alla medlemmar är demons egna användare (DEMO_USERS).
 */

import { DEMO_ORGANIZATION, DEMO_ORGANIZATION_LARGE, DEMO_USERS } from "./catalog";

export const DEMO_SLUGS: readonly string[] = [DEMO_ORGANIZATION.slug, DEMO_ORGANIZATION_LARGE.slug];

const DEMO_EMAILS: ReadonlySet<string> = new Set(
  Object.values(DEMO_USERS).map((u) => u.email.toLowerCase()),
);

export interface DemoOrganizationFacts {
  slug: string;
  name: string;
  /** E-post för organizations.created_by (null om användaren saknas). */
  createdByEmail: string | null;
  members: readonly { email: string | null; role: string }[];
}

/**
 * Varför organisationen INTE får röras som demo, eller null om den är demon.
 * `forReset`: radering kräver dessutom att alla medlemmar är demons användare.
 */
export function demoOrganizationProblem(
  facts: DemoOrganizationFacts,
  options: { forReset: boolean },
): string | null {
  const owner = DEMO_USERS.owner.email.toLowerCase();
  if (!DEMO_SLUGS.includes(facts.slug)) {
    return `${facts.slug} är inte en demoorganisation.`;
  }
  if (!facts.name.includes("(demo")) {
    return `${facts.name} (${facts.slug}) ser inte ut som en demoorganisation.`;
  }
  if (facts.createdByEmail?.toLowerCase() !== owner) {
    return (
      `${facts.slug} är skapad av ${facts.createdByEmail ?? "en okänd användare"}, inte av demons ägare ` +
      `${DEMO_USERS.owner.email}. Sluggen är upptagen av en annan organisation; demon rör den inte.`
    );
  }
  const ownerMember = facts.members.find((m) => m.email?.toLowerCase() === owner);
  if (ownerMember?.role !== "owner") {
    return `${DEMO_USERS.owner.email} är inte ägare i ${facts.slug}. Demon rör den inte.`;
  }
  if (options.forReset) {
    const strangers = facts.members
      .filter((m) => m.email === null || !DEMO_EMAILS.has(m.email.toLowerCase()))
      .map((m) => `${m.email ?? "okänd användare"} (${m.role})`);
    if (strangers.length > 0) {
      return (
        `${facts.slug} har medlemmar som inte är demons användare: ${strangers.join(", ")}. ` +
        "Ta bort dem ur organisationen först om den verkligen ska raderas."
      );
    }
  }
  return null;
}
