// File-operation types extracted from agent session logs. The former
// session-context / last-assistant-text readers (for the dropped AI
// commit-message + title features) were removed; only these data types remain,
// constructed by each provider's log parser.

#[derive(Debug, Clone)]
pub struct FileOperation {
    pub op: FileOpType,
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOpType {
    Read,
    Write,
    Edit,
}
