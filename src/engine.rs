use crate::packet::{self, Expected, Reply};
use socket2::{Domain, Protocol, Socket, Type};
use std::io;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Options {
    pub timeout: Duration,
    pub attempts: u16,
    pub ttl: u32,
    /// Payload bytes; complete ICMP message is payload_size + 8 bytes.
    pub payload_size: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(1000),
            attempts: 3,
            ttl: 64,
            payload_size: 56,
        }
    }
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if self.timeout.is_zero()
            || self.timeout > Duration::from_secs(10)
            || self.attempts == 0
            || self.attempts > 10
            || self.ttl == 0
            || self.ttl > 255
            || !(16..=1200).contains(&self.payload_size)
        {
            return Err("Invalid internal ICMP configuration".into());
        }
        Ok(())
    }
}
#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub latency: Option<f64>,
    pub message: String,
}
impl Outcome {
    fn negative(message: impl Into<String>) -> Self {
        Self {
            latency: None,
            message: message.into(),
        }
    }
}

pub fn operation_error(stage: &str, error: &io::Error) -> String {
    if error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(1 | 13 | 10013))
    {
        format!("ICMP {stage}: socket permission denied; Windows requires Administrator privileges, Linux requires CAP_NET_RAW/root, macOS IPv4 tries an unprivileged ICMP datagram socket, IPv6 requires root ({error})")
    } else {
        format!("ICMP {stage}: {error}")
    }
}
fn network_error(error: &io::Error) -> Option<&'static str> {
    match error.kind() {
        io::ErrorKind::NetworkUnreachable => Some("Network unreachable"),
        io::ErrorKind::HostUnreachable => Some("Host unreachable"),
        _ => None,
    }
}

pub trait Transport {
    fn identifier(&self, leased: u16) -> u16 {
        leased
    }
    fn parse_reply(&self, bytes: &[u8], source: IpAddr, expected: &Expected<'_>) -> Option<Reply> {
        packet::parse(bytes, source, expected)
    }
    fn send(&mut self, packet: &[u8], target: IpAddr) -> io::Result<()>;
    fn receive(&mut self, bytes: &mut [u8], wait: Duration) -> io::Result<(usize, IpAddr)>;
}
// Darwin's IPv4 ICMP datagram sockets preserve the supplied Echo identifier and
// checksum and receive the same IPv4 header as raw sockets (XNU icmp_dgram_send
// delegates to rip_send/rip_input). Keep the existing codec and identifier lease.
// Do not generalize to Linux ping sockets: those have kernel-managed identifiers
// and omit the outer IPv4 header. The original node-raw-socket fallback was IPv4.
#[cfg(any(target_os = "macos", test))]
fn macos_socket<S>(target: IpAddr, mut create: impl FnMut(Type) -> io::Result<S>) -> io::Result<S> {
    match create(Type::RAW) {
        Err(error) if target.is_ipv4() && error.kind() == io::ErrorKind::PermissionDenied => {
            create(Type::DGRAM)
        }
        result => result,
    }
}

// Only creation permission errors select the fallback. Setup/send/receive errors
// from an already-created raw socket must never switch transports.
#[cfg(any(target_os = "linux", test))]
fn linux_socket<S>(mut create: impl FnMut(Type) -> io::Result<S>) -> Result<(S, bool), String> {
    match create(Type::RAW) {
        Ok(socket) => Ok((socket, false)),
        Err(raw) if raw.kind() == io::ErrorKind::PermissionDenied => {
            create(Type::DGRAM).map(|socket| (socket, true)).map_err(|fallback| format!(
                "ICMP raw socket creation denied ({raw}); Linux ICMP ping socket creation failed ({fallback}); inspect /proc/sys/net/ipv4/ping_group_range and permit a service group, or grant CAP_NET_RAW/root for raw ICMP"
            ))
        }
        Err(error) => Err(operation_error("socket creation", &error)),
    }
}

pub fn open(target: IpAddr, options: &Options) -> Result<(Box<dyn Transport>, IpAddr), String> {
    #[cfg(target_os = "linux")]
    {
        let (socket, ping) = linux_socket(|kind| {
            Socket::new(
                if target.is_ipv4() {
                    Domain::IPV4
                } else {
                    Domain::IPV6
                },
                kind,
                Some(if target.is_ipv4() {
                    Protocol::ICMPV4
                } else {
                    Protocol::ICMPV6
                }),
            )
        })?;
        if ping {
            let (transport, local) = crate::linux::Ping::open(socket, target, options)?;
            return Ok((Box::new(transport), local));
        }
        let (transport, local) = Raw::from_socket(socket, target, options)?;
        Ok((Box::new(transport), local))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (transport, local) = Raw::open(target, options)?;
        Ok((Box::new(transport), local))
    }
}

