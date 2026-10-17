//! Linux-only ping socket adapter. Raw socket setup and receive stay in engine.rs.
use crate::engine::{operation_error, Options, Transport};
use crate::packet::{self, Expected, Reply};
use socket2::Socket;
use std::io;
use std::mem::{self, size_of};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

pub(crate) struct Ping {
    socket: UdpSocket,
    id: u16,
    target: IpAddr,
    error: Option<ExtendedError>,
}

#[derive(Clone, Copy, Debug)]
struct ExtendedError {
    origin: u8,
    kind: u8,
    code: u8,
    errno: u32,
    offender: Option<IpAddr>,
}

impl Ping {
    pub(crate) fn open(
        socket: Socket,
        target: IpAddr,
        options: &Options,
    ) -> Result<(Self, IpAddr), String> {
        let setup = || -> io::Result<(Self, IpAddr)> {
            if target.is_ipv4() {
                socket.set_ttl_v4(options.ttl)?;
            } else {
                socket.set_unicast_hops_v6(options.ttl)?;
            }
            let route = UdpSocket::bind(SocketAddr::new(
                if target.is_ipv4() {
                    "0.0.0.0".parse().unwrap()
                } else {
                    "::".parse().unwrap()
                },
                0,
            ))?;
            route.connect(SocketAddr::new(target, 33434))?;
            let local = route.local_addr()?.ip();
            // Port zero asks Linux for an exclusive Echo identifier. Do not set
            // SO_REUSEADDR/SO_REUSEPORT or assume the application lease is used.
            socket.bind(&SocketAddr::new(local, 0).into())?;
            let id = socket
                .local_addr()?
                .as_socket()
                .ok_or_else(|| io::Error::other("Missing ping socket address"))?
                .port();
            if id == 0 {
                return Err(io::Error::other("Missing kernel Echo identifier"));
            }
            let enabled: libc::c_int = 1;
            let (level, option) = if target.is_ipv4() {
                (libc::IPPROTO_IP, libc::IP_RECVERR)
            } else {
                (libc::IPPROTO_IPV6, libc::IPV6_RECVERR)
            };
            // SAFETY: live owned descriptor and a correctly sized initialized int.
            if unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    level,
                    option,
                    (&enabled as *const libc::c_int).cast(),
                    size_of::<libc::c_int>() as libc::socklen_t,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            socket.set_write_timeout(Some(options.timeout))?;
            Ok((
                Self {
                    socket: socket.into(),
                    id,
                    target,
                    error: None,
                },
                local,
            ))
        };
        setup().map_err(|e| operation_error("Linux ping socket setup", &e))
    }

