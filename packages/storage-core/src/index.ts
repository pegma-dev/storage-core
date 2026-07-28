/**
 * Where a record lives.
 *
 * `partition` groups records that are read, written, and swept together.
 * `id` identifies one record inside that group. Backends map the pair onto
 * whatever they use natively: partition and row keys, or a compound primary
 * key.
 */
export interface EntityKey {
  readonly partition: string;
  readonly id: string;
}

/** A value a backend can store in a single field without interpretation. */
export type StoredValue = string | number | boolean | null;

/** The flat, backend-neutral form of a record. */
export type StoredRecord = Readonly<Record<string, StoredValue>>;

/**
 * Translates between a component's own type and the flat record a backend
 * stores.
 *
 * Components own their schema. Storage never inspects the decoded value, so
 * nested objects, dates, and enums are the codec's business.
 *
 * Records are always written whole. There is no partial-merge write, which
 * means a field set to null by `encode` reliably clears, and a decoded value
 * is always the complete record rather than a patch applied to unknown prior
 * state.
 */
export interface Codec<T> {
  encode(value: T): StoredRecord;
  decode(record: StoredRecord): T;
}

/**
 * A named set of records with a declared key and codec.
 *
 * Declaring a collection is how a component tells storage what it keeps
 * without storage knowing what any of it means.
 */
export interface CollectionDefinition<T> {
  readonly name: string;
  key(value: T): EntityKey;
  readonly codec: Codec<T>;
}

/** Declares a collection. Returns the definition unchanged. */
export function defineCollection<T>(
  definition: CollectionDefinition<T>,
): CollectionDefinition<T> {
  return definition;
}

export class StorageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

/**
 * Thrown when a read-modify-write could not be completed because a competing
 * writer kept winning.
 */
export class ConcurrencyError extends StorageError {
  readonly collection: string;
  readonly key: EntityKey;
  readonly attempts: number;

  constructor(collection: string, key: EntityKey, attempts: number) {
    super(
      `Write to ${collection} (${key.partition}/${key.id}) failed after ${attempts} attempts because the record kept changing.`,
    );
    this.name = "ConcurrencyError";
    this.collection = collection;
    this.key = key;
    this.attempts = attempts;
  }
}

/**
 * A record together with an opaque token identifying the version that was
 * read.
 *
 * The token is only meaningful to the backend that issued it. Pass it back to
 * {@link CollectionStore.deleteIfUnchanged} to act on the version you saw.
 */
export interface VersionedRecord<T> {
  readonly value: T;
  readonly version: string;
}

/** Largest page a collection-wide authoritative scan may request. */
export const MAX_SCAN_PAGE_SIZE = 1_000;

/**
 * One physical row returned by an authoritative collection scan.
 *
 * `key` is the key the adapter read, not one recomputed from the decoded
 * value. `version` may be passed to conditional operations on the same
 * adapter.
 */
export interface ScanRecord<T> extends VersionedRecord<T> {
  readonly key: EntityKey;
}

export interface ScanOptions {
  /** Positive integer no larger than {@link MAX_SCAN_PAGE_SIZE}. */
  readonly limit: number;
  /**
   * Opaque adapter-issued continuation from the preceding page.
   *
   * Omit this to begin a new scan cycle. Persist and pass it back unchanged;
   * malformed cursors and cursors from another adapter or collection fail.
   */
  readonly cursor?: string;
}

export interface ScanPage<T> {
  /** At most the requested number of physical rows. */
  readonly records: readonly ScanRecord<T>[];
  /** Continuation for the next page, or null when this cycle is complete. */
  readonly nextCursor: string | null;
}

export interface InsertResult<T> {
  /** False when a record already existed; `value` is then the existing one. */
  readonly inserted: boolean;
  readonly value: T;
}

/**
 * What a decider wants to happen to a record.
 *
 * `keep` exists so that a decider can inspect the current record and decline
 * to write, because of a stale event or an invariant that forbids the change,
 * without that being an error.
 */
export type UpdateDecision<T> =
  { readonly action: "write"; readonly value: T } | { readonly action: "keep" };

/**
 * Decides what to write, given the record as it exists right now.
 *
 * The decider runs again with freshly read state on every conflict, so any
 * rule that depends on the current record belongs inside it rather than
 * around the call: an event watermark, a field that must keep its first
 * value, a cap on how many rows may be active.
 *
 * It may be asynchronous, so a decision that needs to count sibling records
 * or call another service can do so and still be re-evaluated on conflict.
 * It should not be assumed to run exactly once, and it may legitimately
 * produce different values on different attempts.
 */
export type UpdateDecider<T> = (
  current: T | null,
) => UpdateDecision<T> | Promise<UpdateDecision<T>>;

