# Public registry parser fixtures

These immutable public MIT package archives match the official npm registry. They are parser and archive test inputs, not a claim that unit tests authenticate their signatures.

| File                            | Source URL                                                                                | SHA256                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| storage-core-0.4.0.tgz          | https://registry.npmjs.org/@pegma/storage-core/-/storage-core-0.4.0.tgz                   | 8fe21519d16f3c94f43c9477714ea08afa9b72fb4a2f0bf0b4c1b1905096a8cf |
| storage-azure-tables-0.4.0.tgz  | https://registry.npmjs.org/@pegma/storage-azure-tables/-/storage-azure-tables-0.4.0.tgz   | bbe26f50cc60d2f45334bbd3d3455ffff7a541b84485123dfe8925e74be46a60 |
| storage-cloudflare-d1-0.4.1.tgz | https://registry.npmjs.org/@pegma/storage-cloudflare-d1/-/storage-cloudflare-d1-0.4.1.tgz | 5e354776b5260d7c0342389daaeb91856022d7375d599708219d8f43786c3301 |
| storage-dynamodb-0.4.5.tgz      | https://registry.npmjs.org/@pegma/storage-dynamodb/-/storage-dynamodb-0.4.5.tgz           | 5bb9cbc12540dc5c3a805181ebf8c2de28d75c0bf0d0180eb0712d4a97ec05be |

Each archive includes its original package LICENSE. The original three archives total 47126 bytes. DynamoDB 0.4.5 adds 14618 bytes, bringing the four Pegma archives to 61744 bytes.

`core040-slsa.json` retains only the genuine public SLSA attestation entry from https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-core@0.4.0 (observed 2026-11-09). The original complete response SHA256 was 14a3b4cf38d4df36f50566af0fa59665f69ec36e67e22b6a4f85feab273c5c3a. No authentication headers, tokens or local paths are included. Tests explicitly stub the already-verified npm audit envelope when exercising the pure claim validator. Actual ECDSA/Sigstore authentication must still run through the unprivileged release verifier using the pinned official npm tool.

Additional genuine SLSA parser fixtures (only the unique SLSA entry is retained):

| Fixture            | Canonical official response                                                           | Original complete response SHA256                                |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| azure040-slsa.json | https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-azure-tables@0.4.0  | b551b76f2a7b8c47d63aba1385816bf590c301df04745d71b59d49599d439c5e |
| d1041-slsa.json    | https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-cloudflare-d1@0.4.1 | 3636da27527d535e6afdd31df0bd6718233d6faba7f507db4b9cd04ebdeeb4b1 |

Signed base64 payload, certificate and transparency values are preserved unchanged. No auth headers, tokens or local paths are included. Controlled orchestration tests can present these genuine entries as scripted npm audit output to exercise downstream decisions, but that scripted command output is not an actual cryptographic verification or release qualification. The separate real Linux npm audit and public consumer gates remain mandatory.

## Qualified DynamoDB 0.4.5 fixtures

