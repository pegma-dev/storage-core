# Release operations

Runtime packages publish only through a stable GitHub release and trusted
publisher OIDC. Merging source never publishes. The workflow has no dispatch or
npm-token fallback. The separately reviewed, metadata-only DynamoDB registration
below is an explicit first-package exception, not a runtime release path.

## Current versions and source ownership

Core and Azure are published at `0.4.0`; D1 at `0.4.1`. DynamoDB `0.4.2` is reserved for
registration-only metadata, and `0.4.3` is the unpublished first trusted runtime
candidate. Registration is not adapter code, conformance evidence or a production
dependency. Do not claim an actual registration or release until its public
registry evidence exists.

Unversioned Core/Azure/D1 changes in current source are **not** the code published
at those versions. Schema 2 deliberately selects source artifacts by the new tag
version and reuses original registry archives for the others. It never rebuilds
those old versions or labels their old provenance as the new source. Hosts retain
the genuine Core `0.4.0` runtime, including StorageError/ConcurrencyError identity;
no Core or host upgrade is implied.

Versions are independently assigned but release tags share a repository-wide
namespace. Never reuse or move a tag/version, including failed publication or
registration versions. First trusted DynamoDB is planned as `v0.4.3`; the separate
later D1 feature must allocate a fresh unused version, such as `0.4.4`, after rebase
and review.

## Required configuration

Configure each runtime package's trusted publisher for pegma-dev/storage-core,
publish.yml, environment npm-publish and action npm publish. Maintain the reviewed
RELEASE_ALLOWED_SIGNERS SSH allowed-signers variable and protected signed,
annotated v* tags. The npm-publish environment requires normal owner approval
and tag-only deployment. Recheck actual ownership, approved signer, tag
protection, environment and npm 2FA/direct-publish policy before each release;
historical attestations do not establish current configuration.

Only publish receives id-token:write. It checks out no source, installs no
dependencies and runs no release-tag/package code. Both npm environment filters
preserve RUNNER_ENVIRONMENT, and the active publisher requires github-hosted
along with the exact release/source/workflow/OIDC identity. Credentials,
inherited npm config, proxy and CA overrides are excluded. There is no token
fallback or alternative local publisher: release:publish and its retained helper
export refuse before I/O and direct the owner to the protected workflow.

## DynamoDB namespace registration

After the policy PR, full gates and normal merge, the maintainer may create and
verify the signed v0.4.3 source tag without creating its GitHub release yet.
That approved immutable source guards the separate registration preparation.

A registration-only `@pegma/storage-dynamodb@0.4.2` archive contains exactly
package.json, README.md and LICENSE. It has no exports/main/module/types/bin,
runtime files, scripts or dependencies of any kind. Metadata/README say that it
only registers the namespace, is not an SDK and has no OIDC provenance. Inspect
and retain its exact bytes/digests before an explicit maintainer 2FA publication
under bootstrap; never install it for a backend/host proof or describe it as the
latest runtime. Inspect actual registry bytes/dist-tags afterward. No GitHub
v0.4.2 release is needed.

Then configure and verify trusted publishing and package/account restrictions.
Create the v0.4.3 GitHub release only when this configuration is complete. Never
manually publish the real `0.4.3` artifact first: immutable bytes with missing trusted
provenance cannot later be repaired by a skip. Registration `0.4.2` remains immutable
and explicitly outside runtime qualification.

## Schema 2 and registry reuse policy

The exact dependency-first inventory remains:

1. @pegma/storage-core
2. @pegma/storage-azure-tables
3. @pegma/storage-cloudflare-d1
4. @pegma/storage-dynamodb

A prepared artifact contains exactly package-manifest.json and four tgz files.
The schema 2 header binds repository, gitCommit, releaseTag, registryPolicySha256
and that ordered package inventory. Every record includes its package metadata,
file inventory, compressed byte size, SHA-1, SHA-256, SHA-512 SRI and a closed origin:

- source binds the selected package's directory, exact new commit and tag;
- registryReuse binds the original official registry URL, independently pinned
  policy entry, historical source/tag/workflow and original run/attempt.

scripts/release-reuse-policy.json is reviewed source, not a digest supplied only
by the downloaded artifact. Its exact old archive hashes and historical source
identities are mandatory. Changing or adding reuse pins requires review and
genuine registry cryptographic proof; availability errors never trigger a source
fallback. Internal runtime pins remain exact, including DynamoDB → Core `0.4.0`.

The producer downloads unselected original archives verbatim and validates bounded
contents, public metadata, exported files, README/LICENSE and test exclusion. It
never substitutes their current unversioned workspace builds. Genuine npm `11.18.0`
signature/Sigstore verification then authenticates each reused root's matching
SLSA subject, certificate issuer/SAN, repository IDs, source/tag/workflow/event,
original invocation and github-hosted builder. Raw outputs and locks are retained
outside the five-file release inventory. Decoding an attestation is not
cryptographic verification.

Old schema 1 releases and tags remain immutable. New producer code rejects their
schema rather than guessing an origin. Recover an old release using its original
reviewed producer and retained artifacts; do not repack or rewrite historical
tags under schema 2.

