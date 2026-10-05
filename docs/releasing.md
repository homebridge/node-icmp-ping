# Releasing

## Edit the version manually

Update the package's version in these four files so they agree:

- `package.json`: top-level `version`.
- `package-lock.json`: top-level `version` and `packages[""].version`.
- `Cargo.toml`: `[package].version` for `node-icmp-ping`.
- `Cargo.lock`: `version` in the `[[package]]` entry named `node-icmp-ping`.

Leave dependency versions alone. Do not rebuild either lockfile merely for a
version bump; edit the existing entries. No version-editing command is needed.
Run `node scripts/check-versions.js` for a read-only check, inspect `git diff`,
then commit and push normally for review. CI prints every value if they disagree.

## Generated build artifacts

For local development:

```sh
npm ci
npm run build
npm test
npm run test:release
```

Building requires Rust stable and the platform linker/SDK. Every normal build
checks the four version files and generates `binding.js` and the host native
`.node` binary with the pinned napi-rs generator and locked Cargo dependencies.
Rebuild after source or version changes. `binding.js` and prebuilds are ignored
artifacts: never hand-edit or commit them. Generation errors stop the build.
Public API declarations remain in the reviewed `index.d.ts`.

## Package contents and assembly

CI checks versions, formatting, Clippy and Rust tests, then builds eight targets:
Linux x64/arm64 glibc and musl, macOS x64/arm64, and Windows x64/arm64.
Musl builds use native Alpine containers on matching hosts; no emulation is needed.

Assembly downloads those build artifacts from the current workflow run, checks
that all eight binaries and the generated loader exist, and names missing files
on failure. The platform-independent loader comes from the Linux x64 glibc build.
It packages that loader and all eight binaries with the public entry points,
declarations, manifest, license and documentation. A basic check requires a
nonempty tarball containing all expected files. No custom checksum record or
registry integrity subsystem is maintained; npm and Actions handle their own
standard transport checks.

`npm-distribution` contains the assembled `.tgz`. Four Node 26 smoke jobs install
it offline with install scripts disabled: Linux glibc x64, Alpine musl x64,
macOS arm64 and Windows x64. They load CommonJS and ESM and run API, IPv4/IPv6
loopback ICMP and resource tests. Linux checks the actual libc and selected binary.
Other architectures receive build, presence and package-content verification.
Node 22/24 remain supported but are not repeated in CI; Node 26 is the newest
supported version and the compatibility frontier.

For local assembly, download the eight `bindings-<target>` artifacts into
`artifacts/`, then run `node scripts/assemble.js`. Plain `npm pack` does not build;
a single-target local build is not an all-platform distribution. Inspect the
assembled tarball with `npm run package:check`; run installed-package tests with
`node scripts/test-install.js`. ICMP tests require elevated Windows privileges or
passwordless `sudo -n` on Unix (containers run as root with `NET_RAW`). Permission
errors fail rather than skip tests. No external Internet ping target is needed.

## Publish with a GitHub Release

Create and publish a GitHub Release at the intended source commit after review.
The `release: published` event runs the same build/package/smoke pipeline and,
after it passes, `publish.yml` publishes the assembled tarball once.

The GitHub **Set as a pre-release** checkbox alone selects the npm channel:

- Unchecked: `npm publish --tag latest`.
- Checked: `npm publish --tag beta`.

This follows the routing in `homebridge-virtual-accessories`. The package version
suffix does not select or constrain the channel. The GitHub tag need not equal
the package version: publishing package `1.0.1` from release `v1.0.2` is allowed.
The four source package versions must still agree with each other.

Keep npm Trusted Publisher configured for `homebridge/node-icmp-ping`, workflow
`publish.yml`, environment `npm-production`. Publication uses OIDC, provenance
and public access. Only the publish job receives `id-token: write`. Shared
publication concurrency does not cancel an in-progress publish. No npm token
or release workflow dispatch is required.

## Publication failures

Exactly one of the two conditional publication steps runs, invoking npm once.
Exit zero succeeds; a nonzero exit surfaces npm's error and fails the job. There
is no automatic publication retry, registry read-back/polling, dist-tag repair,
release-policy inference or post-publication custom integrity verification.

On failure, inspect the error and the npm registry manually before taking any
further action. A failed client response can occur after npm accepted a publish.
A manual rerun attempts publication again; it is not an automatic recovery or an
idempotent registry check. The maintainer decides the next action after checking
npm state. Automation does not edit versions, move tags or repair releases.
