# ADR-14: Browser reaches the document platform only through the DocBridge API

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

The Web UI needs the destination hierarchy, owned by the document platform (ADR-07), and job operations, owned by the DocBridge API. The platform verifies tokens locally (ADR-05), so it could serve the browser directly. Services run as separate containers behind one load balancer (ADR-02).

## Decision required

Does the browser reach the document platform directly or only through the DocBridge API?

## Alternatives evaluated

### 1. Browser talks only to the DocBridge API

The API forwards browse requests to the platform with the caller's token and returns the filtered tree unchanged.

- \+ One public backend: one base URL, one CORS origin, one load balancer rule.
- \+ The platform stays private, only the API and workers can reach it.
- \+ The API already calls the platform at submission to resolve folder to team, so the server-to-server path exists anyway.
- \+ Platform API changes are absorbed by the API, the UI is untouched.
- \- One extra hop on the destination tree path.
- \- The API carries a pass-through endpoint with no logic of its own.

### 2. Browser talks to the platform directly for browsing

The load balancer routes browse requests to the platform and job requests to the API.

- \+ Mirrors an external product with its own public API.
- \+ No pass-through endpoint in the API.
- \- The platform becomes publicly reachable and needs a hardened public surface in R1.
- \- The UI depends on two backends: two base URLs, two CORS setups, two failure modes.
- \- Destination ids must still be re-validated by the API at submission, so nothing is saved on authorization.

## Decision

**Option 1.**

Routing browsing through the API keeps the platform private and the UI pointed at one backend, at the cost of a hop measured in milliseconds. The platform standing in for an external product calls for a clean API contract between the two services, not for public exposure. We accept a pass-through endpoint in the API; a direct path is one load balancer rule away if the platform ever gains clients other than DocBridge.

**Ratified by:** Awaiting review
