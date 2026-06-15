use serde::Serialize;
use std::sync::Arc;

/// Two modes:
///   - Daemon: pushes onto the daemon's EventBus, which fans out over RPC.
///   - Noop: drops events. Used in tests / paths without an event channel.
#[derive(Clone)]
pub enum Emitter {
    Daemon(Arc<crate::state::EventBus>),
    Noop,
}

impl Emitter {
    pub fn daemon(bus: Arc<crate::state::EventBus>) -> Self {
        Self::Daemon(bus)
    }

    /// Drops all events on the floor. Used by code paths without a real channel.
    pub fn noop() -> Self {
        Self::Noop
    }

    pub fn emit<T: Serialize + Clone>(&self, event: &str, payload: T) {
        match self {
            Emitter::Daemon(bus) => {
                if let Ok(v) = serde_json::to_value(payload) {
                    bus.emit(event, v);
                }
            }
            Emitter::Noop => {}
        }
    }
}
