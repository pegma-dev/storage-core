# Storage Core

[![CI](https://github.com/pegma-dev/storage-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/storage-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Persistence for [Pegma](https://pegma.dev) components, without the component
having to know what the database is.

> [!IMPORTANT]
> Storage Core is in early `0.x` development. Its public API is not stable,
> and it is not ready for production use.

## Why it exists

A component that keeps records should not also have to write retry loops,
conflict handling, and sweep logic. That code is the same everywhere, it is
subtle, and getting it slightly wrong produces data loss that only shows up
under load.

Storage Core owns that plumbing. Components declare what they keep; storage
handles how it is kept.

It is schema-agnostic on purpose. It never inspects a decoded record, so a
support desk's tickets and an authorization component's role assignments use
the same primitives without storage knowing anything about either.

## Declaring what you keep

```ts
import { defineCollection, createMemoryStore } from "@pegma/storage-core";

interface Session {
  readonly id: string;
  readonly principalId: string;
  readonly expiresAt: string;
}

const sessions = defineCollection<Session>({
  name: "sessions",
  key: (session) => ({ partition: "session", id: session.id }),
  codec: {
    encode: (session) => ({ ...session }),
    decode: (record) => ({
      id: String(record["id"]),
      principalId: String(record["principalId"]),
      expiresAt: String(record["expiresAt"]),
    }),
  },
});

const store = createMemoryStore();
const collection = store.collection(sessions);
```

The codec is where your types meet flat storage. Storage only ever sees
strings, numbers, booleans, and nulls; dates, enums, and nested shapes are
yours to encode.

## Changing a record safely

`update` reads, asks you what to write, and writes — retrying with freshly
read state whenever someone else got there first.

```ts
const result = await collection.update(key, (current) => {
  if (current === null) return { action: "keep" };
  if (current.version >= incoming.version) return { action: "keep" };
  return { action: "write", value: applyEvent(current, incoming) };
});
```

The important part is that **your decision runs again on every conflict**. A
staleness check, a field that must keep its first value, a cap on how many
records may be active — put it inside the decider and it is re-evaluated
against whatever the winning writer just stored. A check performed before the
call is a check performed against state that may no longer be true.

The decider may be asynchronous, so a decision that has to count sibling
records or call another service still gets re-evaluated correctly. It may run
more than once, so it must not assume otherwise; if it mints an identifier,
read the stored one back from `result.value`.

## Writing a conditional replacement

`update` covers a decision you can make from the current record. When the
version came from an earlier request and the caller hands it back, use
`putIfUnchanged`, which lands only if nothing has happened since:

```ts
const ok = await collection.putIfUnchanged(revoked, callerSuppliedVersion);
```

## Changing several records together

`transact` applies a list of actions to one partition, all of them or none.
This is how an invariant that spans records survives concurrency — a uniqueness
guard written with the record it guards, or a state change written with its
outbox entry.

```ts
const outcome = await collection.transact(partition, [
  { action: "insert", value: assignment },
  { action: "insert", value: uniquenessGuard },
  { action: "insert", value: auditRecord },
]);

if (!outcome.committed) {
  // "exists", "missing", or "changed"
  return conflictFor(outcome.reason);
}
```

A refused precondition is an outcome, not an exception, so a conflict your
domain expects reads as ordinary control flow. Genuine failures still throw.

The scope is one collection and one partition on purpose. That is what backends
actually offer — Azure entity-group transactions, a D1 batch, a Durable Object
transaction, a SQL statement batch — and promising more would promise something
no adapter could keep.

Actions are `insert`, `put`, `putIfUnchanged`, and `delete`. There is
deliberately **no version-conditional delete**: Azure carries no per-action
condition on a delete inside a transaction, and the conformance suite caught it
committing one that should have been refused. Express a conditional removal as
a `putIfUnchanged` to a tombstone your codec understands.

## Sweeping expired records

Listing a partition is not a snapshot, so a record can become live again
between being enumerated and being deleted. `deleteIfUnchanged` is what makes
a sweep safe:

```ts
for (const row of await collection.listVersioned("session")) {
  if (isExpired(row.value, now)) {
    await collection.deleteIfUnchanged(sessions.key(row.value), row.version);
  }
}
```

A false return means the record changed or is already gone. Both mean leave
it alone, not something went wrong.

## Scanning a collection authoritatively

Maintenance work that must recover records even when a secondary index is
missing can use bounded, cross-partition `scan` pages:

```ts
let cursor: string | undefined;
do {
  const page = await collection.scan({
    limit: 100,
    ...(cursor === undefined ? {} : { cursor }),
  });

  for (const row of page.records) {
    await processIdempotently(row.key, row.value, row.version);
  }

  if (page.nextCursor === null) break;
  cursor = page.nextCursor;
} while (true);
```

The adapter issues the opaque cursor; persist and return it unchanged. A page
contains at most the requested limit, and `nextCursor: null` ends that cycle.
The scan returns the physical stored `EntityKey`, decoded value, and opaque
version. It has no filtering, ordering, or snapshot promise. Concurrent writes
may repeat a row or defer it until a later cycle, so effects must be idempotent
and conditional work must use the returned key and version. Repeated complete
cycles cannot omit a committed live row forever absent perpetual failure or
perpetual writes.

## Conformance is the specification

`@pegma/storage-core/conformance` exports the behaviour every backend must
exhibit, as plain test cases with no test-framework dependency:

```ts
import { conformanceCases } from "@pegma/storage-core/conformance";

for (const testCase of conformanceCases) {
  it(testCase.name, () =>
    testCase.run(() => createMyStoreOverTheSameEmptyBackend()),
  );
}
```

An adapter is finished when it passes them. A behaviour not asserted there is
not something a component may rely on.

## Records are written whole

There is no partial-merge write. `put` and `update` always store the complete
record produced by your codec.

This is a deliberate narrowing. Merge-style patches make clearing a field
unreliable on some backends, and they make a stored record the accumulated
result of writes nobody can see. Writing whole records means a null clears,
and what you decode is what the last writer decided.

## Not here

- **Transactions across records.** Multi-record changes are ordinary sequences
  of calls, and the ordering is the caller's correctness argument.
- **Server-side queries.** Reads are by key, by partition, or an unfiltered
  bounded collection scan. Filtering and sorting happen in your code, which
  keeps the port honest about what a key-value backend can actually do.
- **Secondary indexes.** Look-ups by a non-key field are a partition scan, or
  an index collection you maintain yourself.

## Backends

| Package                        | Status                                     |
| ------------------------------ | ------------------------------------------ |
| `createMemoryStore`            | included; the reference implementation     |
| `@pegma/storage-azure-tables`  | available; passes the same conformance run |
| `@pegma/storage-cloudflare-d1` | available; passes the same conformance run |

The in-memory store is not only for tests. It enforces the same concurrency
rules as a real backend, so an assembled application runs correctly before
anyone has configured a database.

```ts
import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";

const store = createAzureTablesStore({
  client: new TableClient(endpoint, "pegma", credential),
});
```

Every collection shares one table, separated by a partition-key prefix of
`<collection>:<partition>`, so a deployment provisions one table rather than
one per collection. Optimistic concurrency maps onto ETags, and the adapter is
verified against Azurite by the same conformance cases the in-memory store
runs.

## Development

Storage Core requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run format:check
```

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
