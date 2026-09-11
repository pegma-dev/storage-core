import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { defineCollection, type CollectionStore } from "@pegma/storage-core";
import { conformanceCases } from "@pegma/storage-core/conformance";
import { describe, expect, it } from "vitest";

import {
  DYNAMODB_LOCAL_TARBALL_SHA256,
  DYNAMODB_PORT,
  dynamoDbLocalTarballPath,
} from "../../../test/dynamodb-local.js";
import { createDynamoDbStore } from "./index.js";

const ENDPOINT = `http://127.0.0.1:${DYNAMODB_PORT}`;

let tableCounter = 0;

function serviceClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: "local",
      secretAccessKey: "local",
    },
  });
}

/** Fresh store instances over one table no other test has touched. */
function freshStoreFactory() {
  tableCounter += 1;
  const tableName = `pegmaconformance${tableCounter}t${process.pid}`;
  const client = serviceClient();
  return () =>
    createDynamoDbStore({
      client,
      tableName,
    });
}

function freshStore() {
  return freshStoreFactory()();
}

interface Widget {
  readonly group: string;
  readonly id: string;
  readonly label: string;
}

const widgets = defineCollection<Widget>({
  name: "dynamo_targeted_widgets",
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

function collection(): CollectionStore<Widget> {
  return freshStore().collection(widgets);
}

function widget(id: string, label = id): Widget {
  return { group: "tools", id, label };
}

describe("createDynamoDbStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(freshStoreFactory());
    });
  }
});

describe("DynamoDB Local pin", () => {
  it("runs against the SHA-256 of the pinned official tarball", () => {
    const tarball = dynamoDbLocalTarballPath();
    if (!existsSync(tarball)) {
      throw new Error(
        `DynamoDB Local tarball missing at ${tarball}; the harness should have verified it before this suite.`,
      );
    }
    const digest = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    expect(digest).toBe(DYNAMODB_LOCAL_TARBALL_SHA256);
  });
});

describe("DynamoDB table initialization", () => {
  it("is shared by stores over the same table", async () => {
    tableCounter += 1;
    const tableName = `pegmashared${tableCounter}t${process.pid}`;
    const client = serviceClient();
    const first = createDynamoDbStore({ client, tableName });
    const second = createDynamoDbStore({ client, tableName });

    await Promise.all([
      first.collection(widgets).get({ partition: "tools", id: "first" }),
      second.collection(widgets).get({ partition: "tools", id: "second" }),
    ]);

    await expect(
      first.collection(widgets).get({ partition: "tools", id: "first" }),
    ).resolves.toBeNull();
  });

  it("does not create a table when creation is disabled", async () => {
    const records = createDynamoDbStore({
      client: serviceClient(),
      tableName: "pegmaMissingTableForSure",
      createTableIfMissing: false,
    }).collection(widgets);

    await expect(
      records.get({ partition: "tools", id: "provisioned" }),
    ).rejects.toThrow();
  });
});

describe("DynamoDB versions", () => {
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
    expect(
      await records.putIfUnchanged(
        widget("hammer", "stale"),
        beforeDelete?.version ?? "",
      ),
    ).toBe(false);
  });
});

describe("DynamoDB transaction guards", () => {
  it("rolls back earlier writes when an insert finds an existing row", async () => {
    const records = collection();
    await records.put(widget("taken"));

    const outcome = await records.transact("tools", [
      { action: "put", value: widget("would-have-been-written") },
      { action: "insert", value: widget("taken", "duplicate") },
    ]);

    expect(outcome).toEqual({
      committed: false,
      reason: "exists",
      failedAction: 1,
    });
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
    ).resolves.toMatchObject({ committed: false, reason: "missing" });

    await expect(
      records.transact("tools", [
        {
          action: "putIfUnchanged",
          value: widget("changed", "refused"),
          version: stale?.version ?? "",
        },
      ]),
    ).resolves.toMatchObject({ committed: false, reason: "changed" });
  });
});

describe("DynamoDB transaction limits", () => {
  it("refuses more actions than one transaction may carry, before any work", async () => {
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
      freshStore().collection(counted).transact("tools", oversized),
    ).rejects.toThrow(/at most 100 actions/);
    expect(keyCalls).toBe(0);
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

describe("DynamoDB key constraints", () => {
  it("rejects a partition containing a character this adapter forbids", async () => {
    const store = freshStore();
    const records = store.collection({
      name: "guarded",
      key: (value: { readonly id: string }) => ({
        partition: "bad/partition",
        id: value.id,
      }),
      codec: {
        encode: (value) => ({ id: value.id }),
        decode: (record) => ({ id: String(record["id"]) }),
      },
    });

    await expect(
      records.get({ partition: "bad/partition", id: "x" }),
    ).rejects.toThrow(/forbids in keys/);
  });

  it("rejects a collection name containing the partition separator", () => {
    const store = freshStore();
    expect(() =>
      store.collection({
        name: "has:colon",
        key: (value: { readonly id: string }) => ({
          partition: "all",
          id: value.id,
        }),
        codec: {
          encode: (value) => ({ id: value.id }),
          decode: (record) => ({ id: String(record["id"]) }),
        },
      }),
    ).toThrow(/may not contain/);
  });

  it("rejects an illegal DynamoDB table name", () => {
    expect(() =>
      createDynamoDbStore({
        client: serviceClient(),
        tableName: "no",
      }),
    ).toThrow(/table name/);
  });
});

describe("DynamoDB source bytes", () => {
  it("writes key-constraint control characters as escapes", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("\\u0000-\\u001F");
    expect(source).toContain("\\u001f");
    expect(source.includes("\u0000")).toBe(false);
    expect(source.includes("\u001f")).toBe(false);
  });
});
