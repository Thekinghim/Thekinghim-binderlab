import { afterEach, describe, expect, it, vi } from "vitest";

import { keepInPlace, scrollFix } from "./keep-in-place";

describe("scrollFix", () => {
  it("rullar med skillnaden, avrundat", () => {
    expect(scrollFix(300, 520.4)).toBe(220);
    expect(scrollFix(300, 120)).toBe(-180);
  });
  it("står still under en pixel", () => {
    expect(scrollFix(300, 300.6)).toBe(0);
    expect(scrollFix(300, 300)).toBe(0);
  });
});

describe("keepInPlace", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    let top = 400;
    let onResize: (() => void) | null = null;
    const listeners = new Map<string, () => void>();
    const scrollBy = vi.fn((_x: number, dy: number) => {
      top -= dy;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          onResize = cb;
        }
        observe() {}
        disconnect() {
          onResize = null;
        }
      },
    );
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("window", {
      scrollBy,
      setTimeout: () => 1,
      clearTimeout: () => {},
      addEventListener: (e: string, f: () => void) => listeners.set(e, f),
      removeEventListener: (e: string) => listeners.delete(e),
    });
    const el = {
      isConnected: true,
      getBoundingClientRect: () => ({ top }),
      closest: () => null,
    } as unknown as HTMLElement;
    return {
      el,
      scrollBy,
      grow: (px: number) => {
        top += px;
        onResize?.();
      },
      touch: () => listeners.get("touchstart")?.(),
      get top() {
        return top;
      },
    };
  }

  it("håller kontrollen där den stod när korten ovanför växer eller krymper", () => {
    const t = setup();
    keepInPlace(t.el);
    t.grow(250);
    expect(t.scrollBy).toHaveBeenLastCalledWith(0, 250);
    t.grow(-90);
    expect(t.scrollBy).toHaveBeenLastCalledWith(0, -90);
    expect(t.top).toBe(400);
  });

  it("slutar när personen själv rör sidan", () => {
    const t = setup();
    keepInPlace(t.el);
    t.touch();
    t.grow(250);
    expect(t.scrollBy).not.toHaveBeenCalled();
  });

  it("slutar när stop anropas", () => {
    const t = setup();
    const stop = keepInPlace(t.el);
    stop();
    t.grow(100);
    expect(t.scrollBy).not.toHaveBeenCalled();
  });
});
