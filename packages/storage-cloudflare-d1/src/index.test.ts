import { env } from "cloudflare:workers";
import { conformanceCases } from "@pegma/storage-core/conformance";
import {
  defineCollection,
  StorageError,
  type CollectionStore,
} from "@pegma/storage-core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCloudflareD1Store,
  type CloudflareD1Database,
  type CloudflareD1PreparedStatement,
  type CloudflareD1Result,
} from "./index.js";

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

function freshStore(readBatchSize?: number) {
  return createCloudflareD1Store({
    database: env.DB,
    ...(readBatchSize === undefined ? {} : { readBatchSize }),
  });
}

function collection(): CollectionStore<Widget> {
  return freshStore().collection(widgets);
}

function widget(id: string, label = id): Widget {
  return { group: "tools", id, label };
}

function wrappedDatabase(
  runBatch: <T>(
    statements: CloudflareD1PreparedStatement[],
  ) => Promise<CloudflareD1Result<T>[]>,
): CloudflareD1Database {
  return {
    prepare(query) {
      return env.DB.prepare(query);
    },
    batch: runBatch,
    withSession() {
      return undefined;
    },
  };
}

interface ReadBatchHooks {
  readonly beforeSchemaBatch?: (call: number) => void | Promise<void>;
  readonly beforeReadBatch?: (call: number) => void | Promise<void>;
  readonly afterReadBatch?: (
    call: number,
    results: CloudflareD1Result<unknown>[],
  ) => CloudflareD1Result<unknown>[] | Promise<CloudflareD1Result<unknown>[]>;
}

/** Observe the real binding; faults change only its transport/result boundary. */
function observedDatabase(hooks: ReadBatchHooks = {}) {
  const originals = new WeakMap<
    CloudflareD1PreparedStatement,
    { statement: D1PreparedStatement; sql: string }
  >();
  const readBatchSizes: number[] = [];
  let preparations = 0;
  let directKeyReads = 0;
  let schemaBatches = 0;
  let activeReadBatches = 0;
  let maximumReadBatches = 0;
  const keyed = (sql: string) =>
    sql.trimStart().startsWith("SELECT") &&
    sql.includes("WHERE partition_key = ? AND row_key = ?");
  const wrap = (
    original: D1PreparedStatement,
    sql: string,
  ): CloudflareD1PreparedStatement => {
    const counted = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const method = Reflect.get(target, property, target);
        if (property === "first" || property === "all" || property === "run") {
          return (...args: unknown[]) => {
            if (keyed(sql)) directKeyReads += 1;
            return Reflect.apply(method, target, args);
          };
        }
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
    originals.set(counted, { statement: original, sql });
    return counted;
  };
  const database: CloudflareD1Database = {
    prepare(sql) {
      preparations += 1;
      return wrap(env.DB.prepare(sql), sql);
    },
    async batch<T>(statements: CloudflareD1PreparedStatement[]) {
      const actual = statements.map((statement) => originals.get(statement));
      if (actual.some((item) => item === undefined))
        throw new Error("Unobserved prepared statement.");
      const read = actual.every((item) => keyed(item!.sql));
      if (!read) {
        if (actual[0]?.sql.trimStart().startsWith("CREATE")) {
          schemaBatches += 1;
          await hooks.beforeSchemaBatch?.(schemaBatches);
        }
        return env.DB.batch<T>(actual.map((item) => item!.statement));
      }
      readBatchSizes.push(statements.length);
      const call = readBatchSizes.length;
      activeReadBatches += 1;
      maximumReadBatches = Math.max(maximumReadBatches, activeReadBatches);
      try {
        await hooks.beforeReadBatch?.(call);
        const results = await env.DB.batch<T>(
          actual.map((item) => item!.statement),
        );
        return (
          hooks.afterReadBatch === undefined
            ? results
            : await hooks.afterReadBatch(call, results)
        ) as CloudflareD1Result<T>[];
      } finally {
        activeReadBatches -= 1;
      }
    },
    withSession() {
      throw new Error("The adapter must use the direct primary binding.");
    },
  };
  return {
    database,
    readBatchSizes,
    preparations: () => preparations,
    directKeyReads: () => directKeyReads,
    schemaBatches: () => schemaBatches,
    maximumReadBatches: () => maximumReadBatches,
  };
}

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("D1 test barrier or waiter did not settle.")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  for (const readBatchSize of [undefined, 512]) {
    describe(
      readBatchSize === undefined
        ? "default direct reads"
        : "opt-in batched reads",
      () => {
        for (const testCase of conformanceCases) {
          it(testCase.name, async () => {
            await testCase.run(() => freshStore(readBatchSize));
          });
        }
      },
    );
  }
});

