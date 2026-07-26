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
}

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

function upsertMap<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  map.set(key, created);
  return created;
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

  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const partitions = upsertMap(
        collections,
        definition.name,
        (): Partitions => new Map(),
      );
      const { codec } = definition;

      function read(key: EntityKey): StoredRow | undefined {
        return partitions.get(key.partition)?.get(key.id);
      }

      function versioned(row: StoredRow): VersionedRecord<T> {
        return {
          value: codec.decode(row.record),
          version: String(row.version),
        };
      }

      function write(key: EntityKey, value: T, version: number): T {
        const record = codec.encode(value);
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
          return { inserted: true, value: write(key, value, 1) };
        },

        async put(value) {
          const key = definition.key(value);
          write(key, value, (read(key)?.version ?? 0) + 1);
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

            const stored = write(key, decision.value, (now?.version ?? 0) + 1);
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
      };
    },
  };
}
