# Releases and npm distribution

One public npm package, `@homebridge/node-icmp-ping`, contains all six native binaries. Build and test CI never publishes. Creating a GitHub Release does not automatically publish to npm. Publication and live npm trust configuration remain separate operator steps.

## Package contents and assembly

The pinned napi-rs CLI still builds the addon with N-API 9 and generates `binding.js`. Its platform/architecture/libc selection is retained verbatim. The binaries live beside that loader at the package root, where it already searches:

| Target | Bundled file |
| --- | --- |
| Linux glibc x64 | `icmp_ping.linux-x64-gnu.node` |
| Linux glibc arm64 | `icmp_ping.linux-arm64-gnu.node` |
| macOS x64 | `icmp_ping.darwin-x64.node` |
| macOS arm64 | `icmp_ping.darwin-arm64.node` |
| Windows MSVC x64 | `icmp_ping.win32-x64-msvc.node` |
| Windows MSVC arm64 | `icmp_ping.win32-arm64-msvc.node` |

The public CommonJS and ESM API stays unchanged. `index.js` delegates to the generated loader and adds a distribution-specific error with the original error as its cause. There is no separate platform selector, binary downloader, or install-time compilation. musl and other targets remain unsupported. Upstream's generated optional-package probes remain in the loader, but no platform packages are declared, installed, assembled, or published; supported installations load the adjacent binary. Loader tests cover all six selections, musl filesystem/report detection, unsupported targets, and missing binaries.

`Build and test` builds on all six native runners. It tests each build on Node 22/24/26 and exercises real privileged IPv4/IPv6 loopback Echo before uploading a `bindings-<Rust target>` artifact containing the binary and generated loader. Assembly requires exactly these six artifacts, nonempty binaries, and identical generated loaders matching the reviewed `binding.js`. A generator/version change that changes this file requires regeneration and review before CI passes.

Assembly copies the tested binaries into the root without rewriting the manifest, then runs `npm pack --ignore-scripts` once. The exact tarball is inspected for the expected identity, version, public access, entry points, six binary files, no runtime dependencies, and no install hooks. Each packed binary must equal its original tested input. Development sources, scripts, tests, and build output are excluded. The published files are the manifest, three API files, loader, README, license, two documents, and six binaries (15 files).

The retained `npm-distribution` artifact contains only:

- `homebridge-node-icmp-ping-<version>.tgz`
- `integrity.json`: package name, version, filename, and SHA-512 SRI of the complete compressed tarball

The checksum record detects a mismatch against the retained assembly output; it is not a signature or a substitute for GitHub artifact/run provenance. Retain both files and the originating run, commit, and tag together. Assembly refuses a nonempty output directory to prevent accidental replacement of a retained distribution.

After assembly, 18 install jobs (six target runners × Node 22/24/26) download that same artifact. Every job verifies its retained SHA-512 and exact contents, installs offline with `--ignore-scripts`, checks the installed version and lockfile integrity, confirms there are no separate runtime packages, loads CommonJS/ESM, validates arguments, and runs real IPv4/IPv6 Echo with the required privileges. Permission failures fail the job. The reusable workflow completes only after all install jobs pass; publication depends on its completion. Linux timeout tests remain isolated in network namespaces.

For local assembly, download all six binding artifacts into `artifacts/` with their original directory names, then run:

```sh
node scripts/assemble.js
npm run package:check
node scripts/test-install.js
```

The last command requires raw-socket privileges (passwordless `sudo -n` on Unix, or an elevated process; Windows CI runs as Administrator). A local single-target build is sufficient for `npm test`, but is deliberately insufficient for release packaging. `package:check` inspects the retained distribution, not a dry-run of the working tree.

## One-time beta bootstrap

The prepared version is `0.9.0-beta.1`, tag `v0.9.0-beta.1`, a GitHub prerelease and npm `next` release. Unsuffixed versions use `latest`; major zero alone does not imply a prerelease. Preparing these changes creates no tag, release, or npm publication.

