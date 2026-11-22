"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { activeSubTab, sectionsForRole, subTabHref } from "@/components/shell/nav";
import { WithCarriedQuery, withQuery } from "@/components/shell/side-nav";
import { cn } from "@/lib/cn";

import { useV2Shell } from "./shell/shell-context";

/**
 * Underflikarna (Lönsamhet · Ekonomi · Bokföring …) för en sida som byggts om till V2Page.
 * V2Page döljer skalets gamla underflikar; lägg den här först i sidans innehåll i stället:
 *
 *   <V2Page title="Lönsamhet" period>
 *     <SubNav />
 *     …
 *   </V2Page>
 *
 * Flikarna kommer från menyn (src/components/shell/nav.ts) och rollen, som skalets egna, och
 * period och filter följer med. Inget ritas när rollen ser färre än två flikar.
 */
export function SubNav({ className }: { className?: string }) {
  return (
    <Suspense fallback={<SubNavInner view={null} className={className} />}>
      <SubNavWithView className={className} />
    </Suspense>
  );
}

function SubNavWithView({ className }: { className?: string }) {
  const view = useSearchParams().get("vy");
  return <SubNavInner view={view} className={className} />;
}

function SubNavInner({ view, className }: { view: string | null; className?: string }) {
  const shell = useV2Shell();
  const path = usePathname();
  const hit = activeSubTab(path, view);
  const role = shell?.role;
  const section =
    hit && role ? sectionsForRole(role).find((s) => s.id === hit.section.id) : undefined;
  if (!hit || !section || section.tabs.length < 2) return null;
  return (
    <WithCarriedQuery>
      {(query) => (
        <nav aria-label={section.label} className={cn("v2-subnav", className)}>
          {section.tabs.map((t) => (
            <Link
              key={t.key}
              href={withQuery(subTabHref(t), query)}
              prefetch={false}
              aria-current={t.key === hit.tab.key ? "page" : undefined}
            >
              {t.short ? (
                <>
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </>
              ) : (
                t.label
              )}
            </Link>
          ))}
        </nav>
      )}
    </WithCarriedQuery>
  );
}
