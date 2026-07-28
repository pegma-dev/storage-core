import { TableClient } from "@azure/data-tables";
import { conformanceCases } from "@pegma/storage-core/conformance";
import { describe, expect, it } from "vitest";

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

describe("createAzureTablesStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(freshStoreFactory());
    });
  }
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
