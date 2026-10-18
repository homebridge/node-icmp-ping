//! Permission-only Windows Echo adapter. All IP Helper calls are synchronous on
//! the existing Node-API worker: no callback can outlive its buffers or handle.
use crate::engine::{operation_error, Options, Raw, Transport};
use crate::packet::{Expected, Reply};
use socket2::{Domain, Protocol, Socket, Type};
use std::io;
use std::mem::size_of;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::ptr;
use std::time::Duration;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::*;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

fn select<S>(
    raw: io::Result<S>,
    fallback: impl FnOnce() -> Result<S, String>,
) -> Result<S, String> {
    match raw {
        Ok(raw) => Ok(raw),
        Err(error) if error.raw_os_error() == Some(10013) => fallback().map_err(|fallback| {
            format!("ICMP raw socket creation denied ({error}); Windows ICMP Echo fallback failed: {fallback}")
        }),
        Err(error) => Err(operation_error("socket creation", &error)),
    }
}

pub fn open(target: IpAddr, options: &Options) -> Result<(Box<dyn Transport>, IpAddr), String> {
    // Keep creation separate from raw configuration: only WSAEACCES here permits
    // fallback. Configuration/send/receive failures never change transports.
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
    enum Selected {
        Raw(Socket),
        Echo(Native),
    }
    match select(raw.map(Selected::Raw), || {
        Native::open(target, options).map(Selected::Echo)
    })? {
        Selected::Raw(socket) => {
            let (raw, local) = Raw::from_socket(socket, target, options)?;
            Ok((Box::new(raw), local))
        }
        Selected::Echo(api) => {
            // The OS chooses the source and owns identifiers/checksums. The
            // engine's encoded header is discarded; only its payload is sent.
            let local = if target.is_ipv4() {
                Ipv4Addr::UNSPECIFIED.into()
            } else {
                Ipv6Addr::UNSPECIFIED.into()
            };
            Ok((Box::new(Echo::new(api, target)), local))
        }
    }
}

trait EchoApi {
    fn exchange(&mut self, payload: &[u8], wait: Duration) -> io::Result<Option<Reply>>;
}

struct Echo<A> {
    api: A,
    target: IpAddr,
    pending: Option<Vec<u8>>,
    reply: Option<Reply>,
}
impl<A> Echo<A> {
    fn new(api: A, target: IpAddr) -> Self {
        Self {
            api,
            target,
            pending: None,
            reply: None,
        }
    }
}
impl<A: EchoApi> Transport for Echo<A> {
    fn send(&mut self, packet: &[u8], target: IpAddr) -> io::Result<()> {
        if target != self.target || packet.len() < 8 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid Echo request",
            ));
        }
        self.pending = Some(packet[8..].to_vec());
        self.reply = None;
        Ok(())
    }
    fn receive(&mut self, _: &mut [u8], wait: Duration) -> io::Result<(usize, IpAddr)> {
        if let Some(payload) = self.pending.take() {
            self.reply = self.api.exchange(&payload, wait)?;
            return Ok((0, self.target));
        }
        // A mismatched response consumes this request, not another send. Preserve
        // the engine deadline before retrying (at most one API call per attempt).
        std::thread::sleep(wait);
        Err(io::ErrorKind::TimedOut.into())
    }
    fn parse_reply(&self, _: &[u8], _: IpAddr, _: &Expected<'_>) -> Option<Reply> {
        match &self.reply {
            Some(Reply::Echo) => Some(Reply::Echo),
            Some(Reply::Negative(reason)) => Some(Reply::Negative(reason.clone())),
            None => None,
        }
    }
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: exclusively owned successful Icmp[6]CreateFile result; all
        // synchronous requests finished before Drop. Close exactly once.
        let _closed = unsafe { IcmpCloseHandle(self.0) };
        #[cfg(test)]
        assert_ne!(
            _closed, 0,
            "IcmpCloseHandle failed for an owned Echo handle"
        );
    }
}
struct Native {
    handle: Handle,
    target: IpAddr,
    ttl: u8,
}
impl Native {
    fn open(target: IpAddr, options: &Options) -> Result<Self, String> {
        options.validate()?;
        // SAFETY: no pointer parameters. INVALID_HANDLE_VALUE is not owned.
        let handle = unsafe {
            if target.is_ipv4() {
                IcmpCreateFile()
            } else {
                Icmp6CreateFile()
            }
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(operation_error(
                "Echo handle creation",
                &io::Error::last_os_error(),
            ));
        }
        Ok(Self {
            handle: Handle(handle),
            target,
            ttl: options.ttl as u8,
        })
    }
}

