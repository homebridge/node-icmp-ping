# Platform coverage

The single npm package `@homebridge/node-icmp-ping` from [Homebridge](https://github.com/homebridge/node-icmp-ping) bundles all eight native binaries. The unchanged napi-rs generated loader selects the adjacent binary by platform, architecture, and libc; see [package contents](releasing.md#package-contents-and-assembly). There are no separate native npm dependencies.

Raw ICMP is the only v1 backend. Administrator privileges on Windows are accepted as a v1 limitation; Windows IP Helper Echo APIs are not used. A future backend could be added behind the engine boundary without changing `ping(ip)`.

| Target | CI runner | Build | Node API CI | Real ICMP | Prebuilt artifact |
| --- | --- | --- | --- | --- | --- |
| Linux glibc x64 | ubuntu-24.04 | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| Linux glibc arm64 | ubuntu-24.04-arm | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| Linux musl x64 | ubuntu-24.04 + Alpine 3.23 | Configured; pending CI | Configured: 22/24/26 | Required: privileged IPv4/IPv6 loopback | Pending CI |
| Linux musl arm64 | ubuntu-24.04-arm + Alpine 3.23 | Configured; pending CI | Configured: 22/24/26 | Required: privileged IPv4/IPv6 loopback | Pending CI |
| macOS x64 | macos-15-intel | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| macOS arm64 | macos-15 | Yes (also local) | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| Windows x64 | windows-2025 | Yes | Yes: 22/24/26 | Yes: Administrator IPv4/IPv6 loopback | Yes |
| Windows arm64 | windows-11-arm | Yes | Yes: 22/24/26 | Yes: Administrator IPv4/IPv6 loopback | Yes |

All six native prebuild jobs passed in [run 35383061355](https://github.com/homebridge/node-icmp-ping/actions/runs/35383061355), using Rust 1.98.1, Node 22.23.2, Node 24.19.0 on macOS x64, 24.20.0 on Linux/macOS arm64/Windows x64, 24.21.0 on Windows arm64, and Node 26.9.0. Every native artifact was loaded and used for real Echo on its matching architecture before upload. That run exposed a clean-install test setup error after native jobs passed; subsequent CI corrects that test and validates the assembled distribution. The corrected distribution, including clean installation and actual Echo from the installed tarball, passed in [run 35383836057](https://github.com/homebridge/node-icmp-ping/actions/runs/35383836057). Those historical runs validate the earlier multi-package distribution, not the new bundled tarball. The current workflow additionally installs the exact retained bundled tarball offline with scripts disabled on all eight targets and Node 22/24/26. Require a green run of that full matrix before releasing. Windows CI permission failure is a failing job, never a silently skipped test.

The repeated-operation test performs 64 sequential calls on every target and checks bounded worker-environment shutdown. Linux x64/arm64 additionally exercise three IPv4/IPv6 timeout/success cycles in isolated namespaces; descriptor counts remained 22 → 22. Descriptor/handle counts are not instrumented on macOS or Windows. No Internet target is required for Echo success tests.

Linux glibc binaries are built on Ubuntu 24.04 and may require that runner's glibc baseline. Musl binaries are built and tested on Alpine 3.23; older Alpine versions are not established as supported. macOS minimum deployment targets follow the configured CI SDK defaults. Future compatibility widening must be backed by builds and runtime tests on the intended older OS versions.

Sources: [Windows raw sockets](https://learn.microsoft.com/en-us/windows/win32/winsock/tcp-ip-raw-sockets-2), [IPv6 raw socket checksum behavior](https://www.rfc-editor.org/rfc/rfc3542#section-3.1), [ICMPv6](https://www.rfc-editor.org/rfc/rfc4443), [ICMPv4](https://www.rfc-editor.org/rfc/rfc792).

## Native Alpine validation

Both musl jobs use real matching-architecture Linux runners with Docker; no QEMU, cross-linker, or glibc compatibility layer is used. The official Rust and Node images provide x64 and arm64 Alpine variants. Rust uses dynamic musl linkage for the Node addon. All six existing platform builds and the independent glibc install tests remain in place. The same retained SHA-512 tarball must pass all 24 installations (eight platform/libc targets × Node 22/24/26).

The Alpine final-package tests inspect the running process's libc mapping and Node report, assert architecture and Node major, confirm the loaded `.node` path is musl, and require successful raw IPv4 and IPv6 loopback Echo. Containers run as root with `NET_RAW`; there is no fallback for missing permissions or IPv6. ARM64 runner or official image availability can block CI, but never redirects testing through emulation. Node's Docker project describes musl runtime support separately from its glibc support; this package's support is bounded by the tested Alpine/Node matrix.

References: [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [official Node image architectures](https://github.com/nodejs/docker-node/blob/main/versions.json), [Node musl support](https://github.com/nodejs/docker-node#musl-builds-for-alpine), [official Rust Alpine image](https://github.com/rust-lang/docker-rust/blob/master/stable/alpine3.23/Dockerfile), and [napi-rs musl linkage](https://napi.rs/docs/more/faq).
