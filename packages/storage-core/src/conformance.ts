import assert from "node:assert/strict";

import { ConcurrencyError, defineCollection, type Store } from "./index.js";

/**
 * The behaviour every {@link Store} implementation must exhibit.
 *
 * These cases are the specification. An adapter is finished when it passes
 * them, and a behaviour that is not asserted here is not something a
 * component may rely on.
 *
 * The suite has no test-framework dependency so that it can run under
 * whatever runner an adapter already uses:
 *
 * ```ts
 * for (const testCase of conformanceCases) {
 *   it(testCase.name, () => testCase.run(() => createMyStore()));
 * }
 * ```
 */
export interface ConformanceCase {
  readonly name: string;
  /**
   * `createStore` must return a store with no records in the collections this
   * suite uses. Returning a fresh instance per call is the simplest way.
   */
  run(createStore: () => Store): Promise<void>;
}

interface Widget {
  readonly group: string;
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly retiredAt: string | null;
}

const widgets = defineCollection<Widget>({
  name: "pegma_conformance_widgets",
  key: (widget) => ({ partition: widget.group, id: widget.id }),
  codec: {
    encode: (widget) => ({
      group: widget.group,
      id: widget.id,
      label: widget.label,
      count: widget.count,
      retiredAt: widget.retiredAt,
    }),
    decode: (record) => ({
      group: String(record["group"]),
      id: String(record["id"]),
      label: String(record["label"]),
      count: Number(record["count"]),
      retiredAt:
        record["retiredAt"] == null ? null : String(record["retiredAt"]),
    }),
  },
});

const others = defineCollection<Widget>({
  name: "pegma_conformance_others",
  key: widgets.key,
  codec: widgets.codec,
});

function widget(overrides: Partial<Widget> = {}): Widget {
  return {
    group: "tools",
    id: "hammer",
    label: "Hammer",
    count: 1,
    retiredAt: null,
    ...overrides,
  };
}

function testCase(
  name: string,
  run: (store: Store) => Promise<void>,
): ConformanceCase {
  return { name, run: (createStore) => run(createStore()) };
}