// IP_STATUS values are not Winsock errno values. Only documented network
// outcomes become negatives; resource/parameter/unknown errors reject. Some
// numeric values have different meanings for IPv4 and IPv6.
fn status(code: u32, v6: bool) -> io::Result<Reply> {
    let reason = match code {
        IP_SUCCESS => return Ok(Reply::Echo),
        IP_REQ_TIMED_OUT => return Err(io::ErrorKind::TimedOut.into()),
        IP_DEST_NET_UNREACHABLE => "Network unreachable",
        IP_DEST_HOST_UNREACHABLE => "Host unreachable",
        IP_DEST_PROT_UNREACHABLE if v6 => "Communication administratively prohibited",
        IP_DEST_PROT_UNREACHABLE | IP_DEST_PORT_UNREACHABLE => "Destination unreachable",
        IP_PACKET_TOO_BIG => "Packet too big",
        IP_TTL_EXPIRED_TRANSIT | IP_TTL_EXPIRED_REASSEM => "Time exceeded",
        IP_PARAM_PROBLEM => "Parameter problem",
        IP_DEST_UNREACHABLE | IP_DEST_SCOPE_MISMATCH if v6 => "Destination unreachable",
        IP_TIME_EXCEEDED if v6 => "Time exceeded",
        IP_UNRECOGNIZED_NEXT_HEADER if v6 => "Parameter problem",
        _ => {
            return Err(io::Error::other(format!(
                "Windows ICMP API status {code}: {}",
                io::Error::from_raw_os_error(code as i32)
            )))
        }
    };
    Ok(Reply::Negative(reason.into()))
}

fn timeout_ms(wait: Duration) -> io::Result<u32> {
    // Round down so the synchronous call cannot receive a fresh full timeout.
    let millis = wait.as_millis().min(u32::MAX as u128) as u32;
    if millis == 0 {
        Err(io::ErrorKind::TimedOut.into())
    } else {
        Ok(millis)
    }
}

// Use an aligned, initialized allocation. IPv6 also requires room for the
// internal IO_STATUS_BLOCK and an eight-byte ICMP error in addition to payload.
fn reply_storage(payload: usize) -> Vec<usize> {
    let bytes = size_of::<ICMP_ECHO_REPLY>().max(size_of::<ICMPV6_ECHO_REPLY_LH>())
        + payload
        + 8
        + size_of::<IO_STATUS_BLOCK>();
    vec![0; bytes.div_ceil(size_of::<usize>())]
}
fn storage_bytes(storage: &[usize]) -> &[u8] {
    // SAFETY: initialized allocation; byte reads permit any alignment.
    unsafe { std::slice::from_raw_parts(storage.as_ptr().cast(), std::mem::size_of_val(storage)) }
}

