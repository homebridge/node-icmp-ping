//! Independent Echo codec. Packet size is payload bytes, excluding the 8-byte header.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, PartialEq)]
pub enum Reply {
    Echo,
    Negative(String),
}

pub fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0u32;
    for word in bytes.chunks(2) {
        sum += u16::from_be_bytes([word[0], *word.get(1).unwrap_or(&0)]) as u32;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

pub fn checksum_v6(source: Ipv6Addr, target: Ipv6Addr, packet: &[u8]) -> u16 {
    let mut bytes = Vec::with_capacity(40 + packet.len());
    bytes.extend(source.octets());
    bytes.extend(target.octets());
    bytes.extend((packet.len() as u32).to_be_bytes());
    bytes.extend([0, 0, 0, 58]);
    bytes.extend(packet);
    checksum(&bytes)
}

pub fn echo(target: IpAddr, local: IpAddr, id: u16, seq: u16, payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![if target.is_ipv4() { 8 } else { 128 }, 0, 0, 0];
    packet.extend(id.to_be_bytes());
    packet.extend(seq.to_be_bytes());
    packet.extend(payload);
    let sum = match (local, target) {
        (IpAddr::V6(source), IpAddr::V6(target)) => checksum_v6(source, target, &packet),
        _ => checksum(&packet),
    };
    packet[2..4].copy_from_slice(&sum.to_be_bytes());
    packet
}

fn matches(packet: &[u8], id: u16, seq: u16) -> bool {
    packet.len() >= 8 && packet[4..6] == id.to_be_bytes() && packet[6..8] == seq.to_be_bytes()
}

fn ipv4(packet: &[u8], quoted: bool) -> Option<(&[u8], IpAddr, IpAddr)> {
    if packet.len() < 20 || packet[0] >> 4 != 4 || packet[9] != 1 {
        return None;
    }
    let header = (packet[0] as usize & 15) * 4;
    let length = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    // Reject fragments and malformed header lengths, including quoted fragments.
    if header < 20
        || header > packet.len()
        || length < header + 8
        || u16::from_be_bytes([packet[6], packet[7]]) & 0x3fff != 0
    {
        return None;
    }
    let end = if quoted {
        length.min(packet.len())
    } else {
        if length > packet.len() {
            return None;
        }
        length
    };
    let source = IpAddr::V4(Ipv4Addr::new(
        packet[12], packet[13], packet[14], packet[15],
    ));
    let target = IpAddr::V4(Ipv4Addr::new(
        packet[16], packet[17], packet[18], packet[19],
    ));
    Some((&packet[header..end], source, target))
}

fn quoted_v6(packet: &[u8]) -> Option<(&[u8], IpAddr)> {
    if packet.len() < 40 || packet[0] >> 4 != 6 {
        return None;
    }
    let target = IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&packet[24..40]).ok()?));
    let length = 40 + u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let packet = &packet[..length.min(packet.len())];
    let mut next = packet[6];
    let mut offset = 40usize;
    // Bound extension traversal; do not treat fragment bodies as an Echo header.
    for _ in 0..16 {
        if next == 58 {
            return Some((packet.get(offset..)?, target));
        }
        let ext = packet.get(offset..)?;
        if ext.len() < 8 {
            return None;
        }
        let size = match next {
            0 | 43 | 60 => (ext[1] as usize + 1) * 8,
            44 => {
                if u16::from_be_bytes([ext[2], ext[3]]) & 0xfff9 != 0 {
                    return None;
                }
                8
            }
            51 => (ext[1] as usize + 2) * 4,
            _ => return None,
        };
        next = ext[0];
        offset = offset.checked_add(size)?;
        if offset > packet.len() {
            return None;
        }
    }
    None
}

fn reason(v6: bool, kind: u8, code: u8) -> Option<&'static str> {
    match (v6, kind, code) {
        (false, 3, 0) => Some("Network unreachable"),
        (false, 3, 1) => Some("Host unreachable"),
        (false, 3, 4) => Some("Packet too big"),
        (false, 3, 9 | 10 | 13) => Some("Communication administratively prohibited"),
        (false, 3, _) => Some("Destination unreachable"),
        (false, 11, _) | (true, 3, _) => Some("Time exceeded"),
        (false, 12, _) | (true, 4, _) => Some("Parameter problem"),
        (true, 1, 0) => Some("Network unreachable"),
        (true, 1, 1) => Some("Communication administratively prohibited"),
        (true, 1, 3) => Some("Host unreachable"),
        (true, 1, _) => Some("Destination unreachable"),
        (true, 2, _) => Some("Packet too big"),
        _ => None,
    }
}

