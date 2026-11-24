import type { Metadata } from "next";

import { requireStaff } from "@/server/staff/session";

import { NewPinForm } from "./new-pin-form";

export const metadata: Metadata = { title: "Ny PIN-kod" };

/** Första inloggningen (eller efter "Ny PIN-kod" från ägaren): välj en egen kod. */
export default async function NewPinPage() {
  await requireStaff();
  return (
    <div className="v2-card mt-4">
      <div className="v2-card-body flex flex-col gap-4">
        <div>
          <h1 className="text-v2-lg font-semibold">Välj en egen PIN-kod</h1>
          <p className="mt-1 text-v2-mute">
            6 siffror som bara du vet. Du använder den nästa gång du loggar in.
          </p>
        </div>
        <NewPinForm />
      </div>
    </div>
  );
}