export const conformanceCases: readonly ConformanceCase[] = [
  testCase(
    "get returns null for a key that was never written",
    async (store) => {
      const collection = store.collection(widgets);
      assert.equal(
        await collection.get({ partition: "tools", id: "absent" }),
        null,
      );
    },
  ),

  testCase("put then get round-trips through the codec", async (store) => {
    const collection = store.collection(widgets);
    const value = widget({ label: "Claw hammer", count: 3 });
    await collection.put(value);
    assert.deepEqual(await collection.get(widgets.key(value)), value);
  }),

  testCase("put replaces an existing record whole", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ label: "First", retiredAt: "2026-01-01" }));
    await collection.put(widget({ label: "Second" }));

    const stored = await collection.get({ partition: "tools", id: "hammer" });
    assert.equal(stored?.label, "Second");
    // Not merged onto the previous record: a null in the new value clears.
    assert.equal(stored?.retiredAt, null);
  }),

  testCase("insertIfAbsent reports the record it created", async (store) => {
    const collection = store.collection(widgets);
    const result = await collection.insertIfAbsent(widget({ label: "Fresh" }));

    assert.equal(result.inserted, true);
    assert.equal(result.value.label, "Fresh");
  }),

  testCase(
    "insertIfAbsent leaves an existing record alone and returns it",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.insertIfAbsent(widget({ label: "Original" }));
      const result = await collection.insertIfAbsent(
        widget({ label: "Later" }),
      );

      assert.equal(result.inserted, false);
      assert.equal(result.value.label, "Original");

      const stored = await collection.get({ partition: "tools", id: "hammer" });
      assert.equal(stored?.label, "Original");
    },
  ),

  testCase("update creates a record when none exists", async (store) => {
    const collection = store.collection(widgets);
    const result = await collection.update(
      { partition: "tools", id: "hammer" },
      (current) => {
        assert.equal(current, null);
        return { action: "write", value: widget({ label: "Created" }) };
      },
    );

    assert.equal(result.written, true);
    assert.equal(result.value?.label, "Created");
    assert.equal(result.attempts, 1);
  }),

  testCase("update sees the current record and replaces it", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ count: 4 }));

    const result = await collection.update(
      { partition: "tools", id: "hammer" },
      (current) => {
        assert.equal(current?.count, 4);
        return {
          action: "write",
          value: { ...(current as Widget), count: current!.count + 1 },
        };
      },
    );

    assert.equal(result.value?.count, 5);
    assert.equal((await collection.get(widgets.key(widget())))?.count, 5);
  }),

  testCase("update that keeps does not write", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ label: "Untouched" }));

    const result = await collection.update(
      { partition: "tools", id: "hammer" },
      () => ({ action: "keep" }),
    );

    assert.equal(result.written, false);
    assert.equal(result.value?.label, "Untouched");
    assert.equal(
      (await collection.get(widgets.key(widget())))?.label,
      "Untouched",
    );
  }),

  testCase("update that keeps a missing record reports null", async (store) => {
    const collection = store.collection(widgets);
    const result = await collection.update(
      { partition: "tools", id: "absent" },
      () => ({ action: "keep" }),
    );

    assert.equal(result.written, false);
    assert.equal(result.value, null);
  }),

  testCase(
    "update re-runs the decider against state written mid-decision",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.put(widget({ count: 1 }));

      const seen: number[] = [];
      let interfered = false;

      const result = await collection.update(
        { partition: "tools", id: "hammer" },
        async (current) => {
          seen.push(current?.count ?? -1);
          if (!interfered) {
            interfered = true;
            // A competing writer lands while this decision is in flight.
            await collection.put(widget({ count: 100 }));
          }
          return {
            action: "write",
            value: { ...(current as Widget), count: current!.count + 1 },
          };
        },
      );

      assert.deepEqual(seen, [1, 100]);
      assert.equal(result.written, true);
      assert.equal(result.value?.count, 101);
      assert.equal(result.attempts, 2);
    },
  ),

  testCase("update gives up after the attempt limit", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ count: 0 }));

    let round = 0;
    await assert.rejects(
      collection.update(
        { partition: "tools", id: "hammer" },
        async (current) => {
          round += 1;
          // Always lose the race.
          await collection.put(widget({ count: round * 10 }));
          return {
            action: "write",
            value: { ...(current as Widget), count: 1 },
          };
        },
        { maxAttempts: 2 },
      ),
      (error: unknown) =>
        error instanceof ConcurrencyError && error.attempts === 2,
    );
    assert.equal(round, 2);
  }),

  testCase("list returns every record in a partition", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ id: "hammer" }));
    await collection.put(widget({ id: "wrench" }));

    const found = await collection.list("tools");
    assert.deepEqual(found.map((item) => item.id).sort(), ["hammer", "wrench"]);
  }),

  testCase("list does not cross partitions", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ group: "tools", id: "hammer" }));
    await collection.put(widget({ group: "toys", id: "hammer" }));

    assert.deepEqual(
      (await collection.list("toys")).map((item) => item.group),
      ["toys"],
    );
  }),

  testCase("list returns nothing for an unused partition", async (store) => {
    const collection = store.collection(widgets);
    assert.deepEqual(await collection.list("empty"), []);
  }),

  testCase(
    "keys sharing a separator character stay distinct",
    async (store) => {
      const collection = store.collection(widgets);
      // "a" + "b c" and "a b" + "c" must not collide.
      await collection.put(widget({ group: "a", id: "b c", label: "first" }));
      await collection.put(widget({ group: "a b", id: "c", label: "second" }));

      assert.equal(
        (await collection.get({ partition: "a", id: "b c" }))?.label,
        "first",
      );
      assert.equal(
        (await collection.get({ partition: "a b", id: "c" }))?.label,
        "second",
      );
      assert.equal((await collection.list("a")).length, 1);
    },
  ),

  testCase("collections do not share records", async (store) => {
    await store.collection(widgets).put(widget({ label: "In widgets" }));
    const other = store.collection(others);

    assert.equal(await other.get({ partition: "tools", id: "hammer" }), null);
  }),

  testCase("delete reports whether anything was removed", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget());

    assert.equal(
      await collection.delete({ partition: "tools", id: "hammer" }),
      true,
    );
    assert.equal(
      await collection.get({ partition: "tools", id: "hammer" }),
      null,
    );
    assert.equal(
      await collection.delete({ partition: "tools", id: "hammer" }),
      false,
    );
  }),

  testCase("getVersioned reports null for a missing record", async (store) => {
    const collection = store.collection(widgets);
    assert.equal(
      await collection.getVersioned({ partition: "tools", id: "absent" }),
      null,
    );
  }),

  testCase("a write changes the version token", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ count: 1 }));
    const first = await collection.getVersioned(widgets.key(widget()));

    await collection.put(widget({ count: 2 }));
    const second = await collection.getVersioned(widgets.key(widget()));

    if (first === null || second === null) {
      throw new Error("expected both reads to find the record");
    }
    assert.notEqual(first.version, second.version);
    assert.equal(second.value.count, 2);
  }),

  testCase("listVersioned reports usable version tokens", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ id: "hammer" }));
    await collection.put(widget({ id: "wrench" }));

    const rows = await collection.listVersioned("tools");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(
        await collection.deleteIfUnchanged(widgets.key(row.value), row.version),
        true,
      );
    }
    assert.deepEqual(await collection.list("tools"), []);
  }),

  testCase(
    "deleteIfUnchanged refuses a record that moved on",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.put(widget({ count: 1 }));
      const seen = await collection.getVersioned(widgets.key(widget()));
      if (seen === null) {
        throw new Error("expected the record to exist");
      }

      // The record becomes live again between enumeration and deletion.
      await collection.put(widget({ count: 2 }));

      assert.equal(
        await collection.deleteIfUnchanged(widgets.key(widget()), seen.version),
        false,
      );
      assert.equal((await collection.get(widgets.key(widget())))?.count, 2);
    },
  ),

  testCase(
    "putIfUnchanged writes when the version still matches",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.put(widget({ count: 1 }));
      const seen = await collection.getVersioned(widgets.key(widget()));
      if (seen === null) {
        throw new Error("expected the record to exist");
      }

      assert.equal(
        await collection.putIfUnchanged(
          { ...seen.value, count: 2 },
          seen.version,
        ),
        true,
      );
      assert.equal((await collection.get(widgets.key(widget())))?.count, 2);
    },
  ),

  testCase("putIfUnchanged refuses a record that moved on", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ count: 1 }));
    const seen = await collection.getVersioned(widgets.key(widget()));
    if (seen === null) {
      throw new Error("expected the record to exist");
    }

    // Someone else writes between the read and the conditional write.
    await collection.put(widget({ count: 50 }));

    assert.equal(
      await collection.putIfUnchanged(
        { ...seen.value, count: 2 },
        seen.version,
      ),
      false,
    );
    assert.equal((await collection.get(widgets.key(widget())))?.count, 50);
  }),

  testCase("putIfUnchanged refuses a record already gone", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget());
    const seen = await collection.getVersioned(widgets.key(widget()));
    if (seen === null) {
      throw new Error("expected the record to exist");
    }
    await collection.delete(widgets.key(widget()));

    assert.equal(
      await collection.putIfUnchanged(seen.value, seen.version),
      false,
    );
    assert.equal(await collection.get(widgets.key(widget())), null);
  }),

  testCase("putIfUnchanged moves the version on", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ count: 1 }));
    const first = await collection.getVersioned(widgets.key(widget()));
    if (first === null) {
      throw new Error("expected the record to exist");
    }

    assert.equal(
      await collection.putIfUnchanged(
        { ...first.value, count: 2 },
        first.version,
      ),
      true,
    );
    // The token that authorized the first write must not authorize a second.
    assert.equal(
      await collection.putIfUnchanged(
        { ...first.value, count: 3 },
        first.version,
      ),
      false,
    );
  }),

  testCase("transact applies every action", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ id: "doomed" }));

    const outcome = await collection.transact("tools", [
      { action: "insert", value: widget({ id: "hammer", count: 1 }) },
      { action: "put", value: widget({ id: "wrench", count: 2 }) },
      { action: "delete", key: { partition: "tools", id: "doomed" } },
    ]);

    assert.equal(outcome.committed, true);
    const found = await collection.list("tools");
    assert.deepEqual(found.map((item) => item.id).sort(), ["hammer", "wrench"]);
  }),

  testCase("a refused action leaves the partition untouched", async (store) => {
    const collection = store.collection(widgets);
    await collection.put(widget({ id: "hammer", count: 1 }));

    const outcome = await collection.transact("tools", [
      { action: "put", value: widget({ id: "wrench", count: 9 }) },
      // Taken already, so the whole transaction must be refused.
      { action: "insert", value: widget({ id: "hammer", count: 99 }) },
    ]);

    assert.equal(outcome.committed, false);
    if (outcome.committed) {
      throw new Error("unreachable");
    }
    assert.equal(outcome.reason, "exists");
    // failedAction is best effort; not every backend reports it.

    // Neither action applied.
    assert.equal(
      await collection.get({ partition: "tools", id: "wrench" }),
      null,
    );
    assert.equal(
      (await collection.get({ partition: "tools", id: "hammer" }))?.count,
      1,
    );
  }),

  testCase(
    "transact refuses a conditional write whose record moved on",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.put(widget({ id: "hammer", count: 1 }));
      const seen = await collection.getVersioned({
        partition: "tools",
        id: "hammer",
      });
      if (seen === null) {
        throw new Error("expected the record to exist");
      }
      await collection.put(widget({ id: "hammer", count: 2 }));

      const outcome = await collection.transact("tools", [
        { action: "put", value: widget({ id: "wrench", count: 5 }) },
        {
          action: "putIfUnchanged",
          value: widget({ id: "hammer", count: 3 }),
          version: seen.version,
        },
      ]);

      assert.equal(outcome.committed, false);
      if (outcome.committed) {
        throw new Error("unreachable");
      }
      assert.equal(outcome.reason, "changed");

      // Neither the conditional write nor its sibling applied.
      assert.equal(
        (await collection.get({ partition: "tools", id: "hammer" }))?.count,
        2,
      );
      assert.equal(
        await collection.get({ partition: "tools", id: "wrench" }),
        null,
      );
    },
  ),
  testCase("transact refuses a delete of a missing record", async (store) => {
    const collection = store.collection(widgets);
    const outcome = await collection.transact("tools", [
      { action: "delete", key: { partition: "tools", id: "absent" } },
    ]);

    assert.equal(outcome.committed, false);
    if (outcome.committed) {
      throw new Error("unreachable");
    }
    assert.equal(outcome.reason, "missing");
  }),

  testCase(
    "transact rejects an action outside its partition",
    async (store) => {
      const collection = store.collection(widgets);
      await assert.rejects(
        collection.transact("tools", [
          { action: "put", value: widget({ group: "toys", id: "ball" }) },
        ]),
        /may only touch partition/,
      );
    },
  ),

  testCase("transact rejects touching one key twice", async (store) => {
    const collection = store.collection(widgets);
    await assert.rejects(
      collection.transact("tools", [
        { action: "put", value: widget({ id: "hammer", count: 1 }) },
        { action: "put", value: widget({ id: "hammer", count: 2 }) },
      ]),
      /more than once/,
    );
  }),

  testCase(
    "deleteIfUnchanged reports false for a record already gone",
    async (store) => {
      const collection = store.collection(widgets);
      await collection.put(widget());
      const seen = await collection.getVersioned(widgets.key(widget()));
      if (seen === null) {
        throw new Error("expected the record to exist");
      }
      assert.equal(await collection.delete(widgets.key(widget())), true);

      // The token is one this store issued; the record it described is gone.
      // Version tokens are opaque and backend-issued, so a token the store
      // never minted is outside the contract and is not asserted here.
      assert.equal(
        await collection.deleteIfUnchanged(widgets.key(widget()), seen.version),
        false,
      );
    },
  ),
];
