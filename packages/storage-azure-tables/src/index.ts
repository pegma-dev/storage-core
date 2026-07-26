import type {
  TableClient,
  TableEntity,
  TableEntityResult,
} from "@azure/data-tables";
import {
  ConcurrencyError,
  StorageError,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type Store,
  type StoredRecord,
  type StoredValue,
  type VersionedRecord,
} from "@pegma/storage-core";

/**
 * Properties the table itself owns. A record may not use these names, because
 * writing them would either be rejected or silently shadow the key.
 */
const RESERVED = new Set(["partitionkey", "rowkey", "timestamp", "etag"]);

/**
 * Characters Azure Table Storage forbids in a partition or row key.
 *
 * Forward slash, backslash, number sign, question mark, and control
 * characters. Passing one through produces an opaque service error, so it is
 * caught here where the message can say which value was wrong.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_KEY_CHARS = /[/\\#?\u0000-\u001F\u007F-\u009F]/;

function assertKeyPart(label: string, value: string): void {
  if (value.length === 0) {
    throw new StorageError(`${label} must not be empty.`);
  }
  if (ILLEGAL_KEY_CHARS.test(value)) {
    throw new StorageError(
      `${label} contains a character Azure Table Storage forbids in keys (one of / \\ # ? or a control character): ${JSON.stringify(value)}`,
    );
  }
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}

function isStatus(error: unknown, code: number): boolean {
  return statusCode(error) === code;
}

/** OData string literals escape a single quote by doubling it. */
function odataLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encode(record: StoredRecord): Record<string, StoredValue> {
  const entity: Record<string, StoredValue> = {};
  for (const [name, value] of Object.entries(record)) {
    if (RESERVED.has(name.toLowerCase())) {
      throw new StorageError(
        `A record may not define the property ${JSON.stringify(name)}; that name belongs to the table.`,
      );
    }
    // Null is written by omission. Because every write replaces the whole
    // entity, an omitted property is an absent one, which is what clearing
    // a field is supposed to mean.
    if (value !== null) {
      entity[name] = value;
    }
  }
  return entity;
}

function decode(
  entity: TableEntityResult<Record<string, unknown>>,
): StoredRecord {
  const record: Record<string, StoredValue> = {};
  for (const [name, value] of Object.entries(entity)) {
    if (RESERVED.has(name.toLowerCase()) || name.startsWith("odata.")) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      record[name] = value;
    } else if (value instanceof Date) {
      record[name] = value.toISOString();
    } else {
      record[name] = String(value);
    }
  }
  return record;
}

export interface AzureTablesStoreOptions {
  /**
   * A client for the table every collection is stored in.
   *
   * Collections share one table and are separated by a partition-key prefix,
   * so a deployment provisions one table rather than one per collection.
   */
  readonly client: TableClient;

  /**
   * Create the table on first use if it is missing. Defaults to true.
   *
   * Set false when the table is provisioned by infrastructure and the
   * application's identity has no permission to create tables.
   */
  readonly createTableIfMissing?: boolean;
}

/**
 * Creates a {@link Store} backed by Azure Table Storage.
 *
 * Every collection lives in one table. A record's partition key is
 * `<collection>:<partition>` and its row key is the record id, so listing a
 * partition stays a single-partition query, which is the only kind Table
 * Storage performs well.
 *
 * Optimistic concurrency maps onto ETags: `update` re-reads and re-runs its
 * decider whenever a conditional write is rejected, and `deleteIfUnchanged`
 * is a conditional delete.
 */
