import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";

import { DriftNav } from "./_components/drift-nav";

/** Drift: undersidornas meny och service workern (offline-läge och push). */
export default function DriftLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 pt-6 pb-16 md:px-8 md:pt-8">
      <DriftNav />
      <ServiceWorkerRegistration />
      {children}
    </div>
  );
}
