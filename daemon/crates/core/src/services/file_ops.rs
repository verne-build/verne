//! Extract file operations from an agent's tool-use hook payload, for the
//! agent-shadow diff tracker. Dispatch is by agent key, with the claude
//! strategy as the default for every agent without a custom one.

use crate::services::jsonl_reader::{FileOpType, FileOperation};

/// Tool hook (name + input JSON) → file operations. `agent_type` selects the
/// extraction strategy; unknown/None agents use the claude-style default.
pub fn extract_file_ops(
    agent_type: &str,
    tool_name: &str,
    tool_input: &serde_json::Value,
) -> Vec<FileOperation> {
    match agent_type {
        "codex" => codex(tool_name, tool_input),
        "copilot" => copilot(tool_name, tool_input),
        _ => claude(tool_name, tool_input),
    }
}

/// Claude (and default): Read/Write/Edit tools carry a `file_path`.
fn claude(tool_name: &str, tool_input: &serde_json::Value) -> Vec<FileOperation> {
    let op = match tool_name {
        "Read" => FileOpType::Read,
        "Write" => FileOpType::Write,
        "Edit" => FileOpType::Edit,
        _ => return vec![],
    };
    let file_path = tool_input
        .get("file_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if file_path.is_empty() {
        vec![]
    } else {
        vec![FileOperation { op, file_path }]
    }
}