## Gates and exact preparation

Run formatting, types, all tests and release metadata on actual Node 22 and 24.
Tests use real Azurite, local Miniflare D1 and Amazon DynamoDB Local with Java 21.
The release workflow verifies the signed stable event identity before source
execution, then runs both Node validation lanes before preparation.

Preparation requires a clean checkout at the signed annotated tag, exact event
commit and origin/main ancestry. The selected runtime comes from that source;
ordinary workspace builds for types/tests do not become unselected release
artifacts. Development pack without a release tag selects the highest candidate
version but cannot authorize publication.

The output is nonhidden RUNNER_TEMP/storage-prepared. It is sealed before
consumer execution, uploaded with a unique run/attempt name and overwrite:false,
and retained by immutable artifact ID. Record the upload ZIP digest plus the
independent manifest SHA-256. Every downstream job downloads by ID, not just name.
Owner preapproval independently checks the actual original API artifact/ZIP
digest, source/tag, manifest, five-file inventory and all archive bytes.

Local `release:pack` defaults to `.release` and retains sibling proof directories
`.release-reuse-verification` and `.release-consumer-verification`. These
default paths are ignored by Git; custom outputs inside the checkout can
still violate `--require-clean`. Prefer a new output outside the checkout, such
as `--output ../storage-prepared-unique`, which keeps the same artifact/proof
sibling layout as `RUNNER_TEMP/storage-prepared` in the release workflow.

Before repository validation, downloads or builds, preparation requires an
absent or empty regular artifact directory and absent reuse/consumer proof
siblings. An existing proof directory is refused even when empty or when that
invocation uses `--skip-smoke`; these three paths identify one retained evidence
namespace. A repeated explicit smoke `--output` is likewise refused before
manifest verification or consumer execution. Keep earlier artifacts and proofs
and choose a new output path. Removing only `.release` does not make its proof
siblings fresh, and these commands never delete or overwrite previous receipts.

Smoke installs the selected tar and genuine registry Core `0.4.0`/other roots into an
isolated consumer, scripts disabled and no workspace/source/override fallback.
It imports public roots, executes published Core conformance against DynamoDB
Local, and proves real StorageError/ConcurrencyError identity with Core `0.4.0`.
The fixture is local synthetic backend evidence, not a deployed AWS claim.

## Preflight and minimal publish

A separate unprivileged whole-set preflight verifies exact canonical registry
bytes and real signatures/provenance before returning any decisions. An absent
selected version may publish; an existing selected version may skip only after
its original bytes and authenticated source/invocation qualify. A missing reused
version, conflicting bytes, unqualified existing selected version or non404
registry error stops the release.

Publisher validates the independently sealed original manifest, policy and
preflight receipts again. It receives only verified original archives and
publishes only selected source tar paths from a fresh private directory, with
ignore-scripts, explicit official registry and provenance. Reused packages are
never republished. Package imports and crypto tool installation remain outside
OIDC authority.

The verified npm tool is exactly `11.18.0`. By default, unprivileged verification
authenticates the pinned official archive digest, extracts its bounded regular
file tree into an owned temporary directory and executes that CLI. It does not
discover or execute host-bundled npm, whose legitimate extra `.bin` links are
outside the original archive. An explicit `npmCli`/`RELEASE_NPM_CLI` remains a
strict reviewed path: every file must match the verified official tree, without
links or extra files, before execution. The minimal OIDC publisher still installs
nothing and uses its separately pinned Node/npm runtime.
Raw audit output is retained before any public consumer import, and its hashes
are checked afterward. Never let a caller-provided qualified boolean or decoded
bundle substitute for that actual cryptographic command.

## Unknown outcomes and final qualification

Registry visibility is polled within a bound. A successful physical publication
can be followed by a visibility failure. Preserve the exact original archive,
manifest, source/tag and writer job; never repack, retag, unpublish or overwrite
the version.

If occupancy changes from an earlier absent preflight, the publisher refuses an
unqualified skip. Refresh the unprivileged preflight job against the **original**
prepare/smoke artifact, then continue through normal owner approval. It is not a
new preparation. A mere failed-publisher retry with the old absent decision does
not bypass current cryptographic qualification.

Final unprivileged verification installs exact registry roots, authenticates
ECDSA/Sigstore and certificate/SLSA source identities, and compares canonical
tar bytes to the originals before public imports. Reused entries retain their
historical invocations; selected entries must identify this exact release run
and an actual original attempt no later than the current attempt. It independently
checks the original minimal publisher job, source/event and certificate time
overlap. A failed original job can be the physical writer; the final retry is not
automatically that writer. Retain the explicit package→writer map for independent
owner inspection and distinguish it from final workflow success.

The public registry consumer and complete workflow must succeed before runtime
qualification or host adoption. Raw artifacts, crypto outputs, source bindings,
original writer IDs and consumer results remain reviewable. Green upload/job
status, metadata-only registration or availability by itself is not a qualified
release.
