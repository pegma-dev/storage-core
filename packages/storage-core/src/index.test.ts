import { describe, expect, it } from "vitest";

import { conformanceCases } from "./conformance.js";
import { createMemoryStore, defineCollection } from "./index.js";

describe("createMemoryStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const store = createMemoryStore();
      await testCase.run(() => store);
    });
  }
});

describe("defineCollection", () => {
  it("returns the declaration unchanged", () => {
    const declaration = {
      name: "things",
      key: (value: { readonly id: string }) => ({
        partition: "all",
        id: value.id,
      }),
      codec: {
        encode: (value: { readonly id: string }) => ({ id: value.id }),
        decode: (record: Readonly<Record<string, unknown>>) => ({
          id: String(record["id"]),
        }),
      },
    };

    expect(defineCollection(declaration)).toBe(declaration);
  });
});

describe("store isolation", () => {
  it("gives each store its own records", async () => {
    const things = defineCollection<{ readonly id: string }>({
      name: "things",
      key: (value) => ({ partition: "all", id: value.id }),
      codec: {
        encode: (value) => ({ id: value.id }),
        decode: (record) => ({ id: String(record["id"]) }),
      },
    });

    const first = createMemoryStore().collection(things);
    const second = createMemoryStore().collection(things);
    await first.put({ id: "only-in-first" });

    expect(
      await second.get({ partition: "all", id: "only-in-first" }),
    ).toBeNull();
  });
});