pub struct Raw {
    socket: UdpSocket,
}
impl Raw {
    #[cfg(any(not(target_os = "linux"), test))]
    pub fn open(target: IpAddr, options: &Options) -> Result<(Self, IpAddr), String> {
        let domain = if target.is_ipv4() {
            Domain::IPV4
        } else {
            Domain::IPV6
        };
        let protocol = if target.is_ipv4() {
            Protocol::ICMPV4
        } else {
            Protocol::ICMPV6
        };
        let create = |kind| Socket::new(domain, kind, Some(protocol));
        #[cfg(target_os = "macos")]
        let socket = macos_socket(target, create);
        #[cfg(not(target_os = "macos"))]
        let socket = create(Type::RAW);
        let socket = socket.map_err(|e| operation_error("socket creation", &e))?;
        Self::from_socket(socket, target, options)
    }
    pub(crate) fn from_socket(
        socket: Socket,
        target: IpAddr,
        options: &Options,
    ) -> Result<(Self, IpAddr), String> {
        if target.is_ipv4() {
            socket.set_ttl_v4(options.ttl)
        } else {
            socket.set_unicast_hops_v6(options.ttl)
        }
        .map_err(|e| operation_error("TTL/hop-limit configuration", &e))?;
        // A UDP connect selects the local route/address; no UDP packet is sent.
        // Binding the raw socket ensures the ICMPv6 pseudo-header source is exact.
        let route = UdpSocket::bind(SocketAddr::new(
            if target.is_ipv4() {
                "0.0.0.0".parse().unwrap()
            } else {
                "::".parse().unwrap()
            },
            0,
        ))
        .map_err(|e| operation_error("route socket creation", &e))?;
        route
            .connect(SocketAddr::new(target, 33434))
            .map_err(|e| operation_error("route selection", &e))?;
        let local = route
            .local_addr()
            .map_err(|e| operation_error("source address", &e))?
            .ip();
        socket
            .bind(&SocketAddr::new(local, 0).into())
            .map_err(|e| operation_error("source binding", &e))?;
        // socket2's safe ownership conversion supplies std's initialized-buffer
        // send/recv interface for the same socket descriptor. It does not change
        // the socket type and does not introduce a UDP transport or session.
        socket
            .set_write_timeout(Some(options.timeout))
            .map_err(|e| operation_error("send timeout configuration", &e))?;
        Ok((
            Self {
                socket: socket.into(),
            },
            local,
        ))
    }
}
impl Transport for Raw {
    fn send(&mut self, packet: &[u8], target: IpAddr) -> io::Result<()> {
        let sent = self.socket.send_to(packet, SocketAddr::new(target, 0))?;
        if sent != packet.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Incomplete ICMP datagram send",
            ));
        }
        Ok(())
    }
    fn receive(&mut self, bytes: &mut [u8], wait: Duration) -> io::Result<(usize, IpAddr)> {
        self.socket
            .set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
        let (length, source) = self.socket.recv_from(bytes)?;
        #[cfg(target_os = "macos")]
        if source.is_ipv4() {
            packet::normalize_macos_ipv4(&mut bytes[..length]);
        }
        Ok((length, source.ip()))
    }
}

