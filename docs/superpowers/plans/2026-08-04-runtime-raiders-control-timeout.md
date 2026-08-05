# Runtime Raiders Control Timeout Fix Plan

**Goal:** Make `raiders on` reliably wait for safe local boundary initialization on a large existing Codex session history without weakening the short timeout for read-only interactive controls.

**Root cause:** The control client gives every request a two-second socket timeout. The daemon correctly performs `on` synchronously so it can discover provider files, capture and persist safe boundaries, start collection services, and report a real success or failure. On the first canary, that bounded local work across 627 files exceeded the generic timeout; the client failed with `EAGAIN` while the daemon was still completing the request.

**Design:** Keep the daemon's fail-closed synchronous activation contract. Give state-changing control requests (`on`, `off`, and `uninstall`) a longer but still bounded client timeout, while retaining the existing two-second timeout for `status`, `doctor`, and other fast controls. This avoids reporting activation success before boundary state and watchers are ready, preserves immediate opt-out semantics for large state files, and does not alter provider files, telemetry, scoring, server APIs, or uploaded data.

## Implementation

1. Add a real control-socket regression test whose `on` handler completes after the current two-second limit and returns `enabled`; observe it fail against the released code.
2. Add command-aware timeout selection at the existing Unix-socket client boundary with no protocol change.
3. Run the focused Swift test, the full companion Swift suite, and repository checks.
4. Review the diff for safety/privacy regressions, then commit, merge, and push the new SHA.
5. Build and verify a fresh universal signed/notarized installer triplet, record exact digests, and stop before production deployment or artifact publication for a new exact-value gate.

## Acceptance

- Slow but bounded `on` returns the daemon's actual success response instead of `EAGAIN`.
- Fast read-only commands retain their two-second failure bound.
- The installed `974d75a` canary remains persistently off during development and packaging.
- Production remains healthy and paused, updater automation remains held, and the withdrawn `974d75a` artifact URLs remain unpublished.
- No production deployment, new artifact publication, canary upgrade, or `raiders on` occurs without the next explicit gate.
