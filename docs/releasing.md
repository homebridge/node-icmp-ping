# Releases and npm distribution

No npm package has been published. Build and test CI never publishes, and creating a GitHub Release does not automatically trigger publication.

The napi-rs CLI creates six platform packages, collects the native artifacts, and supplies the generated loader. The root package declares exact-version optional dependencies. Platform packages contain the appropriate `.node` binary; the assembled root package does not bundle every architecture. There is no custom downloader or install-time compilation script.

`Build and test` builds on native architecture runners, tests each artifact on Node 22/24/26, exercises privileged loopback Echo, and validates seven npm tarballs. The assembly job installs the root tarball and platform tarballs in a clean temporary project with install scripts disabled, then loads and runs real IPv4/IPv6 Echo. Linux timeout tests operate in an isolated network namespace, never changing the host firewall.

The first public release is `0.9.0-beta.1` (tag `v0.9.0-beta.1`): a GitHub prerelease and npm `next` release. The existing suffix-based policy is unchanged: future unsuffixed `1.0.0` uses `latest`; major zero alone does not imply a prerelease. Preparing this repository change does not create a tag, GitHub Release, or npm publication.

## One-time beta bootstrap

1. Merge the version preparation PR only after green CI and review of all six native targets and seven package contents. Confirm the npm account can publish the unscoped root and all six platform names; a registry 404 does not guarantee availability. Arrange authenticated manual npm access (including required 2FA) separately. Do not store publication credentials in the repository or add a long-lived CI token as a workaround.
2. After separate release approval, create the exact `v0.9.0-beta.1` tag on the reviewed commit and a matching non-draft GitHub Release with `prerelease: true`. Dispatch `Prepare or publish npm release` on that exact tag with the same `release_tag` and **`publish: false`**. Prepare-only still requires the tag and release metadata; it performs no npm publication.
3. Review all target/runtime results. Download and retain the original `npm-distribution` artifact, recording the workflow run, tag, commit SHA, and a SHA-512 SRI manifest of the exact seven compressed `.tgz` files. Keep the tarballs together in `distribution/` at the matching checkout. The following is read-only apart from writing the manifest; it does not publish:

   ```sh
   node - <<'NODE' > beta-tarballs.json
   const { preflight } = require('./scripts/publish.js');
   console.log(JSON.stringify(preflight('distribution', 'next').map(
     ({ name, version, channel, tarball, integrity }) =>
       ({ name, version, channel, tarball, integrity })
   ), null, 2));
   NODE
   ```

   Review package names, exact versions, root optional dependencies, licenses/attribution, and file listings. Retain the manifest outside the distribution along with the original artifact before retention expires. Do not rebuild or repack these files for publication or recovery.
4. After separate publication approval, perform the one-time authenticated **manual** bootstrap sequentially: all six native tarballs first, then the root. For each retained tarball, use `npm publish <exact-retained-tarball> --registry https://registry.npmjs.org/ --access public --tag next --provenance=false`. Do not run the OIDC publisher locally: it requests provenance. Manual bootstrap outside supported CI must not request automatic provenance or claim an OIDC provenance attestation. See npm's [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
5. Before each mutation, record the existing dist-tags from a fresh registry package-metadata read (or confirmed package absence); `lookup` returns null for an absent exact version, so it cannot supply that baseline on its own. Read the exact version with the exported `lookup(item)` helper, using the retained manifest entry. If the exact version already exists, require `verify(item, state)` to pass before skipping it. Immediately after **every** publish attempt (even an error), read back and verify the exact package name, `0.9.0-beta.1` version, SHA-512 `dist.integrity` against the retained tarball, and `next` tag. Also inspect `state.tags.latest`: it must not point to this beta, and any previously existing `latest` must remain unchanged (for a new package it should remain absent). Stop on any mismatch, unexpected tag, or registry failure; do not blindly retry or automatically repair tags. Only publish or accept the root after all six natives have passed verification. Do not overlap this manual bootstrap with any other publication; the workflow concurrency lock cannot serialize local manual commands.
6. In a clean temporary project, install `node-icmp-ping@next` from npm with install scripts disabled, verify the installed root and selected native package are exactly `0.9.0-beta.1`, load the CommonJS and ESM API, and exercise real IPv4/IPv6 loopback Echo with the required privileges. Repeat on the supported target/runtime matrix before treating the beta as validated. Recheck all seven packages' integrity and dist-tags; `latest` must not have been unintentionally assigned.
7. Once all seven packages exist and bootstrap verification succeeds, configure a [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) for **each** package: repository `justjam2013/node-icmp-ping`, workflow `publish.yml`, environment `npm-production`. Confirm the protected GitHub environment still requires its reviewer (`justjam2013`). All seven trust relationships are required before future publication via protected GitHub OIDC; do not configure only the root.

For partial manual bootstrap recovery, reuse the original retained tarballs and manifest and apply the same preflight/read-back checks. Native builds are **not established to be byte-reproducible**. A fresh prepare-only dispatch may produce different bytes and is not a substitute for retained artifacts. Stop and investigate integrity differences. Do not dispatch `publish: true` merely to finish this bootstrap: that dispatch rebuilds the packages.

## Future releases through protected GitHub OIDC

Release procedure:

1. Update npm and Cargo versions and lockfiles together; push and require green CI.
2. After separate approval, create an exact `v<version>` tag and matching non-draft GitHub Release. Its prerelease flag must match whether the version includes a prerelease suffix.
3. Dispatch `Prepare or publish npm release` on that exact tag, entering the same release tag. Leave `publish` false to validate and assemble without publishing.
4. Review the generated distribution and all target runtime results.
5. After separate publication approval, dispatch with `publish` true and approve the protected environment. The workflow validates tag/version/SHA and release metadata, rebuilds and retests all targets, checks tarballs, then publishes platform packages before the root using npm OIDC and provenance. Stable versions use `latest`; prereleases always use `next`.

The workflow uses Node 24 and npm 11.19.1 for trusted publishing. All seven package trust relationships are required. A partial platform publish cannot be rolled back; investigate and complete the remaining packages at the same version before publishing the root. No publication credentials are stored in this repository.

Publication recovery:

The publisher preflights all seven retained tarballs, hashes the complete compressed `.tgz` bytes with SHA-512, and reads fresh npm registry metadata. An existing exact version is skipped only when its canonical `dist.integrity` matches those bytes and the expected `latest` or `next` tag points to that version. Missing or unsupported integrity, integrity mismatch, tag drift, and registry failures deliberately stop publication and require investigation; tags are never automatically repaired.

Every publish attempt is followed by a fresh registry read-back, including attempts where npm reports failure: the registry may have committed the package before the client lost its response. Only matching version, integrity, and tag establish success. There are no blind retries. All six native packages must be verified before the root is published or accepted as complete. Publication jobs share one concurrency group across refs and channels, without cancelling an in-progress publication.

After partial publication, the safest recovery is to rerun the failed **publish job** in the original workflow run while its original `npm-distribution` artifact is retained. Do not rerun the build jobs. Save the original distribution artifact for investigation/recovery before retention expires. A new workflow dispatch rebuilds and repacks packages; fresh native builds are not established to be byte-reproducible and may differ from already published tarballs. If integrity differs, stop and investigate rather than accepting version existence or replacing the original artifacts. A retry with all seven matching packages succeeds without republishing any package.
