"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { BRIEF_OPEN_EVENT, seenToday, todayIn } from "./once";

/** Rutans kod (dialogen, korten, bilderna) hämtas bara när den kan behövas. */
const DailyBriefDialog = dynamic(() => import("./dialog").then((m) => m.DailyBrief), {
  ssr: false,
});

/**
 * Dagens brief i skalet, utan att rutans kod ligger i appens start. Koden hämtas när rutan
 * inte visats i dag (den öppnas då av sig själv efter laddningen), när appen visas igen och
 * dagen har bytts, eller när knappen på Hem trycks (rutan öppnas då direkt när koden kommit).
 */
export function DailyBrief({ userKey, timeZone }: { userKey: string; timeZone: string }) {
  const [load, setLoad] = useState<null | { openNow: boolean }>(null);

  useEffect(() => {
    if (load) return;
    const check = () => {
      if (!seenToday(userKey, todayIn(timeZone))) setLoad({ openNow: false });
    };
    const timer = setTimeout(check, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const onOpen = () => setLoad({ openNow: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(BRIEF_OPEN_EVENT, onOpen);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(BRIEF_OPEN_EVENT, onOpen);
    };
  }, [load, userKey, timeZone]);

  return load ? (
    <DailyBriefDialog userKey={userKey} timeZone={timeZone} openNow={load.openNow} />
  ) : null;
}
