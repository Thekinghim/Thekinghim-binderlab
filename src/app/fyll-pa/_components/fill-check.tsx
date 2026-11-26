"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/v2/button";
import { toastUndo, toastV2 } from "@/components/v2/toast";

import { changeRoute, undoRouteChange } from "@/app/(app)/rutt/actions";
import { CHECKLIST, dayKeys, useDayChecks } from "@/app/(app)/rutt/_lib/day-checks";
import { reach } from "@/app/(app)/rutt/_lib/reach";

import type { FillStore } from "../_lib/data";
import type { FillMachine } from "../_lib/model";
import type { MachineLink } from "../_lib/tiles";
import { MachineTop } from "./fill-v2";

/**
 * Ruttläget, ett offline-stopp (automaten svarar inte): inga fack att fylla. Checklistan (samma
 * bockar som på Rutt), Stoppet klart och Hoppa över. Checklistan och Stoppet klart sparas i
 * telefonen och fungerar utan nät; Hoppa över ändrar rutten på servern och säger till när den
 * inte nås (inget låtsas vara sparat).
 */
export function CheckStopScreen({
  machine: m,
  store,
  scope,
  date,
  link,
  route,
  tools,
  onBack,
  onLeave,
  onFill,
  onSkip,
}: {
  machine: FillMachine;
  store: FillStore | null;
  /** "<org>:<användare>", som på Rutt. */
  scope: string;
  /** Ruttens dag. */
  date: string;
  link: MachineLink | null;
  route: { index: number; total: number; onPrev?: () => void; onNext?: () => void };
  tools?: ReactNode;
  onBack: () => void;
  /** Till nästa stopp (eller tillbaka till Rutt efter det sista). */
  onLeave: () => void;
  /** Automaten är i gång igen: visa facken som vanligt. */
  onFill?: () => void;
  /** Hoppa över pågår (true) eller gick inte fram (false). */
  onSkip?: (on: boolean) => void;
}) {
  const keys = dayKeys(scope, date);
  const [checks, toggleCheck] = useDayChecks(keys.check);
  const [checked, setChecked] = useDayChecks(keys.checked);
  const [skipping, setSkipping] = useState(false);
  const name = m.name || m.code;
  const isChecked = checked.has(m.id);

  const skip = async () => {
    setSkipping(true);
    onSkip?.(true);
    const r = await reach(() => changeRoute(m.id, "skip"));
    setSkipping(false);
    if (!r.ok) {
      onSkip?.(false);
      toastV2(r.error, { tone: "critical" });
      return;
    }
    const data = r.data;
    if (data) {
      toastUndo(`${name} hoppas över i dag`, undefined, () => {
        void reach(() => undoRouteChange(data.id, data.replaced)).then((u) => {
          if (!u.ok) toastV2(u.error, { tone: "critical" });
        });
      });
    }
    onLeave();
  };

  return (
    <div className="v2-fill-app v2-fill-machine v2-fill-check">
      <MachineTop
        m={m}
        store={store}
        machines={[]}
        onPick={() => {}}
        onBack={onBack}
        backLabel="Till Rutt"
        route={route}
        link={link ?? "offline"}
        tools={tools}
      />
      <div className="work">
        <div className="main2">
          <section className="chkstop">
            <h2>{isChecked ? "Kollad i dag" : "Offline · kolla på plats"}</h2>
            <p>Automaten svarar inte. Gå igenom listan.</p>
            <ul className="chk">
              {CHECKLIST.map((text, i) => {
                const id = `${m.id}:${i}`;
                return (
                  <li key={id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checks.has(id)}
                        onChange={() => toggleCheck(id)}
                      />
                      <span>{text}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {onFill ? (
              <Button variant="plain" touch className="chkfill" onClick={onFill}>
                I gång igen? Fyll på
              </Button>
            ) : null}
          </section>
        </div>
        <div className="side2">
          <div className="foot chkfoot">
            <Button
              variant="plain"
              size="lg"
              disabled={skipping}
              pending={skipping}
              onClick={() => void skip()}
            >
              Hoppa över
            </Button>
            <Button
              variant="act"
              size="lg"
              disabled={skipping}
              onClick={() => {
                setChecked(m.id, true);
                onLeave();
              }}
            >
              Stoppet klart
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
