# ADR-20: Infrastructure defined with AWS CDK in TypeScript

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

ADR-01 and ADR-02 settle AWS and ECS Fargate. The spec requires deployment to be fully automated with nothing manual beyond initial credentials. The project is written in TypeScript.

## Decision required

Which tool defines the cloud infrastructure?

## Alternatives evaluated

### 1. AWS CDK in TypeScript

Infrastructure as TypeScript code, synthesised to CloudFormation.

- \+ Same language as the apps, typed constructs.
- \+ L2 constructs for ECS, ALB, RDS, S3 and SQS cover everything in the architecture diagram.
- \+ Lives in the monorepo next to the services it deploys (ADR-19).
- \- CloudFormation underneath: slow deploys, occasional drift.
- \- AWS only, consistent with ADR-01.

### 2. Terraform

Industry standard IaC with its own language.

- \+ Multi cloud and the broadest ecosystem.
- \- A second language (HCL) and a state backend to run.
- \- Multi cloud buys nothing after ADR-01.

### 3. Raw CloudFormation / SAM

YAML templates directly.

- \+ No abstraction layer to learn.
- \- Verbose, no abstraction, no reuse.

## Decision

**Option 1.**

One language across apps, shared packages and infrastructure keeps the whole system legible to the same engineers. We accept CloudFormation's deploy speed and drift risk in exchange for typed constructs in the project's language.

**Ratified by:** Awaiting review
