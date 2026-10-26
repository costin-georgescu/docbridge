# ADR-22: CRC32C as the end-to-end integrity checksum

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Blueprint Risk 1 defers the checksum algorithm to the TDD. Integrity must be verified end to end: browser to staging to worker to platform. S3 validates a full-object checksum on multipart uploads only for CRC algorithms (CRC32, CRC32C, CRC64NVME with checksum type `FULL_OBJECT`); SHA-1 and SHA-256 are composite-only on multipart. The browser must hash a 1 GB file without freezing (spec), so hashing streams in a Web Worker regardless of algorithm.

## Decision required

Which checksum algorithm carries integrity from upload to delivery?

## Alternatives evaluated

### 1. CRC32C end to end

One algorithm at every hop.

- \+ S3 validates the full object on a single PUT and on multipart complete.
- \+ Same value stored on the staged file, recomputed by the worker while streaming, recomputed by the platform on receipt.
- \+ Browser and worker implementation via `@aws-crypto/crc32c`, which runs in both.
- \- 32-bit: detects corruption, does not resist deliberate tampering — which is the job of access control and TLS, not of the checksum.
- \- LocalStack's checksum emulation must be verified against real S3 in staging.

### 2. SHA-256 end to end

Cryptographic hash at every hop.

- \+ Collision resistance beyond corruption detection.
- \- S3 cannot validate the full object on multipart, so storage-side verification is lost exactly for the largest files.
- \- WebCrypto digest is not streaming; a JS implementation is needed anyway.

### 3. Two checksums

CRC32C for S3 validation, SHA-256 for end-to-end verification.

- \+ Each property where it's strongest.
- \- Two values to carry, compute and compare everywhere for no requirement that demands it.

## Decision

**Option 1.**

The spec requires corruption detection; CRC32C gives it at every hop with storage itself participating, including on the multipart uploads that carry the largest files. We accept a non-cryptographic checksum because tampering is addressed by access control, not by the hash.

**Ratified by:** Awaiting review
