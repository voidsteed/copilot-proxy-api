use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::contracts::{
    BridgeInbound, BridgeOutbound, CommandResponse, DesktopCommand, DesktopSnapshot, HostCall,
};
use crate::vault::NativeHost;

#[derive(Debug, Clone, Hash)]
pub struct BridgeConfig {
    pub node_path: PathBuf,
    pub bridge_script: PathBuf,
    pub engine_script: PathBuf,
    pub data_dir: PathBuf,
    pub state_dir: Option<PathBuf>,
    pub fixture_mode: bool,
    pub version: String,
}

#[derive(Debug, Clone)]
pub enum BridgeEvent {
    Connected(BridgeClient),
    Ready(DesktopSnapshot),
    Snapshot(DesktopSnapshot),
    Response { id: u64, response: CommandResponse },
    ShowUi,
    Fatal(String),
    Disconnected(String),
}

#[derive(Debug, Clone)]
pub struct BridgeClient {
    tx: mpsc::UnboundedSender<BridgeInbound>,
}

impl BridgeClient {
    pub fn send_command(&self, id: u64, command: DesktopCommand) -> Result<(), String> {
        self.tx
            .send(BridgeInbound::Command { id, command })
            .map_err(|_| "The local backend connection is closed.".to_string())
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(BridgeInbound::Shutdown);
    }
}

pub fn resolve_node_binary() -> PathBuf {
    if let Ok(explicit) = std::env::var("COPILOT_PROXY_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return path;
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/share/fnm/aliases/default/bin/node"));
        candidates.push(home.join(".nvm/current/bin/node"));
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".asdf/shims/node"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    candidates.push(PathBuf::from("/usr/local/bin/node"));

    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("node");
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    PathBuf::from("node")
}

pub fn resolve_bridge_scripts() -> (PathBuf, PathBuf) {
    if let Ok(dir) = std::env::var("COPILOT_PROXY_BRIDGE_DIR") {
        let base = PathBuf::from(dir);
        return (base.join("bridge.cjs"), base.join("engine.cjs"));
    }

    // Packaged macOS .app layout: Contents/MacOS/<bin> -> Contents/Resources/bridge/
    if let Ok(exe) = std::env::current_exe()
        && let Some(macos_dir) = exe.parent()
        && let Some(contents_dir) = macos_dir.parent()
    {
        let bundled = contents_dir.join("Resources/bridge");
        let bridge = bundled.join("bridge.cjs");
        let engine = bundled.join("engine.cjs");
        if bridge.is_file() && engine.is_file() {
            return (bridge, engine);
        }
    }

    // Development layout relative to repo worktree
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest_dir.parent() {
        let dev = repo_root.join("desktop/dist");
        let bridge = dev.join("bridge.cjs");
        let engine = dev.join("engine.cjs");
        if bridge.is_file() && engine.is_file() {
            return (bridge, engine);
        }
    }

    (PathBuf::from("bridge.cjs"), PathBuf::from("engine.cjs"))
}

pub fn default_data_dir(fixture_mode: bool) -> PathBuf {
    if let Ok(explicit) = std::env::var("COPILOT_PROXY_DATA_DIR")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit);
    }
    if fixture_mode {
        return std::env::temp_dir().join("copilot-proxy-rust-fixture");
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Copilot Proxy")
}

pub fn spawn_bridge_worker(
    config: BridgeConfig,
    mut event_tx: iced::futures::channel::mpsc::Sender<BridgeEvent>,
) {
    use iced::futures::SinkExt;

    tokio::spawn(async move {
        let host = Arc::new(NativeHost::new(config.fixture_mode));
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<BridgeInbound>();
        let client = BridgeClient { tx: in_tx.clone() };
        let _ = event_tx.send(BridgeEvent::Connected(client)).await;

        let mut cmd = Command::new(&config.node_path);
        cmd.arg("--max-semi-space-size=2")
            .arg("--max-old-space-size=64")
            .arg(&config.bridge_script)
            .arg("--data-dir")
            .arg(&config.data_dir)
            .arg("--engine-path")
            .arg(&config.engine_script)
            .arg("--version")
            .arg(&config.version)
            .arg("--encryption")
            .arg(host.encryption_mode())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(state_dir) = &config.state_dir {
            cmd.arg("--state-dir").arg(state_dir);
        }
        if config.fixture_mode {
            cmd.arg("--fixture");
        }
        if let Some(parent) = Path::new(&config.bridge_script).parent() {
            cmd.current_dir(parent);
        }

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                let _ = event_tx
                    .send(BridgeEvent::Fatal(format!(
                        "Could not start the proxy bridge ({}): {err}",
                        config.node_path.display()
                    )))
                    .await;
                return;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = event_tx
                    .send(BridgeEvent::Fatal("Bridge stdin was unavailable.".to_string()))
                    .await;
                return;
            }
        };
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = event_tx
                    .send(BridgeEvent::Fatal("Bridge stdout was unavailable.".to_string()))
                    .await;
                return;
            }
        };
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    eprintln!("[bridge] {line}");
                }
            });
        }

        // Writer task: forwards commands & host results to bridge stdin as NDJSON
        let writer = tokio::spawn(async move {
            while let Some(message) = in_rx.recv().await {
                let is_shutdown = matches!(message, BridgeInbound::Shutdown);
                if let Ok(mut serialized) = serde_json::to_string(&message) {
                    serialized.push('\n');
                    if stdin.write_all(serialized.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
                if is_shutdown {
                    break;
                }
            }
        });

        // Reader loop: consumes NDJSON messages from bridge stdout
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<BridgeOutbound>(trimmed) {
                Ok(BridgeOutbound::Ready { snapshot }) => {
                    let _ = event_tx.send(BridgeEvent::Ready(snapshot)).await;
                }
                Ok(BridgeOutbound::Snapshot { snapshot }) => {
                    let _ = event_tx.send(BridgeEvent::Snapshot(snapshot)).await;
                }
                Ok(BridgeOutbound::Response { id, response }) => {
                    let _ = event_tx
                        .send(BridgeEvent::Response { id, response })
                        .await;
                }
                Ok(BridgeOutbound::HostCall { id, call }) => {
                    if matches!(call, HostCall::ShowUi) {
                        let _ = event_tx.send(BridgeEvent::ShowUi).await;
                        let _ = in_tx.send(BridgeInbound::HostResult {
                            id,
                            ok: true,
                            value: None,
                            error: None,
                        });
                        continue;
                    }
                    let host_clone = Arc::clone(&host);
                    let tx_clone = in_tx.clone();
                    tokio::task::spawn_blocking(move || {
                        let result = match host_clone.handle_call(call) {
                            Ok(value) => BridgeInbound::HostResult {
                                id,
                                ok: true,
                                value,
                                error: None,
                            },
                            Err(error) => BridgeInbound::HostResult {
                                id,
                                ok: false,
                                value: None,
                                error: Some(error),
                            },
                        };
                        let _ = tx_clone.send(result);
                    });
                }
                Ok(BridgeOutbound::Fatal { message }) => {
                    let _ = event_tx.send(BridgeEvent::Fatal(message)).await;
                }
                Err(err) => {
                    eprintln!("[bridge] ignored invalid frame: {err}");
                }
            }
        }

        writer.abort();
        let status = child.wait().await;
        let reason = match status {
            Ok(code) if code.success() => "Proxy bridge stopped.".to_string(),
            Ok(code) => format!("Proxy bridge exited with status {code}."),
            Err(err) => format!("Proxy bridge terminated: {err}"),
        };
        let _ = event_tx.send(BridgeEvent::Disconnected(reason)).await;
    });
}