1. Merge only after review and green CI, including all 18 final-tarball install jobs. Have Homebridge npm administrators confirm permission to create/publish **only `@homebridge/node-icmp-ping`**, with the required organization/team access and 2FA. Verify the GitHub `npm-production` environment has the intended reviewers and deployment restrictions. Repository ownership and a registry 404 do not establish npm publishing rights. Arrange authenticated manual access separately; do not store publication credentials in the repository.
2. After release approval, create the exact tag on the reviewed commit and matching non-draft GitHub Release with `prerelease: true`. Dispatch `Prepare or publish npm release` on that tag with the same `release_tag` and **`publish: false`**. Prepare-only still validates the tag, commit, version, and release metadata.
3. Review all target/runtime results. Retain the original `npm-distribution` artifact and its workflow run, tag, and commit SHA before retention expires. Keep the two files together in `distribution/` at the matching checkout. Run `npm run package:check` and inspect the contents, attribution, and `integrity.json`. Keep an independent copy of the recorded SRI with your release records. Do not rebuild or repack for publication or recovery.
4. After publication approval, perform the one-time authenticated manual bootstrap from that retained file:

   ```sh
   npm publish distribution/homebridge-node-icmp-ping-0.9.0-beta.1.tgz --registry https://registry.npmjs.org/ --access public --tag next --provenance=false
   ```

   Manual bootstrap outside supported CI must not request or claim automatic OIDC provenance. See npm's [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/). Do not run the OIDC publisher locally; it requests provenance. Do not overlap manual and workflow publication; the workflow concurrency lock cannot serialize manual commands.
5. Before any publication attempt, record existing dist-tags from a fresh registry packument (or confirmed package absence). The `lookup` helper returns null for an absent exact version and cannot establish that baseline alone. Read the exact version using `lookup(item)` below; if present, require `verify` to pass and skip the mutation. Immediately after **every** publish attempt, including errors, rerun this read-back against the original retained artifact:

   ```sh
   node - <<'NODE'
   const { preflight, lookup, verify } = require('./scripts/publish.js');
   (async () => {
     const item = preflight('distribution', 'next');
     const state = await lookup(item);
     verify(item, state);
     console.log(state.tags);
   })().catch(error => { console.error(error); process.exitCode = 1; });
   NODE
   ```

   Matching package name, version, SHA-512 `dist.integrity`, and `next` tag are required. Check that `latest` did not move to this beta and any prior `latest` remains unchanged; for a new package it should remain absent. Stop on any mismatch or registry failure; never blindly retry or automatically repair tags.
6. Install `@homebridge/node-icmp-ping@next` in a clean project with scripts disabled; check the version, CommonJS/ESM API and real IPv4/IPv6 Echo on the supported matrix. Recheck integrity and dist-tags.
7. Configure one [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) for `@homebridge/node-icmp-ping`: repository `homebridge/node-icmp-ping`, workflow `publish.yml`, environment `npm-production`, permitting direct `npm publish`. Confirm protected-environment reviewers and restrictions. No native-package trust relationships are needed. These settings must be verified externally; this repository change does not configure or verify live npm trust.

If platform packages were already created during an earlier bootstrap, leave them alone and investigate their status separately. This distribution does not depend on them and does not publish or delete them.

## Future releases through protected GitHub OIDC

1. Update npm and Cargo versions and lockfiles together, regenerate the loader with the pinned CLI, push and require green CI.
2. After approval, create an exact `v<version>` tag and matching non-draft GitHub Release. Its prerelease flag must match the version suffix.
3. Dispatch the publish workflow on that exact tag with the same release tag. A prepare-only dispatch validates and assembles without publishing.
4. After publication approval, dispatch with `publish: true`. This new dispatch builds and tests a new candidate; review its retained artifact and all test results before approving the protected environment. It is not a way to publish a previous prepare-only artifact.
5. The protected job uses Node 24 and npm 11.19.1, verifies the retained tarball and record, and publishes that one file using OIDC and provenance. Prereleases use `next`, stable versions `latest`. It performs fresh registry read-back before accepting success.

Tag/commit/version/channel validation, public scoped access, protected environment, OIDC permissions, and the publication concurrency group are retained. There is no native-before-root ordering or cross-package recovery.

## Publication recovery

The publisher verifies the retained SHA-512 and tarball contents before registry access. An existing exact version is accepted only when its canonical SHA-512 `dist.integrity` equals the original compressed bytes and the intended `next` or `latest` tag points to that version. Missing/malformed/unsupported integrity, mismatched identity or bytes, dist-tag drift, and registry failures stop publication. Tags are never automatically repaired.

Every publish attempt is followed by fresh registry read-back, even when npm reports failure: the registry may have committed the package before the client lost the response. There are no blind mutation retries. Publication jobs share one concurrency group across refs and channels and never cancel an in-progress publication.

Recover by rerunning only the failed **publish job in the original workflow run**, while its original `npm-distribution` artifact remains available. Do not rerun build jobs or dispatch a new workflow to recover. Native builds are not established to be byte-reproducible, and rebuilding/repacking may produce different bytes. Preserve the original artifact and checksum record before retention expires; stop and investigate any integrity difference. A retry with an already-published matching package and matching dist-tag succeeds without republishing. Manual bootstrap recovery uses the same retained artifact and verification procedure, with separately authorized authenticated access.
