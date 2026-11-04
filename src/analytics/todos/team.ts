/**
 * Delägaren: en punkt "Bjud in delägaren" så länge bara en person har ett konto i
 * organisationen (butiksportalens konton räknas inte). Utan ett andra konto syns inte vem
 * som fyller på eller gör vad, och med 20 automater går det inte att dela upp arbetet.
 *
 *   nivå        = 'soon'
 *   fingerprint = antal konton och väntande inbjudningar: en ny inbjudan, en som gått ut
 *                 eller ett konto som försvinner tar upp en avbockad punkt igen
 *
 * Bara ägare och admin får punkten (laddaren skickar `team` bara för dem).
 */

import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import type { TodoItem } from "./types";

/** Sidan där inbjudan görs; `bjud-in=1` öppnar dialogen direkt. */
export const INVITE_LINK = "/installningar/anvandare?bjud-in=1";

export function teamTodos(ctx: TodoContext): TodoItem[] {
  const team = ctx.input.team;
  if (!team || team.members >= 2) return [];
  const pending = Math.max(0, team.pendingInvites);
  return [
    {
      key: "team:invite",
      fingerprint: `${team.members}|${pending}`,
      kind: "team",
      level: "soon",
      urgency: urgencyOf("soon", 0),
      atStakeOre: null,
      daysLeft: null,
      title: pending > 0 ? "Påminn delägaren om inbjudan" : "Bjud in delägaren",
      detail:
        pending > 0
          ? "Inbjudan är skickad men ingen har gått med än."
          : "Bara du har ett konto. Med två konton syns vem som fyller på.",
      evidence: evidence({
        rule: "Bara en person har ett konto i organisationen.",
        figures: [
          { key: "members", label: "Konton", value: team.members, unit: "count" },
          { key: "pendingInvites", label: "Väntande inbjudningar", value: pending, unit: "count" },
        ],
      }),
      link: INVITE_LINK,
      action: { kind: "invite-member", label: "Bjud in", params: {} },
    },
  ];
}
