use std::collections::HashMap;

use crate::services::detect::AgentState;

use super::model::{AgentDetection, AgentStatusSource, EffectiveAgentStatus, HookAuthority};
use super::policy;

#[derive(Debug, Clone)]
pub struct HookReport {
    pub source: String,
    pub sequence: u64,
    pub agent_type: String,
    pub session_id: Option<String>,
    pub state: Option<AgentState>,
    pub authority: HookAuthority,
    pub observed_at: i64,
}

#[derive(Debug, Clone)]
pub struct AgentObservation {
    pub process_agent_type: Option<String>,
    pub screen_agent_type: Option<String>,
    /// The foreground process group is owned by a non-agent process (the login
    /// shell, or any command the user ran after quitting the agent — `curl`,
    /// `git`, …). Drives the identity-clear branch: once a foreign command is
    /// in the foreground, the agent is gone and its identity must drop.
    pub foreign_in_foreground: bool,
    pub detection: AgentDetection,
    pub input_sequence: u64,
    pub output_sequence: u64,
    pub resize_sequence: u64,
    pub last_input_at: i64,
    pub last_output_at: i64,
    pub last_interrupt_at: i64,
    pub observed_at: i64,
}

#[derive(Debug)]
pub struct AgentStatusEngine {
    effective: EffectiveAgentStatus,
    latest_hook_sequence: HashMap<String, u64>,
    hook_identity: Option<String>,
    hook_authority: HookAuthority,
    candidate_identity: Option<String>,
    identity_confirmations: u8,
    idle_confirmations: u8,
    review_in_progress: bool,
    observed_input_sequence: u64,
    observed_output_sequence: u64,
    observed_resize_sequence: u64,
}

impl Default for AgentStatusEngine {
    fn default() -> Self {
        Self {
            effective: EffectiveAgentStatus::default(),
            latest_hook_sequence: HashMap::new(),
            hook_identity: None,
            hook_authority: HookAuthority::IdentityOnly,
            candidate_identity: None,
            identity_confirmations: 0,
            idle_confirmations: 0,
            review_in_progress: false,
            observed_input_sequence: 0,
            observed_output_sequence: 0,
            observed_resize_sequence: 0,
        }
    }
}

impl AgentStatusEngine {
    pub fn snapshot(&self) -> EffectiveAgentStatus {
        self.effective.clone()
    }

    pub fn apply_hook(&mut self, report: HookReport) -> Option<EffectiveAgentStatus> {
        let sequence_key = report
            .session_id
            .as_deref()
            .map(|session_id| format!("{}:{session_id}", report.source))
            .unwrap_or_else(|| report.source.clone());
        let latest = self.latest_hook_sequence.entry(sequence_key).or_insert(0);
        if report.sequence <= *latest {
            return None;
        }
        *latest = report.sequence;
        self.hook_identity = Some(report.agent_type.clone());
        self.hook_authority = report.authority;

        let mut next = self.effective.clone();
        next.agent_type = Some(report.agent_type);
        next.session_id = report.session_id;
        next.hook_sequence = report.sequence;
        if report.authority == HookAuthority::FullLifecycle {
            if let Some(state) = report.state {
                // Codex auto-review: a permission/pre-tool hook fires Blocked even
                // though an automated reviewer (not a human) is handling it. Don't
                // surface Blocked while the review banner is on screen; leave the
                // prior state (Working) intact. Identity/session/sequence still
                // update above via `next`.
                let suppress_block =
                    state == AgentState::Blocked && self.review_in_progress;
                if !suppress_block {
                    next.agent_state = state;
                    next.source = AgentStatusSource::Hook;
                    next.confidence = 100;
                    next.visible_blocker = state == AgentState::Blocked;
                    next.visible_working = state == AgentState::Working;
                }
            }
        }
        self.commit(next, report.observed_at)
    }

