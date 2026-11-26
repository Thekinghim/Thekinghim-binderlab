import { describe, expect, it } from "vitest";

import { fileNameFrom, saveRoute } from "./save-file";

const file = new File(["a;b"], "x.csv", { type: "text/csv" });

describe("saveFile: delningsarket på telefonen", () => {
  it("delar bara med finger och när filen går att dela", () => {
    const yes = { canShare: () => true };
    const no = { canShare: () => false };
    expect(saveRoute(yes, true, file)).toBe("share");
    expect(saveRoute(yes, false, file)).toBe("download");
    expect(saveRoute(no, true, file)).toBe("download");
    expect(saveRoute({}, true, file)).toBe("download");
    expect(saveRoute(undefined, true, file)).toBe("download");
    const throws = {
      canShare: () => {
        throw new Error("nej");
      },
    };
    expect(saveRoute(throws, true, file)).toBe("download");
  });

  it("filnamnet ur Content-Disposition", () => {
    expect(fileNameFrom('attachment; filename="betallista-2026-11-26.csv"', "x")).toBe(
      "betallista-2026-11-26.csv",
    );
    expect(fileNameFrom(null, "binderlab-export.zip")).toBe("binderlab-export.zip");
  });
});
