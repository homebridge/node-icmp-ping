<div>
    <a href="https://www.npmjs.com/package/@homebridge/node-icmp-ping"><img src="https://img.shields.io/github/package-json/v/homebridge/node-icmp-ping?color=F99211" /></a>
    <a href="https://www.npmjs.com/package/@homebridge/node-icmp-ping"><img src="https://img.shields.io/github/v/release/homebridge/node-icmp-ping?color=FFd461" /></a>
</div>

# node-icmp-ping

`node-icmp-ping` performs ICMP Echo directly through a native Rust/Node-API implementation. It does not invoke the system `ping` executable.

## Installation

```sh
npm install @homebridge/node-icmp-ping
```

The package is published through GitHub Releases using npm Trusted Publishing. Supported Node lines are 22.13+, 24.x, and 26.x. Node-API 9 works throughout this range; the Node 22 minimum also matches the napi-rs build CLI. Node 18 and 20 are not supported.

One npm package bundles all eight prebuilt binaries beside the napi-rs generated loader, which selects the matching platform and libc. No optional native packages or binary downloads are required. Ordinary installation on a supported target requires no Rust, Cargo, Python, node-gyp, or local compiler. Building a checkout requires Rust and the platform linker/SDK.

## Privileges and platforms

ICMP socket permissions depend on the platform:

- Linux: raw ICMP remains the primary transport (root or `CAP_NET_RAW`). Only a raw socket creation permission failure enables the IPv4/IPv6 ICMP datagram fallback, subject to `net.ipv4.ping_group_range`. See the configuration below.
- macOS: IPv4 falls back to an unprivileged ICMP datagram socket when raw-socket permission is denied. IPv6 still requires root.
- Windows: run Node.js with **Administrator privileges**. Windows v1 uses Winsock raw ICMP, with no fallback to `IcmpSendEcho` or `Icmp6SendEcho2`.

Permission failures reject with a message explaining the privilege requirement. ICMP filtering/firewalls can cause negative results even when a host is running. Permission restrictions are part of the platform contract.

Prebuild targets are Linux glibc and musl (Alpine 3.23) x64/arm64, macOS x64/arm64, and Windows MSVC x64/arm64. Other architectures are not included. Unsupported/missing native binaries cause a clear loading error; there is no system-command or alternate protocol fallback. See [platform coverage](docs/platforms.md) for build, CI, runtime, and artifact status separately.

## Linux without raw-socket privileges

Inspect the setting in the **same network namespace** as the service, and its effective/supplementary groups:

```sh
cat /proc/sys/net/ipv4/ping_group_range
sysctl net.ipv4.ping_group_range
id homebridge
# For a running service, inspect its actual credentials (substitute its PID):
grep '^Gid:\|^Groups:' /proc/PID/status
```

The inclusive numeric group range permits ICMP Echo sockets for matching effective
or supplementary groups. Despite the `ipv4` name, Linux uses this setting for both
IPv4 and IPv6 ping sockets. `1 0` disables access; distribution defaults vary.
IPv6 also needs kernel IPv6 support, an enabled interface, and a usable route.
Scoped IPv6 addresses remain outside the existing API.

To permit only the service's primary group (replace `homebridge` if necessary):

```sh
ping_gid=$(id -g homebridge)
sudo sysctl -w "net.ipv4.ping_group_range=$ping_gid $ping_gid"
```

For persistence on systems using `sysctl.d`, write the same **numeric** range:

```sh
printf 'net.ipv4.ping_group_range = %s %s\n' "$ping_gid" "$ping_gid" | sudo tee /etc/sysctl.d/90-homebridge-ping.conf
sudo sysctl --system
sysctl net.ipv4.ping_group_range
```

Review existing sysctl files before replacing a range: another service may rely on
it, and later settings may override it. Restart the service after changing group
membership. Containers have their own network namespace and security policy; the
host/container administrator must configure the relevant namespace. This library
does not change sysctls, capabilities, group memberships, or firewall rules.

Use a dedicated service group where possible. A broad range permits every matching
process to send Echo requests, increasing probing/traffic opportunities; it does
not grant arbitrary raw sockets or `CAP_NET_RAW`. Root, `CAP_NET_RAW`, seccomp,
LSM rules, and service sandboxing remain separate controls. Do not grant broad Node
binary capabilities just to enable Echo when a restricted group range suffices.
If both socket creation attempts fail, the error includes both causes and this
setting's path. A disabled/unsupported fallback fails explicitly. Firewalls can
still reject or drop requests, producing a negative result or a bounded timeout.

## API

```js
const { ping } = require('@homebridge/node-icmp-ping');
const result = await ping('192.168.1.50');
const ipv6 = await ping('2001:db8::50');
```

ESM uses the same function:

```js
import { ping } from '@homebridge/node-icmp-ping';
```

Only `ping(ip)` is exported. Supply exactly one IPv4 or IPv6 literal string. No DNS lookup occurs. Hostnames, bracketed URLs, and zone-qualified/scoped IPv6 strings are rejected. IP parsing automatically determines the address family. Link-local IPv6 requiring an interface scope is not supported by v1's plain-IP contract.

