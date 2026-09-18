# node-icmp-ping: reference inventory and architecture gate

Inspected 2026-09-18. No new repository or implementation has been created.

## Reference

Repository: https://github.com/justjam2013/node-net-ping

Branch: `latest`

Inspected commit: `aba84d7879ae5ea0e17cd75cf76d00c1527b1d55`

A read-only shallow reference clone was made in the task's scratch directory. The source repository was not changed. node-raw-socket was not changed.

## Reusable project structure

- Package metadata: `@justjam2013/net-ping`, version `2.0.2`, CommonJS `index.js`; author justjam2023 / Renzo Zanelli. Contributors Stephen Vickers and NoSpaceships Ltd. A new package must use its own name and repository URLs.
- License: MIT, with copyright notices for Stephen Vickers (2013), NoSpaceships Ltd (2018), and justjam2023 / Renzo Zanelli (2025–2026). The permission notice permits reuse while retaining applicable notices. Preserve these notices when carrying over project materials.
- Layout: root package metadata, README, LICENSE, HISTORY, `example/`, `.github/workflows/`, and Dependabot configuration. Adapt to `src/`, `test/`, and `examples/` for the new implementation.
- README organization: introductory installation and usage, protocol support, error handling, packet size, RTT, API reference, and examples. This organization is useful, but its content must be rewritten for `ping(ip): Promise<PingResult>`.
- Examples: IPv4, IPv6, response time, packet size, TTL, retries, and traceroute variants. Reuse only the concept of small runnable examples; replace their callback/session implementation. Initial examples should cover IP literals, IPv6, negative results, rejected operations, and concurrent calls.
- Style: JavaScript predominantly uses tabs, semicolons, `var`, spaces before function-call parentheses, and CommonJS. Some examples use CRLF. No formal lint configuration or formatter configuration is present. Use rustfmt and a consistent modern JS style for the new project.
- `.gitignore`: excludes `node_modules` and `.npmrc`. New exclusions must cover Cargo target output and local generated binaries without excluding binaries from published platform packages.
- `.npmignore`: excludes `node_modules`, npm-debug.log, package-lock.json, and `.npmrc`; no package `files` allowlist. Prefer an explicit allowlist in the new package.
- Dependabot: weekly npm updates, maximum five open PRs. Add Cargo coverage in the new project; do not carry over its misleading comment claiming PRs are disabled.
- Issue templates, CONTRIBUTING, SECURITY, and other contribution metadata: none found in the inspected branch.

## Legacy implementation: do not copy

- Dependency: `@justjam2013/raw-socket`, including its install-script allowance. Exclude the dependency and its entire native dependency architecture.
- Persistent Session/EventEmitter API, generic raw socket access, callbacks, pause/resume, timers, traceroute, configurable family, and explicit close.
- Process-derived session identifier and per-session request dictionary.
- Wall-clock JS Date timestamps for latency.
- Legacy option defaults and compatibility-oriented public API.
- Existing examples and implementation-specific documentation.
- Build script `npm ping`: this checks npm registry connectivity, not compilation or ICMP correctness.
- Existing workflow mutates dependencies with `npm audit fix`, tolerates audit failures, and performs no Rust, native-addon, JS API, or ICMP tests. Replace its mechanics.
- Release script `npm publish --access public`. There is no trusted-publishing workflow in the inspected branch; prepare a new OIDC workflow rather than claiming one was inherited.

## Node, CI, tests, platforms, release policy

- No `engines` declaration or explicit maintained Node policy exists in the inspected package.
- Build workflow: `Build`, push-triggered, Ubuntu, Node 22.x and 24.x, checkout v4/setup-node v4, npm install and npm ping. Node 26 is absent.
- No automated test suite or test script exists in the inspected branch.
- IPv4 and IPv6 are documented; the README has no verified OS/architecture support matrix. Privileged example invocations use sudo.
- No platform prebuild jobs, artifact distribution, package validation, release-channel guard, or release/version validation workflow exists.
- No new GitHub Actions run was triggered or inspected for a new implementation.

