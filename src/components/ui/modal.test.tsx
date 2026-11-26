/**
 * Modal och Lagers ark: i appens V2-skal V2:s ark (vaul, ett system för alla ark), utanför
 * skalet (Enkel vy, Fyll på) den gamla <dialog>.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sheet as LagerSheet } from "@/app/(app)/lager/_components/sheet";
import { V2ShellProvider, type V2ShellInfo } from "@/components/v2/shell/shell-context";

import { Modal } from "./modal";

const shell: V2ShellInfo = { role: "owner", openCommand: () => {}, timeZone: "Europe/Stockholm" };

function inShell(node: React.ReactNode): string {
  return renderToStaticMarkup(<V2ShellProvider value={shell}>{node}</V2ShellProvider>);
}

describe("Modal", () => {
  it("utanför V2-skalet: en <dialog>", () => {
    const html = renderToStaticMarkup(
      <Modal open={false} onClose={() => {}} title="Arkivera avtalet" />,
    );
    expect(html).toContain("<dialog");
  });

  it("i V2-skalet: V2:s ark, ingen <dialog>", () => {
    const html = inShell(<Modal open={false} onClose={() => {}} title="Arkivera avtalet" />);
    expect(html).not.toContain("<dialog");
  });
});

describe("Lagers ark", () => {
  it("utanför V2-skalet: en <dialog>", () => {
    const html = renderToStaticMarkup(
      <LagerSheet open={false} onClose={() => {}} title="Nytt lager" />,
    );
    expect(html).toContain("<dialog");
  });

  it("i V2-skalet: V2:s ark, ingen <dialog>", () => {
    const html = inShell(<LagerSheet open={false} onClose={() => {}} title="Nytt lager" />);
    expect(html).not.toContain("<dialog");
  });
});
