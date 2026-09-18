//! Raw sockets receive duplicate copies; minimal ICMP error quotes contain only
//! the Echo header. Lease distinct identifiers and quarantine released identifiers
//! for 60 seconds to avoid attributing delayed negative messages to a new call.
use std::collections::{BTreeSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
#[derive(Default)]
struct Allocator {
    occupied: BTreeSet<u16>,
    retired: VecDeque<(u16, Instant)>,
    next: u16,
}
impl Allocator {
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
#[derive(Debug)]
pub struct Lease(pub u16);
impl Lease {
    pub fn acquire() -> Result<Self, String> {
        IDS.get_or_init(Default::default)
            .lock()
            .map_err(|_| "Echo identifier allocator poisoned")?
            .acquire(Instant::now())
            .map(Self)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut state) = IDS.get_or_init(Default::default).lock() {
            state.release(self.0, Instant::now());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_quarantine_and_expiry() {
        let now = Instant::now();
        let mut allocator = Allocator::default();
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
        let mut allocator = Allocator::default();
        let now = Instant::now();
        for _ in 0..=u16::MAX {
            allocator.acquire(now).unwrap();
        }
        assert!(allocator.acquire(now).is_err());
    }
}
