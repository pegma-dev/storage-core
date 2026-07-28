import { TableClient, type TableEntityResult } from "@azure/data-tables";
import {
  defineCollection,
  StorageError,
  type StoredValue,
} from "@pegma/storage-core";
import { conformanceCases } from "@pegma/storage-core/conformance";
import { describe, expect, it, vi } from "vitest";

import { TABLE_PORT } from "../../../test/azurite.js";
import { createAzureTablesStore } from "./index.js";

/**
 * Azurite's well-known development credentials. These are published emulator
 * defaults, identical in every Azurite install, and grant access to nothing
 * beyond the local process.
 */
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/${ACCOUNT};`,
].join(";");

let tableCounter = 0;

/** Fresh store instances over one table no other test has touched. */
function freshStoreFactory() {
  tableCounter += 1;
  const table = `pegmaconformance${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return () => createAzureTablesStore({ client });
}

function freshStore() {
  return freshStoreFactory()();
}

const scanErrors = defineCollection<{ readonly id: string }>({
  name: "scanerrors",
  key: (value) => ({ partition: "all", id: value.id }),
  codec: {
    encode: (value) => ({ id: value.id }),
    decode: (record) => ({ id: String(record["id"]) }),
  },
});

function pageWithContinuation(continuationToken: string) {
  return Object.assign(
    [] as Array<TableEntityResult<Record<string, StoredValue>>>,
    { continuationToken },
  );
}

function resumedScanWithFailure(error: unknown) {
  const validSdkContinuation = Buffer.from(
    JSON.stringify({ nextPartitionKey: `${scanErrors.name}:all` }),
  ).toString("base64");
  const next = vi
    .fn()
    .mockResolvedValueOnce({
      done: false,
      value: pageWithContinuation(validSdkContinuation),
    })
    .mockRejectedValueOnce(error);
  const client = {
    listEntities: vi.fn(() => ({
      byPage: vi.fn(() => ({ next })),
    })),
  } as unknown as TableClient;
  const collection = createAzureTablesStore({
    client,
    createTableIfMissing: false,
  }).collection(scanErrors);
  return { collection, next };
}

describe("createAzureTablesStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(freshStoreFactory());
    });
  }
});

describe("Azure scan errors", () => {
  for (const [name, error] of [
    [
      "throttling",
      Object.assign(new Error("throttled"), {
        statusCode: 429,
        code: "TooManyRequests",
      }),
    ],
    [
      "authentication",
      Object.assign(new Error("forbidden"), {
        statusCode: 403,
        code: "AuthorizationFailure",
      }),
    ],
    [
      "network",
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    ],
  ] as const) {
    it(`preserves a resumed-scan ${name} error`, async () => {
      const { collection } = resumedScanWithFailure(error);
      const first = await collection.scan({ limit: 1 });
      expect(first.nextCursor).not.toBeNull();

      await expect(
        collection.scan({
          limit: 1,
          cursor: first.nextCursor as string,
        }),
      ).rejects.toBe(error);
    });
  }

  it("classifies a genuinely malformed SDK continuation token", async () => {
    const malformedSdkToken = Buffer.from("{").toString("base64");
    const cursor = `pegma-azure-tables-scan-v1:${encodeURIComponent(
      JSON.stringify({
        collection: scanErrors.name,
        continuation: malformedSdkToken,
      }),
    )}`;
    const collection = freshStore().collection(scanErrors);

    const failure = await collection
      .scan({ limit: 1, cursor })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/Scan cursor is malformed/),
      cause: expect.any(SyntaxError),
    });
  });
});

describe("Azure key constraints", () => {
  it("rejects a partition containing a character Table Storage forbids", async () => {
    const store = freshStore();
    const collection = store.collection({
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
      collection.get({ partition: "bad/partition", id: "x" }),
    ).rejects.toThrow(/forbids in keys/);
  });

  it("rejects a record property that would collide with the table's own", async () => {
    const store = freshStore();
    const collection = store.collection({
      name: "colliding",
      key: (value: { readonly id: string }) => ({
        partition: "all",
        id: value.id,
      }),
      codec: {
        encode: (value) => ({ id: value.id, rowKey: "hijacked" }),
        decode: (record) => ({ id: String(record["id"]) }),
      },
    });

    await expect(collection.put({ id: "x" })).rejects.toThrow(
      /belongs to the table/,
    );
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
});
