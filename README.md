# node-icmp-ping

`node-icmp-ping` performs ICMP Echo directly through a native Rust/Node-API implementation. It does not invoke the system `ping` executable.

## Installation

```sh
npm install node-icmp-ping
```

The repository is prepared for npm publication; no initial package has been published yet. Supported Node lines are 22.13+, 24.x, and 26.x. Node-API 9 works throughout this range; the Node 22 minimum also matches the napi-rs build CLI. Node 18 and 20 are not supported.

Release packages use napi-rs platform packages and prebuilt binaries. Ordinary installation on a supported target requires no Rust, Cargo, Python, node-gyp, or local compiler. Building a checkout requires Rust and the platform linker/SDK.

## Privileges and platforms

The process must have permission to create **raw ICMP sockets**:

- Linux: root or `CAP_NET_RAW`. Datagram ping-socket permissions alone are insufficient.
- macOS: run with root privileges for raw sockets.
- Windows: run Node.js with **Administrator privileges**. Windows v1 uses Winsock raw ICMP, with no fallback to `IcmpSendEcho` or `Icmp6SendEcho2`.

Permission failures reject with a message explaining the privilege requirement. ICMP filtering/firewalls can cause negative results even when a host is running. Permission restrictions are part of the platform contract.

Prebuild targets are Linux glibc x64/arm64, macOS x64/arm64, and Windows MSVC x64/arm64. Linux musl and other architectures are not included. Unsupported/missing native binaries cause a clear loading error; there is no system-command or alternate protocol fallback. See [platform coverage](docs/platforms.md) for build, CI, runtime, and artifact status separately.

## API

```js
const { ping } = require('node-icmp-ping');
const result = await ping('192.168.1.50');
const ipv6 = await ping('2001:db8::50');
```

ESM uses the same function:

```js
import { ping } from 'node-icmp-ping';
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

Each invocation owns its raw socket and closes it through Rust RAII before settling its Promise. There is no persistent session, socket, or `close()` API. A short-lived UDP socket is used only to select the local route; it sends no UDP packet. Echo traffic itself always uses a raw socket.

Independent concurrent calls are safe:

```js
const results = await Promise.all(['127.0.0.1', '::1'].map(ip => ping(ip)));
```

Bounded work runs through napi-rs AsyncTask on Node-API's shared worker pool. Large batches queue behind the pool and can also delay other worker-pool operations. The per-attempt deadline starts when the native worker sends, not while queued. Worker/environment shutdown may wait for already-running bounded work; sockets do not survive completion. Active calls lease unique 16-bit identifiers because minimal ICMP error quotes contain no payload token. Payload tokens additionally validate replies; no persistent ping session is retained.

## Development

```sh
npm install
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
npm run build
npm test
npm run package:check
npm pack --dry-run
```

`npm test` needs no privileges and exercises argument validation and the actual addon export. Pure Rust tests exercise encoding, checksums, parsing, correlation, negative mapping, and deterministic native retry logic. `npm run test:integration` and `npm run test:resources` require raw-socket privileges and must pass in runtime-test CI; they do not silently skip permission failures. No external Internet target is required.

Cargo.lock is committed because this npm-distributed native product should have reproducible dependency resolution. CI uses `--locked`. [Release process](docs/releasing.md) describes prebuilt assembly and trusted publishing setup.

## Future configuration

Optional timeout, attempt, TTL, and payload-size overrides may be added later. They are not accepted by v1. A Windows Echo API backend may be considered later for non-elevated operation; it is not included in v1.

## License and attribution

MIT. Project metadata and README organization were informed by the predecessor project credited in [the reference inventory](docs/reference-inventory.md). Its ping implementation, dependency architecture, session API, and callbacks were not copied.
