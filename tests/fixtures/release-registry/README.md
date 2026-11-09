# Public registry parser fixtures

These immutable public MIT package archives were downloaded from the official npm registry. They are parser and archive test inputs, not a claim that unit tests authenticate their signatures.

| File                            | Source URL                                                                                | SHA256                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| storage-core-0.4.0.tgz          | https://registry.npmjs.org/@pegma/storage-core/-/storage-core-0.4.0.tgz                   | 8fe21519d16f3c94f43c9477714ea08afa9b72fb4a2f0bf0b4c1b1905096a8cf |
| storage-azure-tables-0.4.0.tgz  | https://registry.npmjs.org/@pegma/storage-azure-tables/-/storage-azure-tables-0.4.0.tgz   | bbe26f50cc60d2f45334bbd3d3455ffff7a541b84485123dfe8925e74be46a60 |
| storage-cloudflare-d1-0.4.1.tgz | https://registry.npmjs.org/@pegma/storage-cloudflare-d1/-/storage-cloudflare-d1-0.4.1.tgz | 5e354776b5260d7c0342389daaeb91856022d7375d599708219d8f43786c3301 |

Each archive includes its original package LICENSE. The three archives total 47126 bytes.

`core040-slsa.json` retains only the genuine public SLSA attestation entry from https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-core@0.4.0 (observed 2026-11-09). The original complete response SHA256 was 14a3b4cf38d4df36f50566af0fa59665f69ec36e67e22b6a4f85feab273c5c3a. No authentication headers, tokens or local paths are included. Tests explicitly stub the already-verified npm audit envelope when exercising the pure claim validator. Actual ECDSA/Sigstore authentication must still run through the unprivileged release verifier using the pinned official npm tool.

Additional genuine SLSA parser fixtures (only the unique SLSA entry is retained):

| Fixture            | Canonical official response                                                           | Original complete response SHA256                                |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| azure040-slsa.json | https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-azure-tables@0.4.0  | b551b76f2a7b8c47d63aba1385816bf590c301df04745d71b59d49599d439c5e |
| d1041-slsa.json    | https://registry.npmjs.org/-/npm/v1/attestations/@pegma%2fstorage-cloudflare-d1@0.4.1 | 3636da27527d535e6afdd31df0bd6718233d6faba7f507db4b9cd04ebdeeb4b1 |

Signed base64 payload, certificate and transparency values are preserved unchanged. No auth headers, tokens or local paths are included. Controlled orchestration tests can present these genuine entries as scripted npm audit output to exercise downstream decisions, but that scripted command output is not an actual cryptographic verification or release qualification. The separate real Linux npm audit and public consumer gates remain mandatory.
