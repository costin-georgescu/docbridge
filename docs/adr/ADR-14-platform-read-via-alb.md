# ADR-14: Browser reads the destination tree directly from the platform

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

The Web UI needs the destination hierarchy, owned by the document platform (ADR-07), and job operations, owned by the DocBridge API. The platform verifies tokens locally (ADR-05), so it can serve the browser directly. Services run as separate containers behind one load balancer (ADR-02).

## Decision required

Does the browser reach the document platform directly for browsing or only through the DocBridge API?

## Alternatives evaluated

### 1. Browser talks only to the DocBridge API

The API forwards browse requests to the platform with the caller's token and returns the filtered tree unchanged.

- \+ One public backend: one base URL, one load balancer rule for reads.
- \+ The platform stays fully private; only the API and workers reach it.
- \+ Platform API changes are absorbed by the API; the UI is untouched.
- \- The API carries a pass-through endpoint with no logic of its own.
- \- One extra hop and failure mode on the tree path; a platform outage makes the API look down for reads that are not its domain.

### 2. Browser talks to the platform directly for browsing

The load balancer routes `GET /tree` to the platform and everything else per domain. Only that one path is public: the delivery `PUT`, `/folders/resolve` and `/admin/*` are never routed, so the platform's write and admin surface stays private. The platform verifies the user's token itself — the same guard the workers' service token already requires.

- \+ Mirrors an external product with its own public API.
- \+ No pass-through endpoint: each service owns its domain end to end.
- \+ The platform's public surface is one read path on the same domain; no second origin or CORS setup.
- \- A third rule on the public listener to keep narrow.
- \- Destination ids must still be re-validated by the API at submission, so nothing is saved on authorization.

## Decision

**Option 2.**

The pass-through added no logic: it forwarded a token and relayed a response. Since the platform already verifies tokens locally, routing `GET /tree` to it directly gives each service a clean public surface and removes a hop on the read path. The load balancer routes only that path — delivery, resolve and admin endpoints stay unrouted and reachable only on the internal service name. Submission still calls `POST /folders/resolve` server-to-server, so authorization at submission is unchanged.

**Ratified by:** Awaiting review