    pub fn observe(&mut self, observation: AgentObservation) -> Option<EffectiveAgentStatus> {
        if observation.foreign_in_foreground {
            self.hook_identity = None;
            self.hook_authority = HookAuthority::IdentityOnly;
            self.candidate_identity = None;
            self.identity_confirmations = 0;
            self.idle_confirmations = 0;
            let mut next = self.effective.clone();
            next.agent_type = None;
            next.agent_state = AgentState::Unknown;
            next.source = AgentStatusSource::Process;
            next.confidence = 100;
            next.session_id = None;
            next.visible_blocker = false;
            next.visible_working = false;
            self.observed_input_sequence = observation.input_sequence;
            self.observed_output_sequence = observation.output_sequence;
            self.observed_resize_sequence = observation.resize_sequence;
            return self.commit(next, observation.observed_at);
        }

        let strong_identity = observation.process_agent_type.clone();
        let weak_identity = observation
            .screen_agent_type
            .clone()
            .or_else(|| self.hook_identity.clone());
        let candidate = strong_identity.clone().or(weak_identity);
        let confirmed = if strong_identity.is_some() || candidate == self.hook_identity {
            candidate
        } else {
            if candidate == self.candidate_identity {
                self.identity_confirmations = self.identity_confirmations.saturating_add(1);
            } else {
                self.candidate_identity = candidate.clone();
                self.identity_confirmations = 1;
            }
            (self.identity_confirmations >= policy::IDENTITY_CONFIRMATIONS)
                .then_some(candidate)
                .flatten()
        };

        let Some(agent_type) = confirmed.or_else(|| self.effective.agent_type.clone()) else {
            self.observed_input_sequence = observation.input_sequence;
            self.observed_output_sequence = observation.output_sequence;
            self.observed_resize_sequence = observation.resize_sequence;
            return None;
        };

        let output_advanced = observation.output_sequence > self.observed_output_sequence;
        let input_advanced = observation.input_sequence > self.observed_input_sequence;
        let resize_advanced = observation.resize_sequence > self.observed_resize_sequence;
        self.observed_input_sequence = observation.input_sequence;
        self.observed_output_sequence = observation.output_sequence;
        self.observed_resize_sequence = observation.resize_sequence;

        let output_active =
            observation.observed_at - observation.last_output_at <= policy::OUTPUT_ACTIVE_MS;
        let input_tainted = input_advanced
            || resize_advanced
            || observation.observed_at - observation.last_input_at <= policy::INPUT_TAINT_MS;
        let recent_interrupt = observation.last_interrupt_at > 0
            && observation.observed_at - observation.last_interrupt_at
                <= policy::INTERRUPT_RECENT_MS;

        let mut next = self.effective.clone();
        next.agent_type = Some(agent_type);
        next.visible_blocker = observation.detection.visible_blocker;
        next.visible_working = observation.detection.visible_working;

        self.review_in_progress = observation.detection.review_in_progress;

        // Codex auto-review: a hook already surfaced Blocked, but the screen
        // shows the auto-reviewer is processing the request. Release to Working
        // so the sidebar dot does not blink blocked → working.
        if self.review_in_progress
            && self.effective.source == AgentStatusSource::Hook
            && self.effective.agent_state == AgentState::Blocked
        {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Working;
            next.source = AgentStatusSource::Screen;
            next.confidence = 80;
            next.visible_blocker = false;
            next.visible_working = true;
            return self.commit(next, observation.observed_at);
        }

        // A complete lifecycle integration remains authoritative until process
        // exit. The only local override is an explicit interrupt followed by a
        // quiet, structurally idle screen (agents do not reliably emit Stop for
        // Ctrl+C/Escape).
        if self.hook_authority == HookAuthority::FullLifecycle
            && self.effective.source == AgentStatusSource::Hook
            && !recent_interrupt
        {
            return self.commit(next, observation.observed_at);
        }
        if observation.detection.skip_state_update {
            return self.commit(next, observation.observed_at);
        }

        if observation.detection.visible_blocker && !output_active && !input_tainted {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Blocked;
            next.source = AgentStatusSource::Screen;
            next.confidence = 90;
        } else if output_advanced && output_active && !input_tainted {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Working;
            next.source = AgentStatusSource::Pty;
            next.confidence = 85;
        } else if observation.detection.visible_working && !input_tainted {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Working;
            next.source = AgentStatusSource::Screen;
            next.confidence = 80;
        } else if recent_interrupt
            && observation.detection.state == AgentState::Idle
            && !output_active
        {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Idle;
            next.source = AgentStatusSource::Interrupt;
            next.confidence = 95;
        } else if observation.detection.visible_idle && !output_active && !input_tainted {
            // A rule matched live idle chrome (e.g. the prompt box). Trust it
            // immediately instead of waiting out IDLE_CONFIRMATIONS.
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Idle;
            next.source = AgentStatusSource::Screen;
            next.confidence = 80;
        } else if observation.detection.state == AgentState::Idle
            && !output_active
            && !input_tainted
        {
            self.idle_confirmations = self.idle_confirmations.saturating_add(1);
            if self.idle_confirmations >= policy::IDLE_CONFIRMATIONS {
                next.agent_state = AgentState::Idle;
                next.source = AgentStatusSource::Screen;
                next.confidence = 75;
            }
        } else if input_advanced
            && observation.observed_at - observation.last_input_at <= policy::POST_INPUT_WORKING_MS
            && self.effective.agent_state == AgentState::Blocked
        {
            self.idle_confirmations = 0;
            next.agent_state = AgentState::Working;
            next.source = AgentStatusSource::Pty;
            next.confidence = 70;
        } else {
            return self.commit(next, observation.observed_at);
        }

        self.commit(next, observation.observed_at)
    }

