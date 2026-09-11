# `@pegma/storage-dynamodb`

Amazon DynamoDB adapter for
[`@pegma/storage-core`](https://www.npmjs.com/package/@pegma/storage-core).

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
range, on-demand billing). To provision it with infrastructure instead, set
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

This adapter passes the conformance suite published by `@pegma/storage-core`,
run against Amazon DynamoDB Local rather than a fake client. An adapter that
agrees only with its author's assumptions is not verified.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
