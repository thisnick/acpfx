//! Orchestrator stamp fields added to every routed event.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Fields added by the orchestrator to every routed event.
///
/// These are optional because they are only present after the orchestrator
/// stamps the event during routing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct OrchestratorStamp {
    /// Wall-clock ms since epoch, added by orchestrator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    /// Source node name, added by orchestrator.
    #[serde(rename = "_from", skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}
