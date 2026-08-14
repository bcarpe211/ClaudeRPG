# Runtime Raiders Sequence-8 Canary Migration

## Scope decision

The privacy-preserving production aggregate contains one enrolled installation
in total. Its latest reported tuple is companion 0.2.4, release sequence 6,
update protocol 1, last seen within 0-7 days. The installed-off development
canary retained that enrollment while advancing locally to sequence 8; it did
not send a later heartbeat. There is therefore no evidence of another
sequence-8 installation or a sequence-8 fleet.

Sequence 8 is treated as a one-time canary repair. It is not a compatibility
mode in the public installer.

## Architecture

1. `companion/packaging/install.sh` handles fresh installations only. It always
   creates `$HOME/.local/bin/raiders`, never scans `PATH`, and refuses a legacy
   layout without modifying it.
2. `companion/legacy-sequence8/migrate.sh` is excluded from the public release
   quartet. It accepts only the known sequence-8 identity and observed layout.
3. Signed native code verifies the exact legacy app identity and the exact
   `/opt/homebrew/opt/libpq/bin/raiders` leaf. It validates the Homebrew parent
   chain, the recorded link target, ownership, modes, and inode identity without
   making Homebrew an allowed installation destination.
4. The transaction prepares and health-checks the immutable candidate while the
   legacy command remains intact. After a durable commit, it installs the
   canonical command and retires only the proven legacy leaf. Every precommit
   failure preserves the old installation; every postcommit interruption is
   idempotently recoverable.
5. Migration behavior is proven locally with an exact metadata fixture and
   injected failure matrix before Apple trust work. Gate 2 verifies only final
   signing, notarization, packaging, binding, launcher behavior, and a fresh
   installation smoke test.
6. Release output is always an absent immutable directory named
   `dist/sequence-<n>-<sha>`. Generic `dist/install.sh` is not release evidence.

## Checkpoints

- [x] Confirm fleet scope with a read-only aggregate containing no identifiers.
- [x] Share the installer-size contract across web, builder, Gate 2, publication,
  and tests.
- [x] Make onboarding download to an owner-only temporary file, validate it, and
  execute only after a complete successful download.
- [x] Add strict native sequence-8 layout and command-link validation.
- [x] Separate the one-time migrator from the public installer.
- [ ] Pass the complete sequence-8 success, near-match, rollback, and crash matrix.
- [ ] Pass fresh-install, onboarding, immutable-output, and documentation tests.
- [ ] Pass the full Swift and JavaScript suites twice where the local preflight
  requires repeatability.
- [ ] With separate authorization, migrate the installed-off canary and verify it.
- [ ] In the next release after successful canary migration, delete the private
  sequence-8 native route and the one-time migration package.

## Operational boundary

This implementation phase does not authorize signing, notarization, artifact
publication, Pi access or changes, installed-canary migration, `raiders on`, or
collection.
