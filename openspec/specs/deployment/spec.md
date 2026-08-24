# deployment Specification

## Purpose
Specifies the production deployment behavior of the workspace app on Vercel: how it serves users, where data persists, and what must hold true for a deployment to be considered working.

## Requirements

### Requirement: Hosted availability

The system SHALL be reachable at its Vercel production URL over HTTPS and serve the workspace UI.

#### Scenario: First visit

- **WHEN** an unauthenticated user opens the production URL
- **THEN** the app loads and prompts for the workspace password

### Requirement: Durable storage in production

The deployed app SHALL persist all documents, assets, index, and share metadata in the configured Cloudflare R2 bucket, never relying on serverless-local filesystem state between requests.

#### Scenario: Save survives cold start

- **WHEN** a user saves a document and a later request hits a fresh serverless instance
- **THEN** the saved content is returned unchanged

### Requirement: Password-gated access

The deployment SHALL reject unauthenticated API access to workspace data unless the request carries a valid session established with `APP_PASSWORD`.

#### Scenario: Unauthenticated API call

- **WHEN** a request without a session cookie calls a workspace API route
- **THEN** the server responds with 401 and no note data

### Requirement: Deployment health verification

The deployment SHALL expose health (`/api/health`) and storage-backend (`/api/storage`) endpoints that report the active backend as R2 when R2 env vars are configured.

#### Scenario: Post-deploy smoke test

- **WHEN** `/api/storage` is called after deploy
- **THEN** the report names the configured R2 bucket as the active backend
