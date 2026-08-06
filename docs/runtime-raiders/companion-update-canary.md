# Runtime Raiders two-sequence update canary

Status: **pending — no signing, publication, installation, live provider use,
or office activation is authorized by this record.**

Use this after the server cutover runbook and companion operations runbook. Keep
collection persistently off except for the single separately authorized bounded
step below. Record aggregate status/timestamps only. Never record prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments.

## Required order

1. build/sign/notarize/staple sequence 1 from its exact clean SHA;
2. separately approve Caddy route preparation and sequence-1 publication;
3. install sequence 1 with collection persistently off;
4. commit `companion/RELEASE` version `0.2.1`, sequence `2`, producing a new SHA;
5. rebuild/review/sign and separately approve sequence-2 publication;
6. observe one notification and matching `raiders status` availability;
7. run `raiders update` manually and verify signing, version, sequence, daemon health, disabled state, enrollment, cursors, and outbox;
8. confirm no second notification for sequence 2;
9. separately authorize a bounded `raiders on` canary;
10. complete one official Codex Desktop root Run and one Codex CLI root Run;
11. verify `codex_desktop` and `codex_cli`, content-free storage, Raid Power, model, and effort; and
12. run `raiders off` before seeking separate office activation.

Steps 1–8 do not authorize step 9. The sequence-2 manifest and ZIP are never
executed or piped; only the installed signed player runs `raiders update`.
Step 11 verifies official surface classification, not a provider claim derived
from display fields: model and effort are display-only and Raid Power is the
scoring result.

## Acceptance and rollback

At each step retain only pass/fail/pending, aggregate count, release sequence,
and UTC timestamp in the restricted operator record. A malformed manifest,
unexpected notification behavior, invalid signature, failed health check,
unexpected collection state, content-bearing record, or wrong surface is a
NO-GO: run `raiders off`, do not advance, and use the signed updater's rollback
or the separately authorized release withdrawal as applicable. Neither action
authorizes an office rollout.