    // MSG_ERRQUEUE contains the quoted original ICMP message (no IP header),
    // the original destination in msg_name, and sock_extended_err + offender.
    fn queued_error(&mut self, bytes: &mut [u8]) -> io::Result<Option<(usize, IpAddr)>> {
        let mut address: libc::sockaddr_storage = unsafe { mem::zeroed() };
        // usize alignment satisfies cmsghdr on all supported Linux ABIs.
        let mut control = [0usize; 64];
        let mut iov = libc::iovec {
            iov_base: bytes.as_mut_ptr().cast(),
            iov_len: bytes.len(),
        };
        let mut msg: libc::msghdr = unsafe { mem::zeroed() };
        msg.msg_name = (&mut address as *mut libc::sockaddr_storage).cast();
        msg.msg_namelen = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = size_of_val(&control);
        // SAFETY: all buffers above remain live and writable for the syscall.
        let length = unsafe {
            libc::recvmsg(
                self.socket.as_raw_fd(),
                &mut msg,
                libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT,
            )
        };
        if length < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::WouldBlock {
                Ok(None)
            } else {
                Err(error)
            };
        }
        self.error = None;
        // A consumed but unusable entry is returned as an empty, ignored event.
        let ignored = Some((0, self.target));
        if msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0 {
            return Ok(ignored);
        }
        let Some(destination) = sockaddr_ip(&address, msg.msg_namelen as usize) else {
            return Ok(ignored);
        };
        // SAFETY: CMSG traversal is confined to the initialized control buffer
        // returned by the kernel; length checks precede each payload read.
        unsafe {
            let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
            while !cmsg.is_null() {
                let header = &*cmsg;
                let relevant = if self.target.is_ipv4() {
                    header.cmsg_level == libc::IPPROTO_IP && header.cmsg_type == libc::IP_RECVERR
                } else {
                    header.cmsg_level == libc::IPPROTO_IPV6
                        && header.cmsg_type == libc::IPV6_RECVERR
                };
                let base = libc::CMSG_LEN(0) as usize;
                if relevant && header.cmsg_len >= base + size_of::<libc::sock_extended_err>() {
                    let data = libc::CMSG_DATA(cmsg);
                    let error = data.cast::<libc::sock_extended_err>().read_unaligned();
                    let available = header.cmsg_len - base - size_of::<libc::sock_extended_err>();
                    let mut offender: libc::sockaddr_storage = mem::zeroed();
                    let count = available.min(size_of::<libc::sockaddr_storage>());
                    std::ptr::copy_nonoverlapping(
                        data.add(size_of::<libc::sock_extended_err>()),
                        (&mut offender as *mut libc::sockaddr_storage).cast::<u8>(),
                        count,
                    );
                    self.error = Some(ExtendedError {
                        origin: error.ee_origin,
                        kind: error.ee_type,
                        code: error.ee_code,
                        errno: error.ee_errno,
                        offender: sockaddr_ip(&offender, count),
                    });
                    return Ok(Some((length as usize, destination)));
                }
                cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
            }
        }
        Ok(ignored)
    }
}

fn sockaddr_ip(address: &libc::sockaddr_storage, length: usize) -> Option<IpAddr> {
    // SAFETY: family and returned length are checked; storage has sufficient
    // size/alignment for either sockaddr. Addresses are in network byte order.
    unsafe {
        match address.ss_family as i32 {
            libc::AF_INET if length >= size_of::<libc::sockaddr_in>() => {
                let addr = (address as *const libc::sockaddr_storage)
                    .cast::<libc::sockaddr_in>()
                    .read();
                Some(IpAddr::V4(addr.sin_addr.s_addr.to_ne_bytes().into()))
            }
            libc::AF_INET6 if length >= size_of::<libc::sockaddr_in6>() => {
                let addr = (address as *const libc::sockaddr_storage)
                    .cast::<libc::sockaddr_in6>()
                    .read();
                Some(IpAddr::V6(addr.sin6_addr.s6_addr.into()))
            }
            _ => None,
        }
    }
}

fn parse_error(
    bytes: &[u8],
    destination: IpAddr,
    error: ExtendedError,
    expected: &Expected<'_>,
) -> Option<Reply> {
    let request = packet::echo(
        expected.target,
        expected.local,
        expected.id,
        expected.seq,
        expected.payload,
    );
    // Match even minimal quotes to the wire identifier, sequence and checksum;
    // validate every quoted payload byte. Old attempts and recycled identifiers
    // must not turn an unrelated error into this invocation's negative result.
    if destination != expected.target
        || bytes.len() < 8
        || bytes.len() > request.len()
        || bytes != &request[..bytes.len()]
    {
        return None;
    }
    let origin = if expected.target.is_ipv4() {
        libc::SO_EE_ORIGIN_ICMP
    } else {
        libc::SO_EE_ORIGIN_ICMP6
    };
    let reason = if error.origin == origin {
        packet::reason(expected.target.is_ipv6(), error.kind, error.code)?
    } else if error.origin == libc::SO_EE_ORIGIN_LOCAL && error.errno == libc::EMSGSIZE as u32 {
        "Packet too big"
    } else {
        return None;
    };
    Some(Reply::Negative(match error.offender {
        Some(source) => format!("{reason} (source={source})"),
        None => reason.into(),
    }))
}