pub struct Expected<'a> {
    pub target: IpAddr,
    pub local: IpAddr,
    pub id: u16,
    pub seq: u16,
    pub payload: &'a [u8],
}

pub fn parse(bytes: &[u8], source: IpAddr, expected: &Expected<'_>) -> Option<Reply> {
    let v6 = expected.target.is_ipv6();
    let packet = if v6 {
        bytes
    } else {
        let (packet, header_source, header_target) = ipv4(bytes, false)?;
        if header_source != source || header_target != expected.local {
            return None;
        }
        packet
    };
    if packet.len() < 8 {
        return None;
    }
    let sum = match (source, expected.local) {
        (IpAddr::V6(source), IpAddr::V6(local)) if v6 => checksum_v6(source, local, packet),
        (IpAddr::V4(_), IpAddr::V4(_)) if !v6 => checksum(packet),
        _ => return None,
    };
    if sum != 0 {
        return None;
    }
    if packet[0] == if v6 { 129 } else { 0 } {
        return (packet[1] == 0
            && source == expected.target
            && matches(packet, expected.id, expected.seq)
            && packet[8..] == *expected.payload)
            .then_some(Reply::Echo);
    }
    let message = reason(v6, packet[0], packet[1])?;
    let (quoted, destination) = if v6 {
        quoted_v6(&packet[8..])?
    } else {
        let (quoted, _, destination) = ipv4(&packet[8..], true)?;
        (quoted, destination)
    };
    if destination != expected.target
        || quoted.first() != Some(&if v6 { 128 } else { 8 })
        || quoted.get(1) != Some(&0)
        || !matches(quoted, expected.id, expected.seq)
    {
        return None;
    }
    // A minimal quote contains only the header. Validate any quoted payload bytes too.
    let data = &quoted[8..];
    if data.len() > expected.payload.len() || data != &expected.payload[..data.len()] {
        return None;
    }
    Some(Reply::Negative(format!("{message} (source={source})")))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn wrap4(message: &[u8], source: IpAddr, target: IpAddr) -> Vec<u8> {
        let mut bytes = vec![0; 20];
        bytes[0] = 0x45;
        bytes[9] = 1;
        bytes[2..4].copy_from_slice(&((20 + message.len()) as u16).to_be_bytes());
        if let IpAddr::V4(a) = source {
            bytes[12..16].copy_from_slice(&a.octets());
        }
        if let IpAddr::V4(a) = target {
            bytes[16..20].copy_from_slice(&a.octets());
        }
        bytes.extend(message);
        bytes
    }
    #[test]
    fn known_checksum_and_odd_length() {
        assert_eq!(checksum(&[0, 1, 0xf2, 3, 0xf4, 0xf5, 0xf6, 0xf7]), 0x220d);
        assert_eq!(checksum(&[1, 2, 3]), 0xfbfd);
    }
    #[test]
    fn encode_v4() {
        let packet = echo(ip("127.0.0.1"), ip("127.0.0.1"), 0x1234, 2, &[0; 56]);
        assert_eq!(packet.len(), 64);
        assert_eq!(&packet[..2], &[8, 0]);
        assert_eq!(&packet[4..8], &[0x12, 0x34, 0, 2]);
        assert_eq!(checksum(&packet), 0);
    }
    #[test]
    fn encode_v6_and_pseudo_header() {
        let packet = echo(ip("::1"), ip("::1"), 0x1234, 2, &[0; 56]);
        assert_eq!(packet[0], 128);
        assert_eq!(packet.len(), 64);
        assert_eq!(
            checksum_v6(Ipv6Addr::LOCALHOST, Ipv6Addr::LOCALHOST, &packet),
            0
        );
        assert_ne!(
            checksum_v6(Ipv6Addr::LOCALHOST, "::2".parse().unwrap(), &packet),
            0
        );
    }
    #[test]
    fn reply_matching_and_corruption() {
        for (target, local) in [(ip("127.0.0.2"), ip("127.0.0.1")), (ip("::2"), ip("::1"))] {
            let payload = [7; 56];
            let exp = Expected {
                target,
                local,
                id: 12,
                seq: 3,
                payload: &payload,
            };
            let mut msg = echo(local, target, 12, 3, &payload);
            msg[0] = if target.is_ipv6() { 129 } else { 0 };
            msg[2..4].fill(0);
            let sum = match (target, local) {
                (IpAddr::V6(a), IpAddr::V6(b)) => checksum_v6(a, b, &msg),
                _ => checksum(&msg),
            };
            msg[2..4].copy_from_slice(&sum.to_be_bytes());
            let packet = if target.is_ipv6() {
                msg.clone()
            } else {
                wrap4(&msg, target, local)
            };
            assert_eq!(parse(&packet, target, &exp), Some(Reply::Echo));
            assert_eq!(parse(&packet, target, &Expected { seq: 4, ..exp }), None);
            assert_eq!(parse(&packet, target, &Expected { id: 13, ..exp }), None);
            assert_eq!(parse(&packet, local, &exp), None);
            for length in 0..packet.len() {
                assert_eq!(parse(&packet[..length], target, &exp), None);
            }
            let mut bad = packet.clone();
            *bad.last_mut().unwrap() ^= 1;
            assert_eq!(parse(&bad, target, &exp), None);
            let request = echo(target, local, 12, 3, &payload);
            let request = if target.is_ipv6() {
                request
            } else {
                wrap4(&request, local, target)
            };
            assert_eq!(parse(&request, local, &exp), None);
        }
    }
    #[test]
    fn quoted_v4_negative_and_mismatches() {
        let local = ip("192.0.2.1");
        let target = ip("192.0.2.2");
        let router = ip("192.0.2.3");
        let payload = [7; 56];
        let exp = Expected {
            local,
            target,
            id: 15,
            seq: 2,
            payload: &payload,
        };
        let quoted = wrap4(&echo(target, local, 15, 2, &payload), local, target);
        let mut msg = vec![3, 1, 0, 0, 0, 0, 0, 0];
        msg.extend(&quoted[..28]);
        let sum = checksum(&msg);
        msg[2..4].copy_from_slice(&sum.to_be_bytes());
        let packet = wrap4(&msg, router, local);
        assert!(
            matches!(parse(&packet,router,&exp),Some(Reply::Negative(s)) if s.contains("Host unreachable"))
        );
        assert_eq!(parse(&packet, router, &Expected { id: 16, ..exp }), None);
        assert_eq!(
            parse(
                &packet,
                router,
                &Expected {
                    target: ip("192.0.2.4"),
                    ..exp
                }
            ),
            None
        );
    }
    #[test]
    fn quoted_v6_negative_extensions() {
        let local = ip("::1");
        let target = ip("::2");
        let router = ip("::3");
        let payload = [7; 56];
        let exp = Expected {
            local,
            target,
            id: 15,
            seq: 2,
            payload: &payload,
        };
        let mut quote = vec![0; 40];
        quote[0] = 0x60;
        quote[6] = 60;
        quote[4..6].copy_from_slice(&72u16.to_be_bytes());
        if let IpAddr::V6(a) = target {
            quote[24..40].copy_from_slice(&a.octets());
        }
        quote.extend([58, 0, 0, 0, 0, 0, 0, 0]);
        quote.extend(echo(target, local, 15, 2, &payload));
        let mut msg = vec![1, 3, 0, 0, 0, 0, 0, 0];
        msg.extend(&quote[..56]);
        let sum = checksum_v6("::3".parse().unwrap(), "::1".parse().unwrap(), &msg);
        msg[2..4].copy_from_slice(&sum.to_be_bytes());
        assert!(
            matches!(parse(&msg,router,&exp),Some(Reply::Negative(s)) if s.contains("Host unreachable"))
        );
        assert_eq!(parse(&msg, router, &Expected { seq: 3, ..exp }), None);
        quote[41] = 255;
        assert_eq!(quoted_v6(&quote), None);
    }
    #[test]
    fn ipv4_options_and_fragments() {
        let mut packet = wrap4(&[0; 8], ip("127.0.0.1"), ip("127.0.0.1"));
        packet.splice(20..20, [0; 4]);
        packet[0] = 0x46;
        packet[2..4].copy_from_slice(&32u16.to_be_bytes());
        assert_eq!(ipv4(&packet, false).unwrap().0.len(), 8);
        packet[6] = 0x20;
        assert!(ipv4(&packet, false).is_none());
        packet[6] = 0;
        packet[0] = 0x44;
        assert!(ipv4(&packet, false).is_none());
    }
    #[test]
    fn error_categories() {
        assert_eq!(reason(false, 3, 0), Some("Network unreachable"));
        assert_eq!(reason(true, 2, 0), Some("Packet too big"));
        assert_eq!(reason(true, 4, 0), Some("Parameter problem"));
        assert_eq!(reason(false, 11, 0), Some("Time exceeded"));
        assert_eq!(reason(false, 8, 0), None);
    }
}
