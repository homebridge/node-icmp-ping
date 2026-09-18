//! Minimal global coordination: raw sockets receive duplicate copies and an ICMP
//! error may quote only the Echo header. Active identifiers must therefore differ.
use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
static IDS: OnceLock<Mutex<BTreeSet<u16>>> = OnceLock::new();
#[derive(Debug)]
pub struct Lease(pub u16);
impl Lease {
    pub fn acquire() -> Result<Self, String> {
        let mut ids = IDS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Echo identifier allocator poisoned")?;
        let id = (0..=u16::MAX)
            .find(|id| !ids.contains(id))
            .ok_or("Too many active ICMP operations")?;
        ids.insert(id);
        Ok(Self(id))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut ids) = IDS.get_or_init(Default::default).lock() {
            ids.remove(&self.0);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_and_released() {
        let leases: Vec<_> = (0..100).map(|_| Lease::acquire().unwrap()).collect();
        let ids: BTreeSet<_> = leases.iter().map(|x| x.0).collect();
        assert_eq!(ids.len(), 100);
        drop(leases);
        let a = Lease::acquire().unwrap();
        let b = Lease::acquire().unwrap();
        assert_ne!(a.0, b.0);
    }
}