pub fn probe<T: Transport + ?Sized>(
    transport: &mut T,
    target: IpAddr,
    local: IpAddr,
    id: u16,
    payload: &[u8],
    options: &Options,
) -> Result<Outcome, String> {
    options.validate()?;
    if payload.len() != options.payload_size {
        return Err("Invalid internal ICMP payload length".into());
    }
    let id = transport.identifier(id);
    let mut bytes = vec![0u8; 65535];
    for seq in 1..=options.attempts {
        let packet = packet::echo(target, local, id, seq, payload);
        let start = Instant::now();
        let deadline = start + options.timeout;
        if let Err(error) = transport.send(&packet, target) {
            if let Some(reason) = network_error(&error) {
                return Ok(Outcome::negative(reason));
            }
            return Err(operation_error("send", &error));
        }
        while let Some(wait) = deadline.checked_duration_since(Instant::now()) {
            match transport.receive(&mut bytes, wait) {
                Ok((length, source)) => {
                    let elapsed = start.elapsed();
                    if Instant::now() > deadline {
                        break;
                    }
                    if length > bytes.len() {
                        return Err("ICMP receive returned invalid length".into());
                    }
                    match transport.parse_reply(
                        &bytes[..length],
                        source,
                        &Expected {
                            target,
                            local,
                            id,
                            seq,
                            payload,
                        },
                    ) {
                        Some(Reply::Echo) => {
                            return Ok(Outcome {
                                latency: Some(elapsed.as_secs_f64() * 1000.0),
                                message: String::new(),
                            })
                        }
                        Some(Reply::Negative(message)) => return Ok(Outcome::negative(message)),
                        None => continue,
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) =>
                {
                    break
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    if let Some(reason) = network_error(&e) {
                        return Ok(Outcome::negative(reason));
                    }
                    return Err(operation_error("receive", &e));
                }
            }
        }
    }
    Ok(Outcome::negative(format!(
        "Request timed out after {} attempts",
        options.attempts
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_fallback_policy() {
        for error in [
            None,
            Some(io::ErrorKind::PermissionDenied),
            Some(io::ErrorKind::Other),
            Some(io::ErrorKind::Unsupported),
            Some(io::ErrorKind::OutOfMemory),
        ] {
            let mut calls = Vec::new();
            let result = linux_socket(|kind| {
                calls.push(kind);
                if kind == Type::RAW {
                    if let Some(error) = error {
                        return Err(io::Error::from(error));
                    }
                }
                Ok(42)
            });
            let fallback = error == Some(io::ErrorKind::PermissionDenied);
            assert_eq!(
                calls,
                if fallback {
                    vec![Type::RAW, Type::DGRAM]
                } else {
                    vec![Type::RAW]
                }
            );
            if error.is_none() || fallback {
                assert_eq!(result.unwrap(), (42, fallback));
            } else {
                assert!(result.is_err());
            }
        }
        for code in [1, 13] {
            let mut calls = 0;
            let error = linux_socket::<()>(|_| {
                calls += 1;
                Err(io::Error::from_raw_os_error(if calls == 1 {
                    code
                } else {
                    97
                }))
            })
            .unwrap_err();
            assert_eq!(calls, 2);
            assert!(error.contains("raw socket creation denied"));
            assert!(error.contains("ping_group_range"));
            assert!(error.contains("97"));
        }
    }

    #[test]
    fn macos_fallback_policy() {
        for address in ["127.0.0.1", "::1"] {
            for error in [
                None,
                Some(io::ErrorKind::PermissionDenied),
                Some(io::ErrorKind::Other),
            ] {
                let mut calls = Vec::new();
                let result = macos_socket(address.parse().unwrap(), |kind| {
                    calls.push(kind);
                    if kind == Type::RAW {
                        if let Some(error) = error {
                            return Err(io::Error::from(error));
                        }
                    }
                    Ok(())
                });
                let fallback =
                    address == "127.0.0.1" && error == Some(io::ErrorKind::PermissionDenied);
                assert_eq!(
                    calls,
                    if fallback {
                        vec![Type::RAW, Type::DGRAM]
                    } else {
                        vec![Type::RAW]
                    }
                );
                assert_eq!(result.is_ok(), error.is_none() || fallback);
            }
        }
        let error = macos_socket::<()>("127.0.0.1".parse().unwrap(), |kind| {
            Err(io::Error::from(if kind == Type::RAW {
                io::ErrorKind::PermissionDenied
            } else {
                io::ErrorKind::AddrNotAvailable
            }))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrNotAvailable);
    }

    // Run explicitly in CI as a normal user. An unavailable raw socket must not
    // cause this regression test to skip or silently succeed with a timeout.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires unprivileged macOS network access"]
    fn macos_unprivileged_ipv4_echo() {
        assert_eq!(
            Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        std::thread::scope(|scope| {
            for size in [16, 57, 1200] {
                scope.spawn(move || {
                    let target = "127.0.0.1".parse().unwrap();
                    let options = Options {
                        payload_size: size,
                        ..Options::default()
                    };
                    let lease = crate::identifier::Lease::acquire().unwrap();
                    let (mut socket, local) = Raw::open(target, &options).unwrap();
                    let payload = vec![size as u8; size];
                    let outcome =
                        probe(&mut socket, target, local, lease.0, &payload, &options).unwrap();
                    assert!(outcome.latency.is_some(), "{}", outcome.message);
                });
            }
        });
    }

    struct Fake {
        sends: Vec<Vec<u8>>,
        response: Option<Vec<u8>>,
        fail: Option<io::ErrorKind>,
    }
    impl Transport for Fake {
        fn send(&mut self, bytes: &[u8], _: IpAddr) -> io::Result<()> {
            self.sends.push(bytes.to_vec());
            Ok(())
        }
        fn receive(&mut self, bytes: &mut [u8], _: Duration) -> io::Result<(usize, IpAddr)> {
            if let Some(kind) = self.fail {
                return Err(io::Error::from(kind));
            }
            if let Some(packet) = self.response.take() {
                bytes[..packet.len()].copy_from_slice(&packet);
                return Ok((packet.len(), "::1".parse().unwrap()));
            }
            Err(io::Error::from(io::ErrorKind::TimedOut))
        }
    }
    fn fake() -> Fake {
        Fake {
            sends: Vec::new(),
            response: None,
            fail: None,
        }
    }
    #[test]
    fn defaults_and_limits() {
        let o = Options::default();
        assert_eq!(o.timeout, Duration::from_millis(1000));
        assert_eq!(o.attempts, 3);
        assert_eq!(o.ttl, 64);
        assert_eq!(o.payload_size, 56);
        assert!(o.validate().is_ok());
        assert!(Options {
            attempts: 0,
            ..o.clone()
        }
        .validate()
        .is_err());
        assert!(Options {
            attempts: 100,
            ..o.clone()
        }
        .validate()
        .is_err());
        assert!(Options {
            timeout: Duration::ZERO,
            ..o.clone()
        }
        .validate()
        .is_err());
        assert!(Options {
            ttl: 256,
            ..o.clone()
        }
        .validate()
        .is_err());
        assert!(Options {
            payload_size: 8,
            ..o
        }
        .validate()
        .is_err());
    }
    #[test]
    fn deterministic_native_timeout_retries() {
        let mut fake = fake();
        let ip = "::1".parse().unwrap();
        let o = Options::default();
        let result = probe(&mut fake, ip, ip, 7, &[1; 56], &o).unwrap();
        assert_eq!(result.latency, None);
        assert!(result.message.contains("timed out"));
        assert_eq!(fake.sends.len(), 3);
        for (i, p) in fake.sends.iter().enumerate() {
            assert_eq!(&p[6..8], &((i + 1) as u16).to_be_bytes());
        }
    }
    #[test]
    fn deterministic_native_success_and_receive_error() {
        let ip = "::1".parse().unwrap();
        let o = Options::default();
        let mut msg = packet::echo(ip, ip, 7, 1, &[1; 56]);
        msg[0] = 129;
        msg[2..4].fill(0);
        let sum = packet::checksum_v6("::1".parse().unwrap(), "::1".parse().unwrap(), &msg);
        msg[2..4].copy_from_slice(&sum.to_be_bytes());
        let mut fake = fake();
        fake.response = Some(msg);
        let result = probe(&mut fake, ip, ip, 7, &[1; 56], &o).unwrap();
        assert!(result.latency.unwrap() >= 0.0);
        assert!(result.message.is_empty());
        assert_eq!(fake.sends.len(), 1);
        fake.fail = Some(io::ErrorKind::Other);
        assert!(probe(&mut fake, ip, ip, 7, &[1; 56], &o)
            .unwrap_err()
            .contains("receive"));
    }
    #[test]
    fn permission_and_network_mapping() {
        for code in [1, 13, 10013] {
            assert!(
                operation_error("socket creation", &io::Error::from_raw_os_error(code))
                    .contains("permission denied")
            );
        }
        assert_eq!(
            network_error(&io::Error::from(io::ErrorKind::NetworkUnreachable)),
            Some("Network unreachable")
        );
        assert_eq!(
            network_error(&io::Error::from(io::ErrorKind::HostUnreachable)),
            Some("Host unreachable")
        );
        assert_eq!(network_error(&io::Error::from_raw_os_error(5)), None);
    }
    #[test]
    fn repeated_deterministic_timeout_success_and_drop() {
        for _ in 0..200 {
            deterministic_native_timeout_retries();
            deterministic_native_success_and_receive_error();
        }
    }
}
