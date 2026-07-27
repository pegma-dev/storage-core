# The Cloudflare adapter: `@pegma/storage-cloudflare-d1`

## Status

Implemented on `claude/cloudflare-d1-adapter`, including real-D1 conformance
coverage in the Cloudflare Workers Vitest pool. This record does not represent
the branch as merged or the package as published. The first npm publish remains
a manual 2FA bootstrap step; trusted publishing can be configured after that.

Decided 2026-07-27. This is the assignment record for Storage Core's second
real adapter — read `AGENTS.md` first; its hard rules govern everything here.

## Why a second adapter exists

Pegma's stance is Azure Tables first, no backend sprawl. This adapter is the
one deliberate exception, and it exists for a reason other than breadth:
**pegma.dev deploys on Cloudflare as the ecosystem's second reference
environment** (see pegma-dev/pegma.dev, `docs/PROJECT_PLAN.md`, Phase 4),
and its planned Workers consumer needs a Store. Two clouds, one conformance
suite, is the portability claim made publicly on the site — this adapter is
that claim, tested. It is not an invitation to a third adapter.

## The backend decision

- **D1 — chosen.** Serverless SQLite: transactional SQL and conditional
  writes, able to honor the full port — including single-collection,
  single-partition `transact` — without pretending. One qualifier the
  adapter must respect: D1's consistency story is primary-first, and global
  read replication can serve stale reads unless the session mechanism
  (read-your-writes) is used. Version tokens are meaningless over stale
  reads, so the adapter pins its operations to the primary / a session —
  and must not enable or document replicated reads as compatible.
- **Workers KV — rejected, permanently.** Eventually consistent, no
  compare-and-swap. It cannot pass the conformance suite and must not be
  bent to appear to. Do not revisit this without new facts about KV itself.
- **Durable Objects — deferred, not rejected.** Strong consistency per
  object (CAS is trivial there), but a heavier operational model. Revisit
  only if D1 proves unable to express something the conformance suite
  requires.

## Shape of the work

- New package `packages/storage-cloudflare-d1` in this repository, beside
  `packages/storage-azure-tables` and structured like it.
- One D1 database, one table for all collections, mirroring the Azure
  layout: partition key derived as `<collection>:<partition>`, row key = id,
  a version column as the token (D1 has no ETag; a monotonic per-row version
  bumped on every write, checked in the same statement, is the honest
  equivalent).
- `transact` maps to a SQL transaction scoped to one collection + one
  partition — same scope the port promises, no more. Note the Azure
  precedent recorded in AGENTS.md: there is deliberately no
  version-conditional delete inside a transaction and `failedAction` is
  best-effort; keep the D1 adapter's behavior within what the PORT promises
  rather than what SQLite could locally exceed. An adapter must not become
  the reason components assume capabilities the other adapter lacks.

## The test bar (non-negotiable)

The conformance suite is the specification. This adapter is finished when
every case passes against **real D1**. Mechanically that is NOT the
`test/azurite.ts` pattern: a D1 binding is an in-process object, not a TCP
service, so a vitest `globalSetup` cannot spawn it and hand it to test
workers. Use the Cloudflare Workers vitest pool (or instantiate Miniflare
inside the suite itself) so the conformance cases hold a live binding. What
carries over from Azurite is the rule, not the mechanism: the real backend,
never a fake — the Azure adapter's history (a `put` that could not create,
a silently ignored conditional delete) is the proof of why. CI runs both
adapters' suites on Node 22 + 24.

## Versioning and publish

New `CollectionStore` methods are breaking (AGENTS.md); this work adds
none — it is an adapter only, minor-version territory. First publish
follows the ecosystem bootstrap rule: a new npm package cannot use trusted
publishing until it exists (npm/cli#8544) — one manual publish with a 2FA
code, then configure the trusted publisher and it joins the OIDC-only flow.

## What it unblocks

pegma.dev Phase 4: a small real Pegma consumer on Workers (preferred
candidate: a hosted support-desk instance as the site's contact channel).
The adapter lands here first; the consumer work lives in the site repo.
