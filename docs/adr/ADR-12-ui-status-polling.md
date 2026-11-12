# ADR-12: UI polls job status on an interval

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 12.11.2026 | **Author:** Costin Georgescu

## Context

Users need to see task status updates automatically during job processing (as per FR5). Task lifecycles run from seconds to minutes with up to 200 concurrent users during business hours.

## Decision required

How should status updates reach the UI?

## Alternatives evaluated

### 1. Polling

The UI requests job status on a fixed interval until the job is finished.

- \+ Fulfills the automatic update requirement without requiring user action.
- \+ Works over the existing API with no new connection infrastructure to build or operate.
- \+ Trivially small load at 200 concurrent users.
- \- Status visibility lags by up to the poll interval.
- \- Most polls return unchanged data leading to wasted requests.

### 2. Websockets

Persistent connection between the UI and server which pushes each task status change the moment it happens.

- \+ Real-time feel with near instant updates.
- \+ Efficient when updates are frequent.
- \- Requires persistent connection infrastructure: connection management, reconnect handling, and a broadcast path from workers to the API.
- \- Marginal benefit while deliveries take from seconds to minutes.

### 3. Server-sent events

One way push over HTTP with browser auto reconnect.

- \+ Push updates without full websocket complexity.
- \+ Reconnect handled by the browser.
- \- Still persistent connections to manage and scale.
- \- Same marginal benefit as websockets for the same reason.

## Decision

**Option 1.**

FR5 requires automatic updates, not push delivery. Polling satisfies it at trivial cost and adds no connection infrastructure. We accept status lagging by up to the poll interval as deliveries aren't instant anyway, so users can't perceive the difference.

*Update 12.11.2026:* the "trivially small load" premise held for request count but not payload — the job detail response carried every task row, ~600 KB per poll per viewer on a 2,000-task job. The poll now returns the summary only (counts incl. `retrying`, files); task rows moved to `GET /api/jobs/:id/tasks`, keyset-paginated and re-fetched only when the polled counts change. Option 1 stands; the accepted "unchanged data" con now applies to a few hundred bytes per poll rather than the full task list.

**Ratified by:** Awaiting review
