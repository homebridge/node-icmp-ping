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

Raw ICMP is the only backend. Tests require raw-socket privileges and do not skip
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
