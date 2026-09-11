import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type CancellationReason,
  type QueryCommandOutput,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import {
  assertOnePartition,
  ConcurrencyError,
  MAX_SCAN_PAGE_SIZE,
  StorageError,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type Store,
  type StoredRecord,
  type TransactionAction,
  type TransactionOutcome,
  type TransactionRejection,
  type VersionedRecord,
} from "@pegma/storage-core";

const DYNAMODB_SCAN_CURSOR_PREFIX = "pegma-dynamodb-scan-v1:";

/**
 * Separates partition from id in the DynamoDB sort key. Written as an
 * escape so tooling cannot turn it into a literal control character.
 */
const SORT_KEY_SEPARATOR = "\u001f";

/**
 * Characters this adapter forbids in a collection name, partition, or
 * record id: the Azure Tables set, plus the sort-key separator (already a
 * control character). Passing one through would either be rejected by a
 * sibling adapter or collide two logical keys onto one DynamoDB item.
 */
const ILLEGAL_KEY_CHARS = /[/\\#?\u0000-\u001F\u007F-\u009F]/;

/** DynamoDB TransactWriteItems accepts at most this many operations. */
const MAX_TRANSACTION_ACTIONS = 100;

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

interface DynamoDbScanCursor {
  readonly collection: string;
  readonly partition: string;
  readonly id: string;
}

interface PhysicalItem {
  readonly pk: string;
  readonly sk: string;
  readonly rec: string;
  readonly ver: string;
}

export interface DynamoDbStoreOptions {
  /**
   * A low-level DynamoDB client. The host owns credentials, region, retries,
   * and any custom endpoint (including DynamoDB Local).
   */
  readonly client: DynamoDBClient;

  /**
   * The table every collection is stored in.
   *
   * Collections share one table and are separated by the partition key, so a
   * deployment provisions one table rather than one per collection. The
   * hash key is `pk` (collection name) and the range key is `sk`.
   */
  readonly tableName: string;

  /**
   * Create the table on first use if it is missing. Defaults to true.
   *
   * Set false when the table is provisioned by infrastructure and the
   * application's identity has no permission to create tables.
   */
  readonly createTableIfMissing?: boolean;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { name?: string }).name
    : undefined;
}

function isNamed(error: unknown, name: string): boolean {
  return errorName(error) === name;
}

function assertTableName(tableName: string): void {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new StorageError(
      `DynamoDB table name ${JSON.stringify(tableName)} must be 3 to 255 characters of A-Z, a-z, 0-9, underscore, dot, or hyphen.`,
    );
  }
}

function assertKeyPart(label: string, value: string): void {
  if (value.length === 0) {
    throw new StorageError(`${label} must not be empty.`);
  }
  if (ILLEGAL_KEY_CHARS.test(value)) {
    throw new StorageError(
      `${label} contains a character this adapter forbids in keys (one of / \\ # ? or a control character): ${JSON.stringify(value)}`,
    );
  }
}

function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_PAGE_SIZE) {
    throw new StorageError(
      `Scan limit must be an integer from 1 through ${MAX_SCAN_PAGE_SIZE}.`,
    );
  }
}

function sortKey(partition: string, id: string): string {
  return `${partition}${SORT_KEY_SEPARATOR}${id}`;
}

function decodeSortKey(collection: string, sk: string): EntityKey {
  const index = sk.indexOf(SORT_KEY_SEPARATOR);
  if (index === -1) {
    throw new StorageError(
      `Authoritative scan for ${collection} received a row whose sort key is not a partition/id pair.`,
    );
  }
  return {
    partition: sk.slice(0, index),
    id: sk.slice(index + SORT_KEY_SEPARATOR.length),
  };
}

function stringAttribute(
  item: Record<string, AttributeValue> | undefined,
  name: string,
): string | undefined {
  const value = item?.[name];
  return value !== undefined && "S" in value && typeof value.S === "string"
    ? value.S
    : undefined;
}

function parseRecord(json: string): StoredRecord {
  return JSON.parse(json) as StoredRecord;
}

