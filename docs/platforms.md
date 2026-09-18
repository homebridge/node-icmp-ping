# Platform coverage

Raw ICMP is the only v1 backend. Administrator privileges on Windows are accepted as a v1 limitation; Windows IP Helper Echo APIs are not used. A future backend could be added behind the engine boundary without changing `ping(ip)`.

| Target | CI runner | Build | Node API CI | Real ICMP | Prebuilt artifact |
| --- | --- | --- | --- | --- | --- |
| Linux glibc x64 | ubuntu-24.04 | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| Linux glibc arm64 | ubuntu-24.04-arm | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| macOS x64 | macos-15-intel | Yes | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| macOS arm64 | macos-15 | Yes (also local) | Yes: 22/24/26 | Yes: privileged IPv4/IPv6 loopback | Yes |
| Windows x64 | windows-2025 | Yes | Yes: 22/24/26 | Yes: Administrator IPv4/IPv6 loopback | Yes |
| Windows arm64 | windows-11-arm | Yes | Yes: 22/24/26 | Yes: Administrator IPv4/IPv6 loopback | Yes |

All six native prebuild jobs passed in [run 35383061355](https://github.com/justjam2013/node-icmp-ping/actions/runs/35383061355), using Rust 1.98.1, Node 22.23.2, Node 24.19.0 on macOS x64, 24.20.0 on Linux/macOS arm64/Windows x64, 24.21.0 on Windows arm64, and Node 26.9.0. Every native artifact was loaded and used for real Echo on its matching architecture before upload. That run exposed a clean-install test setup error after native jobs passed; subsequent CI corrects that test and validates the assembled distribution. The corrected distribution, including clean installation and actual Echo from the installed tarball, passed in [run 35383836057](https://github.com/justjam2013/node-icmp-ping/actions/runs/35383836057). Consult the latest full CI result before releasing. Windows CI permission failure is a failing job, never a silently skipped test.

The repeated-operation test performs 64 sequential calls on every target and checks bounded worker-environment shutdown. Linux x64/arm64 additionally exercise three IPv4/IPv6 timeout/success cycles in isolated namespaces; descriptor counts remained 22 → 22. Descriptor/handle counts are not instrumented on macOS or Windows. No Internet target is required for Echo success tests.

Linux glibc binaries are built on Ubuntu 24.04 and may require that runner's glibc baseline. Alpine/musl is unsupported. macOS minimum deployment targets follow the configured CI SDK defaults. Future compatibility widening must be backed by builds and runtime tests on the intended older OS versions.

Sources: [Windows raw sockets](https://learn.microsoft.com/en-us/windows/win32/winsock/tcp-ip-raw-sockets-2), [IPv6 raw socket checksum behavior](https://www.rfc-editor.org/rfc/rfc3542#section-3.1), [ICMPv6](https://www.rfc-editor.org/rfc/rfc4443), [ICMPv4](https://www.rfc-editor.org/rfc/rfc792).
