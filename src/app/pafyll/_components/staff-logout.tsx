"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { logout } from "@/server/actions/auth";

/** Logga ut (stor tryckyta). Tillbaka till inloggningen med mobilnummer. */
export function StaffLogout() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="v2-btn quiet touch min-h-11 text-v2-mute"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await logout();
          router.replace("/logga-in/mobil");
          router.refresh();
        })
      }
    >
      Logga ut
    </button>
  );
}
