# ADR-17: Web UI is a React single-page app served as static assets

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

Every screen is behind login and personal: the destination tree, upload and mapping, job tracking by polling (ADR-12) and downloads. The browser computes checksums and uploads to staging directly (ADR-08). There are no public pages and no SEO need. The blueprint already places the UI on a CDN with no UI compute (ADR-02).

## Decision required

Which frontend stack serves the web UI?

## Alternatives evaluated

### 1. React + Vite SPA on S3 + CloudFront

Client rendered single page app built by Vite, served as static assets.

- \+ Matches the blueprint as written: static assets on a CDN, no UI compute.
- \+ One backend origin; the token stays in memory and polling is a client concern.
- \+ No fourth service to run at 99.9%.
- \- Initial load is a bundle download, acceptable for an internal tool with 2,000 users.
- \- No server rendering.

### 2. Next.js with server features

The dominant React meta framework, server rendered.

- \+ Server components and server rendering available when needed.
- \- Becomes a server: another ECS service to run, scale and keep available.
- \- Every page here is client interactive and would opt out of server components.
- \- A second place where the token lives.

### 3. Next.js static export

Next.js used only to produce static files.

- \+ Keeps static deployment.
- \- Disables the features that justify Next, leaving a heavier Vite.

## Decision

**Option 1.**

An internal tool with every screen behind login gains nothing from server rendering and would pay for it with a sixth deployable. Rejecting Next is a workload fit decision, not a verdict on the framework. We accept a bundle download on first load.

**Ratified by:** Awaiting review
