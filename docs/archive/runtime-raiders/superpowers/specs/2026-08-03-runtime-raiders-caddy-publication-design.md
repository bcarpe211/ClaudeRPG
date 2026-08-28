# Runtime Raiders Caddy Artifact Publication Design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

**Date:** 2026-08-03

**Status:** Approved design; implementation complete; every live action remains pending separate approval

**Scope:** Fail-closed hosting and atomic publication of the signed Runtime
Raiders macOS companion quartet on the existing internal Caddy service.

## Goal and fixed contract

Caddy serves no companion file until a root-only atomic selector chooses one
reviewed release. The fixed root is `/var/lib/runtime-raiders`; preparation
leaves `current` absent, so all four paths return plain `404`:

| Store file | HTTPS path |
| --- | --- |
| `install.sh` | `/install.sh` |
| `downloads/runtime-raiders-agent.zip` | `/downloads/runtime-raiders-agent.zip` |
| `downloads/runtime-raiders-agent.zip.sha256` | `/downloads/runtime-raiders-agent.zip.sha256` |
| `downloads/runtime-raiders-agent.update.json` | `/downloads/runtime-raiders-agent.update.json` |

Each exact handler has `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`; the installer, ZIP, checksum, and manifest
have their respective shell, ZIP, text, and JSON content types. No directory
index, wildcard, extra host, extra proxy, or artifact route through Node is
allowed. The remaining site traffic continues to `localhost:8080`.

## Immutable releases and publication

The root-owned store contains `releases/<40-lowercase-hex SHA>/`, each with
`install.sh`, the three download files, and root-only `.release-manifest`.
Directories are nonsymlink root:root `0755`; published files are nonsymlink
root:root `0644`; the private manifest is root:root `0600`. `current` is the
only root-owned relative symlink and is atomically replaced.

Legacy v1 release manifests remain readable for status, withdrawal, and safe
recovery. New updater-capable releases use v2 and record the exact release SHA,
positive safe `release_sequence`, bounded `companion_version`, protocol `1`, and
four SHA-256 values. Existing releases are immutable. A v2 sequence cannot be
duplicated or move backward; a withdrawn release stays on disk for inspection
and may be reselected only by a separately approved valid publication.

`scripts/pi/runtime-raiders-artifacts.sh publish` requires all approved values:

```text
--source DIR --release-sha SHA --release-sequence SEQUENCE
--companion-version VERSION --installer-sha256 SHA256 --zip-sha256 SHA256
--checksum-sha256 SHA256 --update-manifest-sha256 SHA256
```

It accepts exactly the quartet, validates four digests, the canonical ZIP
checksum, and the canonical static manifest. The manifest must bind the fixed
ZIP URL, ZIP digest, SHA, sequence, version, and protocol. It stages and
revalidates the files, writes the v2 release manifest, atomically creates the
immutable directory, then atomically selects it. `status` is content-free:
`unpublished` or active SHA, sequence/version/protocol, and digests.

`withdraw --release-sha SHA` only removes a selector that targets that exact
SHA. It is intentionally available if selected bytes are damaged, because it is
the fail-closed recovery action. Withdrawal makes all four URLs `404`, preserves
immutable files, and neither reloads Caddy nor restarts Node.

## Required authority and acceptance

1. Separately authorize Caddy preparation: validate/reload the reviewed config,
   retain the backup, require both health endpoints `200`, all four artifact
   paths `404`, and an absent selector.
2. After server acceptance, separately authorize sequence-1 quartet publication
   and independently verify four HTTP `200` responses, four recorded digests,
   `no-store`, `nosniff`, and health.
3. Separately authorize the locally downloaded, installer-digest-verified,
   persistently-off sequence-1 canary.
4. Separately authorize sequence-2 build/review/publication, manual
   `raiders update` proof, a bounded live provider canary, and office activation
   in that order. No step implies the next.

The update manifest is never executed. While collection is off, discovery is
only an anonymous static GET to this trusted game-server manifest URL; it adds
no provider telemetry. The public record holds aggregate status/timestamps,
digests, release data, headers, and health only—never artifacts, paths,
prompts, responses, native IDs, tokens, credentials, or provider fragments.

## Failure behavior and non-goals

Caddy preparation failure restores the recorded configuration and leaves the
selector absent. Publication failure preserves the old selector (or no
selector). A digest/header/health failure withdraws the exact active SHA before
any separately authorized server/Caddy rollback. No build, push, pull, Caddy
reload, or cutover automatically publishes. No publication installs, updates,
or enables a companion. A branded 404 page is deferred and is not a release
dependency.
