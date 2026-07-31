//! `verne` — the lean, persistent daemon: PTY terminal sessions + WebSocket
//! streaming only. Detached from Electron; survives app restarts. Everything
//! else Rust used to do now lives in the `verne-sidecar` binary.
pub fn version_json() -> String {
    serde_json::json!({ "src": verne_core::DAEMON_SRC }).to_string()
}

fn main() {
    verne_core::raise_fd_limit();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("{}", version_json());
        return;
    }
    if args.iter().any(|a| a == "--server") {
        verne_core::daemon::run();
        return;
    }
    eprintln!("usage: verne --server");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_json_reports_non_empty_src() {
        let v: serde_json::Value = serde_json::from_str(&super::version_json()).unwrap();
        let src = v["src"].as_str().expect("src must be a string");
        assert!(!src.is_empty());
    }
}