    fn commit(
        &mut self,
        mut next: EffectiveAgentStatus,
        changed_at: i64,
    ) -> Option<EffectiveAgentStatus> {
        let changed = next.agent_type != self.effective.agent_type
            || next.agent_state != self.effective.agent_state
            || next.source != self.effective.source
            || next.session_id != self.effective.session_id
            || next.visible_blocker != self.effective.visible_blocker
            || next.visible_working != self.effective.visible_working;
        if !changed {
            self.effective.hook_sequence = self.effective.hook_sequence.max(next.hook_sequence);
            return None;
        }
        next.revision = self.effective.revision.saturating_add(1);
        next.changed_at = changed_at;
        self.effective = next;
        Some(self.effective.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(sequence: u64, state: Option<AgentState>) -> HookReport {
        HookReport {
            source: "claude".into(),
            sequence,
            agent_type: "claude".into(),
            session_id: Some("s1".into()),
            state,
            authority: HookAuthority::FullLifecycle,
            observed_at: sequence as i64,
        }
    }

    fn observation(now: i64) -> AgentObservation {
        AgentObservation {
            process_agent_type: Some("claude".into()),
            screen_agent_type: None,
            foreign_in_foreground: false,
            detection: AgentDetection::from_state(AgentState::Idle),
            input_sequence: 0,
            output_sequence: 0,
            resize_sequence: 0,
            last_input_at: 0,
            last_output_at: 0,
            last_interrupt_at: 0,
            observed_at: now,
        }
    }

    #[test]
    fn rejects_duplicate_and_out_of_order_hooks() {
        let mut engine = AgentStatusEngine::default();
        assert!(engine
            .apply_hook(hook(2, Some(AgentState::Working)))
            .is_some());
        assert!(engine.apply_hook(hook(2, Some(AgentState::Idle))).is_none());
        assert!(engine.apply_hook(hook(1, Some(AgentState::Idle))).is_none());
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
    }

    #[test]
    fn identity_only_hook_does_not_override_state() {
        let mut engine = AgentStatusEngine::default();
        let mut report = hook(1, Some(AgentState::Working));
        report.authority = HookAuthority::IdentityOnly;
        engine.apply_hook(report);
        assert_eq!(engine.snapshot().agent_type.as_deref(), Some("claude"));
        assert_eq!(engine.snapshot().agent_state, AgentState::Unknown);
    }

    #[test]
    fn process_exit_clears_stale_hook_authority() {
        let mut engine = AgentStatusEngine::default();
        engine.apply_hook(hook(1, Some(AgentState::Working)));
        let mut obs = observation(10_000);
        obs.process_agent_type = None;
        obs.foreign_in_foreground = true;
        engine.observe(obs);
        assert_eq!(engine.snapshot().agent_type, None);
        assert_eq!(engine.snapshot().agent_state, AgentState::Unknown);
    }

    #[test]
    fn foreign_foreground_command_clears_agent() {
        // Agent quit, tab reused for a non-agent command (curl/git). The shell
        // is NOT the foreground pgrp — the command is — so the old
        // `shell_in_foreground` check never fired and identity stuck.
        let mut engine = AgentStatusEngine::default();
        engine.observe(observation(1_000));
        assert_eq!(engine.snapshot().agent_type.as_deref(), Some("claude"));
        let mut obs = observation(2_000);
        obs.process_agent_type = None;
        obs.screen_agent_type = None;
        obs.foreign_in_foreground = true;
        engine.observe(obs);
        assert_eq!(engine.snapshot().agent_type, None);
        assert_eq!(engine.snapshot().agent_state, AgentState::Unknown);
    }

    #[test]
    fn interrupt_can_release_hook_owned_working_state() {
        let mut engine = AgentStatusEngine::default();
        engine.apply_hook(hook(1, Some(AgentState::Working)));
        let mut obs = observation(10_000);
        obs.last_interrupt_at = 9_500;
        engine.observe(obs);
        assert_eq!(engine.snapshot().agent_state, AgentState::Idle);
        assert_eq!(engine.snapshot().source, AgentStatusSource::Interrupt);
    }

    #[test]
    fn input_tainted_output_does_not_become_working() {
        let mut engine = AgentStatusEngine::default();
        let mut report = hook(1, Some(AgentState::Idle));
        report.authority = HookAuthority::IdentityOnly;
        engine.apply_hook(report);
        let mut obs = observation(10_000);
        obs.input_sequence = 1;
        obs.output_sequence = 1;
        obs.last_input_at = 9_900;
        obs.last_output_at = 9_950;
        engine.observe(obs);
        assert_ne!(engine.snapshot().agent_state, AgentState::Working);
    }

    #[test]
    fn resize_redraw_does_not_become_working() {
        let mut engine = AgentStatusEngine::default();
        let mut report = hook(1, Some(AgentState::Idle));
        report.authority = HookAuthority::IdentityOnly;
        engine.apply_hook(report);
        let mut obs = observation(10_000);
        obs.output_sequence = 1;
        obs.resize_sequence = 1;
        obs.last_output_at = 9_950;
        engine.observe(obs);
        assert_ne!(engine.snapshot().agent_state, AgentState::Working);
    }

    #[test]
    fn transcript_viewer_freezes_state() {
        let mut engine = AgentStatusEngine::default();
        let mut report = hook(1, Some(AgentState::Working));
        report.authority = HookAuthority::IdentityOnly;
        engine.apply_hook(report);
        let mut obs = observation(10_000);
        obs.detection = AgentDetection::from_state(AgentState::Working);
        engine.observe(obs.clone());
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
        obs.detection = AgentDetection::from_state(AgentState::Idle);
        obs.detection.skip_state_update = true;
        for i in 0..5 {
            obs.observed_at += i;
            engine.observe(obs.clone());
        }
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
    }

    #[test]
    fn new_hook_session_can_restart_its_sequence() {
        let mut engine = AgentStatusEngine::default();
        engine.apply_hook(hook(5, Some(AgentState::Working)));
        let mut next = hook(1, Some(AgentState::Idle));
        next.session_id = Some("s2".into());
        assert!(engine.apply_hook(next).is_some());
        assert_eq!(engine.snapshot().agent_state, AgentState::Idle);
    }

    #[test]
    fn review_in_progress_suppresses_hook_block() {
        let mut engine = AgentStatusEngine::default();
        // Establish Working + cache the review flag via a screen observation.
        engine.apply_hook(hook(1, Some(AgentState::Working)));
        let mut obs = observation(10_000);
        obs.detection = AgentDetection::from_state(AgentState::Working);
        obs.detection.review_in_progress = true;
        engine.observe(obs);
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
        // Permission-gate hook arrives while the reviewer is processing.
        engine.apply_hook(hook(2, Some(AgentState::Blocked)));
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
        assert!(!engine.snapshot().visible_blocker);
    }

    #[test]
    fn block_fires_normally_without_review() {
        let mut engine = AgentStatusEngine::default();
        engine.apply_hook(hook(1, Some(AgentState::Working)));
        engine.apply_hook(hook(2, Some(AgentState::Blocked)));
        assert_eq!(engine.snapshot().agent_state, AgentState::Blocked);
        assert!(engine.snapshot().visible_blocker);
    }

    #[test]
    fn review_flag_clears_allows_later_block() {
        let mut engine = AgentStatusEngine::default();
        engine.apply_hook(hook(1, Some(AgentState::Working)));
        // Review in progress, then it ends (banner gone → flag false).
        let mut obs = observation(10_000);
        obs.detection = AgentDetection::from_state(AgentState::Working);
        obs.detection.review_in_progress = true;
        engine.observe(obs);
        let mut obs2 = observation(11_000);
        obs2.detection = AgentDetection::from_state(AgentState::Working);
        obs2.detection.review_in_progress = false;
        engine.observe(obs2);
        // A genuine block now must surface.
        engine.apply_hook(hook(2, Some(AgentState::Blocked)));
        assert_eq!(engine.snapshot().agent_state, AgentState::Blocked);
    }

    #[test]
    fn review_in_progress_releases_committed_hook_block() {
        let mut engine = AgentStatusEngine::default();
        // Codex hook (FullLifecycle) commits Blocked before the review banner is seen.
        engine.apply_hook(hook(1, Some(AgentState::Blocked)));
        assert_eq!(engine.snapshot().agent_state, AgentState::Blocked);
        // Next screen observation shows the auto-reviewer working.
        let mut obs = observation(10_000);
        obs.detection = AgentDetection::from_state(AgentState::Working);
        obs.detection.review_in_progress = true;
        engine.observe(obs);
        assert_eq!(engine.snapshot().agent_state, AgentState::Working);
        assert_eq!(engine.snapshot().source, AgentStatusSource::Screen);
        assert!(!engine.snapshot().visible_blocker);
    }

    #[test]
    fn visible_idle_settles_without_confirmation_delay() {
        let mut engine = AgentStatusEngine::default();
        let mut report = hook(1, Some(AgentState::Working));
        report.authority = HookAuthority::IdentityOnly;
        engine.apply_hook(report); // identity only — screen path arbitrates state
        let mut obs = observation(10_000);
        obs.detection = AgentDetection::from_state(AgentState::Idle);
        obs.detection.visible_idle = true;
        obs.last_output_at = 0; // not output-active
        let out = engine.observe(obs).expect("state should change");
        assert_eq!(out.agent_state, AgentState::Idle);
        assert_eq!(out.source, AgentStatusSource::Screen);
    }
}
