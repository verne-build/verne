use super::model::HookAuthority;
use crate::services::agent_registry::{self, HookIntegration};

pub const OUTPUT_ACTIVE_MS: i64 = 1_500;
pub const INPUT_TAINT_MS: i64 = 800;
pub const POST_INPUT_WORKING_MS: i64 = 3_000;
pub const INTERRUPT_RECENT_MS: i64 = 30_000;
pub const IDLE_CONFIRMATIONS: u8 = 3;
pub const IDENTITY_CONFIRMATIONS: u8 = 2;
/// How long a process-derived identity stays authoritative for rejecting hooks
/// from a different agent. The observation loop refreshes it every second; past
/// this window we fail open rather than drop a real agent's hooks.
pub const PROCESS_IDENTITY_FRESH_MS: i64 = 3_000;

/// Hook authority is derived from the registry's `HookIntegration` so it cannot
/// drift from the install set. FullLifecycle integrations own state; Identity
/// (partial lifecycle) and None only correlate identity/session.
pub fn hook_authority(agent_type: &str) -> HookAuthority {
    match agent_registry::get(agent_type).map(|agent| agent.hooks) {
        Some(HookIntegration::FullLifecycle) => HookAuthority::FullLifecycle,
        _ => HookAuthority::IdentityOnly,
    }
}

#[cfg(test)]
mod tests {
    use super::hook_authority;
    use crate::services::agent_status::HookAuthority;

    #[test]
    fn hook_authority_follows_active_registry() {
        for key in ["claude", "codex", "antigravity", "opencode", "pi"] {
            assert_eq!(hook_authority(key), HookAuthority::FullLifecycle, "{key}");
        }
        assert_eq!(hook_authority("cursor"), HookAuthority::IdentityOnly);
    }

    #[test]
    fn unknown_agent_is_identity_only() {
        assert_eq!(hook_authority("nope"), HookAuthority::IdentityOnly);
    }
}