fn decode(storage: &[usize], target: IpAddr, payload: &[u8]) -> io::Result<Option<Reply>> {
    let bytes = storage_bytes(storage);
    let (code, source, data) = match target {
        IpAddr::V4(_) => {
            if bytes.len() < size_of::<ICMP_ECHO_REPLY>() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            // SAFETY: enough initialized bytes; unaligned read avoids assuming
            // layout alignment beyond the allocation's guaranteed alignment.
            let reply = unsafe { ptr::read_unaligned(bytes.as_ptr().cast::<ICMP_ECHO_REPLY>()) };
            let result = status(reply.Status, false)?;
            if result != Reply::Echo {
                return Ok(Some(result));
            }
            // Do not dereference an API-provided pointer until it is bounded by
            // this allocation, including overflow, length and header checks.
            let offset = (reply.Data as usize).checked_sub(bytes.as_ptr() as usize);
            let data = offset
                .filter(|&n| n >= size_of::<ICMP_ECHO_REPLY>())
                .and_then(|n| {
                    n.checked_add(reply.DataSize as usize)
                        .and_then(|end| bytes.get(n..end))
                });
            (
                reply.Status,
                IpAddr::V4(Ipv4Addr::from(reply.Address.to_ne_bytes())),
                data,
            )
        }
        IpAddr::V6(_) => {
            let header = size_of::<ICMPV6_ECHO_REPLY_LH>();
            if bytes.len() < header {
                return Err(io::ErrorKind::InvalidData.into());
            }
            // SAFETY: the initialized allocation contains a complete header.
            let reply =
                unsafe { ptr::read_unaligned(bytes.as_ptr().cast::<ICMPV6_ECHO_REPLY_LH>()) };
            let result = status(reply.Status, true)?;
            if result != Reply::Echo {
                return Ok(Some(result));
            }
            let mut address = [0u8; 16];
            for (chunk, word) in address
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip(reply.Address.sin6_addr)
            {
                chunk.copy_from_slice(&word.to_ne_bytes());
            }
            // ICMPV6_ECHO_REPLY has no data-length member. The synchronous API
            // places RequestSize reply bytes immediately after its 36-byte header.
            (
                reply.Status,
                IpAddr::V6(Ipv6Addr::from(address)),
                bytes.get(header..header + payload.len()),
            )
        }
    };
    if source != target || data != Some(payload) {
        return Ok(None);
    }
    status(code, target.is_ipv6()).map(Some)
}