export function createAzureTablesStore(
  options: AzureTablesStoreOptions,
): Store {
  const { client } = options;
  const createTableIfMissing = options.createTableIfMissing ?? true;

  let tableReady: Promise<void> | undefined;

  function ensureTable(): Promise<void> {
    if (!createTableIfMissing) {
      return Promise.resolve();
    }
    // Memoized so concurrent callers share one attempt, and rejected so a
    // transient failure can be retried rather than cached forever.
    tableReady ??= client.createTable().then(
      () => undefined,
      (error: unknown) => {
        if (isStatus(error, 409)) {
          return;
        }
        tableReady = undefined;
        throw error;
      },
    );
    return tableReady;
  }

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const { codec, name } = definition;

      if (name.includes(":")) {
        throw new StorageError(
          `Collection name ${JSON.stringify(name)} may not contain ":", which separates the collection from the partition in a key.`,
        );
      }
      assertKeyPart("Collection name", name);

      function partitionKey(partition: string): string {
        assertKeyPart("Partition", partition);
        return `${name}:${partition}`;
      }

      function rowKey(id: string): string {
        assertKeyPart("Record id", id);
        return id;
      }

      async function read(
        key: EntityKey,
      ): Promise<TableEntityResult<Record<string, unknown>> | null> {
        await ensureTable();
        try {
          return await client.getEntity(
            partitionKey(key.partition),
            rowKey(key.id),
          );
        } catch (error) {
          if (isStatus(error, 404)) {
            return null;
          }
          throw error;
        }
      }

      function entityFor(
        key: EntityKey,
        value: T,
      ): TableEntity<Record<string, StoredValue>> {
        // The record spreads first so the keys cannot be shadowed, even
        // though `encode` already rejects a record that tries.
        return {
          ...encode(codec.encode(value)),
          partitionKey: partitionKey(key.partition),
          rowKey: rowKey(key.id),
        };
      }

      function versioned(
        entity: TableEntityResult<Record<string, unknown>>,
      ): VersionedRecord<T> {
        return { value: codec.decode(decode(entity)), version: entity.etag };
      }

      return {
        async get(key) {
          const entity = await read(key);
          return entity === null ? null : codec.decode(decode(entity));
        },

        async getVersioned(key) {
          const entity = await read(key);
          return entity === null ? null : versioned(entity);
        },

        async insertIfAbsent(value) {
          await ensureTable();
          const key = definition.key(value);
          try {
            await client.createEntity(entityFor(key, value));
            return { inserted: true, value: codec.decode(codec.encode(value)) };
          } catch (error) {
            if (!isStatus(error, 409)) {
              throw error;
            }
          }
          // Lost the race. Report what the winner stored rather than what
          // this caller tried to write.
          const existing = await read(key);
          if (existing === null) {
            throw new StorageError(
              `Insert into ${name} conflicted but the existing record could not be read; it was deleted in between.`,
            );
          }
          return { inserted: false, value: codec.decode(decode(existing)) };
        },

        async put(value) {
          await ensureTable();
          const key = definition.key(value);
          // Upsert, not update: `put` creates as readily as it replaces, and
          // `updateEntity` requires the row to already exist.
          await client.upsertEntity(entityFor(key, value), "Replace");
        },

        async putIfUnchanged(value, version) {
          await ensureTable();
          const key = definition.key(value);
          try {
            await client.updateEntity(entityFor(key, value), "Replace", {
              etag: version,
            });
            return true;
          } catch (error) {
            const status = statusCode(error);
            // 404: gone. 412: changed since it was read.
            if (status === 404 || status === 412) {
              return false;
            }
            throw error;
          }
        },

        async update(key, decide, updateOptions) {
          const maxAttempts = updateOptions?.maxAttempts ?? 3;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const before = await read(key);
            const current =
              before === null ? null : codec.decode(decode(before));
            const decision = await decide(current);

            if (decision.action === "keep") {
              return { written: false, value: current, attempts: attempt };
            }

            const entity = entityFor(key, decision.value);
            try {
              if (before === null) {
                await client.createEntity(entity);
              } else {
                await client.updateEntity(entity, "Replace", {
                  etag: before.etag,
                });
              }
              return {
                written: true,
                value: codec.decode(codec.encode(decision.value)),
                attempts: attempt,
              };
            } catch (error) {
              const status = statusCode(error);
              // 409: another writer created it first.
              // 412: it changed since it was read.
              // 404: it was deleted since it was read.
              if (status !== 409 && status !== 412 && status !== 404) {
                throw error;
              }
            }
          }

          throw new ConcurrencyError(name, key, maxAttempts);
        },

        async list(partition) {
          const rows = await this.listVersioned(partition);
          return rows.map((row) => row.value);
        },

        async listVersioned(partition) {
          await ensureTable();
          const filter = `PartitionKey eq ${odataLiteral(partitionKey(partition))}`;
          const found: VersionedRecord<T>[] = [];
          for await (const entity of client.listEntities({
            queryOptions: { filter },
          })) {
            found.push(versioned(entity));
          }
          return found;
        },

        async delete(key) {
          await ensureTable();
          try {
            await client.deleteEntity(
              partitionKey(key.partition),
              rowKey(key.id),
            );
            return true;
          } catch (error) {
            if (isStatus(error, 404)) {
              return false;
            }
            throw error;
          }
        },

        async deleteIfUnchanged(key, version) {
          await ensureTable();
          try {
            await client.deleteEntity(
              partitionKey(key.partition),
              rowKey(key.id),
              { etag: version },
            );
            return true;
          } catch (error) {
            const status = statusCode(error);
            // 404: already gone. 412: changed since it was read. Both mean
            // leave it alone.
            if (status === 404 || status === 412) {
              return false;
            }
            throw error;
          }
        },
      };
    },
  };
}
