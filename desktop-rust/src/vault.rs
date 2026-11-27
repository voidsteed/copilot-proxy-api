use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rand::RngCore;
use std::process::Command;

use crate::contracts::HostCall;

const KEYCHAIN_SERVICE: &str = "com.voidsteed.copilotproxy.rust";
const KEYCHAIN_ACCOUNT: &str = "vault-key-v1";
const ALLOWED_EXTERNAL_URL: &str = "https://github.com/login/device";

pub struct NativeHost {
    key_bytes: Option<[u8; 32]>,
    fixture_mode: bool,
}

impl NativeHost {
    pub fn new(fixture_mode: bool) -> Self {
        let key_bytes = if fixture_mode {
            None
        } else {
            load_or_create_keychain_key().ok()
        };
        Self {
            key_bytes,
            fixture_mode,
        }
    }

    pub fn encryption_mode(&self) -> &'static str {
        if self.key_bytes.is_some() {
            "encrypted"
        } else {
            "session-only"
        }
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let key = self
            .key_bytes
            .as_ref()
            .ok_or_else(|| "Secure credential storage is unavailable.".to_string())?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid vault key".to_string())?;
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|_| "Vault encryption failed.".to_string())?;
        let mut payload = Vec::with_capacity(1 + 12 + ciphertext.len());
        payload.push(1u8);
        payload.extend_from_slice(&nonce_bytes);
        payload.extend_from_slice(&ciphertext);
        Ok(BASE64.encode(payload))
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String, String> {
        let key = self
            .key_bytes
            .as_ref()
            .ok_or_else(|| "Secure credential storage is unavailable.".to_string())?;
        let raw = BASE64
            .decode(encoded.as_bytes())
            .map_err(|_| "Invalid encrypted vault payload.".to_string())?;
        if raw.len() < 14 || raw[0] != 1u8 {
            return Err("Unsupported encrypted vault format.".to_string());
        }
        let nonce = Nonce::from_slice(&raw[1..13]);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid vault key".to_string())?;
        let plaintext = cipher
            .decrypt(nonce, &raw[13..])
            .map_err(|_| "Saved sign-in could not be unlocked. Sign in again.".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "Corrupted vault plaintext.".to_string())
    }

    pub fn handle_call(&self, call: HostCall) -> Result<Option<serde_json::Value>, String> {
        match call {
            HostCall::VaultEncrypt { plaintext } => {
                let encrypted = self.encrypt(&plaintext)?;
                Ok(Some(serde_json::Value::String(encrypted)))
            }
            HostCall::VaultDecrypt { ciphertext } => {
                let decrypted = self.decrypt(&ciphertext)?;
                Ok(Some(serde_json::Value::String(decrypted)))
            }
            HostCall::WriteClipboard { text } => {
                write_clipboard(&text)?;
                Ok(None)
            }
            HostCall::OpenExternal { url } => {
                if url != ALLOWED_EXTERNAL_URL {
                    return Err("Only GitHub sign-in can be opened.".to_string());
                }
                if !self.fixture_mode {
                    open_target(&url)?;
                }
                Ok(None)
            }
            HostCall::OpenFolder { path } => {
                if !self.fixture_mode {
                    open_target(&path)?;
                }
                Ok(None)
            }
            HostCall::ShowUi => Ok(None),
            HostCall::ApplyLoginItem { enabled } => {
                if !self.fixture_mode {
                    apply_macos_launch_agent(enabled)?;
                }
                Ok(None)
            }
        }
    }
}

pub fn write_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|err| format!("Clipboard is unavailable: {err}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|err| format!("Could not copy to clipboard: {err}"))
}

fn open_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(target).status();
    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open").arg(target).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", target]).status();

    let status = status.map_err(|err| format!("Could not open target: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("The system refused to open the requested target.".to_string())
    }
}

fn apply_macos_launch_agent(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable.".to_string())?;
        let agents_dir = home.join("Library/LaunchAgents");
        let plist_path = agents_dir.join("com.voidsteed.copilotproxy.plist");
        if !enabled {
            if plist_path.exists() {
                std::fs::remove_file(&plist_path)
                    .map_err(|err| format!("Could not remove login item: {err}"))?;
            }
            return Ok(());
        }
        let exe = std::env::current_exe()
            .map_err(|err| format!("Could not resolve app path: {err}"))?;
        let exe_str = escape_xml(&exe.to_string_lossy());
        std::fs::create_dir_all(&agents_dir)
            .map_err(|err| format!("Could not prepare LaunchAgents folder: {err}"))?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.voidsteed.copilotproxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe_str}</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
        );
        std::fs::write(&plist_path, plist)
            .map_err(|err| format!("Could not write login item: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn load_or_create_keychain_key() -> Result<[u8; 32], String> {
    use security_framework::passwords::{get_generic_password, set_generic_password};

    if let Ok(existing) = get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        if existing.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&existing);
            return Ok(key);
        }
        if let Ok(decoded) = BASE64.decode(&existing)
            && decoded.len() == 32
        {
            let mut key = [0u8; 32];
            key.copy_from_slice(&decoded);
            return Ok(key);
        }
    }

    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let encoded = BASE64.encode(key);
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, encoded.as_bytes())
        .map_err(|err| format!("Keychain write failed: {err}"))?;
    Ok(key)
}

#[cfg(not(target_os = "macos"))]
fn load_or_create_keychain_key() -> Result<[u8; 32], String> {
    Err("Native Keychain encryption is configured for macOS.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_aes_gcm_encryption() {
        let host = NativeHost {
            key_bytes: Some([42u8; 32]),
            fixture_mode: true,
        };
        let secret = r#"{"githubToken":"gho_test","gatewayKey":"0123456789abcdef0123456789abcdef"}"#;
        let encrypted = host.encrypt(secret).expect("encrypt");
        assert_ne!(encrypted, secret);
        let decrypted = host.decrypt(&encrypted).expect("decrypt");
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn rejects_non_github_external_urls() {
        let host = NativeHost::new(true);
        let err = host
            .handle_call(HostCall::OpenExternal {
                url: "https://example.com".to_string(),
            })
            .unwrap_err();
        assert!(err.contains("Only GitHub sign-in"));
    }
}
