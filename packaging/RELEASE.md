# Release packaging

Run `npm run release:pack` from the repository root. It recreates only
`artifacts/agent-release/`, which is ignored by Git, and then writes:

- one zero-runtime-dependency `npc-moneyhand` Skill tarball at the release root;
- the load-unpacked Chrome extension under `extension/npc-moneyhand/`;
- a deterministic extension ZIP at the release root for GitHub Release downloads;
- `release-manifest.json` and `SHA256SUMS.txt`.

The command uses `npm pack --ignore-scripts` and
`npm install --ignore-scripts --offline`, verifies every checksum, installs the Skill tarball, and
drives its CLI through the standard-library Python conformance consumer. The same lifecycle runs on
Linux, Windows, and macOS. A failure removes the confined output instead of leaving a partial
release.

The `portable-skill` workflow builds the same directory and uploads it as a CI artifact. It never
creates a GitHub Release.

The `release` workflow has two explicit publishing paths:

- pushing a version tag such as `v1.1.1` automatically verifies, builds and creates the
  matching GitHub Release;
- a manual run with `publish: false` only builds a downloadable workflow artifact; it does not
  create or modify a GitHub Release;
- a manual run with `publish: true` requires an explicit existing `release_tag`, and publishes only
  after the checked-out tag version, repository tests, package conformance and checksums all pass.

The release workflow fails when the tag does not equal `v<package.json version>`. It creates a new
release with `gh release create --verify-tag`; it does not silently replace an existing release.
Before publish, Windows, macOS arm64 and macOS Intel jobs download the exact Linux-built artifact and
run `packaged-agent-conformance --require-all`, so the MoneyHand Skill lifecycle cannot be skipped.
The flat public assets are self-contained: conformance verifies extension entries inside the ZIP;
the optional `extension/npc-moneyhand/` directory is included only in the full workflow artifact.
