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
  type TransactionRejection,
  type VersionedRecord,
} from "@pegma/storage-core";

const RECORDS_TABLE = "RECORDS";
const GUARD_TABLE = "PEGMA_STORAGE_D1_TX_GUARD";
const D1_SCAN_CURSOR_PREFIX = "pegma-cloudflare-d1-scan-v1:";

const MARKERS = {
  exists: "PEGMA_STORAGE_D1_TX_EXISTS",
  missing: "PEGMA_STORAGE_D1_TX_MISSING",
  changed: "PEGMA_STORAGE_D1_TX_CHANGED",
} as const satisfies Record<TransactionRejection, string>;

/** D1 prefixes a failed statement's message with this. */
const D1_ERROR_PREFIX = "D1_ERROR: ";

/**
 * Largest transaction this adapter submits, matching the Azure adapter's
 * entity-group limit so the same action list is accepted or refused by both.
 *
 * D1 counts a batch as one query against the invocation budget, while each
 * guarded action costs up to three statements. Rejecting an oversized list
 * here preserves the Azure adapter's action bound and keeps the failure a
 * `StorageError` naming the cause rather than an opaque backend error.
 */
const MAX_TRANSACTION_ACTIONS = 100;

function assertVersionToken(version: unknown): asserts version is string {
  if (
    typeof version !== "string" ||
    version.trim().length === 0 ||
    version.trim() === "*"
  ) {
    throw new TypeError(
      'Version must be a non-empty opaque token other than "*".',
    );
  }
}

const schemaInitializations = new WeakMap<
  CloudflareD1Database,
  Promise<void>
>();

const CREATE_RECORDS = `
  CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
    partition_key TEXT NOT NULL,
    row_key TEXT NOT NULL,
    record_json TEXT,
    version INTEGER NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    PRIMARY KEY (partition_key, row_key)
  ) STRICT
`;

const CREATE_GUARD = `
  CREATE TABLE IF NOT EXISTS ${GUARD_TABLE} (
    reason TEXT NOT NULL
  ) STRICT
`;

const CREATE_EXISTS_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_EXISTS
  BEFORE INSERT ON ${GUARD_TABLE}
  WHEN NEW.reason = 'exists'
  BEGIN
    SELECT RAISE(ABORT, '${MARKERS.exists}');
  END
`;

const CREATE_MISSING_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_MISSING
  BEFORE INSERT ON ${GUARD_TABLE}
  WHEN NEW.reason = 'missing'
  BEGIN
    SELECT RAISE(ABORT, '${MARKERS.missing}');
  END
`;

const CREATE_CHANGED_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_CHANGED
  BEFORE INSERT ON ${GUARD_TABLE}
  WHEN NEW.reason = 'changed'
  BEGIN
    SELECT RAISE(ABORT, '${MARKERS.changed}');
  END
`;

const SELECT_ONE = `
  SELECT record_json, CAST(version AS TEXT) AS version, deleted
  FROM ${RECORDS_TABLE}
  WHERE partition_key = ? AND row_key = ?
`;

const SELECT_PARTITION = `
  SELECT record_json, CAST(version AS TEXT) AS version
  FROM ${RECORDS_TABLE}
  WHERE partition_key = ? AND deleted = 0
`;

const SCAN_FIRST = `
  SELECT partition_key, row_key, record_json, CAST(version AS TEXT) AS version
  FROM ${RECORDS_TABLE}
  WHERE partition_key >= ? AND partition_key < ? AND deleted = 0
  ORDER BY partition_key, row_key
  LIMIT ?
`;

const SCAN_AFTER = `
  SELECT partition_key, row_key, record_json, CAST(version AS TEXT) AS version
  FROM ${RECORDS_TABLE}
  WHERE partition_key >= ? AND partition_key < ? AND deleted = 0
    AND (partition_key > ? OR (partition_key = ? AND row_key > ?))
  ORDER BY partition_key, row_key
  LIMIT ?
