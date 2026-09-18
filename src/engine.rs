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
        format!("ICMP {stage}: raw-socket permission denied; Windows requires Administrator privileges, Linux requires CAP_NET_RAW/root, macOS requires root ({error})")
    } else {
        format!("ICMP {stage}: {error}")
    }
}
fn network_error(error: &io::Error) -> Option<&'static str> {
    // ENETUNREACH/EHOSTUNREACH on Linux/BSD and Winsock equivalents.
    match error.raw_os_error() {
        Some(101 | 51 | 10051) => Some("Network unreachable"),
        Some(113 | 65 | 10065) => Some("Host unreachable"),
        _ => None,
    }
}

pub trait Transport {
    fn send(&mut self, packet: &[u8], target: IpAddr) -> io::Result<()>;
    fn receive(&mut self, bytes: &mut [u8], wait: Duration) -> io::Result<(usize, IpAddr)>;
}
pub struct Raw {
    socket: UdpSocket,
}
impl Raw {
    pub fn open(target: IpAddr, options: &Options) -> Result<(Self, IpAddr), String> {
        let socket = Socket::new(
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
        )
        .map_err(|e| operation_error("socket creation", &e))?;
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
        // SOCK_RAW to UDP and does not introduce a UDP transport or session.
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
        self.socket
            .recv_from(bytes)
            .map(|(length, source)| (length, source.ip()))
    }
}

pub fn probe<T: Transport>(
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
                    match packet::parse(
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
            network_error(&io::Error::from_raw_os_error(10051)),
            Some("Network unreachable")
        );
        assert_eq!(
            network_error(&io::Error::from_raw_os_error(10065)),
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