The [0.4.5 release](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.5)
retains the original prepared archives, manifest and registry-verification proof.
`storage-dynamodb-0.4.5.tgz` is a literal copy of the qualified canonical archive,
not an archive rebuilt for these tests. Its source is commit
[`a5a5d0bfe6355df89c049fcec3148845c5124735`](https://github.com/pegma-dev/storage-core/commit/a5a5d0bfe6355df89c049fcec3148845c5124735),
under signed tag `v0.4.5` (tag object
`fc5fb301fde6cb167a6f1c4c8dd59de3187c5f69`). The
[original manifest](https://github.com/pegma-dev/storage-core/releases/download/v0.4.5/package-manifest.json)
has SHA256 `57ae54d4e354b9f6e1ea851ca8ed73f213306b75afa322001339762798470dc5`
and came from original Actions artifact `13700564736`. The release also retains
[registry verification](https://github.com/pegma-dev/storage-core/releases/download/v0.4.5/registry-verification.json)
and [SHA256SUMS](https://github.com/pegma-dev/storage-core/releases/download/v0.4.5/SHA256SUMS).

| Fixture                        | Public source                                                                                             | Current fixture file SHA256                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| storage-dynamodb-0.4.5.tgz     | https://registry.npmjs.org/@pegma/storage-dynamodb/-/storage-dynamodb-0.4.5.tgz                           | 5bb9cbc12540dc5c3a805181ebf8c2de28d75c0bf0d0180eb0712d4a97ec05be |
| dynamodb045-slsa.json          | https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-dynamodb@0.4.5                          | 521d74aa9b4e1762432d99ad2f1c7b5c7fa2c140ed160ba983c1a8cc133d286a |
| dynamodb045-original-run.json  | https://api.github.com/repos/pegma-dev/storage-core/actions/runs/42679292292                              | e7d1262d38e7c7d2ca587d35dbc2f16625f6851dd576196376f7b00dc159f9c8 |
| dynamodb045-original-jobs.json | https://api.github.com/repos/pegma-dev/storage-core/actions/runs/42679292292/attempts/1/jobs?per_page=100 | 592ce8c17ce55c17a6abc2a6487524b88ddb3bc55195b0ef1397da72bc068173 |

`dynamodb045-slsa.json` retains the complete unique SLSA-v1 bundle object from
the canonical official npm attestation response, observed 2026-11-09. The complete
response has SHA256 `b99dff0c372781bda547ab9c4a925a15a3b8bfad50c2d8472f2aaad21c537063`.
This is the release provenance authenticated by npm 11.18.0 during qualification.
Its signed base64 payload, certificate, signatures, transparency entries and
timestamps are unchanged; the transparency-log index is `3768594534`. The JSON
fixtures preserve the public response objects semantically. Their formatting need not
match the original HTTP serialization: the hashes above identify the
current fixture files, not the original wire responses.

The actual original writer was run `42679292292`, **attempt 1**, job
[`129370713574`](https://github.com/pegma-dev/storage-core/actions/runs/42679292292/job/129370713574),
step `Verify and publish the prepared release`. npm accepted its write before
the bounded registry-visibility check failed. Its genuine provenance and
certificate/transparency evidence bind that accepted write to attempt 1, despite
the job's final failure. The [successful recovery attempt 2](https://github.com/pegma-dev/storage-core/actions/runs/42679292292/attempts/2)
reused the original preparation and verified all four packages with four skips
and zero new uploads; the reuse policy credits the original attempt-1 write.
The run-metadata fixture was captured after recovery and reports
attempt 2/success. The separate jobs fixture is explicitly the attempt-1 jobs
response and retains the failed physical writer.

These genuine fixtures exercise parser, source-identity and original-writer
checks. Scripted npm output and controlled orchestration tests still do not
perform ECDSA/Sigstore verification or establish a new release, host, provider or
client qualification. Real cryptographic and consumer/backend gates remain
separate from the unit fixtures.

## Reviewed AWS consumer root archive

`aws-client-dynamodb-3.1130.0.tgz` is the genuine 249176-byte public archive from
https://registry.npmjs.org/@aws-sdk/client-dynamodb/-/client-dynamodb-3.1130.0.tgz.
Its SHA256 is `b0f2cf96a293592e70a4b0cee40d0ef387c10b0cdc541b0c3fd99a8d4b753335`
and SHA512 SRI is
`sha512-yPEc9TWLY1McM6xA9wlxA9rM0ZeS8RAeyi1t7rdHPNxq0TpyCDn6z651ccRJ1RrMU4k2aiVzNCaBYUZA4aaA/w==`.
The exact version and SRI match the preexisting reviewed `pnpm-lock.yaml`.
The vendor archive retains its own Apache-2.0 license; the original three Pegma
MIT archives and their 47126-byte total remain unchanged.

Tests supply these unchanged vendor bytes through the existing fetch seam to
exercise the real consumer admission and refusal paths. Scripted npm installs
write controlled lock and package metadata, and the consumer command remains an
explicit `UNQUALIFIED_STUBS` observation. These tests do not execute AWS code,
authenticate AWS provenance or qualify transitive dependencies. Genuine npm
verification and the real public consumer/backend release gates remain separate.
