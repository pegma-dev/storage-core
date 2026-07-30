# Security Scan — storage-core

Repository-wide security review performed 2026-07-28.

Scope: all first-party source (`packages/*/src`), scripts, CI/CD workflows,
test infrastructure, and dependency manifests. `node_modules` and packed
artifacts under `.release/` are excluded from line-by-line review but
dependency versions are audited.

Findings are appended as they are discovered during the scan, not batched at
the end. Severity scale: Critical / High / Medium / Low / Informational.

---

## Findings

### 1. Vulnerable transitive dev dependencies via `azurite`

- **Severity:** Medium (dev/test environment only)
- **Evidence:** `npm audit` reports 12 vulnerabilities (5 high, 7 moderate),
  all reachable only through the `azurite` devDependency:
  - `brace-expansion <= 5.0.7` — DoS via unbounded expansion length /
    out-of-memory crash (GHSA-mh99-v99m-4gvg, **high**), via
    `azurite → rimraf → glob → minimatch`.
  - `@opentelemetry/core < 2.8.0` — unbounded memory allocation in W3C
    Baggage propagation (GHSA-8988-4f7v-96qf, moderate), via
    `azurite → applicationinsights`.
  - `uuid < 11.1.1` — missing buffer bounds check in v3/v5/v6 when `buf` is
    provided (GHSA-w5hq-g745-h8pq, moderate), via
    `azurite → sequelize → @azure/ms-rest-js`.
- **File references:** the root `package.json` devDependency `azurite ^3.36.0`,
  and `package-lock.json`.
- **Exploitability:** Low in practice. None of these packages ship to
  consumers — the published packages (`@pegma/storage-core`,
  `@pegma/storage-azure-tables`, `@pegma/storage-cloudflare-d1`) declare only
  `@azure/data-tables` and the workspace port as runtime dependencies, and the
  release pipeline packs only `dist/` allowlists. The vulnerable code paths
  run only inside the local/CI test harness (Azurite emulator process), which
  processes no untrusted input: the only client is the adapter test suite
  itself. Exploitation would require an attacker to feed crafted
  baggage/glob/uuid inputs to a developer's local test run.
- **Recommendation:** Track upstream Azurite fixes; upgrade `azurite` when a
  release carrying patched transitive deps is available. No emergency action.
- ⚠️ Disputed 2026-07-29 — not a valid finding: nothing here is reachable or
  fixable. `azurite@3.36.0` is the newest published release, so no upgrade
  exists; the only change `npm audit fix --force` offers is a _downgrade_ to
  `azurite@3.33.0`, which resolves no advisory. Overriding the transitive
  `brace-expansion`, `uuid`, and `@opentelemetry/core` versions would cross
  major boundaries inside a dev harness that must keep working on Node 22 and
  24, trading a non-exploitable dev-only DoS for real gate fragility. The
  packages published from this repository declare none of these, the release
  pipeline packs only `dist/` allowlists, and no workflow gates on
  `npm audit`. Revisit if an Azurite release carries patched deps.

### 2. Hard-coded Azurite credentials in test file

- **Severity:** Informational
- **Evidence:** `packages/storage-azure-tables/src/index.test.ts:13-21`
  contains `devstoreaccount1` and the key
  `Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==`.
- **Exploitability:** None. These are the published, well-known Azurite
  emulator defaults, identical in every Azurite installation, and the endpoint
  is `http://127.0.0.1:<test port>` spawned by the test run itself
  (`test/azurite.ts:17` binds `127.0.0.1`). They grant access to nothing real.
  Secret scanners will flag them; a documented allowlist entry avoids triage
  churn.
- **Recommendation:** None required. Optionally add a `.gitleaks`/scanner
  allowlist comment.
- ⚠️ Disputed 2026-07-29 — not a valid finding: the key is Azurite's published
  emulator default, identical in every install, and
  `packages/storage-azure-tables/src/index.test.ts:13-17` already documents it
  as such. The endpoint is `http://127.0.0.1:10102`, served by a process the
  test run spawns with `--tableHost 127.0.0.1` into a temporary directory it
  deletes afterwards (`test/azurite.ts:17`, `:64-80`). There is no secret to
  rotate and nothing to reach.

### 3. D1 `transact` has no action-count limit

- **Severity:** Low
- **Evidence:** The Azure adapter caps a transaction at 100 actions before
  touching the network (`packages/storage-azure-tables/src/index.ts:62`,
  `:532-536`). The D1 adapter builds one prepared statement per guard/write
  with no bound (`packages/storage-cloudflare-d1/src/index.ts:701-756`) — a
  `putIfUnchanged` costs 3 statements, so an action list multiplies into a far
  larger batch than the caller wrote. Corrected 2026-07-29: D1 publishes no
  per-batch statement or SQL-size limit, as originally claimed here. The limit
  that actually binds is per Worker invocation — 1000 queries on Workers Paid,
  50 on Free — and every statement inside a batch counts against it.
- **Exploitability:** Not attacker-reachable on its own; a host application
  would have to pass an oversized action list. The outcome is a thrown D1
  error, not corruption — D1 batches are atomic. It is a robustness/parity
  gap rather than a vulnerability, logged here because a caller relying on
  port behaviour gets an opaque failure on one backend and a clean
  `StorageError` on the other.
- **Recommendation:** Add a documented cap in the D1 adapter (or in
  `assertOnePartition`) so the failure mode matches across adapters.
