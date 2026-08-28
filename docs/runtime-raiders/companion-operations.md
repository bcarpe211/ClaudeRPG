# Runtime Raiders companion operations

**Status:** Active procedure
**Audience:** Companion maintainers, support, and release operators
**Applies to:** Current local lifecycle, credential APIs, and recovery
**Last verified:** 2026-08-28

For employee onboarding and companion publication, use
[employee beta](employee-beta.md). Historical sequence and quartet material is
archived, non-authoritative, and must not be executed.

## Supported local lifecycle procedures

Employees change an installed device enrollment only with: Change Raider:
`raiders off`, then `raiders re-enroll`.

The recoverable local removal is: Remove the app but keep recovery state:
`raiders uninstall`.

The confirmed destructive local removal is: Revoke and remove every local
Runtime Raiders artifact: `raiders uninstall --everything`.

Browser login alone never changes an installed enrollment. Neither removal mode
deletes a Raider, account, Run, score, reward, or beta history. Do not prescribe
manual support-directory cleanup; a valid retained recovery journal is resumed
only by `raiders re-enroll` after collection is off.

## Server credential lifecycle boundary

The server exposes three credential-lifecycle endpoints for the supported
companion coordinator. They are protocol boundaries, not a manual account or
database recovery procedure:

- `POST /api/raiders/re-enroll` atomically consumes a one-time enrollment,
  revokes the authenticated current device, creates the client-generated
  replacement credential for the Raider selected by that enrollment, and
  records replay identity. A new operation returns `201`; an exact retry of the
  committed operation returns `200` with the same content-free collector
  configuration. Invalid enrollment or authentication returns `401`, and
  conflicting reuse returns `409`. Invalid requests return `400`, oversized
  requests return `413`, and unsupported media types return `415`.
- `GET /api/raiders/enrollment-config` recovers the content-free collector
  configuration for an active device. It returns `200` only for an active
  credential, `401` for an absent, malformed, unknown, or revoked credential,
  and `400` when a request body is supplied.
- `POST /api/raiders/devices/revoke-current` idempotently revokes the
  authenticated device. Both the first successful revocation and a retry with
  that same credential return `200` with `revoked: true`. Invalid requests
  return `400`; an absent, malformed, or unknown credential returns `401`;
  oversized requests return `413`; and unsupported media types return `415`.

Every endpoint has a separate fixed-window limit for the client IP before
request parsing and a separate authenticated-device limit after credential
lookup. Each scope permits 60 requests per 60 seconds. A limited request
returns `429` with `Retry-After`; callers wait for that bounded interval rather
than switching credentials or increasing request volume.

## Recovery after an ambiguous replacement

1. Retry the replacement credential against `enrollment-config` with bounded
   backoff.
2. If it is active, finish local configuration from that response and do not
   use the old credential again.
3. If the replacement credential remains unauthorized, probe the old
   credential with `enrollment-config`. An active old credential proves the
   transaction did not commit; obtain a fresh one-time code before submitting a
   new operation. An exact retry of an already committed replacement remains
   deterministic, but it is not a substitute for the replacement-first probe.
4. If neither credential establishes a coherent state, fail closed, preserve
   the owner-only recovery journal and both local credential materials, keep
   collection off, and resume the supported `raiders re-enroll` coordinator or
   seek assisted recovery.

Credential lifecycle never changes account or game history. Replacement may
change only enrollment, device, and replacement-operation rows; configuration
recovery is read-only; revocation changes only the current device row. Player
and Raider identity rows, Runs, Run events, scores, presence, levels, gold,
rewards, inventory, purchases, cosmetics, totals, and historical ownership are
never moved, merged, recomputed, or deleted. Queued work is not part of a
replacement request and cannot be relabeled for the target Raider.

## Status compatibility

Humans use `raiders status`. Scripts use `raiders status --json`; never parse
the human-readable output. The structured status contract remains compatible
across supported companion updates.