```ts
interface PingResult {
  success: boolean;
  latency: number | null;
  message: string;
}
function ping(ip: string): Promise<PingResult>;
```

Success resolves to `{ success: true, latency: 1.83, message: '' }`, with floating-point round-trip milliseconds from a monotonic clock. Negative responses or timeout resolve to `{ success: false, latency: null, message: '...' }`. Latency is never a numeric sentinel.

Invalid arguments reject. Socket creation/configuration, permission, routing setup, random generation, and unexpected send/receive failures reject. A network/host-unreachable error returned while sending or receiving resolves negatively; relevant matched ICMP unreachable, packet-too-big, time-exceeded, and parameter-problem responses also resolve negatively. A timeout does not prove the host is offline.

```js
try {
  const result = await ping('127.0.0.1');
  if (result.success) console.log(`${result.latency} ms`);
  else console.log(result.message);
} catch (error) {
  console.error(`Operation could not run: ${error.message}`);
}
```

## Defaults and lifetime

Each call attempts at most **three Echo Requests**, waiting up to **1000 ms per attempt**, with TTL / IPv6 hop limit **64** and **56 payload bytes** (64-byte ICMP Echo message including the 8-byte header, excluding IP headers). Retries stop on success or a matched negative response. RTT measures the successful attempt, not total retry duration.

Each invocation owns its ICMP socket and closes it through Rust RAII before settling its Promise. There is no persistent session, socket, or `close()` API. A short-lived UDP socket is used only to select the local route; it sends no UDP packet. Echo traffic uses raw ICMP, with permission-triggered ICMP datagram fallbacks on Linux (IPv4/IPv6) and macOS (IPv4). These are ICMP sockets, not UDP probes.

Independent concurrent calls are safe:

```js
const results = await Promise.all(['127.0.0.1', '::1'].map(ip => ping(ip)));
```

Bounded work runs through napi-rs AsyncTask on Node-API's shared worker pool. Large batches queue behind the pool and can also delay other worker-pool operations. The per-attempt deadline starts when the native worker sends, not while queued. Worker/environment shutdown may wait for already-running bounded work; sockets do not survive completion. Active calls lease unique 16-bit identifiers because minimal ICMP error quotes contain no payload token. The allocator starts at a cryptographically random identifier to reduce collisions across processes and restarts. Released identifiers are quarantined for 60 seconds to reduce delayed-error misattribution. The bounded 65,536-identifier allocator can reject exceptionally large bursts. Negative responses must quote the expected Echo checksum, including the ICMPv6 pseudo-header, and match any quoted payload bytes. Payload tokens additionally validate replies. The identifier and checksum are both 16-bit fields, so minimum error quotes cannot guarantee cross-process uniqueness. No persistent ping session is retained.

## Development

```sh
npm ci
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
npm run build
npm test
npm run test:release
```

`npm run build` always generates ignored `binding.js` and the native binary for the local host using the pinned napi-rs generator and locked Cargo dependencies. Run it before tests or runtime use, and again after source or version changes. `binding.js` is a build/package artifact: never edit or commit it. The public declarations remain in `index.d.ts`. Dependency installation does not require generated outputs. Native prebuilds are also generated and must never be hand-edited or committed.

`npm run package:check` checks the contents of the assembled all-platform tarball after CI assembly; a local single-target build is not a release distribution.

`npm test` needs no privileges and exercises argument validation and the actual addon export. Pure Rust tests exercise encoding, checksums, parsing, correlation, negative mapping, and deterministic native retry logic. `npm run test:integration` and `npm run test:resources` include IPv6 and need working ICMP permissions; privileged raw-path smoke tests must pass in runtime-test CI; they do not silently skip permission failures. No external Internet target is required. On Linux, `bash scripts/test-linux-ping.sh` runs explicit raw, unprivileged Echo, denied-range, negative-reply, and dropped-reply tests in a disposable network namespace (requires sudo, `ip`, `iptables`, `ip6tables`, `setpriv`, and Python 3). The test process drops all capabilities; the harness configures only its temporary namespace. See [platform test details](docs/platforms.md).

To bump a version, manually edit `package.json`, `package-lock.json` (both top-level and root-package versions), `Cargo.toml`, and the `node-icmp-ping` entry in `Cargo.lock` so they agree. Do not rebuild lockfiles for a version bump. Run `node scripts/check-versions.js`, inspect `git diff`, then commit and push normally.

Publishing a GitHub Release runs builds and four Node 26 installed-package smoke jobs. Its **Set as a pre-release** checkbox chooses npm `beta`; unchecked chooses `latest`, independently of the version suffix or GitHub tag. The tag may differ from the package version. npm publication is attempted once; on failure inspect npm's error and the registry manually before further action. See the [release process](docs/releasing.md) for the complete procedure.

Cargo.lock is committed because this npm-distributed native product should have reproducible dependency resolution. CI uses `--locked`. [Release process](docs/releasing.md) describes the version-PR preparation, automatic loader generation, representative installed-package testing, and publication failure handling.