describe("D1 opt-in keyed read batching", () => {
  it.each([
    0,
    -1,
    1.5,
    513,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
    null,
    true,
  ])(
    "rejects invalid readBatchSize %s with the shared StorageError before I/O",
    (readBatchSize) => {
      const observed = observedDatabase();
      expect(() =>
        createCloudflareD1Store({
          database: observed.database,
          readBatchSize: readBatchSize as number,
        }),
      ).toThrow(StorageError);
      expect(observed.preparations()).toBe(0);
      expect(observed.schemaBatches()).toBe(0);
      expect(observed.readBatchSizes).toEqual([]);
    },
  );

  it.each([undefined, 1])(
    "retains the direct first path for readBatchSize %s",
    async (readBatchSize) => {
      await collection().put(widget("direct"));
      const observed = observedDatabase();
      const records = createCloudflareD1Store({
        database: observed.database,
        createSchemaIfMissing: false,
        ...(readBatchSize === undefined ? {} : { readBatchSize }),
      }).collection(widgets);
      expect(
        await Promise.all([
          records.get({ partition: "tools", id: "direct" }),
          records.getVersioned({ partition: "tools", id: "direct" }),
          records.get({ partition: "tools", id: "absent" }),
        ]),
      ).toEqual([
        widget("direct"),
        { value: widget("direct"), version: "1" },
        null,
      ]);
      expect(observed.directKeyReads()).toBe(3);
      expect(observed.readBatchSizes).toEqual([]);
      expect(observed.schemaBatches()).toBe(0);
    },
  );

  it("aligns mixed reads across collections, missing rows, tombstones and exact 64-bit versions", async () => {
    const otherWidgets = { ...widgets, name: "d1_batched_other_widgets" };
    const seed = freshStore();
    await seed.collection(widgets).put(widget("same", "first collection"));
    await seed.collection(widgets).put(widget("second"));
    await seed.collection(widgets).put(widget("removed"));
    await seed
      .collection(widgets)
      .delete({ partition: "tools", id: "removed" });
    await seed.collection(otherWidgets).put(widget("same", "other collection"));
    await env.DB.prepare(
      "UPDATE RECORDS SET version = ? WHERE partition_key = ? AND row_key = ?",
    )
      .bind("9007199254740993", "d1_targeted_widgets:tools", "same")
      .run();
    const observed = observedDatabase();
    const store = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 3,
    });
    const records = store.collection(widgets);
    const others = store.collection(otherWidgets);
    expect(
      await bounded(
        Promise.all([
          records.get({ partition: "tools", id: "same" }),
          others.getVersioned({ partition: "tools", id: "same" }),
          records.getVersioned({ partition: "tools", id: "absent" }),
          records.getVersioned({ partition: "tools", id: "removed" }),
          records.get({ partition: "tools", id: "second" }),
          others.get({ partition: "tools", id: "absent" }),
          records.getVersioned({ partition: "tools", id: "same" }),
          records.get({ partition: "tools", id: "same" }),
        ]),
      ),
    ).toEqual([
      widget("same", "first collection"),
      { value: widget("same", "other collection"), version: "1" },
      null,
      null,
      widget("second"),
      null,
      {
        value: widget("same", "first collection"),
        version: "9007199254740993",
      },
      widget("same", "first collection"),
    ]);
    expect(observed.readBatchSizes).toEqual([3, 3, 2]);
    expect(observed.directKeyReads()).toBe(0);
    expect(observed.maximumReadBatches()).toBe(1);
  });

  it("bounds an actual 1,025-read wave to 512, 512 and one statement", async () => {
    const observed = observedDatabase();
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    }).collection(widgets);
    const values = await bounded(
      Promise.all(
        Array.from({ length: 1_025 }, (_, index) =>
          index % 2 === 0
            ? records.get({ partition: "tools", id: `missing-${index}` })
            : records.getVersioned({
                partition: "tools",
                id: `missing-${index}`,
              }),
        ),
      ),
    );
    expect(values).toEqual(Array.from({ length: 1_025 }, () => null));
    expect(observed.readBatchSizes).toEqual([512, 512, 1]);
    expect(observed.maximumReadBatches()).toBe(1);
    expect(observed.directKeyReads()).toBe(0);
  });

  it("keeps one read batch in flight as more calls arrive", async () => {
    const entered = barrier();
    const release = barrier();
    const observed = observedDatabase({
      beforeReadBatch: async (call) => {
        if (call === 1) {
          entered.release();
          await release.ready;
        }
      },
    });
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 2,
    }).collection(widgets);
    const initial = Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        records.get({ partition: "tools", id: `initial-${index}` }),
      ),
    );
    let later: Promise<(Widget | null)[]> | undefined;
    try {
      await bounded(
        Promise.race([
          entered.ready,
          initial.then(() => {
            throw new Error("Reads completed before the batch barrier.");
          }),
        ]),
      );
      later = Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          records.get({ partition: "tools", id: `later-${index}` }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(observed.readBatchSizes).toEqual([2]);
      expect(observed.maximumReadBatches()).toBe(1);
    } finally {
      release.release();
      await bounded(Promise.all([initial, later]));
    }
    expect(observed.readBatchSizes).toEqual([2, 2, 2, 2]);
    expect(observed.maximumReadBatches()).toBe(1);
  });

  it("isolates queues between Stores sharing the same real binding", async () => {
    await collection().put(widget("separate"));
    const entered = barrier();
    const release = barrier();
    const observed = observedDatabase({
      beforeReadBatch: async (call) => {
        if (call === 1) {
          entered.release();
          await release.ready;
        }
      },
    });
    const options = {
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 4,
    };
    const first = createCloudflareD1Store(options)
      .collection(widgets)
      .get({ partition: "tools", id: "separate" });
    try {
      await bounded(
        Promise.race([
          entered.ready,
          first.then(() => {
            throw new Error("Read completed before the Store barrier.");
          }),
        ]),
      );
      expect(
        await bounded(
          createCloudflareD1Store(options)
            .collection(widgets)
            .get({ partition: "tools", id: "separate" }),
        ),
      ).toEqual(widget("separate"));
      expect(observed.readBatchSizes).toEqual([1, 1]);
      expect(observed.maximumReadBatches()).toBe(2);
    } finally {
      release.release();
      await bounded(first);
    }
  });

  it("completes underfilled queues and never caches a missing, changed or recreated row", async () => {
    const observed = observedDatabase();
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    }).collection(widgets);
    const key = { partition: "tools", id: "fresh" };
    expect(await bounded(records.get(key))).toBeNull();
    await records.put(widget("fresh", "written"));
    const first = await bounded(records.getVersioned(key));
    expect(first?.value).toEqual(widget("fresh", "written"));
    await records.put(widget("fresh", "changed"));
    expect(await bounded(records.get(key))).toEqual(widget("fresh", "changed"));
    expect(await records.delete(key)).toBe(true);
    expect(await bounded(records.get(key))).toBeNull();
    await records.put(widget("fresh", "recreated"));
    const recreated = await bounded(records.getVersioned(key));
    expect(recreated?.value).toEqual(widget("fresh", "recreated"));
    expect(recreated?.version).not.toBe(first?.version);
    expect(
      await records.putIfUnchanged(widget("fresh", "stale"), first!.version),
    ).toBe(false);
    expect(await records.deleteIfUnchanged(key, first!.version)).toBe(false);
    expect(await bounded(records.get(key))).toEqual(
      widget("fresh", "recreated"),
    );
    expect(observed.readBatchSizes).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("copies each caller's physical key before asynchronous admission", async () => {
    await collection().put(widget("original"));
    await collection().put(widget("other"));
    const observed = observedDatabase();
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 4,
    }).collection(widgets);
    const firstKey = { partition: "tools", id: "original" };
    const secondKey = { partition: "tools", id: "other" };
    const first = records.get(firstKey);
    const second = records.getVersioned(secondKey);
    firstKey.id = "other";
    secondKey.partition = "changed-after-call";
    secondKey.id = "missing";
    expect(await bounded(Promise.all([first, second]))).toEqual([
      widget("original"),
      { value: widget("other"), version: "1" },
    ]);
    expect(observed.readBatchSizes).toEqual([2]);
  });

  it("does not serialize writes, transactions or internal update reads behind a paused public read", async () => {
    await collection().put(widget("concurrent", "before"));
    const entered = barrier();
    const release = barrier();
    const observed = observedDatabase({
      beforeReadBatch: async (call) => {
        if (call === 1) {
          entered.release();
          await release.ready;
        }
      },
    });
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 4,
    }).collection(widgets);
    const reading = records.get({ partition: "tools", id: "concurrent" });
    try {
      await bounded(
        Promise.race([
          entered.ready,
          reading.then(() => {
            throw new Error("Read completed before the write barrier.");
          }),
        ]),
      );
      await bounded(records.put(widget("concurrent", "put")));
      expect(
        await bounded(
          records.transact("tools", [
            { action: "put", value: widget("transaction", "committed") },
          ]),
        ),
      ).toEqual({ committed: true });
      expect(
        await bounded(
          records.update(
            { partition: "tools", id: "concurrent" },
            (current) => ({
              action: "write",
              value: widget("concurrent", `${current!.label}-updated`),
            }),
          ),
        ),
      ).toMatchObject({
        written: true,
        attempts: 1,
        value: widget("concurrent", "put-updated"),
      });
      expect(observed.directKeyReads()).toBe(1);
      expect(observed.readBatchSizes).toEqual([1]);
      expect(
        await collection().get({ partition: "tools", id: "transaction" }),
      ).toEqual(widget("transaction", "committed"));
    } finally {
      release.release();
      await bounded(reading);
    }
    expect(await reading).toEqual(widget("concurrent", "put-updated"));
  });

  it.each(["codec", "json"] as const)(
    "decodes duplicate reads independently and confines a %s failure to its own caller",
    async (fault) => {
      await collection().put(widget("duplicate"));
      interface MutableWidget {
        group: string;
        id: string;
        label: string;
      }
      const mutable = defineCollection<MutableWidget>({
        ...widgets,
        codec: {
          encode: (value) => ({ ...value }),
          decode: (value) => value as unknown as MutableWidget,
        },
      });
      const broken = {
        ...mutable,
        codec: {
          ...mutable.codec,
          decode: (
            value: Parameters<typeof mutable.codec.decode>[0],
          ): MutableWidget => {
            if (fault === "codec")
              throw new Error("Synthetic decoder failure.");
            return mutable.codec.decode(value);
          },
        },
      };
      const observed = observedDatabase({
        afterReadBatch: (call, results) => {
          if (fault !== "json" || call !== 1) return results;
          // Keep the backend row shape valid, but corrupt only one caller's JSON.
          return results.map((result, index) =>
            index !== 0
              ? result
              : {
                  ...result,
                  results: [
                    {
                      ...(result.results[0] as Record<string, unknown>),
                      record_json: "{",
                    },
                  ],
                },
          );
        },
      });
      const store = createCloudflareD1Store({
        database: observed.database,
        createSchemaIfMissing: false,
        readBatchSize: 8,
      });
      const records = store.collection(mutable);
      const key = { partition: "tools", id: "duplicate" };
      const [failure, first, versioned, second] = await bounded(
        Promise.allSettled([
          store.collection(broken).get(key),
          records.get(key),
          records.getVersioned(key),
          records.get(key),
        ] as const),
      );
      expect(failure.status).toBe("rejected");
      if (failure.status === "rejected") {
        if (fault === "codec")
          expect(failure.reason).toEqual(
            new Error("Synthetic decoder failure."),
          );
        else expect(failure.reason).toBeInstanceOf(SyntaxError);
      }
      if (
        first.status !== "fulfilled" ||
        versioned.status !== "fulfilled" ||
        second.status !== "fulfilled" ||
        first.value === null ||
        versioned.value === null ||
        second.value === null
      )
        throw new Error("Independent readers did not settle successfully.");
      expect(first.value).not.toBe(second.value);
      expect(first.value).not.toBe(versioned.value.value);
      first.value.label = "caller mutation";
      expect(second.value).toEqual(widget("duplicate"));
      expect(versioned.value).toEqual({
        value: widget("duplicate"),
        version: "1",
      });
      expect(observed.readBatchSizes).toEqual([4]);
      expect(await bounded(records.get(key))).toEqual(widget("duplicate"));
    },
  );

  it("settles a rejected real read batch, drains later queued chunks and recovers without fallback calls", async () => {
    await collection().put(widget("available"));
    const observed = observedDatabase({
      afterReadBatch: (call, results) => {
        if (call === 1) throw new Error("Synthetic read transport failure.");
        return results;
      },
    });
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 2,
    }).collection(widgets);
    const results = await bounded(
      Promise.allSettled(
        Array.from({ length: 5 }, () =>
          records.get({ partition: "tools", id: "available" }),
        ),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    for (const result of results.slice(0, 2))
      if (result.status === "rejected")
        expect(result.reason).toEqual(
          new Error("Synthetic read transport failure."),
        );
    for (const result of results.slice(2))
      if (result.status === "fulfilled")
        expect(result.value).toEqual(widget("available"));
    expect(
      await bounded(records.get({ partition: "tools", id: "available" })),
    ).toEqual(widget("available"));
    expect(observed.readBatchSizes).toEqual([2, 2, 1, 1]);
    expect(observed.directKeyReads()).toBe(0);
    expect(observed.maximumReadBatches()).toBe(1);
  });

  it.each([
    "short",
    "extra",
    "sparse",
    "null-slot",
    "rows-not-array",
    "extra-row",
    "null-row",
    "empty-version",
    "numeric-version",
    "invalid-deleted",
    "invalid-json-field",
  ] as const)(
    "rejects %s results from the real backend rather than treating them as missing records",
    async (fault) => {
      await collection().put(widget("shape"));
      const observed = observedDatabase({
        afterReadBatch: (call, results) => {
          if (call !== 1) return results;
          if (fault === "short") return results.slice(1);
          if (fault === "extra") return [...results, results[0]!];
          if (fault === "sparse")
            return new Array<CloudflareD1Result<unknown>>(results.length);
          return results.map((result) => {
            if (fault === "null-slot") return null;
            if (fault === "rows-not-array") return { ...result, results: null };
            if (fault === "extra-row")
              return {
                ...result,
                results: [...result.results, result.results[0]],
              };
            if (fault === "null-row") return { ...result, results: [null] };
            const row = result.results[0] as Record<string, unknown>;
            const fields =
              fault === "empty-version"
                ? { version: "" }
                : fault === "numeric-version"
                  ? { version: 1 }
                  : fault === "invalid-deleted"
                    ? { deleted: 2 }
                    : { record_json: 7 };
            return { ...result, results: [{ ...row, ...fields }] };
          }) as CloudflareD1Result<unknown>[];
        },
      });
      const records = createCloudflareD1Store({
        database: observed.database,
        createSchemaIfMissing: false,
        readBatchSize: 4,
      }).collection(widgets);
      const results = await bounded(
        Promise.allSettled([
          records.get({ partition: "tools", id: "shape" }),
          records.getVersioned({ partition: "tools", id: "shape" }),
        ]),
      );
      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(StorageError);
      expect(
        await bounded(records.get({ partition: "tools", id: "shape" })),
      ).toEqual(widget("shape"));
      expect(observed.readBatchSizes).toEqual([2, 1]);
      expect(observed.directKeyReads()).toBe(0);
    },
  );

  it("settles every concurrent reader after a schema failure and retries real initialization before recovery", async () => {
    await collection().put(widget("schema-ready"));
    const observed = observedDatabase({
      beforeSchemaBatch: (call) => {
        if (call === 1) throw new Error("Synthetic schema outage.");
      },
    });
    const records = createCloudflareD1Store({
      database: observed.database,
      readBatchSize: 4,
    }).collection(widgets);
    const failed = await bounded(
      Promise.allSettled([
        records.get({ partition: "tools", id: "schema-ready" }),
        records.getVersioned({ partition: "tools", id: "schema-ready" }),
      ]),
    );
    expect(failed.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const result of failed)
      if (result.status === "rejected")
        expect(result.reason).toEqual(new Error("Synthetic schema outage."));
    expect(observed.schemaBatches()).toBe(1);
    expect(observed.readBatchSizes).toEqual([]);
    expect(
      await bounded(
        Promise.all([
          records.get({ partition: "tools", id: "schema-ready" }),
          records.getVersioned({ partition: "tools", id: "schema-ready" }),
        ]),
      ),
    ).toEqual([
      widget("schema-ready"),
      { value: widget("schema-ready"), version: "1" },
    ]);
    expect(observed.schemaBatches()).toBe(2);
    expect(observed.readBatchSizes).toEqual([2]);
  });

  it("keeps update retry reads and insert-conflict fallback reads direct with batching enabled", async () => {
    const observed = observedDatabase();
    const records = createCloudflareD1Store({
      database: observed.database,
      createSchemaIfMissing: false,
      readBatchSize: 4,
    }).collection(widgets);
    const entered = barrier();
    const release = barrier();
    const key = { partition: "tools", id: "batched-aba" };
    let attempts = 0;
    const updating = records.update(key, async (current) => {
      attempts += 1;
      expect(current).toBeNull();
      if (attempts === 1) {
        entered.release();
        await release.ready;
      }
      return { action: "write", value: widget("batched-aba", "updated") };
    });
    try {
      await bounded(
        Promise.race([
          entered.ready,
          updating.then(() => {
            throw new Error("Update completed before its real OCC barrier.");
          }),
        ]),
      );
      await collection().put(widget("batched-aba", "intervening"));
      await collection().delete(key);
    } finally {
      release.release();
      await bounded(updating);
    }
    expect(await updating).toMatchObject({
      written: true,
      attempts: 2,
      value: widget("batched-aba", "updated"),
    });
    expect(observed.directKeyReads()).toBe(2);
    expect(observed.readBatchSizes).toEqual([]);
    expect(
      await records.insertIfAbsent(widget("batched-aba", "refused")),
    ).toEqual({ inserted: false, value: widget("batched-aba", "updated") });
    expect(observed.directKeyReads()).toBe(3);
    expect(observed.readBatchSizes).toEqual([]);
    expect(await bounded(records.get(key))).toEqual(
      widget("batched-aba", "updated"),
    );
    expect(observed.readBatchSizes).toEqual([1]);
  });
});

