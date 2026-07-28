# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Storage Core is the persistence foundation of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live in
`@pegma/spine`; identity and permissions in `@pegma/authorization-core`; a
support desk and other components follow. They publish under the `@pegma`
scope, one repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

Everything else in Pegma depends on this package, so a mistake here is a
mistake everywhere. Weigh changes accordingly.

## Hard rules

**The conformance suite is the specification.** A behaviour that is not
asserted in `packages/storage-core/src/conformance.ts` is not something a
component may rely on, and an adapter is finished only when it passes. Add
cases with the behaviour, never after.

**Verify adapters against a real backend, never a fake.** The Azure adapter is
tested against a real Azurite table service spawned by the test run. A fake
client only proves the adapter agrees with its author. Testing against the real
thing has already caught a `put` that could not create, a conditional delete
the service silently ignored, and a refused-action index that is not always
reported.

**A new method on `CollectionStore` is a breaking change.** Implement it in
every adapter in this repository and cover it in conformance before merging.
Bump the minor version; adapters written elsewhere will not compile.

**Do not promise what an adapter cannot keep.** Transactions are scoped to one
collection and one partition because that is the guarantee backends actually
offer. There is deliberately no version-conditional delete inside a
transaction: Azure carries no per-action condition on a delete, and moving the
condition onto the entity was tested and did not work. When a backend cannot
honour something, remove it from the port rather than documenting a caveat.

**No runtime dependencies in `@pegma/storage-core`.** Adapters may depend on
their backend SDK; the port may not depend on anything. Keep it ESM-only and
written against web-standard APIs where there is a choice, so it can run
outside Node.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit. Tooling has silently turned those escapes
into actual control characters more than once here, producing a regex that
reads correctly and matches the wrong thing.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root, and the package page
renders blank without them. Each needs `prepack` running the build, or a stale
`dist` ships silently. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests are published to consumers.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, `npm test` — all three, on Node 22 and 24. `npm test` starts Azurite automatically.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. The unprivileged preparation job runs
the gate and packs the exact artifacts; only the minimal publish job receives
OIDC authority. Publication is integrity-checked, retry-safe, and
dependency-ordered. See `docs/RELEASING.md`.

## Where things stand

`@pegma/storage-core` and `@pegma/storage-azure-tables` are both published at
`0.3.0`. The port offers keyed access, optimistic concurrency through `update`,
version-conditional `putIfUnchanged` and `deleteIfUnchanged`, partition reads,
and `transact`.

Known gaps, in the order they are likely to matter:

- No durable outbox yet, though `@pegma/spine` documents one as this package's
  responsibility. `transact` is the primitive it needs; the shape should be
  designed against a real consumer rather than guessed.
- No cross-partition atomicity, deliberately, and unlikely to change.
- Reads are by key or by whole partition. No server-side filtering, ordering,
  or secondary indexes. A component that needs a second access path maintains
  its own index collection.

Siblings: [spine](https://github.com/pegma-dev/spine),
[authorization-core](https://github.com/pegma-dev/authorization-core), and the
organization profile at [github.com/pegma-dev](https://github.com/pegma-dev).
