# The AWS adapter: `@pegma/storage-dynamodb`

## Status

The runtime adapter is implemented in this repository. It qualifies when every
conformance case passes against **Amazon DynamoDB Local** and the release gates
are satisfied. [`@pegma/storage-dynamodb@0.4.5`](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.5)
is now the qualified first trusted runtime. Version `0.4.2` was published as a separately reviewed,
metadata-only registration archive: it contains no runtime, exports, scripts or
dependencies, is not an SDK, and must never be a host input. The `v0.4.3` release
attempt failed its npm-version check before preparation, producing no runtime
archive. The `v0.4.4` attempt completed preparation and smoke checks, then failed
the preflight CLI entry with a module cycle (exit 13). Neither published a
runtime. Keep both signed tags immutable and retain the failed releases.
The later `0.4.5` runtime completed registry and public-consumer qualification;
actual host adoption remains a separate acceptance step.

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

The port is unchanged, so `@pegma/storage-core` stays at `0.4.0` and the runtime
runtime pins it exactly. `0.4.2` is registration-only metadata under `bootstrap`,
not a usable adapter release. The qualified `0.4.5` runtime completed the reviewed
signed-source and trusted-publisher flow.
Existing repository-wide tags `v0.4.0`, `v0.4.1`, failed `v0.4.3` and failed
`v0.4.4` must never be reused. The separate D1 `0.4.6` candidate remains
unpublished and requires its own review and release qualification.

Unprivileged validation runs the full gates on Node 22 and 24 before preparation.
Preparation depends on that validation and signed-release identity checks; it
packs only selected source packages and retains the independently pinned exact
original registry archives for unselected packages. Only the minimal publish job
receives OIDC authority. See [RELEASING.md](RELEASING.md) for the separate
registration exception and runtime release procedure. Published metadata
registration alone does not qualify a runtime.

## What it unblocks

AWS composition of every Pegma component that takes an injected `Store`.
Logger, scheduler, and SES adapters are out of scope here.
