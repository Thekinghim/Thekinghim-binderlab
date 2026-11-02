import { describe, expect, it } from "vitest";

import { DEMO_USERS } from "./catalog";
import { demoOrganizationProblem, type DemoOrganizationFacts } from "./guard";

const demo: DemoOrganizationFacts = {
  slug: "nordljus-demo",
  name: "Nordljus Automater AB (demo)",
  createdByEmail: DEMO_USERS.owner.email,
  members: [
    { email: DEMO_USERS.owner.email, role: "owner" },
    { email: DEMO_USERS.viewer.email, role: "viewer" },
    { email: DEMO_USERS.refiller.email, role: "refiller" },
  ],
};

describe("demo: spärren mot att röra andra organisationer", () => {
  it("godkänner demon som seeden skapat", () => {
    expect(demoOrganizationProblem(demo, { forReset: true })).toBeNull();
    expect(
      demoOrganizationProblem(
        {
          ...demo,
          slug: "nordljus-demo-stor",
          members: [{ email: DEMO_USERS.owner.email, role: "owner" }],
        },
        { forReset: true },
      ),
    ).toBeNull();
  });

  it("vägrar en annan slug även om namnet ser ut som demon", () => {
    expect(demoOrganizationProblem({ ...demo, slug: "binderlab" }, { forReset: true })).toMatch(
      /inte en demoorganisation/,
    );
  });

  it("vägrar en kundorganisation som råkar få demons slug ('Nordljus (demo)')", () => {
    const customer: DemoOrganizationFacts = {
      slug: "nordljus-demo",
      name: "Nordljus (demo)",
      createdByEmail: "kund@example.se",
      members: [{ email: "kund@example.se", role: "owner" }],
    };
    expect(demoOrganizationProblem(customer, { forReset: true })).toMatch(/inte av demons ägare/);
    expect(demoOrganizationProblem(customer, { forReset: false })).toMatch(/inte av demons ägare/);
  });

  it("vägrar om skaparen saknas eller demons ägare inte längre är ägare", () => {
    expect(demoOrganizationProblem({ ...demo, createdByEmail: null }, { forReset: true })).toMatch(
      /okänd användare/,
    );
    const demoted = {
      ...demo,
      members: [
        { email: DEMO_USERS.owner.email, role: "viewer" },
        { email: DEMO_USERS.viewer.email, role: "owner" },
      ],
    };
    expect(demoOrganizationProblem(demoted, { forReset: false })).toMatch(/inte ägare/);
  });

  it("radering kräver att alla medlemmar är demons användare", () => {
    const shared = {
      ...demo,
      members: [...demo.members, { email: "kollega@example.se", role: "viewer" }],
    };
    expect(demoOrganizationProblem(shared, { forReset: true })).toMatch(/kollega@example\.se/);
    // Seeden får fortsätta skriva i demon även om någon bjudits in för att titta.
    expect(demoOrganizationProblem(shared, { forReset: false })).toBeNull();
  });

  it("vägrar ett namn utan (demo", () => {
    expect(
      demoOrganizationProblem({ ...demo, name: "Nordljus Automater AB" }, { forReset: true }),
    ).toMatch(/ser inte ut som en demoorganisation/);
  });
});
