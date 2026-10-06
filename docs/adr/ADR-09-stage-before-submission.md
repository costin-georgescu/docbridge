# ADR-09: Submit enabled once all files finish staging

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

Users select files and map them to destination folders before submitting a job. Files must reach staging before they can be delivered to the document platform.

We need to decide whether submission waits for staging to finish or whether a job can be accepted while files are still uploading.

## Decision required

Should users be able to submit a job before all selected files finish staging?

## Alternatives evaluated

### 1. Stage before submission

Files upload in the background while the user maps destinations. Submit becomes available once all files finish staging.

- \+ File uploads overlap the user's mapping work.
- \+ Accepted jobs have all files available for delivery.
- \+ Upload failures can be resolved before submitting the job.
- \- Users can't submit until all bytes are staged.
- \- Large files or slow connections may leave users waiting after mapping.
- \- Files uploaded but never submitted need cleanup.

### 2. Submit before staging finishes

The system accepts the job and mappings while files continue uploading. Delivery waits until the required files are available.

- \+ Users confirm their mappings without waiting for uploads to finish.
- \+ The job appears in history while uploading continues.
- \- Accepted jobs may contain files that never finish uploading.
- \- Requires tracking missing uploads and handling abandoned jobs.
- \- Users still need to keep the browser session open until uploads finish.

## Decision

**Option 1.**

File uploads overlap the user's mapping work, and accepted jobs have their files ready for delivery. Users may need to wait before submitting, but R1 avoids managing accepted jobs with unfinished uploads. Submission acknowledgement is measured after staging finishes as the upload time is separate.

**Ratified by:** Awaiting review
