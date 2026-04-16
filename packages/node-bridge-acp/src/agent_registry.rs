/// Resolve an agent name to the command used to spawn it.
pub fn resolve_agent_command(agent: &str) -> Vec<String> {
    match agent {
        "claude" => vec![
            "npx".into(),
            "-y".into(),
            "@agentclientprotocol/claude-agent-acp@latest".into(),
        ],
        "codex" => vec![
            "npx".into(),
            "-y".into(),
            "@zed-industries/codex-acp@latest".into(),
        ],
        _ => vec![
            "npx".into(),
            "-y".into(),
            format!("@agentclientprotocol/{}-acp@latest", agent),
        ],
    }
}
