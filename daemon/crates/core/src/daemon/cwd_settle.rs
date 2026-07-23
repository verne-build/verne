//! Pure settle-debounce tracker for per-tab foreground cwd samples.
//!
//! Fed one sample per tick per tab; emits `Some(cwd)` only once the same cwd
//! has been observed `settle_ticks` times in a row and differs from the last
//! emitted value. `None` samples (unreadable/exit race) are skipped, not
//! treated as a reset.

use std::collections::HashMap;

struct TabTrack {
    candidate: Option<String>,
    stable_ticks: u32,
    last_emitted: Option<String>,
}

pub struct CwdSettle {
    settle_ticks: u32,
    tabs: HashMap<String, TabTrack>,
}

impl CwdSettle {
    pub fn new(settle_ticks: u32) -> Self {
        Self {
            settle_ticks,
            tabs: HashMap::new(),
        }
    }

    /// Feed one tick's observation; Some(cwd) => emit session-cwd now.
    pub fn observe(&mut self, tab_id: &str, cwd: Option<&str>) -> Option<String> {
        let Some(cwd) = cwd else { return None }; // unreadable sample: skip, don't reset
        let t = self.tabs.entry(tab_id.to_string()).or_insert(TabTrack {
            candidate: None,
            stable_ticks: 0,
            last_emitted: None,
        });
        if t.candidate.as_deref() == Some(cwd) {
            t.stable_ticks += 1;
        } else {
            t.candidate = Some(cwd.to_string());
            t.stable_ticks = 1;
        }
        if t.stable_ticks >= self.settle_ticks && t.last_emitted.as_deref() != Some(cwd) {
            t.last_emitted = Some(cwd.to_string());
            return Some(cwd.to_string());
        }
        None
    }

    pub fn forget(&mut self, tab_id: &str) {
        self.tabs.remove(tab_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_after_three_stable_ticks_then_stays_quiet() {
        let mut s = CwdSettle::new(3);
        assert_eq!(s.observe("t1", Some("/a")), None);
        assert_eq!(s.observe("t1", Some("/a")), None);
        assert_eq!(s.observe("t1", Some("/a")), Some("/a".into())); // settled
        assert_eq!(s.observe("t1", Some("/a")), None); // no re-emit
    }

    #[test]
    fn flapping_resets_the_counter() {
        let mut s = CwdSettle::new(3);
        s.observe("t1", Some("/a"));
        s.observe("t1", Some("/b")); // transient cd in a script
        s.observe("t1", Some("/a"));
        assert_eq!(s.observe("t1", Some("/a")), None); // only 2 stable
        assert_eq!(s.observe("t1", Some("/a")), Some("/a".into()));
    }

    #[test]
    fn none_samples_are_skipped_not_resets() {
        let mut s = CwdSettle::new(3);
        s.observe("t1", Some("/a"));
        s.observe("t1", None); // exit race / unreadable — skip
        s.observe("t1", Some("/a"));
        assert_eq!(s.observe("t1", Some("/a")), Some("/a".into()));
    }

    #[test]
    fn change_after_emission_emits_again_once_settled() {
        let mut s = CwdSettle::new(3);
        for _ in 0..3 {
            s.observe("t1", Some("/a"));
        }
        for _ in 0..2 {
            assert_eq!(s.observe("t1", Some("/b")), None);
        }
        assert_eq!(s.observe("t1", Some("/b")), Some("/b".into()));
    }
}
