import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { webProductToAwish, webSlotToAwish } = await import("./stock-web-fallback");

describe("webSlotToAwish", () => {
  it("fackets egen kapacitet (inventory) som Open API, inte kanalens", () => {
    expect(
      webSlotToAwish("2", {
        id: 7,
        channelName: " B1 ",
        goodId: 9,
        goodName: "Black Bolt",
        status: true,
        floorStatus: "ERR_NORMAL",
        currentInventory: 4,
        capacity: 8,
      }),
    ).toEqual({
      id: "7",
      machineId: "2",
      channel: "B1",
      goodId: "9",
      goodName: "Black Bolt",
      currentInventory: 4,
      capacity: 8,
    });
  });
});

describe("webProductToAwish", () => {
  it("ger samma form som Open API:s Products", () => {
    expect(
      webProductToAwish("10236", {
        id: 55,
        goodId: 9,
        goodName: " Prismatic Evolution ",
        status: true,
        currentInventory: 7,
        capacity: 20,
        channelName: " A3 ",
      }),
    ).toEqual({
      id: "55",
      machineId: "10236",
      channel: "A3",
      goodId: "9",
      goodName: "Prismatic Evolution",
      currentInventory: 7,
      capacity: 20,
    });
  });

  it("tomt fack och okänd kapacitet", () => {
    expect(
      webProductToAwish("1", {
        id: 1,
        goodId: null,
        goodName: null,
        status: false,
        currentInventory: -2,
        capacity: null,
        channelName: null,
      }),
    ).toEqual({
      id: "1",
      machineId: "1",
      channel: "",
      goodId: null,
      goodName: null,
      currentInventory: 0,
      capacity: 0,
    });
  });
});
