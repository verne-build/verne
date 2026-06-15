use super::model::HookAuthority;
use crate::services::agent_registry::{self, HookIntegration};

pub const OUTPUT_ACTIVE_MS: i64 = 1_500;
pub const INPUT_TAINT_MS: i64 = 800;
pub const POST_INPUT_WORKING_MS: i64 = 3_000;
pub const INTERRUPT_RECENT_MS: i64 = 30_000;
pub const IDLE_CONFIRMATIONS: u8 = 3;
pub const IDENTITY_CONFIRMATIONS: u8 = 2;

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
    fn copilot_is_full_lifecycle() {
        assert_eq!(hook_authority("copilot"), HookAuthority::FullLifecycle);
    }

    #[test]
    fn cursor_is_identity_only() {
        assert_eq!(hook_authority("cursor"), HookAuthority::IdentityOnly);
    }

    #[test]
    fn unknown_agent_is_identity_only() {
        assert_eq!(hook_authority("nope"), HookAuthority::IdentityOnly);
    }
}