impl Transport for Ping {
    fn identifier(&self, _: u16) -> u16 {
        self.id
    }
    fn parse_reply(&self, bytes: &[u8], source: IpAddr, expected: &Expected<'_>) -> Option<Reply> {
        match self.error {
            Some(error) => parse_error(bytes, source, error, expected),
            None => packet::parse_ping_echo(bytes, source, expected),
        }
    }
    fn send(&mut self, packet: &[u8], target: IpAddr) -> io::Result<()> {
        // Clear errors from the previous attempt before sending the next one.
        // Bound draining so unsolicited traffic cannot extend the probe forever.
        let mut discard = [0u8; 2048];
        for _ in 0..64 {
            if self.queued_error(&mut discard)?.is_none() {
                break;
            }
        }
        self.socket.take_error()?;
        self.error = None;
        // Linux replaces identifier/checksum. The encoded values already match
        // its assigned identifier and checksum, allowing exact error correlation.
        let sent = match self.socket.send_to(packet, SocketAddr::new(target, 0)) {
            Ok(sent) => sent,
            Err(error) => {
                // An old error can arrive between draining and send. If an
                // error record is queued, clear it and retry the failed syscall
                // once (no Echo was sent by the failed syscall).
                let mut queued = false;
                for _ in 0..64 {
                    if self.queued_error(&mut discard)?.is_none() {
                        break;
                    }
                    queued = true;
                }
                self.error = None;
                if !queued {
                    return Err(io::Error::other(error));
                }
                self.socket.take_error()?;
                self.socket
                    .send_to(packet, SocketAddr::new(target, 0))
                    .map_err(io::Error::other)?
            }
        };
        if sent != packet.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Incomplete ICMP ping send",
            ));
        }
        Ok(())
    }
    fn receive(&mut self, bytes: &mut [u8], wait: Duration) -> io::Result<(usize, IpAddr)> {
        let deadline = Instant::now() + wait;
        loop {
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            if let Some(event) = self.queued_error(bytes)? {
                return Ok(event);
            }
            self.error = None;
            // poll wakes for both Echo data and the extended error queue. Avoid
            // treating sk_err alone as a correlated negative reply.
            let mut fd = libc::pollfd {
                fd: self.socket.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let millis = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .saturating_add(1)
                .clamp(1, i32::MAX as u128) as i32;
            // SAFETY: a live descriptor and a single initialized pollfd.
            let ready = unsafe { libc::poll(&mut fd, 1, millis) };
            if ready < 0 {
                return Err(io::Error::last_os_error());
            }
            if ready == 0 {
                return Err(io::ErrorKind::TimedOut.into());
            }
            if let Some(event) = self.queued_error(bytes)? {
                return Ok(event);
            }
            if fd.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::other("Invalid ping socket"));
            }
            if fd.revents & libc::POLLIN == 0 {
                self.socket.take_error()?;
                continue;
            }
            // Only this invocation receives from this socket. A bounded timeout
            // also handles a spurious readiness notification.
            self.socket.set_read_timeout(Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            ))?;
            match self.socket.recv_from(bytes) {
                Ok((length, source)) => {
                    self.error = None;
                    return Ok((length, source.ip()));
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    return Err(e)
                }
                Err(e) => {
                    if let Some(event) = self.queued_error(bytes)? {
                        return Ok(event);
                    }
                    // A bare asynchronous errno has no sequence/payload
                    // evidence. Reject the operation instead of reporting an
                    // uncorrelated ICMP negative through engine::network_error.
                    return Err(io::Error::other(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{self, probe};
    use socket2::{Domain, Protocol, Type};

    #[test]
    fn error_queue_correlation() {
        for (local, target, router) in [
            ("192.0.2.1", "192.0.2.2", "192.0.2.3"),
            ("2001:db8::1", "2001:db8::2", "2001:db8::3"),
        ] {
            let local: IpAddr = local.parse().unwrap();
            let target: IpAddr = target.parse().unwrap();
            let router = router.parse().unwrap();
            let payload = [7; 57];
            let expected = Expected {
                local,
                target,
                id: 43210,
                seq: 2,
                payload: &payload,
            };
            let request = packet::echo(target, local, expected.id, expected.seq, &payload);
            let kinds: &[u8] = if target.is_ipv4() {
                &[3, 11, 12]
            } else {
                &[1, 2, 3, 4]
            };
            for &kind in kinds {
                for code in 0..=15 {
                    let error = ExtendedError {
                        origin: if target.is_ipv4() {
                            libc::SO_EE_ORIGIN_ICMP
                        } else {
                            libc::SO_EE_ORIGIN_ICMP6
                        },
                        kind,
                        code,
                        errno: libc::EHOSTUNREACH as u32,
                        offender: Some(router),
                    };
                    for length in [8, 9, request.len()] {
                        let quote = &request[..length];
                        assert!(matches!(
                            parse_error(quote, target, error, &expected),
                            Some(Reply::Negative(_))
                        ));
                        assert_eq!(parse_error(quote, local, error, &expected), None);
                        assert_eq!(
                            parse_error(
                                quote,
                                target,
                                error,
                                &Expected {
                                    id: 43211,
                                    ..expected
                                }
                            ),
                            None
                        );
                        assert_eq!(
                            parse_error(quote, target, error, &Expected { seq: 1, ..expected }),
                            None
                        );
                        assert_eq!(
                            parse_error(
                                quote,
                                target,
                                error,
                                &Expected {
                                    payload: &[8; 57],
                                    ..expected
                                }
                            ),
                            None
                        );
                        assert_eq!(
                            parse_error(
                                quote,
                                target,
                                ExtendedError {
                                    origin: 99,
                                    ..error
                                },
                                &expected
                            ),
                            None
                        );
                        for index in 0..length {
                            let mut corrupt = quote.to_vec();
                            corrupt[index] ^= 1;
                            assert_eq!(parse_error(&corrupt, target, error, &expected), None);
                        }
                    }
                    for length in 0..8 {
                        assert_eq!(
                            parse_error(&request[..length], target, error, &expected),
                            None
                        );
                    }
                }
            }
            let local_error = ExtendedError {
                origin: libc::SO_EE_ORIGIN_LOCAL,
                kind: 0,
                code: 0,
                errno: libc::EMSGSIZE as u32,
                offender: None,
            };
            assert_eq!(
                parse_error(&request, target, local_error, &expected),
                Some(Reply::Negative("Packet too big".into()))
            );
        }
    }

    #[test]
    fn sockaddr_lengths_and_families() {
        let mut address: libc::sockaddr_storage = unsafe { mem::zeroed() };
        assert_eq!(sockaddr_ip(&address, size_of_val(&address)), None);
        address.ss_family = libc::AF_INET as _;
        assert_eq!(
            sockaddr_ip(&address, size_of::<libc::sockaddr_in>() - 1),
            None
        );
        address.ss_family = libc::AF_INET6 as _;
        assert_eq!(
            sockaddr_ip(&address, size_of::<libc::sockaddr_in6>() - 1),
            None
        );
    }

    // Explicitly run by the Linux namespace harness, never silently skipped.
    #[test]
    #[ignore = "requires Linux namespace harness; see scripts/test-linux-ping.sh"]
    fn linux_socket_integration() {
        let mode = std::env::var("ICMP_LINUX_TEST_MODE").expect("namespace harness mode");
        let before = std::fs::read_dir("/proc/self/fd").unwrap().count();
        for address in ["127.0.0.1", "::1"] {
            let target: IpAddr = address.parse().unwrap();
            let options = Options {
                timeout: Duration::from_millis(80),
                ..Options::default()
            };
            let raw = Socket::new(
                if target.is_ipv4() {
                    Domain::IPV4
                } else {
                    Domain::IPV6
                },
                Type::RAW,
                Some(if target.is_ipv4() {
                    Protocol::ICMPV4
                } else {
                    Protocol::ICMPV6
                }),
            );
            if mode == "raw" {
                drop(raw.expect("raw privileges required for primary-path check"));
                let (mut socket, local) = engine::Raw::open(target, &options).unwrap();
                assert_eq!(socket.identifier(1234), 1234);
                assert!(probe(&mut socket, target, local, 1234, &[7; 56], &options)
                    .unwrap()
                    .latency
                    .is_some());
                let (socket, _) = engine::open(target, &options).unwrap();
                assert_eq!(socket.identifier(1234), 1234);
                continue;
            }
            assert_eq!(
                raw.unwrap_err().kind(),
                io::ErrorKind::PermissionDenied,
                "test must not have raw privileges"
            );
            if mode == "denied" {
                for _ in 0..64 {
                    let error = match engine::open(target, &options) {
                        Ok(_) => panic!("ping group restriction not applied"),
                        Err(error) => error,
                    };
                    assert!(error.contains("ping_group_range"));
                    assert!(error.contains("raw socket creation denied"));
                }
                continue;
            }
            if mode == "echo" {
                for _ in 0..16 {
                    let socket = Socket::new(
                        if target.is_ipv4() {
                            Domain::IPV4
                        } else {
                            Domain::IPV6
                        },
                        Type::DGRAM,
                        Some(if target.is_ipv4() {
                            Protocol::ICMPV4
                        } else {
                            Protocol::ICMPV6
                        }),
                    )
                    .unwrap();
                    assert!(Ping::open(
                        socket,
                        target,
                        &Options {
                            ttl: 256,
                            ..options.clone()
                        }
                    )
                    .is_err());
                }
                // Retain every socket concurrently to prove unique kernel IDs,
                // then run real Echo probes with different payload lengths.
                let mut sockets = Vec::new();
                let mut ids = std::collections::HashSet::new();
                for _ in 0..32 {
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
                    let socket = Socket::new(domain, Type::DGRAM, Some(protocol)).unwrap();
                    let (ping, _) = Ping::open(socket, target, &options).unwrap();
                    assert_ne!(ping.id, 0);
                    assert!(ids.insert(ping.id));
                    sockets.push(ping);
                }
                drop(sockets);
                std::thread::scope(|scope| {
                    for iteration in 0..24 {
                        let options = &options;
                        scope.spawn(move || {
                            let options = Options {
                                payload_size: [16, 57, 1200][iteration % 3],
                                timeout: Duration::from_secs(1),
                                ..options.clone()
                            };
                            let payload = vec![iteration as u8; options.payload_size];
                            let (mut socket, local) = engine::open(target, &options).unwrap();
                            assert!(probe(&mut *socket, target, local, 0, &payload, &options)
                                .unwrap()
                                .latency
                                .is_some());
                        });
                    }
                });
            }
            for _ in 0..16 {
                let (mut socket, local) = engine::open(target, &options).unwrap();
                let start = Instant::now();
                let result = probe(&mut *socket, target, local, 0, &[7; 56], &options).unwrap();
                match mode.as_str() {
                    "echo" => assert!(result.latency.is_some(), "{}", result.message),
                    "drop" => {
                        assert!(
                            result.message.contains("timed out after 3 attempts"),
                            "{}",
                            result.message
                        );
                        assert!(start.elapsed() >= options.timeout * 3);
                        assert!(start.elapsed() < Duration::from_secs(2));
                    }
                    "reject" => {
                        assert!(result.latency.is_none());
                        assert!(
                            result.message.contains("unreachable")
                                || result.message.contains("prohibited"),
                            "{}",
                            result.message
                        );
                        assert!(start.elapsed() < options.timeout * 3);
                    }
                    _ => panic!("unknown mode {mode}"),
                }
            }
        }
        assert_eq!(
            std::fs::read_dir("/proc/self/fd").unwrap().count(),
            before,
            "socket leak in {mode}"
        );
    }
}
