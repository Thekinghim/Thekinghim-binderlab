import { describe, expect, it } from "vitest";

import { computeTodos } from "./index";
import { input, NOW } from "./test-helpers";

const team = (members: number, pendingInvites = 0) =>
  computeTodos(input({ team: { members, pendingInvites } }), NOW).filter((t) => t.kind === "team");

describe("Bjud in delägaren", () => {
  it("bara ett konto: en punkt som länkar till inbjudan", () => {
    expect(team(1)).toMatchObject([
      {
        key: "team:invite",
        level: "soon",
        title: "Bjud in delägaren",
        link: "/installningar/anvandare?bjud-in=1",
        action: { kind: "invite-member", label: "Bjud in" },
        fingerprint: "1|0",
      },
    ]);
  });

  it("inbjudan skickad men inte antagen: påminnelse, nytt fingerprint", () => {
    const [t] = team(1, 1);
    expect(t?.title).toBe("Påminn delägaren om inbjudan");
    expect(t?.fingerprint).not.toBe(team(1)[0]?.fingerprint);
  });

  it("två konton eller ingen uppgift (påfyllaren): ingen punkt", () => {
    expect(team(2)).toHaveLength(0);
    expect(computeTodos(input({}), NOW).filter((t) => t.kind === "team")).toHaveLength(0);
  });
});
