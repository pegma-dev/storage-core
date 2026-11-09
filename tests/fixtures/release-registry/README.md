# Public registry parser fixtures

These immutable public MIT package archives were downloaded from the official npm registry. They are parser and archive test inputs, not a claim that unit tests authenticate their signatures.

| File                            | Source URL                                                                                | SHA256                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| storage-core-0.4.0.tgz          | https://registry.npmjs.org/@pegma/storage-core/-/storage-core-0.4.0.tgz                   | 8fe21519d16f3c94f43c9477714ea08afa9b72fb4a2f0bf0b4c1b1905096a8cf |
| storage-azure-tables-0.4.0.tgz  | https://registry.npmjs.org/@pegma/storage-azure-tables/-/storage-azure-tables-0.4.0.tgz   | bbe26f50cc60d2f45334bbd3d3455ffff7a541b84485123dfe8925e74be46a60 |
| storage-cloudflare-d1-0.4.1.tgz | https://registry.npmjs.org/@pegma/storage-cloudflare-d1/-/storage-cloudflare-d1-0.4.1.tgz | 5e354776b5260d7c0342389daaeb91856022d7375d599708219d8f43786c3301 |

Each archive includes its original package LICENSE. The three archives total 47126 bytes.

`core040-slsa.json` retains only the genuine public SLSA attestation entry from https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-core@0.4.0 (observed 2026-11-09). The original complete response SHA256 was 14a3b4cf38d4df36f50566af0fa59665f69ec36e67e22b6a4f85feab273c5c3a. No authentication headers, tokens or local paths are included. Tests explicitly stub the already-verified npm audit envelope when exercising the pure claim validator. Actual ECDSA/Sigstore authentication must still run through the unprivileged release verifier using the pinned official npm tool.
