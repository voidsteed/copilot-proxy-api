use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentTarget {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
    #[serde(rename = "antigravity")]
    Antigravity,
    #[serde(rename = "curl")]
    Curl,
}

impl AgentTarget {
    pub const ALL: [AgentTarget; 5] = [
        AgentTarget::ClaudeCode,
        AgentTarget::Codex,
        AgentTarget::OpenCode,
        AgentTarget::Antigravity,
        AgentTarget::Curl,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::Antigravity => "Antigravity CLI",
            Self::Curl => "HTTP",
        }
    }

    pub fn protocol(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Anthropic Messages",
            Self::Codex => "OpenAI Responses",
            Self::OpenCode => "OpenAI Chat Completions",
            Self::Antigravity => "Gemini API",
            Self::Curl => "OpenAI compatible",
        }
    }

    pub fn launch_command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Antigravity => "agy",
            Self::Curl => "curl",
        }
    }

    pub fn is_file_configured(self) -> bool {
        matches!(self, Self::ClaudeCode | Self::Codex | Self::OpenCode)
    }

    pub fn is_launch_configured(self) -> bool {
        matches!(self, Self::Antigravity)
    }

    pub fn incompatible_message(self) -> &'static str {
        match self {
            Self::Antigravity => {
                "Antigravity CLI requires a Google chat model exposed through GitHub Copilot."
            }
            Self::Codex => "Codex requires a model that supports the Responses API.",
            Self::OpenCode => "OpenCode requires a model that supports Chat Completions.",
            Self::ClaudeCode | Self::Curl => {
                "This agent requires a model that supports Chat Completions or the Responses API."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShellPreference {
    #[default]
    Posix,
    Powershell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccountType {
    #[default]
    Individual,
    Business,
    Enterprise,
}

impl AccountType {
    pub const ALL: [AccountType; 3] = [Self::Individual, Self::Business, Self::Enterprise];

    pub fn label(self) -> &'static str {
        match self {
            Self::Individual => "Individual",
            Self::Business => "Business",
            Self::Enterprise => "Enterprise",
        }
    }
}

impl std::fmt::Display for AccountType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentModelChoices {
    #[serde(rename = "claude-code", default)]
    pub claude_code: Option<String>,
    #[serde(default)]
    pub codex: Option<String>,
    #[serde(default)]
    pub opencode: Option<String>,
    #[serde(default)]
    pub antigravity: Option<String>,
}

impl AgentModelChoices {
    pub fn get(&self, target: AgentTarget) -> Option<&str> {
        match target {
            AgentTarget::ClaudeCode => self.claude_code.as_deref(),
            AgentTarget::Codex => self.codex.as_deref(),
            AgentTarget::OpenCode => self.opencode.as_deref(),
            AgentTarget::Antigravity => self.antigravity.as_deref(),
            AgentTarget::Curl => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub account_type: AccountType,
    #[serde(default = "default_true")]
    pub start_on_launch: bool,
    #[serde(default)]
    pub launch_at_login: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default)]
    pub theme: ThemePreference,
    #[serde(default)]
    pub preferred_model: String,
    #[serde(default)]
    pub agent_model_choices: AgentModelChoices,
    #[serde(default)]
    pub shell: ShellPreference,
}

fn default_port() -> u16 {
    4141
}

fn default_true() -> bool {
    true
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            port: 4141,
            account_type: AccountType::Individual,
            start_on_launch: true,
            launch_at_login: false,
            close_to_tray: true,
            theme: ThemePreference::System,
            preferred_model: String::new(),
            agent_model_choices: AgentModelChoices::default(),
            shell: ShellPreference::Posix,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_type: Option<AccountType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_on_launch: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_at_login: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_to_tray: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemePreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellPreference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AccountState {
    SignedOut,
    ExternalUnverified,
    Connecting,
    #[serde(rename_all = "camelCase")]
    AwaitingAuthorization {
        code: String,
        verification_uri: String,
        expires_at: String,
    },
    SignedIn {
        login: String,
        name: Option<String>,
        plan: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthorizationState {
    #[default]
    Idle,
    Connecting {
        #[serde(default)]
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    Awaiting {
        #[serde(default)]
        id: String,
        code: String,
        verification_uri: String,
        expires_at: String,
    },
    Validating {
        #[serde(default)]
        id: String,
    },
    Error {
        #[serde(default)]
        id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GatewayState {
    Stopped,
    Starting,
    #[serde(rename_all = "camelCase")]
    Running {
        url: String,
        started_at: String,
    },
    Stopping,
    #[serde(rename_all = "camelCase")]
    Draining {
        in_flight: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PublicAuthentication {
    None,
    Keyed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConnection {
    pub root_url: String,
    pub api_url: String,
    pub authentication: PublicAuthentication,
}

impl PublicConnection {
    pub fn origin(&self) -> &str {
        self.root_url.trim_end_matches('/')
    }

    pub fn host_label(&self) -> String {
        self.origin()
            .strip_prefix("http://")
            .or_else(|| self.origin().strip_prefix("https://"))
            .unwrap_or(self.origin())
            .to_string()
    }

    pub fn url_for_agent(&self, target: AgentTarget) -> String {
        match target {
            AgentTarget::ClaudeCode => self.root_url.clone(),
            AgentTarget::Antigravity => self.origin().to_string(),
            AgentTarget::Codex | AgentTarget::OpenCode | AgentTarget::Curl => self.api_url.clone(),
        }
    }

    pub fn is_keyed(&self) -> bool {
        matches!(self.authentication, PublicAuthentication::Keyed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProxySource {
    #[default]
    None,
    #[serde(rename_all = "camelCase")]
    NativeManaged {
        session_id: String,
        gateway_generation: u64,
    },
    #[serde(rename_all = "camelCase")]
    LegacyCli {
        status: String,
        observed_at: String,
    },
}

impl ProxySource {
    pub fn is_legacy_cli(&self) -> bool {
        matches!(self, Self::LegacyCli { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentModel {
    #[serde(rename_all = "camelCase")]
    Configured {
        exact: String,
        catalog_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Proposed {
        catalog_id: String,
    },
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    pub target: AgentTarget,
    pub path: String,
    pub status: String,
    pub model: AgentModel,
    pub root_url: Option<String>,
    pub api_url: Option<String>,
    pub authentication_present: bool,
    #[serde(default)]
    pub missing_fields: Vec<String>,
    #[serde(default)]
    pub conflict_fields: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LaunchAgentDiagnostics {
    Absent {
        target: AgentTarget,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Compatible {
        target: AgentTarget,
        path: String,
        existing_model_provider: Option<String>,
        existing_model: Option<String>,
        summary: String,
    },
    Warning {
        target: AgentTarget,
        path: String,
        code: String,
        message: String,
    },
    InvalidFile {
        target: AgentTarget,
        path: String,
        message: String,
    },
}

impl LaunchAgentDiagnostics {
    pub fn target(&self) -> AgentTarget {
        match self {
            Self::Absent { target, .. }
            | Self::Compatible { target, .. }
            | Self::Warning { target, .. }
            | Self::InvalidFile { target, .. } => *target,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Self::Absent { path, .. }
            | Self::Compatible { path, .. }
            | Self::Warning { path, .. }
            | Self::InvalidFile { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ConfigureResult {
    Unchanged {
        view: AgentConfigView,
    },
    Added {
        fields: Vec<String>,
        view: AgentConfigView,
    },
    Conflict {
        fields: Vec<String>,
        view: AgentConfigView,
    },
    Invalid {
        message: String,
        view: AgentConfigView,
    },
}

impl ConfigureResult {
    pub fn view(&self) -> &AgentConfigView {
        match self {
            Self::Unchanged { view }
            | Self::Added { view, .. }
            | Self::Conflict { view, .. }
            | Self::Invalid { view, .. } => view,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub vendor: String,
    #[serde(rename = "type", default)]
    pub model_type: Option<String>,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
    #[serde(default)]
    pub supports: Vec<String>,
    #[serde(default)]
    pub endpoints: Vec<String>,
    #[serde(default)]
    pub preview: bool,
}

impl CatalogModel {
    pub fn is_google_chat(&self) -> bool {
        self.vendor.eq_ignore_ascii_case("google")
            && self.model_type.as_deref().unwrap_or("chat") == "chat"
            && (self.endpoints.is_empty()
                || self.endpoints.iter().any(|e| e == "/chat/completions"))
    }

    pub fn supports_agent(&self, target: AgentTarget) -> bool {
        match target {
            AgentTarget::Antigravity => self.is_google_chat(),
            AgentTarget::Codex => self.endpoints.iter().any(|e| e == "/responses"),
            AgentTarget::OpenCode => self.endpoints.iter().any(|e| e == "/chat/completions"),
            AgentTarget::ClaudeCode | AgentTarget::Curl => self
                .endpoints
                .iter()
                .any(|e| e == "/responses" || e == "/chat/completions"),
        }
    }

    pub fn supports_probe(&self) -> bool {
        self.endpoints
            .iter()
            .any(|e| e == "/chat/completions" || e == "/responses")
            || self.is_google_chat()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum QuotaEntry {
    #[serde(rename_all = "camelCase")]
    Limited {
        id: String,
        label: String,
        remaining: f64,
        limit: f64,
        percent_remaining: f64,
    },
    Unlimited {
        id: String,
        label: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    pub plan: String,
    pub reset_at: Option<String>,
    pub fetched_at: String,
    #[serde(default)]
    pub quotas: Vec<QuotaEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    pub id: String,
    pub started_at: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: f64,
    pub outcome: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTotals {
    pub requests: Option<u64>,
    pub errors: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProbeState {
    #[default]
    Idle,
    Running {
        model: String,
    },
    #[serde(rename_all = "camelCase")]
    Complete {
        model: String,
        text: String,
        duration_ms: f64,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    #[serde(default)]
    pub session_id: String,
    pub revision: u64,
    pub version: String,
    pub platform: String,
    pub fixture: bool,
    pub storage_mode: String,
    pub account: AccountState,
    #[serde(default)]
    pub authorization: AuthorizationState,
    pub gateway: GatewayState,
    #[serde(default)]
    pub connection: Option<PublicConnection>,
    #[serde(default)]
    pub source: ProxySource,
    #[serde(default)]
    pub settings: DesktopSettings,
    #[serde(default)]
    pub agent_configs: Vec<AgentConfigView>,
    #[serde(default)]
    pub launch_agent_diagnostics: Vec<LaunchAgentDiagnostics>,
    #[serde(default)]
    pub last_configure_result: Option<ConfigureResult>,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
    #[serde(default)]
    pub models_fetched_at: Option<String>,
    #[serde(default)]
    pub usage: Option<UsageView>,
    #[serde(default)]
    pub activity: Vec<ActivityRecord>,
    #[serde(default)]
    pub totals: ProxyTotals,
    #[serde(default)]
    pub probe: ProbeState,
    #[serde(default)]
    pub notice: Option<Notice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DesktopCommand {
    SignIn,
    CancelSignIn,
    OpenDevicePage,
    SignOut,
    StartGateway,
    StopGateway,
    DetachLegacy,
    ClearProbe,
    Refresh,
    ClearActivity,
    RotateKey,
    DismissNotice,
    SaveSettings {
        settings: DesktopSettingsPatch,
    },
    #[serde(rename_all = "camelCase")]
    SelectAgentModel {
        target: AgentTarget,
        model_id: String,
    },
    InspectAgentConfig {
        target: AgentTarget,
    },
    InspectLaunchAgent {
        target: AgentTarget,
    },
    ConfigureAgent {
        target: AgentTarget,
    },
    OpenConfigFolder {
        target: AgentTarget,
    },
    Copy {
        target: String,
    },
    #[serde(rename_all = "camelCase")]
    CopyConfig {
        target: AgentTarget,
        model_id: String,
        shell: ShellPreference,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RunProbe {
        model_id: String,
        prompt: String,
    },
}

impl DesktopCommand {
    pub fn kind_key(&self) -> &'static str {
        match self {
            Self::SignIn => "sign-in",
            Self::CancelSignIn => "cancel-sign-in",
            Self::OpenDevicePage => "open-device-page",
            Self::SignOut => "sign-out",
            Self::StartGateway => "start-gateway",
            Self::StopGateway => "stop-gateway",
            Self::DetachLegacy => "detach-legacy",
            Self::ClearProbe => "clear-probe",
            Self::Refresh => "refresh",
            Self::ClearActivity => "clear-activity",
            Self::RotateKey => "rotate-key",
            Self::DismissNotice => "dismiss-notice",
            Self::SaveSettings { .. } => "save-settings",
            Self::SelectAgentModel { .. } => "select-agent-model",
            Self::InspectAgentConfig { .. } => "inspect-agent-config",
            Self::InspectLaunchAgent { .. } => "inspect-launch-agent",
            Self::ConfigureAgent { .. } => "configure-agent",
            Self::OpenConfigFolder { .. } => "open-config-folder",
            Self::Copy { .. } => "copy",
            Self::CopyConfig { .. } => "copy-config",
            Self::RunProbe { .. } => "run-probe",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CommandOutcome {
    Ok {
        #[serde(default)]
        message: Option<String>,
    },
    Rejected {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CommandResponse {
    pub snapshot: DesktopSnapshot,
    pub outcome: CommandOutcome,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HostCall {
    VaultEncrypt { plaintext: String },
    VaultDecrypt { ciphertext: String },
    WriteClipboard { text: String },
    OpenExternal { url: String },
    OpenFolder { path: String },
    ShowUi,
    ApplyLoginItem { enabled: bool },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeOutbound {
    Ready {
        snapshot: DesktopSnapshot,
    },
    Snapshot {
        snapshot: DesktopSnapshot,
    },
    Response {
        id: u64,
        response: CommandResponse,
    },
    HostCall {
        id: u64,
        call: HostCall,
    },
    Fatal {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeInbound {
    Command {
        id: u64,
        command: DesktopCommand,
    },
    HostResult {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Shutdown,
}

pub fn create_config_file_preview(
    target: AgentTarget,
    connection: Option<&PublicConnection>,
    model: &CatalogModel,
    model_id: &str,
) -> Option<(&'static str, String)> {
    let root_url = connection
        .map(|c| c.root_url.as_str())
        .unwrap_or("http://127.0.0.1:4141");
    let api_url = connection
        .map(|c| c.api_url.as_str())
        .unwrap_or("http://127.0.0.1:4141/v1");
    let keyed = connection.map(|c| c.is_keyed()).unwrap_or(false);

    match target {
        AgentTarget::ClaudeCode => {
            let token = if keyed { "<LOCAL_API_KEY>" } else { "dummy" };
            let payload = serde_json::json!({
                "env": {
                    "ANTHROPIC_BASE_URL": root_url,
                    "ANTHROPIC_MODEL": model_id,
                    "ANTHROPIC_AUTH_TOKEN": token,
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
                }
            });
            Some((
                "JSON · ~/.claude/settings.json",
                serde_json::to_string_pretty(&payload).unwrap_or_default(),
            ))
        }
        AgentTarget::Codex => {
            let mut lines = vec![
                format!("model = {}", serde_json::to_string(model_id).unwrap_or_default()),
                "model_provider = \"copilot_proxy\"".to_string(),
                String::new(),
                "[model_providers.copilot_proxy]".to_string(),
                "name = \"Copilot Proxy\"".to_string(),
                format!("base_url = {}", serde_json::to_string(api_url).unwrap_or_default()),
                "wire_api = \"responses\"".to_string(),
            ];
            if keyed {
                lines.push("experimental_bearer_token = \"<LOCAL_API_KEY>\"".to_string());
            }
            Some(("TOML · ~/.codex/config.toml", lines.join("\n")))
        }
        AgentTarget::OpenCode => {
            let (provider, inner_id) = match model_id.split_once('/') {
                Some((p, m)) if !p.is_empty() && !m.is_empty() => (p, m),
                _ => ("copilot_proxy", model_id),
            };
            let mut options = serde_json::Map::new();
            options.insert("baseURL".to_string(), Value::String(api_url.to_string()));
            if keyed {
                options.insert(
                    "apiKey".to_string(),
                    Value::String("<LOCAL_API_KEY>".to_string()),
                );
            }
            let mut model_entry = serde_json::Map::new();
            model_entry.insert(
                "name".to_string(),
                Value::String(if model.name.is_empty() {
                    inner_id.to_string()
                } else {
                    model.name.clone()
                }),
            );
            if let (Some(ctx), Some(out)) = (model.context_window, model.max_output) {
                model_entry.insert(
                    "limit".to_string(),
                    serde_json::json!({ "context": ctx, "output": out }),
                );
            }
            let mut models_map = serde_json::Map::new();
            models_map.insert(inner_id.to_string(), Value::Object(model_entry));
            let mut provider_map = serde_json::Map::new();
            provider_map.insert(
                provider.to_string(),
                serde_json::json!({
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Copilot Proxy",
                    "options": Value::Object(options),
                    "models": Value::Object(models_map)
                }),
            );
            let payload = serde_json::json!({
                "$schema": "https://opencode.ai/config.json",
                "model": format!("{provider}/{inner_id}"),
                "provider": Value::Object(provider_map)
            });
            Some((
                "JSONC · ~/.config/opencode/opencode.jsonc",
                serde_json::to_string_pretty(&payload).unwrap_or_default(),
            ))
        }
        AgentTarget::Antigravity | AgentTarget::Curl => None,
    }
}

pub fn create_launch_preview(
    connection: &PublicConnection,
    model_id: &str,
    shell: ShellPreference,
) -> String {
    let origin = connection.origin();
    let api_key = if connection.is_keyed() {
        "<LOCAL_API_KEY>"
    } else {
        "local-proxy"
    };
    let quote = |value: &str| match shell {
        ShellPreference::Posix => format!("'{}'", value.replace('\'', "'\\''")),
        ShellPreference::Powershell => format!("'{}'", value.replace('\'', "''")),
    };
    let env_line = |name: &str, value: &str| match shell {
        ShellPreference::Posix => format!("export {name}={}", quote(value)),
        ShellPreference::Powershell => format!("$env:{name} = {}", quote(value)),
    };
    match shell {
        ShellPreference::Posix => format!(
            "{}\n{}\n\nagy --settings '{{\"modelProvider\":\"gemini\"}}' --model {}",
            env_line("GOOGLE_GEMINI_BASE_URL", origin),
            env_line("GEMINI_API_KEY", api_key),
            quote(model_id),
        ),
        ShellPreference::Powershell => format!(
            "{}\n{}\n$agySettings = '{{\"modelProvider\":\"gemini\"}}'\n\nagy --settings $agySettings --model {}",
            env_line("GOOGLE_GEMINI_BASE_URL", origin),
            env_line("GEMINI_API_KEY", api_key),
            quote(model_id),
        ),
    }
}

pub fn create_http_preview(connection: &PublicConnection, model: &CatalogModel) -> (String, String) {
    let chat = model.endpoints.iter().any(|e| e == "/chat/completions");
    let endpoint = if chat { "chat/completions" } else { "responses" };
    let url = format!("{}/{}", connection.api_url.trim_end_matches('/'), endpoint);
    let prompt = "Reply with exactly: Copilot Proxy is connected.";
    let payload = if chat {
        serde_json::json!({
            "model": model.id,
            "messages": [{ "role": "user", "content": prompt }]
        })
    } else {
        serde_json::json!({
            "model": model.id,
            "input": prompt
        })
    };
    let body = serde_json::to_string_pretty(&payload).unwrap_or_default();
    (url, body)
}
