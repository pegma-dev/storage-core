# `@pegma/storage-cloudflare-d1`

Cloudflare D1 adapter for
[`@pegma/storage-core`](https://www.npmjs.com/package/@pegma/storage-core).

The published release remains `0.4.1`. This source is the unpublished `0.4.6`
candidate for optional concurrent keyed-read batching and retains exact Core
`0.4.0`. Its review, registry qualification and complete host request-budget
acceptance remain pending; source tests alone do not establish live Free usage.

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

## Optional concurrent read batching

The default `readBatchSize: 1` retains direct keyed and partition reads. To
coalesce concurrent public `get`, `getVersioned`, `list` and `listVersioned`
calls, opt in when constructing a Store inside the request:

```ts
const store = createCloudflareD1Store({
  database: env.DB,
  readBatchSize: 512,
});
```

`readBatchSize` must be a safe integer from 1 through 512. This is an adapter
tuning bound, not a Cloudflare batch-size limit. Calls queued together are
sent as at most that many prepared read statements in one real D1 batch.
There is at most one read batch in flight per Store, and a partial batch runs
without waiting for more calls. Collection handles on that Store share the
queue; separate Store instances do not. Use a request-scoped Store rather
than sharing the queue across Worker requests.

`readBatchSize` bounds each D1 batch, not the total pending read requests.
The adapter has no total pending-queue cap. Callers must bound their concurrent
read waves and the Store's lifetime within the request. Partition lists still
return every live row: the batch bound counts statements, not result rows or
bytes. Batching does not paginate or truncate a list.

Only calls that actually reach storage concurrently can coalesce. Finish
asynchronous key preparation before starting a parallel read wave if the
caller needs predictable batching. Sequential awaited calls remain separate.
There is no caching or same-key deduplication, and each caller decodes its
own value. A batch failure rejects all reads in that batch; later calls can
recover without an automatic fallback to individual requests.

Writes, internal optimistic reads, scans and transactions keep their existing
paths. Batching does not add snapshot or read/write
ordering guarantees: retain version checks and current-state fences. A new
read after an awaited write still reads the direct primary binding.

Cloudflare's [current D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
allow 50 queries per Free Worker invocation; one `db.batch()` counts as one
query against that limit, not one per statement. The limit of 100 bound
parameters applies to each individual query, not the whole batch. The adapter's
512-statement tuning ceiling is not a Cloudflare batch-size limit.
Statement constraints and row-based usage still apply. A larger batch reduces
binding calls, not rows read or serialization work. Choose the
size for the application's bounded record sizes and concurrent callers;
512 arbitrary large records can exceed platform memory or result limits.
Measure complete request budgets, including authentication and final fences,
before relying on a Free-plan profile.

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

A transaction carries at most 100 actions, the same limit the Azure Tables
adapter enforces, so an action list either works on both adapters or is
refused by both with a `StorageError`. The limit is checked before any
statement is sent. Each action costs one to three statements in the batch.
Cloudflare counts the batch as one query against the invocation query budget;
individual statement constraints and row-based usage still apply.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
