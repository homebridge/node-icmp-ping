# Releases and npm distribution

No npm package has been published. Build and test CI never publishes, and creating a GitHub Release does not automatically trigger publication.

The napi-rs CLI creates six platform packages, collects the native artifacts, and supplies the generated loader. The root package declares exact-version optional dependencies. Platform packages contain the appropriate `.node` binary; the assembled root package does not bundle every architecture. There is no custom downloader or install-time compilation script.

`Build and test` builds on native architecture runners, tests each artifact on Node 22/24/26, exercises privileged loopback Echo, and validates seven npm tarballs. The assembly job installs the root tarball and platform tarballs in a clean temporary project with install scripts disabled, then loads and runs real IPv4/IPv6 Echo. Linux timeout tests operate in an isolated network namespace, never changing the host firewall.

Before a first publication, establish ownership of the unscoped root and all six platform package names and configure npm trusted publishing for each package. npm's first-package/bootstrap ownership and trusted-publisher setup must be completed separately; a registry 404 does not guarantee a name is available for publication. Do not add a long-lived token as a workaround.

Configure the npm trusted publisher to use repository `justjam2013/node-icmp-ping`, workflow `publish.yml`, and environment `npm-production`. Configure that GitHub environment with required reviewers before enabling publication. No environment protection or npm trust has been configured by this task. Publication still requires explicit user authorization.

Release procedure:

1. Update npm and Cargo versions and lockfiles together; push and require green CI.
2. After separate approval, create an exact `v<version>` tag and matching non-draft GitHub Release. Its prerelease flag must match whether the version includes a prerelease suffix.
3. Dispatch `Prepare or publish npm release` on that exact tag, entering the same release tag. Leave `publish` false to validate and assemble without publishing.
4. Review the generated distribution and all target runtime results.
5. After separate publication approval, dispatch with `publish` true and approve the protected environment. The workflow validates tag/version/SHA and release metadata, rebuilds and retests all targets, checks tarballs, then publishes platform packages before the root using npm OIDC and provenance. Stable versions use `latest`; prereleases always use `next`.

The workflow uses Node 24 and npm 11.19.1 for trusted publishing. All seven package trust relationships are required. A partial platform publish cannot be rolled back; investigate and complete the remaining packages at the same version before publishing the root. No publication credentials are stored in this repository.
