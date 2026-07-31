use std::process::Command;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    // daemon/crates/core -> daemon/crates -> daemon -> repo root
    let repo = format!("{manifest}/../../..");

    // Build scripts are cached aggressively. Without these the stamp goes stale.
    println!("cargo:rerun-if-changed={repo}/.git/HEAD");
    println!("cargo:rerun-if-changed={repo}/.git/refs");
    println!("cargo:rerun-if-changed={manifest}/src");
    println!("cargo:rerun-if-changed={manifest}/../daemon/src");

    let profile = std::env::var("PROFILE").unwrap_or_default();
    let stamp = if profile == "debug" {
        // A git sha doesn't move for uncommitted edits, so dev uses a build
        // timestamp: any rebuild flags the surviving detached daemon.
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("dev-{secs}")
    } else {
        Command::new("git")
            .args(["-C", &repo, "log", "-1", "--format=%h", "--", "daemon"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    };

    println!("cargo:rustc-env=VERNE_DAEMON_SRC={stamp}");
}
