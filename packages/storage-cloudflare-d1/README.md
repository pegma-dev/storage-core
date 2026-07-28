# `@pegma/storage-cloudflare-d1`

Cloudflare D1 adapter for
[`@pegma/storage-core`](https://www.npmjs.com/package/@pegma/storage-core).

It stores every collection in one D1 database and one `RECORDS` data table.
The physical partition key is `<collection>:<partition>` and the row key is
the record id. All values are passed through prepared statements.

## Usage

Pass the D1 binding directly:

```ts
import { createCloudflareD1Store } from "@pegma/storage-cloudflare-d1";

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const store = createCloudflareD1Store({ database: env.DB });
    // Declare collections and use the store here.
    return new Response("ok");
  },
};
```

The adapter creates its schema on first use by default. To provision it with
deployment migrations instead, set `createSchemaIfMissing: false` and create
the `RECORDS` table plus the internal `PEGMA_STORAGE_D1_TX_GUARD` table and
its three fixed triggers:

```sql
CREATE TABLE IF NOT EXISTS RECORDS (
  partition_key TEXT NOT NULL,
  row_key TEXT NOT NULL,
  record_json TEXT,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  PRIMARY KEY (partition_key, row_key)
) STRICT;

CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (
  reason TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_EXISTS
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'exists'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_EXISTS');
END;

CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_MISSING
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'missing'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_MISSING');
END;

CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_CHANGED
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'changed'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_CHANGED');
END;
```

The marker messages are part of the adapter's transaction protocol and must
not be changed.

## Consistency requirement

Pass a `D1Database` binding, not an object returned by `withSession()`.
Cloudflare's direct binding calls execute on the primary database. That is
required because optimistic version tokens must always be checked against
current state.

Replicated or session-based reads are incompatible with this adapter. Even a
session that starts on the primary may use replicas for subsequent reads, so
the adapter deliberately does not use the Sessions API.

## Versions and deletes

Versions are opaque strings backed by monotonically increasing SQLite integer
values. The adapter reads them with `CAST(version AS TEXT)`, avoiding
JavaScript rounding of 64-bit integers, and compares tokens as text.

Deletes retain an invisible tombstone. `get` and `list` filter tombstones, but
recreating the same logical key increments its retained version rather than
starting again at `1`. A version token therefore cannot become valid again
after delete and recreate.

## Authoritative scans

`CollectionStore.scan` reads one bounded page across every logical partition
in a collection. D1 uses its physical `(partition_key, row_key)` primary key as
the internal continuation position, then returns the logical physical
`EntityKey`, decoded value, and opaque version. Tombstones are never returned.

Cursors are opaque and scoped to this adapter and collection. Persist and pass
them back unchanged; a null continuation ends the current cycle. The query's
key ordering is an implementation detail, not a public ordering or snapshot
promise. Concurrent writes can repeat a row or defer it until a later complete
cycle.

## Transactions

`transact` uses `D1Database.batch()`, which D1 executes as an atomic SQL
transaction. An internal empty guard table and fixed abort triggers turn
zero-row precondition failures into the port's `exists`, `missing`, and
`changed` outcomes. Other D1 errors are rethrown.

Transactions remain limited to one collection and one logical partition, as
required by `@pegma/storage-core`.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
