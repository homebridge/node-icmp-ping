# Platform coverage

Raw ICMP is the only v1 backend. Administrator privileges on Windows are accepted as a v1 limitation; Windows IP Helper Echo APIs are not used. A future backend could be added behind the engine boundary without changing `ping(ip)`.

| Target | CI runner | Build | Node API CI | Real ICMP | Prebuilt artifact |
| --- | --- | --- | --- | --- | --- |
| Linux glibc x64 | ubuntu-24.04 | Pending | Pending 22/24/26 | Pending IPv4/IPv6 | Pending |
| Linux glibc arm64 | ubuntu-24.04-arm | Pending | Pending 22/24/26 | Pending IPv4/IPv6 | Pending |
| macOS x64 | macos-15-intel | Pending | Pending 22/24/26 | Pending IPv4/IPv6 | Pending |
| macOS arm64 | macos-15 | Local build pending | Pending 22/24/26 | Pending IPv4/IPv6 | Pending |
| Windows x64 | windows-2025 | Pending | Pending 22/24/26 | Pending privileged IPv4/IPv6 | Pending |
| Windows arm64 | windows-11-arm | Pending | Pending 22/24/26 | Pending privileged IPv4/IPv6 | Pending |

These are configured targets, not verified support claims. Update this table with actual CI evidence before treating a target as supported. Release CI requires all six runtime tests and prebuilds; compilation alone is insufficient. Windows CI permission failure is a failing job, never a silently skipped test.

Linux glibc binaries are built on Ubuntu 24.04 and may require that runner's glibc baseline. Alpine/musl is unsupported. macOS minimum deployment targets follow the configured CI SDK defaults. Future compatibility widening must be backed by builds and runtime tests on the intended older OS versions.

Sources: [Windows raw sockets](https://learn.microsoft.com/en-us/windows/win32/winsock/tcp-ip-raw-sockets-2), [IPv6 raw socket checksum behavior](https://www.rfc-editor.org/rfc/rfc3542#section-3.1), [ICMPv6](https://www.rfc-editor.org/rfc/rfc4443), [ICMPv4](https://www.rfc-editor.org/rfc/rfc792).
