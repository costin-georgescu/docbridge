# ADR-02: Containerized services on ECS Fargate, ALB entry point

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 21.10.2026 | **Author:** Costin Georgescu

## Context

The system runs long lived services on AWS (ADR-01): the API, auth service, document platform, dispatcher and workers consuming the task queue. Workers fetch files up to 1 GB in size, verify checksums and deliver to the platform. This implies long running, disk touching work. Scale is modest at 200 concurrent users.

## Decision required

Which compute model runs the backend services?

## Alternatives evaluated

### 1. ECS + Fargate

Containers hosted on AWS's managed orchestrator.

- \+ Natural fit for long running services. API stays warm, workers scale on queue size.
- \+ No server lifecycle to manage. AWS handles scaling.
- \+ System is at correct complexity level and scale for this compute model.
- \- Less low-level control than EC2.
- \- Per-task pricing exceeds EC2 at sustained high load but not relevant at this scale.

### 2. EC2 (self managed)

VMs running the services directly or with manual orchestration.

- \+ Full control and cheapest sustained compute.
- \- Server lifecycle management becomes our problem.
- \- Container parity with local dev environment still needed as we're now orchestrating manually.

### 3. EKS

Managed Kubernetes.

- \+ Full k8s ecosystem with portability.
- \- Solves problems we don't have, like multi team scheduling, service mesh and fleet scale.
- \- Higher compute cost.
- \- Adds disproportionate operational surface for a handful of required services (control plane, node groups, networking and upgrades).

### 4. Lambda functions

Serverless functions per request/message.

- \+ Zero infrastructure to maintain.
- \+ Auto scales and cost is per invocation, scales to zero.
- \+ Best fit for sparse event driven work.
- \- Workers move up to 1 GB files and the 15 min timeout causes real limits during fetch, checksum and delivery.

## Decision

**Option 1.**

Long running services without VM ownership. Lambda's timeout conflicts with worker file delivery. EKS and EC2 buy control and flexibility this system doesn't use at current scale. An application load balancer fronts the containers as the single public entry point. API Gateway was considered; its edge token validation and throttling aren't needed in R1.

**Ratified by:** Awaiting review
