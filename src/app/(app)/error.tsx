"use client";

import { RouteError, type RouteErrorProps } from "../_fel/route-error";

/**
 * Felgränsen för sidorna i skalet. Skalet (meny, toppbar) står kvar, och felet tar
 * sidans plats med samma behållare som sidorna. Fel i själva skalet fångas av
 * `app/error.tsx`.
 */
export default function AppError(props: RouteErrorProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <RouteError {...props} />
    </div>
  );
}
