use std::collections::VecDeque;

/// A queued prompt with its own response mode, used for prompt.text entries
/// that arrive while the agent is busy streaming a response.
pub(crate) struct PendingPrompt {
    pub(crate) text: String,
    pub(crate) response_mode: &'static str,
}

/// Mutable state for the bridge main loop.
pub(crate) struct BridgeState {
    pub(crate) active_request_id: Option<String>,
    pub(crate) streaming: bool,
    pub(crate) agent_active: bool,
    pub(crate) accumulated_text: String,
    pub(crate) seq: u64,
    pub(crate) pending_text: String,
    pub(crate) pending_prompts: VecDeque<PendingPrompt>,
    pub(crate) response_mode: &'static str,
    pub(crate) active_prompt_rpc_id: Option<u64>,
}

impl BridgeState {
    pub(crate) fn new() -> Self {
        Self {
            active_request_id: None,
            streaming: false,
            agent_active: false,
            accumulated_text: String::new(),
            seq: 0,
            pending_text: String::new(),
            pending_prompts: VecDeque::new(),
            response_mode: "voice",
            active_prompt_rpc_id: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.streaming = false;
        self.agent_active = false;
        self.active_request_id = None;
        self.active_prompt_rpc_id = None;
        self.accumulated_text.clear();
        self.seq = 0;
    }
}
