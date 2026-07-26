# @pegma/storage-azure-tables

Azure Table Storage adapter for [`@pegma/storage-core`](https://www.npmjs.com/package/@pegma/storage-core).

> [!IMPORTANT]
> This package is in early `0.x` development. Its public API is not stable and
> it is not ready for production use.

## Usage

```ts
import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";

const store = createAzureTablesStore({
  client: new TableClient(endpoint, "pegma", credential),
});
```

Hand the resulting `Store` to any component that declares collections against
`@pegma/storage-core`. Nothing else in the application needs to know which
backend is in use.

## How records are laid out

Every collection shares one table. A record's partition key is
`<collection>:<partition>` and its row key is the record id, so a deployment
provisions one table rather than one per collection, and listing a partition
stays a single-partition query — the only kind Table Storage serves well.

Optimistic concurrency maps onto ETags. `update` re-reads and re-runs its
decider whenever a conditional write is rejected, and `putIfUnchanged` and
`deleteIfUnchanged` are conditional writes that report `false` rather than
throwing when the record has moved on or vanished.

Records are written whole, using `Replace` rather than `Merge`. A field set to
null by your codec therefore clears reliably, which is not true of a merge
write.

## Constraints it enforces for you

- Collection names may not contain `:`, which separates collection from
  partition in a key.
- Partitions and record ids may not contain `/`, `\`, `#`, `?`, or control
  characters. Table Storage rejects these with an opaque service error; this
  adapter fails earlier with a message naming the offending value.
- A record may not define a property called `partitionKey`, `rowKey`,
  `timestamp`, or `etag`. Those belong to the table.

## Verification

This adapter passes the conformance suite published by `@pegma/storage-core`,
run against a real Azurite table service rather than a fake client. An adapter
that agrees only with its author's assumptions is not verified.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
