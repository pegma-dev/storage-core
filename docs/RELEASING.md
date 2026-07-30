# Release operations

Storage Core publishes only from a stable GitHub release. Merging a pull
request never publishes, and the workflow has no manual-dispatch or npm-token
fallback.

## Required external configuration

Before the first release through this workflow:

- configure each public package on npm with the GitHub Actions trusted
  publisher `pegma-dev/storage-core`, workflow `publish.yml`, environment
  `npm-publish`, and allowed action `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the Actions variable `RELEASE_ALLOWED_SIGNERS` containing the
  reviewed Git SSH allowed-signers entry for the maintainer's release key; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

## Independent package versions

The repository has independent package versions. A `vX.Y.Z` release publishes
only public workspaces whose manifest version is `X.Y.Z`. Every other
workspace is packed too and must reproduce the exact integrity already on npm;
this prevents an unversioned package change from hiding in another package's
release.

Release version numbers are nevertheless allocated repository-wide because
Git tags share one namespace. Before changing a package version, choose a
stable `X.Y.Z` that has never appeared as a `vX.Y.Z` tag in this repository;
normally use the next version after the highest existing release tag. A
package may therefore skip numeric versions. Packages intentionally released
together may share the same version and tag, but a later package must never
reuse an earlier release's number or move its tag.

The reviewed release order is:

1. `@pegma/storage-core`
2. `@pegma/storage-azure-tables`
3. `@pegma/storage-cloudflare-d1`

This keeps the port ahead of adapters that depend on it. The release script
also requires internal dependencies to be exact workspace-version pins.

### Authoritative scan release

The new `CollectionStore.scan` method is a breaking port addition, so
`@pegma/storage-core`, `@pegma/storage-azure-tables`, and
`@pegma/storage-cloudflare-d1` release together at `0.4.0`. Both adapters pin
core exactly at `0.4.0`.

D1 advances from `0.1.0` directly to `0.4.0`. This is deliberate:
repository-wide tags `v0.2.0` and `v0.3.0` already exist and must never be
reused or moved. A single protected signed `v0.4.0` release selects and
publishes all three changed packages in dependency order.

### D1 transaction-robustness patch

`@pegma/storage-cloudflare-d1` goes to `0.4.1` alone: a transaction action cap
matching the Azure adapter's, and exact-match classification of the abort
messages its guard triggers raise. The port is unchanged, so
`@pegma/storage-core` and `@pegma/storage-azure-tables` stay at `0.4.0` and
must reproduce the integrity already on npm. `v0.4.1` therefore selects one
package to publish, and D1 keeps its exact `0.4.0` pin on the port.

## Release procedure

Change package versions through an ordinary reviewed pull request and run the
complete gate on Node 22 and 24. After merge, create a signed annotated tag at
the exact `origin/main` commit, push and verify that tag, and only then create
the GitHub release with `--verify-tag`. Never let GitHub create, move, or
replace the tag.

The unprivileged preparation job verifies the tag signature, version,
release-event commit, and `origin/main` ancestry; installs the reviewed npm
version with caching disabled; runs the full gate; packs every public
workspace exactly once; smoke-tests the tarballs; and records each tarball's
SHA-1 and SHA-512 integrity.

Only the `npm-publish` job receives `id-token: write`. It installs no
dependencies, verifies the downloaded prepared artifact, and publishes
release candidates in the dependency-first order above with npm provenance.

## Partial-publish recovery

The workflow is globally serialized. Re-run failed release jobs against the
same unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops before
  later packages publish.

After each publish, the workflow waits for npm to expose the expected
integrity before advancing. Never unpublish and reuse a version.