/// Copilot: lowercase tool names; path under `file_path` or `path`.
fn copilot(tool_name: &str, tool_input: &serde_json::Value) -> Vec<FileOperation> {
    let op = match tool_name {
        "read" | "view" => FileOpType::Read,
        "write" | "create" => FileOpType::Write,
        "edit" => FileOpType::Edit,
        _ => return vec![],
    };
    let file_path = tool_input
        .get("file_path")
        .or_else(|| tool_input.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if file_path.is_empty() {
        vec![]
    } else {
        vec![FileOperation { op, file_path }]
    }
}

/// Codex: only the `apply_patch` tool carries a patch envelope (at
/// `input` / `command` / `patch`); parse the `*** … File:` markers. Any
/// other tool yields no file ops.
fn codex(tool_name: &str, tool_input: &serde_json::Value) -> Vec<FileOperation> {
    if tool_name != "apply_patch" {
        return vec![];
    }
    let patch_text = tool_input
        .get("input")
        .or_else(|| tool_input.get("command"))
        .or_else(|| tool_input.get("patch"))
        .and_then(|v| v.as_str());
    let Some(text) = patch_text else {
        return vec![];
    };

    let mut ops = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(path) = trimmed.strip_prefix("*** Update File: ") {
            ops.push(FileOperation {
                op: FileOpType::Edit,
                file_path: path.trim().to_string(),
            });
        } else if let Some(path) = trimmed.strip_prefix("*** Add File: ") {
            ops.push(FileOperation {
                op: FileOpType::Write,
                file_path: path.trim().to_string(),
            });
        } else if let Some(path) = trimmed.strip_prefix("*** Delete File: ") {
            ops.push(FileOperation {
                op: FileOpType::Edit,
                file_path: path.trim().to_string(),
            });
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- claude (default) ---
    #[test]
    fn claude_read_write_edit_via_file_path() {
        let ops = extract_file_ops(
            "claude",
            "Read",
            &serde_json::json!({ "file_path": "/abs/path/x.rs" }),
        );
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op, FileOpType::Read);
        assert_eq!(ops[0].file_path, "/abs/path/x.rs");
        assert_eq!(
            extract_file_ops(
                "claude",
                "Edit",
                &serde_json::json!({ "file_path": "/y.rs" })
            )[0]
            .op,
            FileOpType::Edit
        );
        assert_eq!(
            extract_file_ops(
                "claude",
                "Write",
                &serde_json::json!({ "file_path": "/z.rs" })
            )[0]
            .op,
            FileOpType::Write
        );
    }

    #[test]
    fn claude_ignores_bash_and_missing_path() {
        assert!(
            extract_file_ops("claude", "Bash", &serde_json::json!({ "command": "ls" })).is_empty()
        );
        assert!(extract_file_ops("claude", "Read", &serde_json::json!({})).is_empty());
    }

    #[test]
    fn unknown_agent_uses_claude_default() {
        // Agents without a custom strategy fall through to the claude default.
        let ops = extract_file_ops(
            "opencode",
            "Read",
            &serde_json::json!({ "file_path": "/a" }),
        );
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op, FileOpType::Read);
    }

    // --- copilot ---
    #[test]
    fn copilot_read_via_file_path_write_via_path_edit() {
        assert_eq!(
            extract_file_ops(
                "copilot",
                "read",
                &serde_json::json!({ "file_path": "/abs/x" })
            )[0]
            .op,
            FileOpType::Read
        );
        let w = extract_file_ops("copilot", "write", &serde_json::json!({ "path": "/abs/y" }));
        assert_eq!(w[0].op, FileOpType::Write);
        assert_eq!(w[0].file_path, "/abs/y");
        assert_eq!(
            extract_file_ops(
                "copilot",
                "edit",
                &serde_json::json!({ "file_path": "/abs/e" })
            )[0]
            .op,
            FileOpType::Edit
        );
    }

    #[test]
    fn copilot_ignores_unknown_tool() {
        assert!(extract_file_ops(
            "copilot",
            "foo",
            &serde_json::json!({ "file_path": "/abs/z" })
        )
        .is_empty());
    }

    // --- codex ---
    #[test]
    fn codex_parses_update() {
        let ops = extract_file_ops(
            "codex",
            "apply_patch",
            &serde_json::json!({
                "input": "*** Begin Patch\n*** Update File: src/foo.rs\n@@\n- old\n+ new\n*** End Patch"
            }),
        );
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op, FileOpType::Edit);
        assert_eq!(ops[0].file_path, "src/foo.rs");
    }

    #[test]
    fn codex_parses_add_and_delete() {
        let ops = extract_file_ops(
            "codex",
            "apply_patch",
            &serde_json::json!({
                "input": "*** Begin Patch\n*** Add File: new.rs\n+ hi\n*** Delete File: old.rs\n*** End Patch"
            }),
        );
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].op, FileOpType::Write);
        assert_eq!(ops[0].file_path, "new.rs");
        assert_eq!(ops[1].op, FileOpType::Edit);
        assert_eq!(ops[1].file_path, "old.rs");
    }

    #[test]
    fn codex_multi_file_and_command_fallback_and_empty_and_non_apply_patch() {
        let multi = extract_file_ops(
            "codex",
            "apply_patch",
            &serde_json::json!({
                "input": "*** Begin Patch\n*** Update File: a.rs\n@@\n*** Update File: b.rs\n@@\n*** End Patch"
            }),
        );
        assert_eq!(multi.len(), 2);
        assert_eq!(multi[0].file_path, "a.rs");
        assert_eq!(multi[1].file_path, "b.rs");
        assert_eq!(
            extract_file_ops(
                "codex",
                "apply_patch",
                &serde_json::json!({
                    "command": "*** Begin Patch\n*** Update File: x.rs\n*** End Patch"
                })
            )
            .len(),
            1
        );
        assert!(extract_file_ops("codex", "apply_patch", &serde_json::json!({})).is_empty());
        assert!(extract_file_ops(
            "codex",
            "shell_command",
            &serde_json::json!({ "command": "ls" })
        )
        .is_empty());
    }

    #[test]
    fn codex_ignores_non_apply_patch_tool_even_with_markers() {
        assert!(extract_file_ops(
            "codex",
            "shell_execute",
            &serde_json::json!({
                "input": "*** Begin Patch\n*** Update File: sneaky.rs\n*** End Patch"
            })
        )
        .is_empty());
    }
}