`;

const INSERT_IF_ABSENT = `
  INSERT INTO ${RECORDS_TABLE}
    (partition_key, row_key, record_json, version, deleted)
  VALUES (?, ?, ?, 1, 0)
  ON CONFLICT (partition_key, row_key) DO UPDATE SET
    record_json = excluded.record_json,
    version = ${RECORDS_TABLE}.version + 1,
    deleted = 0
  WHERE ${RECORDS_TABLE}.deleted = 1
  RETURNING record_json
`;

const PUT = `
  INSERT INTO ${RECORDS_TABLE}
    (partition_key, row_key, record_json, version, deleted)
  VALUES (?, ?, ?, 1, 0)
  ON CONFLICT (partition_key, row_key) DO UPDATE SET
    record_json = excluded.record_json,
    version = ${RECORDS_TABLE}.version + 1,
    deleted = 0
`;

const PUT_IF_UNCHANGED = `
  UPDATE ${RECORDS_TABLE}
  SET record_json = ?, version = version + 1, deleted = 0
  WHERE partition_key = ? AND row_key = ? AND deleted = 0
    AND CAST(version AS TEXT) = ?
  RETURNING record_json
`;

const INSERT_NEW = `
  INSERT INTO ${RECORDS_TABLE}
    (partition_key, row_key, record_json, version, deleted)
  VALUES (?, ?, ?, 1, 0)
  ON CONFLICT (partition_key, row_key) DO NOTHING
  RETURNING record_json
`;

const RESTORE_VERSION = `
  UPDATE ${RECORDS_TABLE}
  SET record_json = ?, version = version + 1, deleted = 0
  WHERE partition_key = ? AND row_key = ? AND deleted = 1
    AND CAST(version AS TEXT) = ?
  RETURNING record_json
`;

const REPLACE_VERSION = `
  UPDATE ${RECORDS_TABLE}
  SET record_json = ?, version = version + 1
  WHERE partition_key = ? AND row_key = ? AND deleted = 0
    AND CAST(version AS TEXT) = ?
  RETURNING record_json
`;

const DELETE = `
  UPDATE ${RECORDS_TABLE}
  SET record_json = NULL, version = version + 1, deleted = 1
  WHERE partition_key = ? AND row_key = ? AND deleted = 0
  RETURNING CAST(version AS TEXT) AS version
`;

const DELETE_IF_UNCHANGED = `
  UPDATE ${RECORDS_TABLE}
  SET record_json = NULL, version = version + 1, deleted = 1
  WHERE partition_key = ? AND row_key = ? AND deleted = 0
    AND CAST(version AS TEXT) = ?
  RETURNING CAST(version AS TEXT) AS version
`;

const GUARD_EXISTS = `
  INSERT INTO ${GUARD_TABLE} (reason)
  SELECT 'exists'
  WHERE EXISTS (
    SELECT 1 FROM ${RECORDS_TABLE}
    WHERE partition_key = ? AND row_key = ? AND deleted = 0
  )
`;

const GUARD_MISSING = `
  INSERT INTO ${GUARD_TABLE} (reason)
  SELECT 'missing'
  WHERE NOT EXISTS (
    SELECT 1 FROM ${RECORDS_TABLE}
    WHERE partition_key = ? AND row_key = ? AND deleted = 0
  )
`;

// `IS NOT` keeps the mismatch test total even if either side is ever NULL.
const GUARD_CHANGED = `
  INSERT INTO ${GUARD_TABLE} (reason)
  SELECT 'changed'
  WHERE EXISTS (
    SELECT 1 FROM ${RECORDS_TABLE}
    WHERE partition_key = ? AND row_key = ? AND deleted = 0
      AND CAST(version AS TEXT) IS NOT ?
  )
