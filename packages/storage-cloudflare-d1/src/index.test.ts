import { env } from "cloudflare:workers";
import { conformanceCases } from "@pegma/storage-core/conformance";
import { defineCollection, type CollectionStore } from "@pegma/storage-core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCloudflareD1Store, type CloudflareD1Database } from "./index.js";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

function assertBindingTypes(
  database: D1Database,
  session: D1DatabaseSession,
): void {
  const direct: CloudflareD1Database = database;
  void direct;

  // @ts-expect-error A session lacks the direct binding's discriminator.
  const rejected: CloudflareD1Database = session;
  void rejected;
}
void assertBindingTypes;

interface Widget {
  readonly group: string;
  readonly id: string;
  readonly label: string;
}

const widgets = defineCollection<Widget>({
  name: "d1_targeted_widgets",
  key: (widget) => ({ partition: widget.group, id: widget.id }),
  codec: {
    encode: (widget) => ({
      group: widget.group,
      id: widget.id,
      label: widget.label,
    }),
    decode: (record) => ({
      group: String(record["group"]),
      id: String(record["id"]),
      label: String(record["label"]),
    }),
  },
});

function freshStore() {
  return createCloudflareD1Store({ database: env.DB });
}

function collection(): CollectionStore<Widget> {
  return freshStore().collection(widgets);
}

function widget(id: string, label = id): Widget {
  return { group: "tools", id, label };
}

beforeAll(async () => {
  await collection().get({ partition: "tools", id: "initialize-schema" });
});

beforeEach(async () => {
  // The Workers pool isolates storage per file, not per test. Explicitly
  // clear the shared data table so every conformance case starts fresh.
  await env.DB.prepare("DELETE FROM RECORDS").run();
  await env.DB.prepare("DELETE FROM PEGMA_STORAGE_D1_TX_GUARD").run();
});

describe("createCloudflareD1Store", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(freshStore);
    });
  }
});

describe("D1 version tombstones", () => {
  it("does not reuse a version after delete and recreate", async () => {
    const records = collection();
    const first = widget("hammer", "first");

    await records.put(first);
    const beforeDelete = await records.getVersioned(widgets.key(first));
    expect(beforeDelete).not.toBeNull();
    expect(await records.delete(widgets.key(first))).toBe(true);

    await records.put(widget("hammer", "recreated"));
    const recreated = await records.getVersioned(widgets.key(first));

    expect(recreated?.value.label).toBe("recreated");
    expect(recreated?.version).not.toBe(beforeDelete?.version);
    expect(BigInt(recreated?.version ?? "0")).toBeGreaterThan(
      BigInt(beforeDelete?.version ?? "0"),
    );
    expect(
      await records.putIfUnchanged(
        widget("hammer", "stale"),
        beforeDelete?.version ?? "",
      ),
    ).toBe(false);
  });

  it("makes update retry when a missing key changes and is deleted again", async () => {
    const records = collection();
    const key = { partition: "tools", id: "saw-aba" };
    const deciderReached: { release: () => void } = { release: () => {} };
    const resumeDecider: { release: () => void } = { release: () => {} };
    const reached = new Promise<void>((resolve) => {
      deciderReached.release = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resumeDecider.release = resolve;
    });
    let calls = 0;

    const updating = records.update(key, async (current) => {
      calls += 1;
      expect(current).toBeNull();
      if (calls === 1) {
        deciderReached.release();
        await pause;
      }
      return { action: "write", value: widget("saw-aba", "updated") };
    });

    await reached;
    await records.put(widget("saw-aba", "intervening"));
    await records.delete(key);
    resumeDecider.release();

    await expect(updating).resolves.toMatchObject({
      written: true,
      attempts: 2,
      value: widget("saw-aba", "updated"),
    });
    expect(calls).toBe(2);
  });

  it("keeps 64-bit versions exact outside JavaScript's safe integer range", async () => {
    const records = collection();
    await records.put(widget("large-version", "before"));
    await env.DB.prepare(
      "UPDATE RECORDS SET version = ? WHERE partition_key = ? AND row_key = ?",
    )
      .bind("9007199254740993", "d1_targeted_widgets:tools", "large-version")
      .run();

    const read = await records.getVersioned({
      partition: "tools",
      id: "large-version",
    });
    expect(read?.version).toBe("9007199254740993");

    expect(
      await records.putIfUnchanged(
        widget("large-version", "after"),
        "9007199254740993",
      ),
    ).toBe(true);
    await expect(
      records.getVersioned({ partition: "tools", id: "large-version" }),
    ).resolves.toMatchObject({
      version: "9007199254740994",
      value: widget("large-version", "after"),
    });
  });
});

describe("D1 transaction guards", () => {
  it("rolls back earlier writes when an insert finds an existing row", async () => {
    const records = collection();
    await records.put(widget("taken"));

    const outcome = await records.transact("tools", [
      { action: "put", value: widget("would-have-been-written") },
      { action: "insert", value: widget("taken", "duplicate") },
    ]);

    expect(outcome).toEqual({ committed: false, reason: "exists" });
    expect(
      await records.get({ partition: "tools", id: "would-have-been-written" }),
    ).toBeNull();
    expect(await records.get({ partition: "tools", id: "taken" })).toEqual(
      widget("taken"),
    );
  });

  it("distinguishes missing from changed conditional writes", async () => {
    const records = collection();
    await records.put(widget("changed", "before"));
    const stale = await records.getVersioned({
      partition: "tools",
      id: "changed",
    });
    await records.put(widget("changed", "after"));

    await expect(
      records.transact("tools", [
        {
          action: "putIfUnchanged",
          value: widget("missing"),
          version: "1",
        },
      ]),
    ).resolves.toEqual({ committed: false, reason: "missing" });

    await expect(
      records.transact("tools", [
        {
          action: "putIfUnchanged",
          value: widget("changed", "refused"),
          version: stale?.version ?? "",
        },
      ]),
    ).resolves.toEqual({ committed: false, reason: "changed" });
  });
});

describe("D1 collection names", () => {
  it("rejects the partition separator", () => {
    expect(() =>
      freshStore().collection({
        ...widgets,
        name: "has:colon",
      }),
    ).toThrow(/may not contain/);
  });
});