impl EchoApi for Native {
    fn exchange(&mut self, payload: &[u8], wait: Duration) -> io::Result<Option<Reply>> {
        let timeout = timeout_ms(wait)?;
        let length = u16::try_from(payload.len()).map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut storage = reply_storage(payload.len());
        let reply_size = std::mem::size_of_val(storage.as_slice()) as u32;
        let options = IP_OPTION_INFORMATION {
            Ttl: self.ttl,
            ..Default::default()
        };
        // SAFETY: native SDK bindings define ABI/layout. All buffers stay alive
        // through these synchronous calls; no Event/APC or borrowed OS lifetime.
        let count = unsafe {
            match self.target {
                IpAddr::V4(address) => IcmpSendEcho(
                    self.handle.0,
                    u32::from_ne_bytes(address.octets()),
                    payload.as_ptr().cast(),
                    length,
                    &options,
                    storage.as_mut_ptr().cast(),
                    reply_size,
                    timeout,
                ),
                IpAddr::V6(address) => {
                    let source =
                        socket2::SockAddr::from(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), 0));
                    let destination = socket2::SockAddr::from(SocketAddr::new(address.into(), 0));
                    Icmp6SendEcho2(
                        self.handle.0,
                        ptr::null_mut(),
                        None,
                        ptr::null(),
                        source.as_ptr().cast(),
                        destination.as_ptr().cast(),
                        payload.as_ptr().cast(),
                        length,
                        &options,
                        storage.as_mut_ptr().cast(),
                        reply_size,
                        timeout,
                    )
                }
            }
        };
        if count == 0 {
            // Read immediately: zero does not contain a valid reply header.
            let error = io::Error::last_os_error();
            let code = error.raw_os_error().unwrap_or(-1) as u32;
            if code == IP_SUCCESS {
                return Err(io::Error::other(
                    "Windows ICMP API returned no reply and no error",
                ));
            }
            return status(code, self.target.is_ipv6()).map(Some);
        }
        decode(&storage, self.target, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::probe;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn creation_policy() {
        for code in [10013, 10022, 10047, 10055, 5] {
            let called = Cell::new(false);
            let result = select::<()>(Err(io::Error::from_raw_os_error(code)), || {
                called.set(true);
                Err("handle creation error".into())
            });
            assert_eq!(called.get(), code == 10013);
            assert!(result.is_err());
            if code == 10013 {
                assert!(result.unwrap_err().contains("handle creation error"));
            }
        }
        assert_eq!(
            select(Ok(42), || panic!("raw success must remain primary")).unwrap(),
            42
        );
    }

    #[test]
    fn statuses_and_timeout_units() {
        for v6 in [false, true] {
            assert_eq!(status(0, v6).unwrap(), Reply::Echo);
            assert_eq!(
                status(11010, v6).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            for (code, reason) in [
                (11002, "Network unreachable"),
                (11003, "Host unreachable"),
                (11005, "Destination unreachable"),
                (11009, "Packet too big"),
                (11013, "Time exceeded"),
                (11014, "Time exceeded"),
                (11015, "Parameter problem"),
            ] {
                assert_eq!(status(code, v6).unwrap(), Reply::Negative(reason.into()));
            }
            for code in [
                5, 8, 87, 997, 11001, 11006, 11007, 11008, 11011, 11012, 11016, 11018, 11050,
                11255, 99999,
            ] {
                assert!(status(code, v6).is_err(), "{code}");
            }
        }
        assert_eq!(
            status(11004, false).unwrap(),
            Reply::Negative("Destination unreachable".into())
        );
        assert_eq!(
            status(11004, true).unwrap(),
            Reply::Negative("Communication administratively prohibited".into())
        );
        assert!(timeout_ms(Duration::from_micros(999)).is_err());
        assert_eq!(timeout_ms(Duration::from_micros(1999)).unwrap(), 1);
        assert_eq!(timeout_ms(Duration::from_secs(1)).unwrap(), 1000);
    }

    #[test]
    fn native_reply_layout_and_validation() {
        assert_eq!(size_of::<ICMPV6_ECHO_REPLY_LH>(), 36);
        assert_eq!(size_of::<ICMP_ECHO_REPLY>(), 40);
        for target in ["127.0.0.1", "::1"] {
            let target: IpAddr = target.parse().unwrap();
            let payload = [0x5a; 57];
            let mut storage = reply_storage(payload.len());
            let base = storage.as_mut_ptr().cast::<u8>();
            // SAFETY: test fixtures fit the initialized allocation.
            unsafe {
                match target {
                    IpAddr::V4(address) => {
                        let offset = size_of::<ICMP_ECHO_REPLY>();
                        ptr::copy_nonoverlapping(payload.as_ptr(), base.add(offset), payload.len());
                        ptr::write(
                            base.cast::<ICMP_ECHO_REPLY>(),
                            ICMP_ECHO_REPLY {
                                Address: u32::from_ne_bytes(address.octets()),
                                DataSize: payload.len() as u16,
                                Data: base.add(offset).cast(),
                                ..Default::default()
                            },
                        );
                    }
                    IpAddr::V6(address) => {
                        let mut reply: ICMPV6_ECHO_REPLY_LH = std::mem::zeroed();
                        let mut words = [0u16; 8];
                        for (word, bytes) in words
                            .iter_mut()
                            .zip(address.octets().as_chunks::<2>().0.iter())
                        {
                            *word = u16::from_ne_bytes([bytes[0], bytes[1]]);
                        }
                        reply.Address.sin6_addr = words;
                        ptr::write_unaligned(base.cast(), reply);
                        ptr::copy_nonoverlapping(payload.as_ptr(), base.add(36), payload.len());
                    }
                }
            }
            assert_eq!(
                decode(&storage, target, &payload).unwrap(),
                Some(Reply::Echo)
            );
            assert_eq!(decode(&storage, target, &[0; 57]).unwrap(), None);
            let wrong = if target.is_ipv4() { "127.0.0.2" } else { "::2" }
                .parse()
                .unwrap();
            assert_eq!(decode(&storage, wrong, &payload).unwrap(), None);
            if target.is_ipv4() {
                for data in [ptr::null_mut(), base.cast(), usize::MAX as *mut _] {
                    unsafe {
                        (*base.cast::<ICMP_ECHO_REPLY>()).Data = data;
                    }
                    assert_eq!(decode(&storage, target, &payload).unwrap(), None);
                }
                unsafe {
                    (*base.cast::<ICMP_ECHO_REPLY>()).Status = IP_TTL_EXPIRED_TRANSIT;
                }
                assert_eq!(
                    decode(&storage, target, &payload).unwrap(),
                    Some(Reply::Negative("Time exceeded".into()))
                );
            }
        }
        assert!(decode(&[], "::1".parse().unwrap(), &[1; 56]).is_err());
    }

    struct Fake {
        calls: Rc<Cell<usize>>,
        drops: Rc<Cell<usize>>,
        code: u32,
        delay: Duration,
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            self.drops.set(self.drops.get() + 1);
        }
    }
    impl EchoApi for Fake {
        fn exchange(&mut self, payload: &[u8], wait: Duration) -> io::Result<Option<Reply>> {
            assert_eq!(payload, &[7; 56]);
            assert!(wait <= Duration::from_millis(20));
            self.calls.set(self.calls.get() + 1);
            std::thread::sleep(self.delay);
            if self.code == u32::MAX {
                Ok(None) // a reply with the wrong address or payload
            } else {
                status(self.code, false).map(Some)
            }
        }
    }
    #[test]
    fn shared_retry_deadline_errors_and_ownership() {
        for (code, delay, calls, success, error) in [
            (0, 0, 1, true, false),
            (11010, 0, 3, false, false),
            (11003, 0, 1, false, false),
            (11006, 0, 1, false, true),
            (u32::MAX, 0, 3, false, false),
            (0, 30, 3, false, false), // a success after the deadline is discarded
        ] {
            let count = Rc::new(Cell::new(0));
            let drops = Rc::new(Cell::new(0));
            let ip = "127.0.0.1".parse().unwrap();
            let mut transport = Echo::new(
                Fake {
                    calls: count.clone(),
                    drops: drops.clone(),
                    code,
                    delay: Duration::from_millis(delay),
                },
                ip,
            );
            let options = Options {
                timeout: Duration::from_millis(20),
                ..Options::default()
            };
            let result = probe(&mut transport, ip, ip, 42, &[7; 56], &options);
            assert_eq!(result.is_err(), error);
            if let Ok(outcome) = result {
                assert_eq!(outcome.latency.is_some(), success);
            }
            assert_eq!(count.get(), calls);
            drop(transport);
            assert_eq!(drops.get(), 1);
        }
    }

    fn handles() -> u32 {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
        let mut count = 0;
        unsafe {
            assert_ne!(GetProcessHandleCount(GetCurrentProcess(), &mut count), 0);
        }
        count
    }

    // The harness runs this executable as a local standard user. No skips and no
    // test-only transport override: actual WSAEACCES selects production fallback.
    #[test]
    #[ignore = "requires a standard Windows user; run scripts/test-windows-echo.ps1"]
    fn windows_unprivileged_echo() {
        let mut denied = true;
        for (domain, protocol, address) in [
            (Domain::IPV4, Protocol::ICMPV4, "127.0.0.1"),
            (Domain::IPV6, Protocol::ICMPV6, "::1"),
        ] {
            match Socket::new(domain, Type::RAW, Some(protocol)) {
                Err(error) => {
                    println!("{address}: raw creation: {error}");
                    denied &= error.raw_os_error() == Some(10013);
                }
                Ok(socket) => {
                    denied = false;
                    println!("{address}: raw creation SUCCEEDED under standard user");
                    match Raw::from_socket(socket, address.parse().unwrap(), &Options::default()) {
                        Ok(_) => println!("{address}: raw setup also succeeded"),
                        Err(error) => println!("{address}: raw setup: {error}"),
                    }
                }
            }
        }
        assert!(denied, "This runner does not demonstrate creation-time WSAEACCES for both families; production fallback selection remains unverified");
        unprivileged_echo_case(false);
    }

    // Separate real API coverage must not be confused with proof that the
    // production creation-only selector is reachable on a particular runner.
    #[test]
    #[ignore = "requires a standard Windows user; run scripts/test-windows-echo.ps1"]
    fn windows_unprivileged_api() {
        unprivileged_echo_case(true);
        real_handle_cleanup_on_api_error();
    }

    fn unprivileged_echo_case(direct_api: bool) {
        let run = |target: IpAddr, size| {
            let options = Options {
                payload_size: size,
                ..Options::default()
            };
            let (mut transport, local): (Box<dyn Transport>, IpAddr) = if direct_api {
                (
                    Box::new(Echo::new(Native::open(target, &options).unwrap(), target)),
                    target,
                )
            } else {
                open(target, &options).unwrap()
            };
            let payload: Vec<u8> = (0..size).map(|i| (i ^ size) as u8).collect();
            let result = probe(&mut *transport, target, local, 7, &payload, &options).unwrap();
            assert!(result.latency.is_some(), "{target}: {}", result.message);
        };
        // Keep the same eight threads alive at both measurements. Thread
        // creation and IP Helper's first concurrent use can allocate process
        // handles unrelated to an invocation's Echo handle.
        let barrier = std::sync::Barrier::new(9);
        let (before, after) = std::thread::scope(|scope| {
            for target in ["127.0.0.1", "::1"] {
                for size in [16, 56, 57, 1200] {
                    let barrier = &barrier;
                    let run = &run;
                    scope.spawn(move || {
                        let warmup =
                            std::panic::catch_unwind(|| run(target.parse().unwrap(), size));
                        barrier.wait();
                        barrier.wait();
                        let ready = warmup.is_ok();
                        let repeated = std::panic::catch_unwind(|| {
                            if ready {
                                for _ in 0..20 {
                                    run(target.parse().unwrap(), size);
                                }
                            }
                        });
                        barrier.wait();
                        barrier.wait();
                        warmup.unwrap();
                        repeated.unwrap();
                    });
                }
            }
            barrier.wait();
            // Let all workers enter the idle barrier and OS deferred cleanup
            // settle before sampling shared process-wide resources.
            std::thread::sleep(Duration::from_millis(100));
            let before = handles();
            barrier.wait();
            barrier.wait();
            std::thread::sleep(Duration::from_millis(100));
            let after = handles();
            barrier.wait();
            (before, after)
        });
        assert!(after <= before + 2, "handle growth: {before} -> {after}");
        println!("IPv4/IPv6 Echo passed (direct API: {direct_api}), 160 calls on eight warmed workers; handles {before} -> {after}");
    }

    #[test]
    fn real_handle_cleanup_on_api_error() {
        // Actual invalid-handle failure exercises native error handling without
        // changing machine networking. The owned real handle still drops.
        for address in ["127.0.0.1", "::1"] {
            let target = address.parse().unwrap();
            let options = Options::default();
            let warmup = Native::open(target, &options).unwrap();
            drop(warmup);
            let before = handles();
            for _ in 0..100 {
                let mut api = Native::open(target, &options).unwrap();
                let owned = api.handle.0;
                api.handle.0 = INVALID_HANDLE_VALUE;
                let result = api.exchange(&[1; 56], Duration::from_millis(10));
                api.handle.0 = owned;
                assert!(result.is_err());
            }
            assert!(handles() <= before + 2);
        }
    }
}