export interface UpdateResult<T> {
  /** False when the decider chose `keep`. */
  readonly written: boolean;
  /**
   * The record after the operation, or null if none exists.
   *
   * After a write this is the value that was stored, so a decider that mints
   * an identifier can be read back from here rather than recomputed.
   */
  readonly value: T | null;
  readonly attempts: number;
}

export interface UpdateOptions {
  /** Total tries before giving up. Defaults to 3. */
  readonly maxAttempts?: number;
}

/** Keyed access to one declared collection. */
export interface CollectionStore<T> {
  get(key: EntityKey): Promise<T | null>;

  /** Like {@link get}, but also reports the version that was read. */
  getVersioned(key: EntityKey): Promise<VersionedRecord<T> | null>;

  /**
   * Writes a record only if its key is free.
   *
   * Safe to call twice with the same value: the second call reports
   * `inserted: false` and returns what is already stored. This makes it the
   * primitive for deduplicating work keyed by an external identifier.
   */
  insertIfAbsent(value: T): Promise<InsertResult<T>>;

  /** Writes a record whole, replacing any existing one. */
  put(value: T): Promise<void>;

  /**
   * Writes a record only if it still holds the version you read.
   *
   * The mirror of {@link deleteIfUnchanged}, for a caller holding a version
   * from an earlier read that wants its write to land only if nothing has
   * happened since. Returns false if the record changed or is gone.
   *
   * Prefer {@link update} when the decision can be made from the current
   * record. Reach for this when the version was read in an earlier request
   * and handed back by the caller, which `update` cannot express because its
   * decider sees the record but never the version.
   */
  putIfUnchanged(value: T, version: string): Promise<boolean>;

  /**
   * Reads, decides, and writes atomically, retrying on conflict.
   *
   * This is the only safe way to change a record that other writers can
   * touch.
   */
  update(
    key: EntityKey,
    decide: UpdateDecider<T>,
    options?: UpdateOptions,
  ): Promise<UpdateResult<T>>;

  /** Every record in one partition, in unspecified order. */
  list(partition: string): Promise<T[]>;

  /** Like {@link list}, but also reports the version of each record. */
  listVersioned(partition: string): Promise<VersionedRecord<T>[]>;

  /**
   * Reads one bounded page across every partition in this collection.
   *
   * This is the authoritative enumeration path for maintenance work that
   * cannot rely on a caller-maintained secondary index. It offers no filter,
   * ordering, or snapshot guarantee. Concurrent changes may produce
   * duplicates or defer a row until a later cycle, so consumers must make
   * effects idempotent and use the returned physical key and version for
   * conditional work.
   *
   * A cycle starts without a cursor and ends when `nextCursor` is null.
   * Repeated complete cycles cannot omit a committed live row forever unless
   * calls keep failing or writes keep racing forever.
   */
  scan(options: ScanOptions): Promise<ScanPage<T>>;

  /** Returns false if there was nothing to delete. */
  delete(key: EntityKey): Promise<boolean>;

  /**
   * Deletes a record only if it still holds the version you read.
   *
   * This is what makes a sweep safe. Listing a partition is not a snapshot,
   * so a record can become live again between being enumerated and being
   * deleted; an unconditional delete would discard that newer state. Returns
   * false if the record changed or is already gone, both of which mean "leave
   * it alone" rather than "something went wrong".
   */
  deleteIfUnchanged(key: EntityKey, version: string): Promise<boolean>;

  /**
   * Applies several writes to one partition, all of them or none.
   *
   * Every action must target `partition`, and no key may appear twice. Both
   * are rejected with a {@link StorageError} rather than being attempted,
   * because a backend would refuse them with a far less useful message.
   *
   * A refused precondition is an outcome, not an error: the result names the
   * action that was refused and why, so a caller can turn it into whatever
   * its own domain calls that conflict. Genuine failures still throw.
   *
   * The single-partition limit is not an implementation detail leaking out.
   * It is the guarantee every backend worth targeting actually offers, from
   * Azure entity-group transactions to a SQL statement batch, and promising
   * more than that would be promising something no adapter could keep.
   *
   * There is deliberately no version-conditional delete here. Azure carries no
   * per-action condition on a delete inside a transaction, and the conformance
   * suite caught it committing one that should have been refused. Rather than
   * offer a guarantee one adapter cannot keep, a conditional removal is
   * expressed as a `putIfUnchanged` to a tombstone your codec understands.
   */
  transact(
    partition: string,
    actions: readonly TransactionAction<T>[],
  ): Promise<TransactionOutcome>;
}

/** One step of a transaction. */
export type TransactionAction<T> =
  | { readonly action: "insert"; readonly value: T }
  | { readonly action: "put"; readonly value: T }
  | {
      readonly action: "putIfUnchanged";
      readonly value: T;
      readonly version: string;
    }
  | { readonly action: "delete"; readonly key: EntityKey };

