# Platform coverage

The single npm package `@homebridge/node-icmp-ping` bundles eight native binaries.
The generated napi-rs loader selects the adjacent binary by platform, architecture
and libc. There are no separate native npm dependencies. `binding.js` and the
prebuilds are generated artifacts, never hand-edited or committed.

| Target | Build runner | Node 26 installed-package smoke |
| --- | --- | --- |
| Linux glibc x64 | ubuntu-24.04 | CJS/ESM, API, IPv4/IPv6 ICMP, resources |
| Linux glibc arm64 | ubuntu-24.04-arm | Build and package verification only |
| Linux musl x64 | ubuntu-24.04 + Alpine 3.23 | CJS/ESM, API, IPv4/IPv6 ICMP, resources |
| Linux musl arm64 | ubuntu-24.04-arm + Alpine 3.23 | Build and package verification only |
| macOS x64 | macos-15-intel | Build and package verification only |
| macOS arm64 | macos-15 | CJS/ESM, API, IPv4/IPv6 ICMP, resources |
| Windows x64 | windows-2025 | CJS/ESM, API, IPv4/IPv6 ICMP, resources |
| Windows arm64 | windows-11-arm | Build and package verification only |

All eight binaries must exist before assembly and appear in the package. Runtime
coverage is representative, not a claim that every architecture was executed.
Node 22/24/26 are supported; CI exercises only the newest supported major, 26.
See [releasing](releasing.md) for assembly and publication details.

Echo uses raw ICMP first, with permission-triggered ICMP datagram fallbacks on Linux (IPv4/IPv6) and macOS (IPv4).
The full IPv4/IPv6 tests require raw-socket privileges and do not skip
permission failures. Windows needs Administrator privileges; Windows IP Helper
Echo APIs are not used. Smoke tests install the assembled tarball offline with
scripts disabled, then exercise the installed addon. Resource tests perform 64
sequential calls and bounded worker shutdown; descriptor counts are checked on
Linux, not macOS/Windows. No external Internet Echo target is required.

Musl builds use matching native x64/arm64 hosts. The musl smoke test uses a Node 26
Alpine 3.23 container as root with `NET_RAW`, verifies actual libc and loaded binary,
and exercises IPv4/IPv6 loopback. No emulation or glibc compatibility layer is used.

Linux glibc builds use Ubuntu 24.04 and may require that glibc baseline. Musl uses
Alpine 3.23; older Alpine compatibility is not established. macOS deployment
minimums follow CI SDK defaults. Compatibility with older operating systems needs
its own evidence.


## Linux ping socket fallback audit and tests

The fallback is attempted only after `socket(SOCK_RAW)` returns a permission
error. Resource exhaustion, unsupported protocols, raw socket setup failures,
and send/receive failures do not select it. The public API, retry count,
per-attempt deadlines, random payload, and raw codec remain unchanged.

The adapter binds its selected local address with port zero, then reads the
kernel-assigned Echo identifier using `getsockname`. It never enables socket
reuse. Each invocation owns its socket through RAII; concurrent live ping sockets
have exclusive identifiers. The existing application identifier lease remains
for raw traffic; ping correlation uses the kernel identifier instead. Full random
payload matching protects Echo replies after identifier reuse. Minimal negative
quotes offer finite-width checksum correlation, not cryptographic uniqueness.

Linux supplies ICMP-only receive frames and recomputes outgoing checksums and
identifiers. The adapter encodes the assigned identifier so the expected request
matches the wire packet. Echo validation retains checksum (including the IPv6
pseudo-header), source, identifier, sequence and full payload checks. Error queues
(`IP_RECVERR` / `IPV6_RECVERR`, `MSG_ERRQUEUE`) carry the original destination,
quoted Echo and extended ICMP error metadata. We check origin/family, destination,
identifier, sequence, checksum and every available payload byte before accepting
a negative result. Truncated ancillary data and short/mismatched quotes are
ignored. The kernel validates the incoming error packet; userspace does not receive
its original outer checksum. A bare asynchronous errno cannot supply this evidence and rejects the operation rather than declaring a matched negative. A send interrupted by a queued stale error gets one bounded syscall retry.
The same negative reason mapping applies to raw packets and ping error metadata.

Reference implementations: Linux [IPv4 ping socket handling](https://github.com/torvalds/linux/blob/v6.12/net/ipv4/ping.c),
[IPv6 ping socket handling](https://github.com/torvalds/linux/blob/v6.12/net/ipv6/ping.c),
and [group range documentation](https://docs.kernel.org/networking/ip-sysctl.html#ping-group-range).
See the README for inspecting, configuring and persisting the group range.

Linux CI on x64 and arm64 runs deterministic tests plus an isolated network
namespace harness. It first proves the raw path works while ping sockets are
disabled, then drops all capabilities and proves raw creation fails. It verifies
both IPv4/IPv6 with an allowed group, denied group, concurrent variable-size Echo
payloads, firewall rejection and dropped Echo requests. Repeated success, failure,
and timeout runs compare `/proc/self/fd` counts for cleanup. The dropped-request
case exercises all three attempts and bounded deadlines. There is no external
Internet dependency and no permission-based skip in these explicit runs.

Codec tests cover minimal/partial/full error quotes, stale sequence, wrong
identifier/destination/payload, corruption, malformed addresses, all supported
negative types, and odd payload checksums. Real namespace tests exercise
administrative rejection; deterministic fixtures cover other negative categories.
They do not emulate every router, security module, container policy or IPv6
extension configuration. Native musl builds and existing privileged package smoke
checks remain in CI; namespace fallback coverage is on glibc Linux.
