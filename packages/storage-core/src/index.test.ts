import { describe, expect, it, vi } from "vitest";

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

describe("memory version lifecycle", () => {
  it("uses one generation source across high-churn deleted keys", async () => {
    const collection = createMemoryStore().collection(
      defineCollection<{ readonly id: string }>({
        name: "churn",
        key: (value) => ({ partition: "all", id: value.id }),
        codec: {
          encode: (value) => ({ id: value.id }),
          decode: (record) => ({ id: String(record["id"]) }),
        },
      }),
    );
    const versions = new Set<string>();

    for (let index = 0; index < 3_000; index += 1) {
      const id = `expired-${index}`;
      await collection.put({ id });
      const stored = await collection.getVersioned({ partition: "all", id });
      expect(stored).not.toBeNull();
      versions.add(stored!.version);

      if (index % 3 === 0) {
        expect(await collection.delete({ partition: "all", id })).toBe(true);
      } else if (index % 3 === 1) {
        expect(
          await collection.deleteIfUnchanged(
            { partition: "all", id },
            stored!.version,
          ),
        ).toBe(true);
      } else {
        expect(
          await collection.transact("all", [
            { action: "delete", key: { partition: "all", id } },
          ]),
        ).toEqual({ committed: true });
      }
    }

    expect(versions.size).toBe(3_000);
    expect(await collection.scan({ limit: 1 })).toEqual({
      records: [],
      nextCursor: null,
    });

    await collection.put({ id: "reused" });
    const stale = await collection.getVersioned({
      partition: "all",
      id: "reused",
    });
    expect(stale).not.toBeNull();
    expect(
      await collection.deleteIfUnchanged(
        { partition: "all", id: "reused" },
        stale!.version,
      ),
    ).toBe(true);
    await collection.put({ id: "reused" });
    expect(
      await collection.deleteIfUnchanged(
        { partition: "all", id: "reused" },
        stale!.version,
      ),
    ).toBe(false);
  });
});

describe("memory scan selection", () => {
  it("sorts one bounded candidate page rather than once per stored row", async () => {
    const collection = createMemoryStore().collection(
      defineCollection<{ readonly id: string }>({
        name: "large",
        key: (value) => ({ partition: "all", id: value.id }),
        codec: {
          encode: (value) => ({ id: value.id }),
          decode: (record) => ({ id: String(record["id"]) }),
        },
      }),
    );
    for (let index = 4_999; index >= 0; index -= 1) {
      await collection.put({ id: String(index).padStart(4, "0") });
    }

    const sort = vi.spyOn(Array.prototype, "sort");
    let page: Awaited<ReturnType<typeof collection.scan>>;
    try {
      page = await collection.scan({ limit: 1_000 });
      expect(sort.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      sort.mockRestore();
    }

    expect(page.records).toHaveLength(1_000);
    expect(page.nextCursor).not.toBeNull();
    expect(page.records.map(({ key }) => key.id)).toEqual(
      Array.from({ length: 1_000 }, (_, index) =>
        String(index).padStart(4, "0"),
      ),
    );
  });
});
