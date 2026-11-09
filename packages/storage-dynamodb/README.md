# `@pegma/storage-dynamodb`

Amazon DynamoDB adapter for
[`@pegma/storage-core`](https://www.npmjs.com/package/@pegma/storage-core).

[`0.4.5` is the qualified trusted runtime](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.5)
and pins released Core `0.4.0`. Version `0.4.2` was published as registration-only metadata,
with no runtime exports/scripts/dependencies; it is not this adapter or a host
dependency. The `v0.4.3` release attempt failed its npm-version check before
preparation, producing no runtime archive. The `v0.4.4` attempt completed
preparation and smoke checks, then failed the preflight CLI entry with a module
cycle (exit 13). Neither published a runtime. Both signed tags remain immutable;
retain their releases as failed attempts.
The `0.4.5` release completed exact-byte, signature/provenance, source and public
consumer verification; this does not establish a host's production acceptance.
Source merge and metadata registration alone do not qualify a runtime. See the
[release policy](https://github.com/pegma-dev/storage-core/blob/main/docs/RELEASING.md).

It stores every collection in one DynamoDB table. The hash key is the
collection name and the range key is `<partition>` + unit separator +
`<id>`. Record bodies are stored as JSON; optimistic concurrency uses a UUID
version token issued on every write.

> [!IMPORTANT]
> This package is in early `0.x` development. Its public API is not stable and
> it is not ready for production use.

## Usage

Pass a DynamoDB client the host already constructed:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoDbStore } from "@pegma/storage-dynamodb";

const store = createDynamoDbStore({
  client: new DynamoDBClient({ region: "us-east-1" }),
  tableName: "pegma",
});
```

Hand the resulting `Store` to any component that declares collections against
`@pegma/storage-core`. Nothing else in the application needs to know which
backend is in use.

The adapter creates the table on first use by default (`pk` hash, `sk`
range, on-demand billing). On Amazon DynamoDB that create can take tens of
seconds before the table is ACTIVE; the adapter waits with backoff (about a
minute of sleeps) and then throws. DynamoDB Local becomes ACTIVE immediately.
To provision the table with infrastructure instead, set
`createTableIfMissing: false` and create:

```
pk (S) HASH
sk (S) RANGE
BillingMode PAY_PER_REQUEST
```

## How records are laid out

DynamoDB Query is by hash key, not by hash-key prefix. The Azure adapter
therefore uses `<collection>:<partition>` as its partition key; this adapter
uses the collection name as the hash key and `<partition>\u001f<id>` as the
range key. Listing a partition is a `begins_with` query. An authoritative scan
is a query of that collection's hash key. One table still holds every
collection.

Optimistic concurrency maps onto the `ver` attribute. `update` re-reads
and re-runs its decider whenever a conditional write is rejected, and
`putIfUnchanged` and `deleteIfUnchanged` are conditional writes that report
`false` rather than throwing when the record has moved on or vanished.

Records are written whole as JSON. A field set to null by your codec is
stored as JSON null and therefore clears.

Deletes remove the item. Recreating the same logical key receives a new
version token, so a stale token from before the delete cannot authorize a
later write.

## Consistency

Reads used for version checks use `ConsistentRead`. Stale replicas would make
version tokens meaningless. Point this client at a region and endpoint the
host already trusts; DynamoDB Local is the test backend, not a production
mode.

## Authoritative scans

`CollectionStore.scan` reads one bounded page across every logical partition
in a collection by querying that collection's hash key. The adapter returns
the logical physical `EntityKey`, decoded value, and opaque version.

Cursors are opaque and scoped to this adapter and collection. Persist and pass
them back unchanged; a null continuation ends the current cycle. The query's
key ordering is an implementation detail, not a public ordering or snapshot
promise. Concurrent writes can repeat a row or defer it until a later
complete cycle.

## Transactions

`transact` uses `TransactWriteItems`, which DynamoDB executes as an all-or-
nothing batch of at most 100 actions — the same action-count the Azure
Tables and D1 adapters enforce. Conditional failures map onto the port's
`exists`, `missing`, and `changed` outcomes. Other DynamoDB errors are
rethrown.

Transactions remain limited to one collection and one logical partition, as
required by `@pegma/storage-core`.

## Constraints it enforces for you

- Collection names may not contain `:`, matching the other adapters.
- Collection names, partitions, and record ids may not be empty and may not
  contain `/`, `\`, `#`, `?`, or control characters. The unit separator that
  joins partition to id is one of those control characters, so two logical
  keys cannot collapse onto one DynamoDB item.
- The table name must be a legal DynamoDB table name.

## Verification

Required verification runs conformance against Amazon DynamoDB Local rather
than a fake client. The release consumer uses actual published Core `0.4.0`
and the selected DynamoDB artifact, including real `StorageError` and
`ConcurrencyError` identity. Qualified publication additionally requires exact
registry bytes, authenticated signatures/provenance and a clean public consumer;
neither source tests nor namespace registration replace those gates.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
