# Releases and npm distribution

No npm package has been published. Build and test CI never publishes, and creating a GitHub Release does not automatically trigger publication.

The napi-rs CLI creates six platform packages, collects the native artifacts, and supplies the generated loader. The root package declares exact-version optional dependencies. Platform packages contain the appropriate `.node` binary; the assembled root package does not bundle every architecture. There is no custom downloader or install-time compilation script.

`Build and test` builds on native architecture runners, tests each artifact on Node 22/24/26, exercises privileged loopback Echo, and validates seven npm tarballs. The assembly job installs the root tarball and platform tarballs in a clean temporary project with install scripts disabled, then loads and runs real IPv4/IPv6 Echo. Linux timeout tests operate in an isolated network namespace, never changing the host firewall.

Before a first publication, establish ownership of the unscoped root and all six platform package names and configure npm trusted publishing for each package. npm's first-package/bootstrap ownership and trusted-publisher setup must be completed separately; a registry 404 does not guarantee a name is available for publication. Do not add a long-lived token as a workaround.

Configure the npm trusted publisher to use repository `justjam2013/node-icmp-ping`, workflow `publish.yml`, and environment `npm-production`. The GitHub environment has been configured with `justjam2013` as a required reviewer. npm trust and first-package ownership have not been configured by this task. Publication still requires explicit user authorization.

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