function mintVersion(): string {
  return crypto.randomUUID();
}

function encodeScanCursor(collection: string, key: EntityKey): string {
  return `${DYNAMODB_SCAN_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({
      collection,
      partition: key.partition,
      id: key.id,
    } satisfies DynamoDbScanCursor),
  )}`;
}

function decodeScanCursor(collection: string, cursor: string): EntityKey {
  try {
    if (!cursor.startsWith(DYNAMODB_SCAN_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(DYNAMODB_SCAN_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "collection,id,partition"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<DynamoDbScanCursor>;
    if (
      value.collection !== collection ||
      typeof value.partition !== "string" ||
      typeof value.id !== "string"
    ) {
      throw new Error("foreign cursor");
    }
    return { partition: value.partition, id: value.id };
  } catch (error) {
    throw new StorageError(
      `Scan cursor is malformed or does not belong to collection ${JSON.stringify(collection)}.`,
      { cause: error },
    );
  }
}

function physicalFromItem(
  collection: string,
  item: Record<string, AttributeValue>,
): PhysicalItem {
  const pk = stringAttribute(item, "pk");
  const sk = stringAttribute(item, "sk");
  const rec = stringAttribute(item, "rec");
  const ver = stringAttribute(item, "ver");
  if (
    pk === undefined ||
    sk === undefined ||
    rec === undefined ||
    ver === undefined
  ) {
    throw new StorageError(
      `Collection ${JSON.stringify(collection)} stored a row missing pk, sk, rec, or ver.`,
    );
  }
  if (pk !== collection) {
    throw new StorageError(
      `Authoritative scan for ${collection} received a row from another collection.`,
    );
  }
  return { pk, sk, rec, ver };
}

function keyAttributes(
  collection: string,
  key: EntityKey,
): Record<"pk" | "sk", AttributeValue> {
  return {
    pk: { S: collection },
    sk: { S: sortKey(key.partition, key.id) },
  };
}

function itemAttributes(
  collection: string,
  key: EntityKey,
  json: string,
  version: string,
): Record<string, AttributeValue> {
  return {
    ...keyAttributes(collection, key),
    rec: { S: json },
    ver: { S: version },
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  if (error instanceof TransactionCanceledException) {
    return error.CancellationReasons;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    isNamed(error, "TransactionCanceledException")
  ) {
    return (error as TransactionCanceledException).CancellationReasons;
  }
  return undefined;
}

function outcomeFromCanceled(
  error: unknown,
  actions: readonly { readonly action: TransactionAction<unknown>["action"] }[],
): TransactionOutcome | null {
  const reasons = cancellationReasons(error);
  if (reasons === undefined) {
    return null;
  }

  for (const [index, reason] of reasons.entries()) {
    if (reason.Code === undefined || reason.Code === "None") {
      continue;
    }
    if (reason.Code !== "ConditionalCheckFailed") {
      return null;
    }
    const step = actions[index];
    if (step === undefined) {
      return null;
    }

    let rejection: TransactionRejection;
    switch (step.action) {
      case "insert":
        rejection = "exists";
        break;
      case "delete":
        rejection = "missing";
        break;
      case "putIfUnchanged": {
        const item = reason.Item;
        rejection =
          item === undefined || Object.keys(item).length === 0
            ? "missing"
            : "changed";
        break;
      }
      default:
        return null;
    }

    return {
      committed: false,
      reason: rejection,
      failedAction: index,
    };
  }

  return null;
}

/**
 * Creates a {@link Store} backed by Amazon DynamoDB.
 *
 * Every collection lives in one table. The hash key is the collection name
 * and the range key is `<partition>\u001f<id>`, so listing a partition is a
 * `begins_with` query and an authoritative scan is a query of that collection
 * hash key. That is DynamoDB's native equivalent of the Azure
 * `<collection>:<partition>` layout: Query is by hash key, not by hash-key
 * prefix.
 *
 * Optimistic concurrency maps onto a UUID `ver` attribute issued on every
 * write. Deletes remove the item. Recreating the same logical key therefore
 * receives a new token, which is what keeps a stale version from becoming
 * valid again.
 *
 * Reads used for version checks are strongly consistent. Stale replicas
 * would make version tokens meaningless, the same reason the D1 adapter
 * stays on the primary.
 */
export function createDynamoDbStore(options: DynamoDbStoreOptions): Store {
  const { client } = options;
  const tableName = options.tableName;
  assertTableName(tableName);
  const createTableIfMissing = options.createTableIfMissing ?? true;

  let tableReady: Promise<void> | undefined;

  async function waitUntilActive(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const described = await client.send(
          new DescribeTableCommand({ TableName: tableName }),
        );
        if (described.Table?.TableStatus === "ACTIVE") {
          return;
        }
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) {
          throw error;
        }
      }
      await wait(50);
    }
    throw new StorageError(
      `DynamoDB table ${JSON.stringify(tableName)} did not become ACTIVE.`,
    );
  }

  function ensureTable(): Promise<void> {
    if (!createTableIfMissing) {
      return Promise.resolve();
    }
    tableReady ??= (async () => {
      try {
        await client.send(
          new CreateTableCommand({
            TableName: tableName,
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            BillingMode: "PAY_PER_REQUEST",
          }),
        );
      } catch (error) {
        if (
          !(error instanceof ResourceInUseException) &&
          !isNamed(error, "ResourceInUseException")
        ) {
          throw error;
        }
      }
      await waitUntilActive();
    })().then(
      () => undefined,
      (error: unknown) => {
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

      function partitionOf(partition: string): string {
        assertKeyPart("Partition", partition);
        return partition;
      }

      function idOf(id: string): string {
        assertKeyPart("Record id", id);
        return id;
      }

      function encoded(value: T): { readonly json: string } {
        return { json: JSON.stringify(codec.encode(value)) };
      }

      function versioned(item: PhysicalItem): VersionedRecord<T> {
        return {
          value: codec.decode(parseRecord(item.rec)),
          version: item.ver,
        };
      }

      async function read(key: EntityKey): Promise<PhysicalItem | null> {
        await ensureTable();
        const result = await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: keyAttributes(name, {
              partition: partitionOf(key.partition),
              id: idOf(key.id),
            }),
            ConsistentRead: true,
          }),
        );
        if (result.Item === undefined) {
          return null;
        }
        return physicalFromItem(name, result.Item);
      }

      async function queryPages(input: {
        readonly keyCondition: string;
        readonly values: Record<string, AttributeValue>;
        readonly start?: Record<string, AttributeValue>;
        readonly limit?: number;
      }): Promise<QueryCommandOutput> {
        await ensureTable();
        return client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: input.keyCondition,
            ExpressionAttributeValues: input.values,
            ConsistentRead: true,
            ...(input.limit === undefined ? {} : { Limit: input.limit }),
            ...(input.start === undefined
              ? {}
              : { ExclusiveStartKey: input.start }),
          }),
        );
      }

      return {
        async get(key) {
          const item = await read(key);
          return item === null ? null : codec.decode(parseRecord(item.rec));
        },

        async getVersioned(key) {
          const item = await read(key);
          return item === null ? null : versioned(item);
        },

        async insertIfAbsent(value) {
          await ensureTable();
          const key = definition.key(value);
          const stored = encoded(value);
          const version = mintVersion();
          try {
            await client.send(
              new PutItemCommand({
                TableName: tableName,
                Item: itemAttributes(
                  name,
                  {
                    partition: partitionOf(key.partition),
                    id: idOf(key.id),
                  },
                  stored.json,
                  version,
                ),
                ConditionExpression: "attribute_not_exists(pk)",
              }),
            );
            return {
              inserted: true,
              value: codec.decode(parseRecord(stored.json)),
            };
          } catch (error) {
            if (
              !(error instanceof ConditionalCheckFailedException) &&
              !isNamed(error, "ConditionalCheckFailedException")
            ) {
              throw error;
            }
          }
          const existing = await read(key);
          if (existing === null) {
            throw new StorageError(
              `Insert into ${name} conflicted but the existing record could not be read; it was deleted in between.`,
            );
          }
          return {
            inserted: false,
            value: codec.decode(parseRecord(existing.rec)),
          };
        },

        async put(value) {
          await ensureTable();
          const key = definition.key(value);
          const stored = encoded(value);
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: itemAttributes(
                name,
                {
                  partition: partitionOf(key.partition),
                  id: idOf(key.id),
                },
                stored.json,
                mintVersion(),
              ),
            }),
          );
        },

        async putIfUnchanged(value, version) {
          await ensureTable();
          const key = definition.key(value);
          const stored = encoded(value);
          try {
            await client.send(
              new PutItemCommand({
                TableName: tableName,
                Item: itemAttributes(
                  name,
                  {
                    partition: partitionOf(key.partition),
                    id: idOf(key.id),
                  },
                  stored.json,
                  mintVersion(),
                ),
                ConditionExpression: "attribute_exists(pk) AND ver = :ver",
                ExpressionAttributeValues: { ":ver": { S: version } },
              }),
            );
            return true;
          } catch (error) {
            if (
              error instanceof ConditionalCheckFailedException ||
              isNamed(error, "ConditionalCheckFailedException")
            ) {
              return false;
            }
            throw error;
          }
        },

        async update(key, decide, updateOptions) {
          const maxAttempts = updateOptions?.maxAttempts ?? 3;
          partitionOf(key.partition);
          idOf(key.id);

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const before = await read(key);
            const current =
              before === null ? null : codec.decode(parseRecord(before.rec));
            const decision = await decide(current);

            if (decision.action === "keep") {
              return { written: false, value: current, attempts: attempt };
            }

            const stored = encoded(decision.value);
            const version = mintVersion();
            const item = itemAttributes(
              name,
              {
                partition: partitionOf(key.partition),
                id: idOf(key.id),
              },
              stored.json,
              version,
            );

            try {
              if (before === null) {
                await client.send(
                  new PutItemCommand({
                    TableName: tableName,
                    Item: item,
                    ConditionExpression: "attribute_not_exists(pk)",
                  }),
                );
              } else {
                await client.send(
                  new PutItemCommand({
                    TableName: tableName,
                    Item: item,
                    ConditionExpression: "attribute_exists(pk) AND ver = :ver",
                    ExpressionAttributeValues: {
                      ":ver": { S: before.ver },
                    },
                  }),
                );
              }
              return {
                written: true,
                value: codec.decode(parseRecord(stored.json)),
                attempts: attempt,
              };
            } catch (error) {
              if (
                !(error instanceof ConditionalCheckFailedException) &&
                !isNamed(error, "ConditionalCheckFailedException")
              ) {
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
          const prefix = sortKey(partitionOf(partition), "");
          const found: VersionedRecord<T>[] = [];
          let start: Record<string, AttributeValue> | undefined;
          do {
            const page = await queryPages({
              keyCondition: "pk = :pk AND begins_with(sk, :prefix)",
              values: {
                ":pk": { S: name },
                ":prefix": { S: prefix },
              },
              ...(start === undefined ? {} : { start }),
            });
            for (const item of page.Items ?? []) {
              found.push(versioned(physicalFromItem(name, item)));
            }
            start = page.LastEvaluatedKey;
          } while (start !== undefined);
          return found;
        },

        async scan(options) {
          assertScanLimit(options.limit);
          const after =
            options.cursor === undefined
              ? null
              : decodeScanCursor(name, options.cursor);
          const collected: PhysicalItem[] = [];
          let start: Record<string, AttributeValue> | undefined =
            after === null
              ? undefined
              : keyAttributes(name, {
                  partition: partitionOf(after.partition),
                  id: idOf(after.id),
                });

          while (collected.length <= options.limit) {
            const remaining = options.limit + 1 - collected.length;
            const page = await queryPages({
              keyCondition: "pk = :pk",
              values: { ":pk": { S: name } },
              limit: remaining,
              ...(start === undefined ? {} : { start }),
            });
            for (const item of page.Items ?? []) {
              collected.push(physicalFromItem(name, item));
            }
            if (page.LastEvaluatedKey === undefined) {
              break;
            }
            start = page.LastEvaluatedKey;
            if (collected.length > options.limit) {
              break;
            }
          }

          const page = collected.slice(0, options.limit);
          const records = page.map((item) => {
            const key = decodeSortKey(name, item.sk);
            return { key, ...versioned(item) };
          });
          return {
            records,
            nextCursor:
              collected.length > options.limit
                ? encodeScanCursor(name, records[records.length - 1]!.key)
                : null,
          };
        },

        async delete(key) {
          await ensureTable();
          const result = await client.send(
            new DeleteItemCommand({
              TableName: tableName,
              Key: keyAttributes(name, {
                partition: partitionOf(key.partition),
                id: idOf(key.id),
              }),
              ReturnValues: "ALL_OLD",
            }),
          );
          return result.Attributes !== undefined;
        },

        async deleteIfUnchanged(key, version) {
          await ensureTable();
          try {
            await client.send(
              new DeleteItemCommand({
                TableName: tableName,
                Key: keyAttributes(name, {
                  partition: partitionOf(key.partition),
                  id: idOf(key.id),
                }),
                ConditionExpression: "attribute_exists(pk) AND ver = :ver",
                ExpressionAttributeValues: { ":ver": { S: version } },
              }),
            );
            return true;
          } catch (error) {
            if (
              error instanceof ConditionalCheckFailedException ||
              isNamed(error, "ConditionalCheckFailedException")
            ) {
              return false;
            }
            throw error;
          }
        },

        async transact(partition, actions) {
          if (actions.length > MAX_TRANSACTION_ACTIONS) {
            throw new StorageError(
              `A transaction may carry at most ${MAX_TRANSACTION_ACTIONS} actions, and this one has ${actions.length}.`,
            );
          }

          const keys = actions.map((step) =>
            step.action === "delete" ? step.key : definition.key(step.value),
          );
          assertOnePartition(name, partition, keys);
          for (const key of keys) {
            partitionOf(key.partition);
            idOf(key.id);
          }
          await ensureTable();

          const transactItems: TransactWriteItem[] = actions.map(
            (step, index) => {
              const key = keys[index] as EntityKey;
              const identity = keyAttributes(name, key);
              switch (step.action) {
                case "insert": {
                  const stored = encoded(step.value);
                  return {
                    Put: {
                      TableName: tableName,
                      Item: itemAttributes(
                        name,
                        key,
                        stored.json,
                        mintVersion(),
                      ),
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  };
                }
                case "put": {
                  const stored = encoded(step.value);
                  return {
                    Put: {
                      TableName: tableName,
                      Item: itemAttributes(
                        name,
                        key,
                        stored.json,
                        mintVersion(),
                      ),
                    },
                  };
                }
                case "putIfUnchanged": {
                  const stored = encoded(step.value);
                  return {
                    Put: {
                      TableName: tableName,
                      Item: itemAttributes(
                        name,
                        key,
                        stored.json,
                        mintVersion(),
                      ),
                      ConditionExpression:
                        "attribute_exists(pk) AND ver = :ver",
                      ExpressionAttributeValues: {
                        ":ver": { S: step.version },
                      },
                      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                    },
                  };
                }
                case "delete":
                  return {
                    Delete: {
                      TableName: tableName,
                      Key: identity,
                      ConditionExpression: "attribute_exists(pk)",
                    },
                  };
              }
            },
          );

          try {
            await client.send(
              new TransactWriteItemsCommand({ TransactItems: transactItems }),
            );
            return { committed: true };
          } catch (error) {
            const outcome = outcomeFromCanceled(
              error,
              actions.map((step) => ({ action: step.action })),
            );
            if (outcome === null) {
              throw error;
            }
            return outcome;
          }
        },
      };
    },
  };
}
