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
Installed-package CI smoke tests run with raw-socket privileges and do not skip
permission failures. Separate Linux tests explicitly remove raw privileges. Separate Windows tests use a standard-user token and require raw creation to fail
with WSAEACCES before checking the IP Helper Echo fallback. Smoke tests install the assembled tarball offline with
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
its original outer checksum. A bare asynchronous errno cannot supply this evidence
and rejects the operation rather than declaring a matched negative. A send
interrupted by a queued stale error gets one bounded syscall retry.
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
extension configuration. Native musl x64/arm64 CI also runs deterministic tests
and the real Echo/concurrency/cleanup case as UID/GID 65534 with all capabilities
dropped and an explicit ping group range. Full firewall/timeout namespace coverage
is on glibc Linux. Existing privileged installed-package smoke checks remain.


## Windows Echo fallback audit and tests

Only `WSAEACCES` (10013) from Winsock raw socket **creation** selects IP Helper.
A created raw socket retains its existing setup, codec and send/receive path.
Other creation errors and all raw setup/runtime errors propagate without fallback.
IPv4 uses `IcmpCreateFile` / `IcmpSendEcho`; IPv6 uses `Icmp6CreateFile` /
`Icmp6SendEcho2` with null Event/APC parameters. Synchronous calls run on the
existing Node-API worker pool. No callback, thread or outstanding native request
survives the call. Each invocation owns its handle and closes it with
`IcmpCloseHandle`, including after failures. Calls do not share mutable buffers
or handles, and the OS chooses the source address and manages Echo correlation.

The shared probe loop retains three attempts, per-attempt monotonic deadlines,
monotonic RTT, TTL/hop limit 64, and the same random 56-byte payload. The adapter
passes only the payload (not the application ICMP header) to Windows, once per
attempt. Remaining time is rounded down to whole milliseconds for the API;
late replies are discarded by the existing deadline check. A mismatched Echo
consumes the remainder of that attempt without sending an extra request.

SDK bindings supply native structure layouts. Reply allocations are initialized,
aligned, and include header, payload, eight error bytes and `IO_STATUS_BLOCK`
space. IPv4 data pointers and lengths are bounded within the reply allocation
before reading. IPv6 data follows the 36-byte reply header and has no explicit
received-length field; comparison uses RequestSize, as in .NET's Windows Ping.
Both families validate source and payload. The OS owns wire identifier, sequence,
checksum and negative correlation; the API does not expose quotes to apply the
raw codec's extra checks. This is a Windows API limitation, not equivalent evidence
of userspace raw-packet validation.

A zero return reads `GetLastError` immediately. Known timeout statuses retry;
known unreachable/too-big/time-exceeded/parameter-problem statuses resolve
negatively with the existing reason vocabulary. IPv4 protocol-unreachable and
IPv6 administrative-prohibition share a number and are mapped by family.
Resource exhaustion, invalid parameters, general failure and unknown statuses
reject rather than becoming a timeout or a claim that the host is down.

References: Microsoft [IcmpSendEcho](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho),
[Icmp6SendEcho2](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmp6sendecho2),
[reply statuses](https://learn.microsoft.com/en-us/windows/win32/api/ipexport/ns-ipexport-icmp_echo_reply),
and [.NET Windows Ping](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Net.Ping/src/System/Net/NetworkInformation/Ping.Windows.cs).

Windows x64 and arm64 CI run deterministic selection/status/buffer/retry/deadline
tests and actual invalid-handle API failures with repeated handle cleanup.
`scripts/test-windows-echo.ps1` creates a disposable local standard user, copies the test executable to a temporary accessible directory,
and launches it with that user’s credentials. Both families must first fail raw creation with
10013; permission-based skips are forbidden. Loopback tests cover 16/56/57/1200
payload bytes and 160 measured calls on eight persistent workers after a full
160-call warmup. Process handle counts are sampled with workers idle, and every
owned handle close must succeed in test builds.
The standard-user process also repeats actual invalid-handle errors for both
address families. The script removes its account and directory in `finally`.
Existing elevated installed-package smoke tests retain raw-path coverage.
Negative status categories and late/timeout responses are deterministic fixtures;
CI does not manufacture router ICMP errors or depend on Internet addresses.
Loopback does not establish compatibility with every firewall/service policy,
remote network or older Windows release.

Current validation blocker (Windows Server 2022/2025 x64 and Windows 11 arm64
hosted runners): raw creation and setup succeed even under the harness's standard-user token.
The strict creation-denial assertion remains a failing gate; it is not skipped
or replaced by a simulated denial. A separate direct-API integration case runs
under the same account to distinguish API functionality from automatic selector
coverage. That case cannot establish that the creation-only fallback is reachable.