`;

interface RecordRow {
  readonly record_json: string;
  readonly version: string;
}

interface PhysicalRow {
  readonly record_json: string | null;
  readonly version: string;
  readonly deleted: number;
}

interface JsonRow {
  readonly record_json: string;
}

interface VersionRow {
  readonly version: string;
}

interface ScanRow extends RecordRow {
  readonly partition_key: string;
  readonly row_key: string;
}

interface D1ScanCursor {
  readonly collection: string;
  readonly partition: string;
  readonly id: string;
}

/** The portion of a D1 query result used by this adapter. */
export interface CloudflareD1Result<T = unknown> {
  readonly results: T[];
}

/**
 * The prepared-statement operations used by this adapter.
 *
 * This structural type keeps the published declarations self-contained. A
 * Cloudflare `D1PreparedStatement` satisfies it without an SDK dependency.
 */
export interface CloudflareD1PreparedStatement {
  bind(...values: unknown[]): CloudflareD1PreparedStatement;
  first<T = unknown>(columnName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<CloudflareD1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<CloudflareD1Result<T>>;
}

/**
 * The direct D1 binding operations used by this adapter.
 *
 * `withSession` is required as a discriminator: the real `D1Database`
 * satisfies this interface, while a `D1DatabaseSession` deliberately does
 * not. The adapter never calls `withSession`; all queries use the direct
 * primary-routed binding.
 */
export interface CloudflareD1Database {
  prepare(query: string): CloudflareD1PreparedStatement;
  batch<T = unknown>(
    statements: CloudflareD1PreparedStatement[],
  ): Promise<CloudflareD1Result<T>[]>;
  withSession(constraintOrBookmark?: string): unknown;
}

export interface CloudflareD1StoreOptions {
  /**
   * The D1 binding that stores every collection.
   *
   * Pass the binding itself, not a D1 session. Direct binding calls stay on
   * the primary database, which optimistic version checks require.
   */
  readonly database: CloudflareD1Database;

  /**
   * Create the records and transaction-guard schema on first use.
   * Defaults to true.
   *
   * Set false when deployment migrations provision the schema and the
   * application's binding should not run DDL.
   */
  readonly createSchemaIfMissing?: boolean;

  /**
   * Coalesce concurrent public keyed and partition reads into read-only batches.
   * Defaults to 1, retaining direct reads. Must be an integer from 1
   * through 512. Larger values suit bounded small records, not arbitrary rows.
   *
   * This limits each physical batch, not the total pending queue. Opt-in
   * queues belong to this Store instance and have no size limit. Callers must
   * bound concurrent read waves and construct the Store per request.
   * No values are cached, and writes/internal optimistic reads are unchanged.
   */
  readonly readBatchSize?: number;
}

type PendingRead =
  | {
      readonly kind: "keyed";
      readonly partition: string;
      readonly id: string;
      readonly resolve: (row: PhysicalRow | null) => void;
      readonly reject: (reason: unknown) => void;
    }
  | {
      readonly kind: "partition";
      readonly partition: string;
      readonly resolve: (rows: RecordRow[]) => void;
      readonly reject: (reason: unknown) => void;
    };

function recordRow(row: PhysicalRow | null): RecordRow | null {
  return row === null || row.deleted === 1 || row.record_json === null
    ? null
    : { record_json: row.record_json, version: row.version };
}

/**
 * Validate all transport slots before resolving any caller. JSON and collection
 * codecs still run separately in each public reader, after this shared batch.
 * Direct first/all calls retain their existing typed-binding behavior.
 */
function batchSettlements(
  results: CloudflareD1Result<unknown>[],
  jobs: readonly PendingRead[],
): (() => void)[] {
  if (!Array.isArray(results) || results.length !== jobs.length) {
    const kind = jobs.every((job) => job.kind === "keyed")
      ? "keyed-read"
      : jobs.every((job) => job.kind === "partition")
        ? "partition-read"
        : "mixed-read";
    throw new StorageError(`D1 returned an invalid ${kind} batch.`);
  }
  return Array.from(results, (result, index) => {
    const job = jobs[index]!;
    if (
      result === null ||
      typeof result !== "object" ||
      !Array.isArray(result.results)
    ) {
      throw new StorageError(`D1 returned an invalid ${job.kind}-read result.`);
    }
    if (job.kind === "keyed") {
      const resolve = job.resolve;
      if (result.results.length > 1)
        throw new StorageError("D1 returned an invalid keyed-read result.");
      if (result.results.length === 0) return () => resolve(null);
      const row: unknown = result.results[0];
      if (
        row === null ||
        typeof row !== "object" ||
        !("version" in row) ||
        typeof row.version !== "string" ||
        row.version.length === 0 ||
        !("deleted" in row) ||
        (row.deleted !== 0 && row.deleted !== 1) ||
        !("record_json" in row) ||
        (row.record_json !== null && typeof row.record_json !== "string")
      ) {
        throw new StorageError("D1 returned an invalid keyed-read row.");
      }
      const physical: PhysicalRow = {
        record_json: row.record_json,
        version: row.version,
        deleted: row.deleted,
      };
      return () => resolve(physical);
    }
    const rows = Array.from(result.results, (row: unknown): RecordRow => {
      if (
        row === null ||
        typeof row !== "object" ||
        !("version" in row) ||
        typeof row.version !== "string" ||
        row.version.length === 0 ||
        !("record_json" in row) ||
        typeof row.record_json !== "string"
      ) {
        throw new StorageError("D1 returned an invalid partition-read row.");
      }
      return { record_json: row.record_json, version: row.version };
    });
    const resolve = job.resolve;
    return () => resolve(rows);
  });
}

function parseRecord(json: string): StoredRecord {
  return JSON.parse(json) as StoredRecord;
}

function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_PAGE_SIZE) {
    throw new StorageError(
      `Scan limit must be an integer from 1 through ${MAX_SCAN_PAGE_SIZE}.`,
    );
  }
}

function encodeScanCursor(collection: string, key: EntityKey): string {
  return `${D1_SCAN_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({
      collection,
      partition: key.partition,
      id: key.id,
    } satisfies D1ScanCursor),
  )}`;
}

function decodeScanCursor(collection: string, cursor: string): EntityKey {
  try {
    if (!cursor.startsWith(D1_SCAN_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(D1_SCAN_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "collection,id,partition"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<D1ScanCursor>;
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

function encoded<T>(
  definition: CollectionDefinition<T>,
  value: T,
): { readonly json: string } {
  const record = definition.codec.encode(value);
  for (const stored of Object.values(record)) {
    if (typeof stored === "number" && !Number.isFinite(stored)) {
      throw new TypeError("Stored record numbers must be finite.");
    }
  }
  return {
    json: JSON.stringify(record),
  };
}

/**
 * Classifies a failed batch by the abort message a guard trigger raised.
 *
 * D1 reports `RAISE(ABORT, marker)` as
 * `D1_ERROR: <marker>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`,
 * so only the raised message ahead of the first `: ` is compared, and it must
 * equal a marker exactly. An unrelated failure that merely mentions a marker
 * somewhere in its text is a real error and must reach the caller rather than
 * be reported as a refused precondition, which would hide it behind a conflict
 * that never happened.
 */
function markerRejection(error: unknown): TransactionRejection | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const reported = message.startsWith(D1_ERROR_PREFIX)
    ? message.slice(D1_ERROR_PREFIX.length)
    : message;
  const end = reported.indexOf(": ");
  const raised = end === -1 ? reported : reported.slice(0, end);
  for (const reason of ["exists", "missing", "changed"] as const) {
    if (raised === MARKERS[reason]) {
      return reason;
    }
  }
  return null;
}

/**
 * Creates a {@link Store} backed by one Cloudflare D1 database binding.
 *
 * All collections share one data table. The physical partition key is
 * `<collection>:<partition>`, and the row key is the record id. Deletes are
 * retained as tombstones so a recreated logical key always receives a newer
 * version token.
 */
export function createCloudflareD1Store(
  options: CloudflareD1StoreOptions,
): Store {
  const { database } = options;
  const createSchemaIfMissing = options.createSchemaIfMissing ?? true;
  const readBatchSize =
    options.readBatchSize === undefined ? 1 : options.readBatchSize;
  if (
    !Number.isSafeInteger(readBatchSize) ||
    readBatchSize < 1 ||
    readBatchSize > 512
  ) {
    throw new StorageError(
      "Read batch size must be an integer from 1 through 512.",
    );
  }
  const pendingReads: PendingRead[] = [];
  let readBatchScheduled = false;
  let readBatchRunning = false;

  function ensureSchema(): Promise<void> {
    if (!createSchemaIfMissing) {
      return Promise.resolve();
    }

    const existing = schemaInitializations.get(database);
    if (existing !== undefined) {
      return existing;
    }

    // Defer preparation into a microtask so `pending` is cached before any
    // synchronous binding failure can be observed by the rejection handler.
    const pending = Promise.resolve()
      .then(() =>
        database.batch([
          database.prepare(CREATE_RECORDS),
          database.prepare(CREATE_GUARD),
          database.prepare(CREATE_EXISTS_TRIGGER),
          database.prepare(CREATE_MISSING_TRIGGER),
          database.prepare(CREATE_CHANGED_TRIGGER),
        ]),
      )
      .then(
        () => undefined,
        (error: unknown) => {
          // Delete only this attempt. A later attempt must not be evicted if
          // an unusual thenable reports the old failure late.
          if (schemaInitializations.get(database) === pending) {
            schemaInitializations.delete(database);
          }
          throw error;
        },
      );
    schemaInitializations.set(database, pending);
    return pending;
  }

  function scheduleReadBatch(): void {
    if (readBatchScheduled || readBatchRunning || pendingReads.length === 0) {
      return;
    }
    readBatchScheduled = true;
    queueMicrotask(() => {
      readBatchScheduled = false;
      // Every batch failure settles its callers below. Their read promises
      // retain the work; there is no detached timer or background cache.
      void drainReadBatches();
    });
  }

  async function drainReadBatches(): Promise<void> {
    if (readBatchRunning) return;
    readBatchRunning = true;
    try {
      while (pendingReads.length > 0) {
        const jobs = pendingReads.splice(0, readBatchSize);
        try {
          const results = await database.batch<unknown>(
            jobs.map((job) =>
              job.kind === "keyed"
                ? database.prepare(SELECT_ONE).bind(job.partition, job.id)
                : database.prepare(SELECT_PARTITION).bind(job.partition),
            ),
          );
          const settlements = batchSettlements(results, jobs);
          for (const settle of settlements) settle();
        } catch (error) {
          for (const job of jobs) job.reject(error);
        }
      }
    } finally {
      readBatchRunning = false;
      scheduleReadBatch();
    }
  }

  async function queuedRead(
    partition: string,
    id: string,
  ): Promise<PhysicalRow | null> {
    await ensureSchema();
    return new Promise<PhysicalRow | null>((resolve, reject) => {
      pendingReads.push({ kind: "keyed", partition, id, resolve, reject });
      scheduleReadBatch();
    });
  }

  async function queuedPartitionRead(partition: string): Promise<RecordRow[]> {
    await ensureSchema();
    return new Promise<RecordRow[]>((resolve, reject) => {
      pendingReads.push({ kind: "partition", partition, resolve, reject });
      scheduleReadBatch();
    });
  }

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const { codec, name } = definition;

      if (name.length === 0) {
        throw new StorageError("Collection name must not be empty.");
      }
      if (name.includes(":")) {
        throw new StorageError(
          `Collection name ${JSON.stringify(name)} may not contain ":", which separates the collection from the partition in a key.`,
        );
      }

      function partitionKey(partition: string): string {
        return `${name}:${partition}`;
      }

      async function readPhysical(key: EntityKey): Promise<PhysicalRow | null> {
        await ensureSchema();
        return database
          .prepare(SELECT_ONE)
          .bind(partitionKey(key.partition), key.id)
          .first<PhysicalRow>();
      }

      async function read(key: EntityKey): Promise<RecordRow | null> {
        const row = await readPhysical(key);
        return recordRow(row);
      }

      async function readForGet(key: EntityKey): Promise<RecordRow | null> {
        const row =
          readBatchSize === 1
            ? await readPhysical(key)
            : await queuedRead(partitionKey(key.partition), key.id);
        return recordRow(row);
      }

      function decodeRow(row: RecordRow): VersionedRecord<T> {
        return {
          value: codec.decode(parseRecord(row.record_json)),
          version: row.version,
        };
      }

      async function listVersioned(
        partition: string,
      ): Promise<VersionedRecord<T>[]> {
        if (readBatchSize > 1) {
          const rows = await queuedPartitionRead(partitionKey(partition));
          return rows.map(decodeRow);
        }
        await ensureSchema();
        const result = await database
          .prepare(SELECT_PARTITION)
          .bind(partitionKey(partition))
          .all<RecordRow>();
        return result.results.map(decodeRow);
      }

      function decodeScanRow(row: ScanRow) {
        const prefix = `${name}:`;
        if (!row.partition_key.startsWith(prefix)) {
          throw new StorageError(
            `Authoritative scan for ${name} received a row from another collection.`,
          );
        }
        return {
          key: {
            partition: row.partition_key.slice(prefix.length),
            id: row.row_key,
          },
          value: codec.decode(parseRecord(row.record_json)),
          version: row.version,
        };
      }

      return {
        async get(key) {
          const row = await readForGet(key);
          return row === null
            ? null
            : codec.decode(parseRecord(row.record_json));
        },

        async getVersioned(key) {
          const row = await readForGet(key);
          return row === null ? null : decodeRow(row);
        },

        async insertIfAbsent(value) {
          await ensureSchema();
          const key = definition.key(value);
          const stored = encoded(definition, value);
          const inserted = await database
            .prepare(INSERT_IF_ABSENT)
            .bind(partitionKey(key.partition), key.id, stored.json)
            .first<JsonRow>();
          if (inserted !== null) {
            return {
              inserted: true,
              value: codec.decode(parseRecord(inserted.record_json)),
            };
          }

          const existing = await read(key);
          if (existing === null) {
            throw new StorageError(
              `Insert into ${name} conflicted but the existing record could not be read; it was deleted in between.`,
            );
          }
          return {
            inserted: false,
            value: codec.decode(parseRecord(existing.record_json)),
          };
        },

        async put(value) {
          await ensureSchema();
          const key = definition.key(value);
          const stored = encoded(definition, value);
          await database
            .prepare(PUT)
            .bind(partitionKey(key.partition), key.id, stored.json)
            .run();
        },

        async putIfUnchanged(value, version) {
          assertVersionToken(version);
          await ensureSchema();
          const key = definition.key(value);
          const stored = encoded(definition, value);
          const written = await database
            .prepare(PUT_IF_UNCHANGED)
            .bind(stored.json, partitionKey(key.partition), key.id, version)
            .first<JsonRow>();
          return written !== null;
        },

        async update(key, decide, updateOptions) {
          const maxAttempts = updateOptions?.maxAttempts ?? 3;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const before = await readPhysical(key);
            const current =
              before === null ||
              before.deleted === 1 ||
              before.record_json === null
                ? null
                : codec.decode(parseRecord(before.record_json));
            const decision = await decide(current);

            if (decision.action === "keep") {
              return { written: false, value: current, attempts: attempt };
            }

            const stored = encoded(definition, decision.value);
            const statement =
              before === null
                ? database
                    .prepare(INSERT_NEW)
                    .bind(partitionKey(key.partition), key.id, stored.json)
                : before.deleted === 1
                  ? database
                      .prepare(RESTORE_VERSION)
                      .bind(
                        stored.json,
                        partitionKey(key.partition),
                        key.id,
                        before.version,
                      )
                  : database
                      .prepare(REPLACE_VERSION)
                      .bind(
                        stored.json,
                        partitionKey(key.partition),
                        key.id,
                        before.version,
                      );
            const written = await statement.first<JsonRow>();
            if (written !== null) {
              return {
                written: true,
                value: codec.decode(parseRecord(written.record_json)),
                attempts: attempt,
              };
            }
          }

          throw new ConcurrencyError(name, key, maxAttempts);
        },

        async list(partition) {
          return (await listVersioned(partition)).map((row) => row.value);
        },

        listVersioned,

        async scan(options) {
          assertScanLimit(options.limit);
          await ensureSchema();
          const after =
            options.cursor === undefined
              ? null
              : decodeScanCursor(name, options.cursor);
          const prefix = `${name}:`;
          const upper = `${name};`;
          const requested = options.limit + 1;
          const statement =
            after === null
              ? database.prepare(SCAN_FIRST).bind(prefix, upper, requested)
              : database
                  .prepare(SCAN_AFTER)
                  .bind(
                    prefix,
                    upper,
                    partitionKey(after.partition),
                    partitionKey(after.partition),
                    after.id,
                    requested,
                  );
          const result = await statement.all<ScanRow>();
          const page = result.results.slice(0, options.limit);
          const records = page.map(decodeScanRow);
          return {
            records,
            nextCursor:
              result.results.length > options.limit
                ? encodeScanCursor(name, records[records.length - 1]!.key)
                : null,
          };
        },

        async delete(key) {
          await ensureSchema();
          const deleted = await database
            .prepare(DELETE)
            .bind(partitionKey(key.partition), key.id)
            .first<VersionRow>();
          return deleted !== null;
        },

        async deleteIfUnchanged(key, version) {
          assertVersionToken(version);
          await ensureSchema();
          const deleted = await database
            .prepare(DELETE_IF_UNCHANGED)
            .bind(partitionKey(key.partition), key.id, version)
            .first<VersionRow>();
          return deleted !== null;
        },

        async transact(partition, actions) {
          // Checked from the length alone, before the caller's key function
          // runs over every action: an oversized list is refused either way,
          // and there is no reason to derive keys for a batch that cannot be
          // submitted.
          if (actions.length > MAX_TRANSACTION_ACTIONS) {
            throw new StorageError(
              `A transaction may carry at most ${MAX_TRANSACTION_ACTIONS} actions, and this one has ${actions.length}.`,
            );
          }

          for (const step of actions) {
            if (step.action === "putIfUnchanged") {
              assertVersionToken(step.version);
            }
          }

          const keys = actions.map((step) =>
            step.action === "delete" ? step.key : definition.key(step.value),
          );
          assertOnePartition(name, partition, keys);
          await ensureSchema();

          const statements: CloudflareD1PreparedStatement[] = [];

          for (const [index, step] of actions.entries()) {
            const key = keys[index] as EntityKey;
            const physicalPartition = partitionKey(key.partition);

            switch (step.action) {
              case "insert": {
                const stored = encoded(definition, step.value);
                statements.push(
                  database
                    .prepare(GUARD_EXISTS)
                    .bind(physicalPartition, key.id),
                  database
                    .prepare(PUT)
                    .bind(physicalPartition, key.id, stored.json),
                );
                break;
              }

              case "put": {
                const stored = encoded(definition, step.value);
                statements.push(
                  database
                    .prepare(PUT)
                    .bind(physicalPartition, key.id, stored.json),
                );
                break;
              }

              case "putIfUnchanged": {
                const stored = encoded(definition, step.value);
                statements.push(
                  database
                    .prepare(GUARD_MISSING)
                    .bind(physicalPartition, key.id),
                  database
                    .prepare(GUARD_CHANGED)
                    .bind(physicalPartition, key.id, step.version),
                  database
                    .prepare(PUT_IF_UNCHANGED)
                    .bind(stored.json, physicalPartition, key.id, step.version),
                );
                break;
              }

              case "delete":
                statements.push(
                  database
                    .prepare(GUARD_MISSING)
                    .bind(physicalPartition, key.id),
                  database.prepare(DELETE).bind(physicalPartition, key.id),
                );
                break;
            }
          }

          try {
            await database.batch(statements);
            return { committed: true };
          } catch (error) {
            const reason = markerRejection(error);
            if (reason === null) {
              throw error;
            }
            return { committed: false, reason };
          }
        },
      };
    },
  };
}