## Useful ICMP behavior learned

These are reference observations, not implementation decisions:

- `packetSize` means the complete ICMP message, excluding IP headers. The code allocates exactly that many bytes; its default is 16 bytes, minimum 12, with an 8-byte Echo header.
- The README reports devices producing incorrect checksums for very small Echo messages. Prefer a conventional larger payload and make the new size interpretation explicit.
- IPv4 decoding accounts for a variable-length IP header before the ICMP header.
- IPv4 ICMP errors quote the original IP header and Echo header; matching therefore needs to inspect quoted request data.
- Loopback can deliver outgoing Echo Requests as well as replies. An observed request is not a successful reply.
- Echo identifier and sequence matching are necessary but should be strengthened with target/source checks and per-call payload identity where available.
- Errors can originate from routers rather than the destination; source validation for negative responses differs from Echo Reply validation.
- Legacy negative categories include unreachable, packet-too-big, time-exceeded, and parameter-problem. New code needs independently verified protocol parsing and explicit operation-error separation.
- Legacy defaults are 2000 ms timeout, one retry after the initial send, TTL 128. They do not meet the requested new defaults.
- Legacy IPv6 parsing assumes no IPv6 header and reads identifier/sequence at the top-level ICMP offset for all message types. Do not copy this approach for quoted IPv6 negative messages.
- Legacy RTT uses wall-clock timestamps and may cover multiple attempts. The new implementation must use a monotonic per-attempt measurement.

## Preliminary availability and tooling

- A direct HTTPS GET of `https://registry.npmjs.org/node-icmp-ping` returned HTTP 404 on 2026-09-18. No registered package was found. This is a preliminary availability check, not a reservation or guarantee that npm will permit publication.
- GitHub connector identifies the authenticated account as `justjam2013` with admin permission on the reference repository.
- Local GitHub HTTPS credential lookup succeeded; an authenticated GitHub API request returned 200 with `repo` and `workflow` OAuth scopes. Actual new-repository creation permission has not been exercised.
- Local Node is v24.11.0.
- Neither Cargo nor gh was found in PATH; Cargo was also absent at the conventional user Cargo path. Rust setup is still needed before local validation.

## Windows architecture gate

The request's section 26 explicitly says to stop if meaningful Windows support requires a materially different architecture.

Microsoft documents IPv4 and IPv6 raw ICMP sockets, but restricts raw-socket creation to administrators:

https://learn.microsoft.com/en-us/windows/win32/winsock/tcp-ip-raw-sockets-2

Microsoft also provides native IPv4 `IcmpSendEcho2` and IPv6 `Icmp6SendEcho2` APIs. These use ICMP handles and reply buffers rather than an application-owned raw-packet send/receive engine:

https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho2

https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmp6sendecho2

Architecture assessment: a dedicated Windows IP Helper backend would materially differ in packet ownership, reply processing, and native resource types, while retaining the same JS API and bounded worker mechanism. Administrator-only raw sockets could preserve a more uniform raw-socket architecture. This assessment does not establish that Windows raw ICMP is impossible; Microsoft explicitly supports it. What is unresolved is whether administrator-only Windows operation satisfies the intended meaningful-support requirement. No backend has been selected, no support claim has been made, and no runtime behavior has been tested.

## Implementation and validation status

Not implemented: GitHub repository, clean new Git history, Rust/napi-rs boundary, ICMP engine, JS/TypeScript API, defaults, deterministic tests, resource tests, platform prebuilds, npm package, CI, or publish preparation.

No new default branch, head SHA, package version, workflow run ID, platform artifact, or passing test result exists to report. No build/CI/runtime support claim is made for any of the six requested OS/architecture combinations.

Requested checks have not run because there is no new implementation. The reference clone remains clean.

**No npm package was published and no release capable of triggering publication was created.**