- ✅ Resolved 2026-07-29 — the D1 adapter refuses more than 100 actions with a
  `StorageError` from the action count alone, before deriving keys, preparing
  statements, or touching the database, matching the Azure adapter's limit so
  one action list is accepted or refused by both. The query-budget correction
  noted in the evidence is recorded in the adapter comment and the package
  README.

### 4. D1 transaction rejection inferred by substring match on error text

- **Severity:** Low
- **Evidence:** `markerRejection`
  (`packages/storage-cloudflare-d1/src/index.ts:373-391`) classifies a failed
  batch by checking whether `error.message` _includes_ marker strings such as
  `PEGMA_STORAGE_D1_TX_CHANGED`, then reports `committed: false` instead of
  rethrowing.
- **Exploitability:** A genuine, unrelated D1 error whose message happens to
  contain a marker substring would be silently misreported as a precondition
  refusal, hiding a real failure. Bound parameters are not echoed into D1
  error messages, so record content cannot inject the marker through normal
  operation; the residual risk is D1 error text changes or unusual constraint
  errors. Integrity impact (hidden failure reported as a clean conflict), not
  confidentiality.
- **Recommendation:** Prefer exact-match against the full error message, or
  compare the message suffix after the known `RAISE(ABORT, ...)` prefix, so
  incidental substring occurrences cannot misclassify.
- ✅ Resolved 2026-07-29 — `markerRejection` now compares the raised abort
  message exactly instead of scanning the whole text. Verified against real D1,
  a triggered abort arrives as the marker between a `D1_ERROR: ` prefix and a
  `: SQLITE_CONSTRAINT ...` suffix, so the classifier strips that prefix, takes
  the segment before the first `: `, and requires it to equal a marker. An
  unrelated error that merely mentions a marker is rethrown; a test asserts it.

---

## Areas reviewed with no findings

Scan complete 2026-07-28. The following were examined and found clean:

- **Injection.** All D1 queries are static strings with bound parameters
  (`packages/storage-cloudflare-d1/src/index.ts` — every `.bind()` call site;
  table/column names are module constants). The Azure adapter's single OData
  filter escapes single quotes correctly
  (`packages/storage-azure-tables/src/index.ts:98-100`) and validates key
  parts against Azure's forbidden-character set before use (`:34-46`).
  No `eval`, `new Function`, or string-built queries anywhere in first-party
  source.
- **Key-space isolation.** Both adapters compose the physical partition key
  as `<collection>:<partition>` and both forbid `:` in collection names
  (Azure `:207-211`, D1 `:341-345`), so two `(collection, partition)` pairs
  cannot collide onto one physical partition.
- **Reserved-property shadowing.** The Azure adapter rejects record fields
  named `partitionkey`/`rowkey`/`timestamp`/`etag` case-insensitively and
  spreads the record before the keys so the keys win regardless
  (`:25`, `:105-109`, `:247-248`).
- **Concurrency integrity.** Conditional writes/deletes map to ETags (Azure)
  or version columns checked in the same statement (D1); `transact` rejects
  cross-partition and duplicate-key batches before any I/O
  (`packages/storage-core/src/index.ts:298-322`). Tombstone handling in D1
  prevents version reuse after delete.
- **Command execution.** `scripts/release-packages.mjs` and
  `test/azurite.ts` spawn only fixed executables (`git`, `npm`, `node`) with
  argument arrays; `shell: true` is used solely for the Windows `npm.cmd`
  fallback, and tarball paths are passed through `basename` before use.
  `verifyPreparedManifest` validates tarball paths stay beside the manifest
  before reading them (`scripts/release-packages.mjs:588-592`).
- **CI/CD.** All GitHub Actions are pinned to full-length SHAs; workflows use
  minimal `permissions:`; no `pull_request_target`; publishing is OIDC
  trusted-publisher only, requires a signed annotated tag verified against an
  allowed-signers file, an exact commit match, and registry integrity
  comparison before and after publish
  (`.github/workflows/publish.yml`, `scripts/release-packages.mjs:639-682`).
- **Secrets.** No credentials in tracked files beyond the documented Azurite
  emulator defaults (finding 2). `.gitignore` excludes `.env*` and
  `.release/`; `git ls-files` confirms no release artifacts or env files are
  tracked.
- **Runtime surface.** Published packages have no network calls of their own,
  no runtime dependencies in the port, no use of `Math.random` for
  security-relevant values, and no DOM/browser state access.

## Summary

| #   | Severity          | Title                                                  | Disposition            |
| --- | ----------------- | ------------------------------------------------------ | ---------------------- |
| 1   | Medium (dev-only) | Vulnerable transitive dev dependencies via `azurite`   | ⚠️ Disputed 2026-07-29 |
| 2   | Informational     | Hard-coded Azurite emulator credentials in tests       | ⚠️ Disputed 2026-07-29 |
| 3   | Low               | D1 `transact` has no action-count limit                | ✅ Resolved 2026-07-29 |
| 4   | Low               | D1 rejection inferred by substring match on error text | ✅ Resolved 2026-07-29 |

No Critical or High issues in first-party code. The four findings are all
low-impact and none are exploitable through the published packages' public
APIs.

Each finding was re-reviewed against the code on 2026-07-29. The two D1
robustness gaps are fixed in `@pegma/storage-cloudflare-d1` with tests against
real D1; the two remaining items are recorded as disputed, with reasoning, on
the findings themselves.