/**
 * Why a transaction did not commit.
 *
 * `exists` an insert found the key taken. `missing` a delete or conditional
 * write found nothing. `changed` a conditional write or delete found a
 * different version than the one it named.
 */
export type TransactionRejection = "exists" | "missing" | "changed";

export type TransactionOutcome =
  | { readonly committed: true }
  | {
      readonly committed: false;
      readonly reason: TransactionRejection;
      /**
       * Index of the refused action, when the backend says which one.
       *
       * Best effort on purpose: Azure does not always report it, so a caller
       * that must know which precondition failed should re-read rather than
       * rely on this being present.
       */
      readonly failedAction?: number;
    };

/**
 * A backend.
 *
 * Components take a `Store` and declare their collections against it.
 * Swapping the implementation is the only change a host makes to move between
 * backends.
 */
export interface Store {
  collection<T>(definition: CollectionDefinition<T>): CollectionStore<T>;
}

interface StoredRow {
  readonly record: StoredRecord;
  readonly version: number;
}

/** Partitions hold rows by id; a collection holds partitions by name. */
type Partitions = Map<string, Map<string, StoredRow>>;

/**
 * Rejects a transaction that reaches outside its partition or touches one key
 * twice. Both are caller mistakes, and a backend would report them as an
 * opaque service error well after the useful context is gone.
 */
export function assertOnePartition(
  collection: string,
  partition: string,
  keys: readonly EntityKey[],
): void {
  if (keys.length === 0) {
    throw new StorageError(
      `A transaction on ${collection} was given no actions.`,
    );
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (key.partition !== partition) {
      throw new StorageError(
        `A transaction on ${collection} may only touch partition ${JSON.stringify(partition)}, but an action targets ${JSON.stringify(key.partition)}.`,
      );
    }
    if (seen.has(key.id)) {
      throw new StorageError(
        `A transaction on ${collection} touches ${JSON.stringify(key.id)} more than once.`,
      );
    }
    seen.add(key.id);
  }
}

function upsertMap<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  map.set(key, created);
  return created;
}

const MEMORY_SCAN_CURSOR_PREFIX = "pegma-memory-scan-v1:";

interface MemoryScanCursor {
  readonly collection: string;
  readonly partition: string;
  readonly id: string;
}

function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_PAGE_SIZE) {
    throw new StorageError(
      `Scan limit must be an integer from 1 through ${MAX_SCAN_PAGE_SIZE}.`,
    );
  }
}

function encodeMemoryScanCursor(collection: string, key: EntityKey): string {
  return `${MEMORY_SCAN_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({
      collection,
      partition: key.partition,
      id: key.id,
    } satisfies MemoryScanCursor),
  )}`;
}

