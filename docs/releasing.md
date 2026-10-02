# Releasing

## Prepare a version PR

With a supported Node version installed, prepare an explicit version:

```sh
npm run prepare-version -- 1.0.1
git diff
```

The command updates only `package.json`, both root version entries in
`package-lock.json`, `Cargo.toml`, and the root package in `Cargo.lock`.
It requires neither installed npm dependencies nor Rust and does not generate
build outputs. Stable versions and prereleases such as `1.1.0-beta.1` are accepted.
Use the exact version without a `v` prefix; ranges, bump keywords, and build
metadata (`+...`) are rejected to match the release policy. Invalid arguments
change nothing.

Review the diff, commit the four version files, push your branch, and open a PR.
The command leaves changes unstaged and uncommitted; it never pushes, tags,
creates releases, or publishes. The name `prepare-version` avoids npm's reserved
`version` lifecycle hook: do not use `npm version`, which has its own commit/tag
behavior, for this process. Merge the reviewed version PR only after CI passes.

## Generated build artifacts

For local development, install dependencies with `npm ci`, then run
`npm run build` before `npm test`, `npm run test:release`, or runtime use.
Building requires Rust stable and the platform linker/SDK. Every build validates
the authoritative versions and uses pinned `@napi-rs/cli` and locked Cargo
dependencies to generate `binding.js` together with the host native binary.
Rebuild after source or version changes. There are no stale-file checks or
version-triggered generation rules. `binding.js` and native binaries are ignored
build/package artifacts: never edit or commit them. Generated declarations are
temporary; the reviewed public API remains `index.d.ts`.

CI uses the same `npm run build -- --target <target>` path on each native host.
Dependency installation, version preparation, and retained-tarball inspection
work without a source-checkout loader. Tests and application imports naturally
require a build first. Plain `npm pack` does not build native artifacts: use the
assembly command below for a complete package, which requires all eight targets.

## Publish the intended release

Create the GitHub Release with tag `v<package version>` at the reviewed commit on
`main`. Mark suffixed versions such as `1.1.0-beta.1` as prereleases (`next`);
unsuffixed versions use `latest`. Inconsistent tag, version, commit, or prerelease
metadata stops the workflow.

`publish.yml` validates the release, invokes `native.yml`, and publishes only after
all native and installed-package tests pass. Keep the Trusted Publisher configured
for `homebridge/node-icmp-ping`, workflow `publish.yml`, environment `npm-production`.
Publication uses OIDC, provenance, and public access. No npm token or publication
dispatch is needed. Publication concurrency is shared across channels and refs and
never cancels an in-progress publication.

## Build once, test and publish the retained bytes

The eight native targets remain Linux x64/arm64 glibc and musl, macOS x64/arm64,
and Windows x64/arm64. Musl builds and tests run in native Alpine containers on
matching hosts. Builds exercise the native API, real ICMP, resource behavior, and
supported Node versions; Linux loss tests use isolated network namespaces.

Assembly requires all eight native build artifacts from the same commit/run.
Each contains its binary and freshly generated loader. napi-rs generates a
platform-independent loader from the package name/version and native exports;
assembly always copies the loader from `bindings-x86_64-unknown-linux-gnu` along
with all eight binaries. This fixed choice does not depend on download order or
any existing local loader. It packs once, checks the manifest and exact file
inventory, and compares packed loader and binary bytes with the tested inputs. It retains `npm-distribution` containing only:

- `homebridge-node-icmp-ping-<version>.tgz`
- `integrity.json` with name, version, filename and the complete tarball's SHA-512

The hash detects changed bytes; it is not a signature. Preserve the artifact with
its originating workflow run, commit, and tag. Assembly refuses a nonempty output
directory. Native builds are not guaranteed to reproduce identical tarball bytes.

All 24 install jobs (eight targets × Node 22/24/26) download and verify this exact
artifact, install offline with scripts disabled, check package/lockfile identity,
load CommonJS and ESM, and run IPv4/IPv6 Echo. Linux jobs verify the actual libc and
loaded binary; musl tests cannot silently exercise glibc. These tests require raw
socket privileges and fail on permission errors.

For local assembly, download the eight binding artifacts into `artifacts/` under
their original names, then run `node scripts/assemble.js`. To inspect a downloaded
artifact run `npm run package:check`; to install/test it run
`node scripts/test-install.js` (elevated Windows or passwordless `sudo -n` on Unix).
A single-target local build is sufficient for `npm test`, but not release assembly.

## Failures stop for investigation

Immediately before publication, the job rechecks live release identity and tag/commit
state, then verifies the downloaded tarball's SHA-512 and contents. It uses an
absolute tarball path. An already-published exact version succeeds without mutation
only when registry name, version, SHA-512 integrity and intended dist-tag all match.

The publisher invokes `npm publish` at most once per run. Even a failed client
response can follow a committed publication, so fresh registry state determines
success. An absent post-publish version is read again after 2, 4, 8 and 16 seconds
(five reads total). Each request has its own 30-second timeout; the backoff is not
an overall deadline. Visible identity, integrity or dist-tag mismatches and lookup
errors fail immediately. Exhaustion fails clearly. Nothing repairs dist-tags.

Preserve the original artifact and investigate a failed or ambiguous publication
before deciding what to do next. Do not rebuild/repack a possibly published version
or recreate its release/tag to make a check green. If the publisher is correct and
the original artifact remains available, a maintainer can rerun only the failed
publish job in that original run after investigation; it repeats validation and
checks for an existing exact publication first. A rerun executes the original
workflow code, not newer fixes on main. Expired artifacts or publisher defects
require a separately reviewed decision, not an automated historical recovery path.

Loader/version errors must be corrected in a reviewed PR before an intended release.
Automation never repairs branches, moves tags, or repairs historical releases.
