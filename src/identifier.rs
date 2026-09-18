//! Raw sockets receive duplicate copies; minimal ICMP error quotes contain only
//! the Echo header. Lease distinct identifiers and quarantine released identifiers
//! for 60 seconds to reduce delayed-error misattribution within this process.
//! A random starting identifier also reduces collisions across processes/restarts;
//! finite-width identifiers cannot guarantee cross-process uniqueness.
use std::collections::{BTreeSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
struct Allocator {
    occupied: BTreeSet<u16>,
    retired: VecDeque<(u16, Instant)>,
    next: u16,
}
impl Allocator {
    fn new(fill: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>) -> Result<Self, String> {
        let mut seed = [0; 2];
        fill(&mut seed).map_err(|e| format!("ICMP random identifier: {e}"))?;
        Ok(Self {
            occupied: BTreeSet::new(),
            retired: VecDeque::new(),
            next: u16::from_be_bytes(seed),
        })
    }

    fn acquire(&mut self, now: Instant) -> Result<u16, String> {
        while self
            .retired
            .front()
            .is_some_and(|(_, at)| now.duration_since(*at) >= Duration::from_secs(60))
        {
            if let Some((id, _)) = self.retired.pop_front() {
                self.occupied.remove(&id);
            }
        }
        for _ in 0..=u16::MAX {
            let id = self.next;
            self.next = self.next.wrapping_add(1);
            if self.occupied.insert(id) {
                return Ok(id);
            }
        }
        Err("ICMP Echo identifier capacity exhausted; retry after active probes or identifier quarantine expire".into())
    }
    fn release(&mut self, id: u16, now: Instant) {
        self.retired.push_back((id, now));
    }
}
static IDS: OnceLock<Mutex<Allocator>> = OnceLock::new();

fn initialize(
    ids: &OnceLock<Mutex<Allocator>>,
    fill: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>,
) -> Result<&Mutex<Allocator>, String> {
    if let Some(state) = ids.get() {
        return Ok(state);
    }
    let allocator = Allocator::new(fill)?;
    Ok(ids.get_or_init(|| Mutex::new(allocator)))
}
#[derive(Debug)]
pub struct Lease(pub u16);
impl Lease {
    pub fn acquire() -> Result<Self, String> {
        initialize(&IDS, getrandom::fill)?
            .lock()
            .map_err(|_| "Echo identifier allocator poisoned")?
            .acquire(Instant::now())
            .map(Self)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(ids) = IDS.get() {
            if let Ok(mut state) = ids.lock() {
                state.release(self.0, Instant::now());
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initialization_uses_random_seed_once_and_wraps() {
        for seed in [0u16, 0x1234, u16::MAX] {
            let ids = OnceLock::new();
            let state = initialize(&ids, |bytes| {
                assert_eq!(bytes.len(), 2);
                bytes.copy_from_slice(&seed.to_be_bytes());
                Ok(())
            })
            .unwrap();
            let now = Instant::now();
            let mut allocator = state.lock().unwrap();
            assert_eq!(allocator.acquire(now).unwrap(), seed);
            assert_eq!(allocator.acquire(now).unwrap(), seed.wrapping_add(1));
            drop(allocator);
            assert!(std::ptr::eq(
                state,
                initialize(&ids, |_| panic!("already initialized")).unwrap()
            ));
        }
    }
    #[test]
    fn initialization_randomness_failure_is_not_a_zero_seed() {
        let ids = OnceLock::new();
        let error = initialize(&ids, |_| Err(getrandom::Error::UNSUPPORTED))
            .err()
            .unwrap();
        assert!(error.contains("ICMP random identifier"));
        assert!(ids.get().is_none());
    }
    #[test]
    fn independent_quarantine_and_expiry() {
        let now = Instant::now();
        let mut allocator = Allocator::new(|seed| {
            seed.fill(0);
            Ok(())
        })
        .unwrap();
        let ids: BTreeSet<_> = (0..100).map(|_| allocator.acquire(now).unwrap()).collect();
        assert_eq!(ids.len(), 100);
        for id in &ids {
            allocator.release(*id, now);
        }
        allocator.next = 0;
        assert_eq!(allocator.acquire(now).unwrap(), 100);
        allocator.next = 0;
        assert_eq!(allocator.acquire(now + Duration::from_secs(61)).unwrap(), 0);
        assert_eq!(allocator.retired.len(), 0);
    }
    #[test]
    fn capacity_is_bounded() {
        let mut allocator = Allocator::new(|seed| {
            seed.fill(0);
            Ok(())
        })
        .unwrap();
        let now = Instant::now();
        for _ in 0..=u16::MAX {
            allocator.acquire(now).unwrap();
        }
        assert!(allocator.acquire(now).is_err());
    }
}
