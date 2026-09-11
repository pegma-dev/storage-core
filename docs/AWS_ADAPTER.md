# The AWS adapter: `@pegma/storage-dynamodb`

## Status

Implemented in this repository. It is finished when every conformance case
passes against **Amazon DynamoDB Local**. The first advertised publication is
package version `0.4.2` (the next unused repository-wide release number after
`v0.4.1`).

Decided 2026-09-11. This is the assignment record for Storage Core's third
real adapter — read `AGENTS.md` first; its hard rules govern everything here.

## Why a third adapter exists

`docs/CLOUDFLARE_ADAPTER.md` recorded D1 as the one deliberate second backend
for pegma.dev, and said that was not an invitation to a third adapter.
Azure Tables and D1 remain the two reference-environment backends. This adapter
exists for a different reason: **AWS hosts have no record store**. Identity,
sessions, mail outbox, webhooks, the durable rate-limit tier, audit,
scheduler state, the billing ledger, support-desk, and health store pings
all take an injected Storage Core `Store`. Without a DynamoDB adapter that
passes `packages/storage-core/src/conformance.ts`, those packages cannot
persist on AWS except via the in-memory store, which is not production.

The portability claim is still one conformance suite. A third adapter that
cannot keep the port's promises must not ship.

## The backend decision

- **DynamoDB — chosen.** Conditional writes (`ConditionExpression`),
  strongly consistent reads, and `TransactWriteItems` (100 operations) honor
  the full port — including single-collection, single-partition `transact`
  — without pretending. Query is by hash key, so the physical layout is
  the DynamoDB-native equivalent of Azure's `<collection>:<partition>`
  prefix, not a copy of it.
- **RDS / Aurora — not chosen.** A SQL adapter would overlap D1's model
  without giving AWS hosts a first-class key-value store, and would not
  unblock the stack any sooner than DynamoDB.
- **S3 — rejected, permanently, for records.** Eventual listing, no
  compare-and-swap. Object bytes belong in `@pegma/storage-s3`. Do not
  revisit this without new facts about S3 itself.

## Shape of the work

- New package `packages/storage-dynamodb` in this repository, beside
  `packages/storage-azure-tables` and structured like it.
- One DynamoDB table for all collections. Hash key `pk` = collection name,
  range key `sk` = `<partition>` + U+001F + `<id>`. Record body in `rec`
  (JSON). Version token in `ver` (UUID issued on every write).
- Deletes remove the item. Recreating the same logical key therefore
  receives a new UUID, which is what keeps a stale token from becoming valid
  again — the same guarantee Azure ETags and D1 tombstones keep by other
  means.
- `scan` queries the collection hash key in bounded pages. Its opaque
  continuation is scoped to this adapter and the collection.
- `transact` maps to `TransactWriteItems` scoped to one collection + one
  partition — same scope the port promises, no more. The 100-action cap
  matches Azure entity-group transactions and the D1 adapter. An adapter
  must not become the reason components assume capabilities the other
  adapters lack.

## The test bar (non-negotiable)

The conformance suite is the specification. This adapter is finished when
every case passes against **real DynamoDB Local**. Mechanically that is the
`test/azurite.ts` pattern: spawn the official engine (here, Amazon's
DynamoDB Local jar), not a mocked `DynamoDBClient`. The jar comes from the
pinned `dynamodb_local_2025-04-14.tar.gz` tarball; its SHA-256 is the digest
of that file. DynamoDB Local is a separate vitest run (`pnpm run test:dynamodb`)
from the memory/Azure suites, so a download or pin failure does not take
down the rest of the Node gate. CI still runs it as part of `pnpm test` on
Node 22 + 24.

## Versioning and publish

The port is unchanged, so `@pegma/storage-core` stays at `0.4.0` and this
adapter pins it exactly. The package's first advertised version is `0.4.2`
because repository-wide tags `v0.4.0` and `v0.4.1` already exist and must
never be reused.

## What it unblocks

AWS composition of every Pegma component that takes an injected `Store`.
Logger, scheduler, and SES adapters are out of scope here.
