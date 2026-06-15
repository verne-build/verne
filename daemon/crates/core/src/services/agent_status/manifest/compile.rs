use regex::Regex;

use super::schema::Gate;

#[derive(Debug)]
pub struct CompiledGate {
    contains: Vec<String>, // lowercased
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
    all: Vec<CompiledGate>,
    any: Vec<CompiledGate>,
    not: Vec<CompiledGate>,
}

impl CompiledGate {
    pub fn compile(gate: &Gate) -> Result<Self, String> {
        let compile_all = |gs: &[Gate]| gs.iter().map(Self::compile).collect::<Result<Vec<_>, _>>();
        let compile_re = |ps: &[String]| {
            ps.iter()
                .map(|p| Regex::new(p).map_err(|e| format!("invalid regex {p:?}: {e}")))
                .collect::<Result<Vec<_>, _>>()
        };
        Ok(Self {
            contains: gate.contains.iter().map(|s| s.to_lowercase()).collect(),
            regex: compile_re(&gate.regex)?,
            line_regex: compile_re(&gate.line_regex)?,
            all: compile_all(&gate.all)?,
            any: compile_all(&gate.any)?,
            not: compile_all(&gate.not)?,
        })
    }

    pub fn matches(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        self.matches_with(text, &lower)
    }

    fn matches_with(&self, text: &str, lower: &str) -> bool {
        if !self.contains.iter().all(|n| lower.contains(n)) {
            return false;
        }
        if !self.regex.iter().all(|re| re.is_match(text)) {
            return false;
        }
        if !self
            .line_regex
            .iter()
            .all(|re| text.lines().any(|l| re.is_match(l)))
        {
            return false;
        }
        if !self.all.iter().all(|g| g.matches_with(text, lower)) {
            return false;
        }
        if !self.any.is_empty() && !self.any.iter().any(|g| g.matches_with(text, lower)) {
            return false;
        }
        if self.not.iter().any(|g| g.matches_with(text, lower)) {
            return false;
        }
        true
    }
}