describe("D1 schema initialization", () => {
  it("is shared by stores over the same direct binding", async () => {
    let schemaBatches = 0;
    const database = wrappedDatabase(
      <T>(statements: CloudflareD1PreparedStatement[]) => {
        schemaBatches += 1;
        return env.DB.batch<T>(statements as D1PreparedStatement[]);
      },
    );
    const first = createCloudflareD1Store({ database });
    const second = createCloudflareD1Store({ database });

    await Promise.all([
      first.collection(widgets).get({ partition: "tools", id: "first" }),
      second.collection(widgets).get({ partition: "tools", id: "second" }),
    ]);

    expect(schemaBatches).toBe(1);
  });

  it("retries a rejected initialization for the same binding", async () => {
    let schemaBatches = 0;
    const database = wrappedDatabase(
      <T>(statements: CloudflareD1PreparedStatement[]) => {
        schemaBatches += 1;
        if (schemaBatches === 1) {
          return Promise.reject(new Error("transient schema failure"));
        }
        return env.DB.batch<T>(statements as D1PreparedStatement[]);
      },
    );

    await expect(
      createCloudflareD1Store({ database })
        .collection(widgets)
        .get({ partition: "tools", id: "first-attempt" }),
    ).rejects.toThrow("transient schema failure");
    await expect(
      createCloudflareD1Store({ database })
        .collection(widgets)
        .get({ partition: "tools", id: "second-attempt" }),
    ).resolves.toBeNull();

    expect(schemaBatches).toBe(2);
  });

  it("does not initialize when schema creation is disabled", async () => {
    let schemaBatches = 0;
    const database = wrappedDatabase(
      <T>(statements: CloudflareD1PreparedStatement[]) => {
        schemaBatches += 1;
        return env.DB.batch<T>(statements as D1PreparedStatement[]);
      },
    );

    await expect(
      createCloudflareD1Store({
        database,
        createSchemaIfMissing: false,
      })
        .collection(widgets)
        .get({ partition: "tools", id: "provisioned" }),
    ).resolves.toBeNull();
    expect(schemaBatches).toBe(0);
  });
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

describe("D1 transaction limits", () => {
  it("refuses more actions than one transaction may carry, before any work", async () => {
    let batches = 0;
    const database = wrappedDatabase(
      <T>(statements: CloudflareD1PreparedStatement[]) => {
        batches += 1;
        return env.DB.batch<T>(statements as D1PreparedStatement[]);
      },
    );
    let keyCalls = 0;
    const counted = {
      ...widgets,
      key: (value: Widget) => {
        keyCalls += 1;
        return widgets.key(value);
      },
    };
    const oversized = Array.from(
      { length: 101 },
      (_unused, index) =>
        ({ action: "put", value: widget(`bulk-${String(index)}`) }) as const,
    );

    await expect(
      createCloudflareD1Store({ database })
        .collection(counted)
        .transact("tools", oversized),
    ).rejects.toThrow(/at most 100 actions/);
    expect(batches).toBe(0);
    expect(keyCalls).toBe(0);
    expect(
      await collection().get({ partition: "tools", id: "bulk-0" }),
    ).toBeNull();
  });

  it("accepts a transaction at the limit", async () => {
    const records = collection();
    const atLimit = Array.from(
      { length: 100 },
      (_unused, index) =>
        ({ action: "put", value: widget(`sized-${String(index)}`) }) as const,
    );

    await expect(records.transact("tools", atLimit)).resolves.toEqual({
      committed: true,
    });
    expect(await records.get({ partition: "tools", id: "sized-99" })).toEqual(
      widget("sized-99"),
    );
  });
});

describe("D1 transaction failures", () => {
  it("rethrows an unrelated error whose text mentions a marker", async () => {
    let batches = 0;
    const database = wrappedDatabase(
      <T>(statements: CloudflareD1PreparedStatement[]) => {
        batches += 1;
        if (batches === 1) {
          return env.DB.batch<T>(statements as D1PreparedStatement[]);
        }
        return Promise.reject(
          new Error(
            "D1_ERROR: no such column: PEGMA_STORAGE_D1_TX_CHANGED at offset 7: SQLITE_ERROR",
          ),
        );
      },
    );

    await expect(
      createCloudflareD1Store({ database })
        .collection(widgets)
        .transact("tools", [{ action: "put", value: widget("unaffected") }]),
    ).rejects.toThrow(/no such column/);
    expect(batches).toBe(2);
  });

  it("reports a refused precondition raised by a guard trigger", async () => {
    const records = collection();
    await records.put(widget("occupied"));

    await expect(
      records.transact("tools", [
        { action: "insert", value: widget("occupied", "duplicate") },
      ]),
    ).resolves.toEqual({ committed: false, reason: "exists" });
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
