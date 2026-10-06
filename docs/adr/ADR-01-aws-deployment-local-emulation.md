# ADR-01: Deployment on AWS with local development on emulated cloud services

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

The system needs to be deployed to cloud infrastructure with automated deployment, runnable locally via docker compose (as per requirements).

Functional requirements map almost identically to managed cloud solutions.

## Decision required

Which cloud platform to deploy on, and how to emulate these services locally for development.

## Alternatives evaluated

### 1. AWS + LocalStack

Deployment on AWS with LocalStack (AWS API emulation) runs locally in docker compose.

- \+ Requirements map exactly to native services.
- \+ LocalStack is a mature emulator for exactly these services.
- \+ Managed services carry availability/durability burden, which means less to build and operate.
- \- Vendor lock-in.
- \- LocalStack emulation is not perfect, some edge cases differ in production.

### 2. GCP or Azure with their emulators

Equivalent primitives exist (signed URLs, managed queue, KMS, database).

- \+ Comparable managed capabilities.
- \+ Multi-cloud knowledge is transferable.
- \- Local emulation story is weaker, no single LocalStack equivalent for the full stack.
- \- No advantage over AWS for these specific requirements.

### 3. Self hosted infrastructure

Run and maintain our own database, file storage and messaging services instead of using managed cloud services.

- \+ Greater control over the whole infrastructure.
- \+ Reduced dependence on a cloud provider.
- \- System maintenance is now an in-house burden.
- \- Higher operational workload for the first release.
- \- Fully self hosted key management would not satisfy the requirement for a dedicated cloud key management service.

## Decision

**Option 1.**

Managed services provide the storage, messaging and encryption features required, while reducing the infrastructure we must maintain. Local emulation supports development through Docker compose, with cloud testing needed to verify differences from production. We accept dependence on AWS in exchange for lower operational workload.

**Ratified by:** Awaiting review
