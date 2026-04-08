//! Event categories and type-to-category mapping.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// High-level event categories.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Audio,
    Speech,
    Agent,
    Control,
    Lifecycle,
    Log,
    Player,
    Node,
}

/// All known event type strings.
pub const ALL_EVENT_TYPES: &[&str] = &[
    "audio.chunk",
    "audio.level",
    "speech.partial",
    "speech.delta",
    "speech.final",
    "speech.pause",
    "agent.submit",
    "agent.delta",
    "agent.complete",
    "agent.thinking",
    "agent.tool_start",
    "agent.tool_done",
    "control.interrupt",
    "control.state",
    "control.error",
    "lifecycle.ready",
    "lifecycle.done",
    "log",
    "player.status",
    "node.status",
];

/// Map an event type string to its category.
/// Returns `None` for unknown event types.
pub fn category_of(event_type: &str) -> Option<Category> {
    match event_type {
        "audio.chunk" | "audio.level" => Some(Category::Audio),
        "speech.partial" | "speech.delta" | "speech.final" | "speech.pause" => {
            Some(Category::Speech)
        }
        "agent.submit" | "agent.delta" | "agent.complete" | "agent.thinking"
        | "agent.tool_start" | "agent.tool_done" => Some(Category::Agent),
        "control.interrupt" | "control.state" | "control.error" => Some(Category::Control),
        "lifecycle.ready" | "lifecycle.done" => Some(Category::Lifecycle),
        "log" => Some(Category::Log),
        "player.status" => Some(Category::Player),
        "node.status" => Some(Category::Node),
        _ => None,
    }
}

/// Get all event type strings belonging to a category.
pub fn types_in_category(category: Category) -> &'static [&'static str] {
    match category {
        Category::Audio => &["audio.chunk", "audio.level"],
        Category::Speech => &[
            "speech.partial",
            "speech.delta",
            "speech.final",
            "speech.pause",
        ],
        Category::Agent => &[
            "agent.submit",
            "agent.delta",
            "agent.complete",
            "agent.thinking",
            "agent.tool_start",
            "agent.tool_done",
        ],
        Category::Control => &["control.interrupt", "control.state", "control.error"],
        Category::Lifecycle => &["lifecycle.ready", "lifecycle.done"],
        Category::Log => &["log"],
        Category::Player => &["player.status"],
        Category::Node => &["node.status"],
    }
}

/// Check whether an event type string is known.
pub fn is_known_event_type(event_type: &str) -> bool {
    category_of(event_type).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_types_have_categories() {
        for ty in ALL_EVENT_TYPES {
            assert!(
                category_of(ty).is_some(),
                "event type '{}' has no category",
                ty
            );
        }
    }

    #[test]
    fn unknown_type_returns_none() {
        assert_eq!(category_of("foo.bar"), None);
        assert!(!is_known_event_type("foo.bar"));
    }

    #[test]
    fn category_roundtrip() {
        for ty in ALL_EVENT_TYPES {
            let cat = category_of(ty).unwrap();
            let types = types_in_category(cat);
            assert!(types.contains(ty), "'{}' not in types_in_category({:?})", ty, cat);
        }
    }

    #[test]
    fn types_in_category_counts() {
        assert_eq!(types_in_category(Category::Audio).len(), 2);
        assert_eq!(types_in_category(Category::Speech).len(), 4);
        assert_eq!(types_in_category(Category::Agent).len(), 6);
        assert_eq!(types_in_category(Category::Control).len(), 3);
        assert_eq!(types_in_category(Category::Lifecycle).len(), 2);
        assert_eq!(types_in_category(Category::Log).len(), 1);
        assert_eq!(types_in_category(Category::Player).len(), 1);
        assert_eq!(types_in_category(Category::Node).len(), 1);
    }
}