function decodeMemoryScanCursor(collection: string, cursor: string): EntityKey {
  try {
    if (!cursor.startsWith(MEMORY_SCAN_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(MEMORY_SCAN_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "collection,id,partition"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<MemoryScanCursor>;
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

function compareKeys(left: EntityKey, right: EntityKey): number {
  if (left.partition < right.partition) {
    return -1;
  }
  if (left.partition > right.partition) {
    return 1;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

/**
 * Creates an in-process {@link Store} that keeps everything in memory.
 *
 * This is the reference implementation. It enforces the same concurrency
 * rules as a real backend, so a component tested against it behaves the same
 * way in production. It is also what lets a freshly assembled application run
 * before anyone has configured a database.
 */
export function createMemoryStore(): Store {
  const collections = new Map<string, Partitions>();
  const collectionVersions = new Map<
    string,
    Map<string, Map<string, number>>
  >();

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const partitions = upsertMap(
        collections,
        definition.name,
        (): Partitions => new Map(),
      );
      const { codec } = definition;
      const versions = upsertMap(
        collectionVersions,
        definition.name,
        (): Map<string, Map<string, number>> => new Map(),
      );

      function read(key: EntityKey): StoredRow | undefined {
        return partitions.get(key.partition)?.get(key.id);
      }

      function versioned(row: StoredRow): VersionedRecord<T> {
        return {
          value: codec.decode(row.record),
          version: String(row.version),
        };
      }

      function write(key: EntityKey, value: T): T {
        const record = codec.encode(value);
        const partitionVersions = upsertMap(
          versions,
          key.partition,
          (): Map<string, number> => new Map(),
        );
        const version = (partitionVersions.get(key.id) ?? 0) + 1;
        partitionVersions.set(key.id, version);
        upsertMap(
          partitions,
          key.partition,
          (): Map<string, StoredRow> => new Map(),
        ).set(key.id, { record, version });
        // Decode what was stored rather than echoing the input, so callers see
        // the same value a later `get` would return.
        return codec.decode(record);
      }

      function dropIfEmpty(partition: string): void {
        if (partitions.get(partition)?.size === 0) {
          partitions.delete(partition);
        }
      }

      return {
        async get(key) {
          const row = read(key);
          return row === undefined ? null : codec.decode(row.record);
        },

        async getVersioned(key) {
          const row = read(key);
          return row === undefined ? null : versioned(row);
        },

        async insertIfAbsent(value) {
          const key = definition.key(value);
          const existing = read(key);
          if (existing !== undefined) {
            return { inserted: false, value: codec.decode(existing.record) };
          }
          return { inserted: true, value: write(key, value) };
        },

        async put(value) {
          const key = definition.key(value);
          write(key, value);
        },

        async putIfUnchanged(value, version) {
          const key = definition.key(value);
          const row = read(key);
          if (row === undefined || String(row.version) !== version) {
            return false;
          }
          write(key, value);
          return true;
        },

        async update(key, decide, options) {
          const maxAttempts = options?.maxAttempts ?? 3;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const before = read(key);
            const current =
              before === undefined ? null : codec.decode(before.record);
            const decision = await decide(current);

            if (decision.action === "keep") {
              return { written: false, value: current, attempts: attempt };
            }

            // Re-read rather than trusting `before`: awaiting the decider
            // gives another writer the chance to land in between.
            const now = read(key);
            if ((now?.version ?? 0) !== (before?.version ?? 0)) {
              continue;
            }

            const stored = write(key, decision.value);
            return { written: true, value: stored, attempts: attempt };
          }

          throw new ConcurrencyError(definition.name, key, maxAttempts);
        },

        async list(partition) {
          const rows = partitions.get(partition);
          return rows === undefined
            ? []
            : [...rows.values()].map((row) => codec.decode(row.record));
        },

        async listVersioned(partition) {
          const rows = partitions.get(partition);
          return rows === undefined ? [] : [...rows.values()].map(versioned);
        },

        async scan(options) {
          assertScanLimit(options.limit);
          const after =
            options.cursor === undefined
              ? null
              : decodeMemoryScanCursor(definition.name, options.cursor);
          const found: Array<{
            readonly key: EntityKey;
            readonly row: StoredRow;
          }> = [];
          let hasMore = false;
          for (const [partition, rows] of partitions) {
            for (const [id, row] of rows) {
              const key = { partition, id };
              if (after === null || compareKeys(key, after) > 0) {
                found.push({ key, row });
                found.sort((left, right) => compareKeys(left.key, right.key));
                if (found.length > options.limit) {
                  found.pop();
                  hasMore = true;
                }
              }
            }
          }
          return {
            records: found.map(({ key, row }) => ({
              key,
              ...versioned(row),
            })),
            nextCursor: hasMore
              ? encodeMemoryScanCursor(
                  definition.name,
                  found[found.length - 1]!.key,
                )
              : null,
          };
        },

        async delete(key) {
          const deleted =
            partitions.get(key.partition)?.delete(key.id) ?? false;
          dropIfEmpty(key.partition);
          return deleted;
        },

        async deleteIfUnchanged(key, version) {
          const row = read(key);
          if (row === undefined || String(row.version) !== version) {
            return false;
          }
          const deleted =
            partitions.get(key.partition)?.delete(key.id) ?? false;
          dropIfEmpty(key.partition);
          return deleted;
        },

        async transact(partition, actions) {
          const keys = actions.map((step) =>
            step.action === "delete" ? step.key : definition.key(step.value),
          );
          assertOnePartition(definition.name, partition, keys);

          // Every precondition is checked before anything is applied. Nothing
          // between here and the last write awaits, so no other writer can
          // interleave.
          for (const [index, step] of actions.entries()) {
            const key = keys[index] as EntityKey;
            const row = read(key);
            const conditional = step.action === "putIfUnchanged";

            if (step.action === "insert" && row !== undefined) {
              return {
                committed: false,
                failedAction: index,
                reason: "exists",
              };
            }
            if (
              (conditional || step.action === "delete") &&
              row === undefined
            ) {
              return {
                committed: false,
                failedAction: index,
                reason: "missing",
              };
            }
            if (conditional && String(row?.version) !== step.version) {
              return {
                committed: false,
                failedAction: index,
                reason: "changed",
              };
            }
          }

          for (const [index, step] of actions.entries()) {
            const key = keys[index] as EntityKey;
            if (step.action === "delete") {
              partitions.get(key.partition)?.delete(key.id);
              dropIfEmpty(key.partition);
            } else {
              write(key, step.value);
            }
          }

          return { committed: true };
        },
      };
    },
  };
}
