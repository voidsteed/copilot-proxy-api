pub mod activity;
pub mod agents;
pub mod models;
pub mod overview;
pub mod settings;

use std::collections::{BTreeSet, HashMap};

use iced::widget::{
    button, column, container, mouse_area, row, scrollable, space, text, Container,
};
use iced::{Alignment, Border, Element, Font, Length, Padding};

use crate::bridge::{BridgeClient, BridgeConfig, BridgeEvent};
use crate::contracts::{
    AccountState, AccountType, AgentTarget, AuthorizationState, DesktopCommand, DesktopSettings,
    DesktopSnapshot, GatewayState, ShellPreference, ThemePreference,
};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::tray::{TrayAction, TrayController};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Page {
    Overview,
    Agents,
    Models,
    Activity,
    Settings,
}

impl Page {
    pub const ALL: [Page; 5] = [
        Page::Overview,
        Page::Agents,
        Page::Models,
        Page::Activity,
        Page::Settings,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Agents => "Agents",
            Self::Models => "Models",
            Self::Activity => "Activity",
            Self::Settings => "Settings",
        }
    }

    pub fn icon(self) -> &'static [u8] {
        match self {
            Self::Overview => icons::OVERVIEW,
            Self::Agents => icons::AGENTS,
            Self::Models => icons::MODELS,
            Self::Activity => icons::ACTIVITY,
            Self::Settings => icons::SETTINGS,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    InitTray,
    Tray(TrayAction),
    ToastTick,
    Bridge(BridgeEvent),
    WindowOpened(iced::window::Id),
    WindowCloseRequested(iced::window::Id),
    WindowClosed(iced::window::Id),
    WindowFocused,
    DragWindow,
    Navigate(Page),
    RunCommand(DesktopCommand, Option<String>),
    ToggleTestPanel(bool),
    OpenProbeForModel(String),
    ProbeModelChanged(String),
    ProbePromptChanged(String),
    SubmitProbe,
    SelectAgentTab(AgentTarget),
    SelectHttpModel(String),
    ModelSearchChanged(String),
    ModelVendorFilterChanged(String),
    ModelFeatureFilterChanged(String),
    ClearModelFilters,
    ActivityModelFilterChanged(String),
    ActivityOutcomeFilterChanged(String),
    ClearActivityFilters,
    ToggleActivityRow(String),
    SettingsThemeChanged(ThemePreference),
    SettingsShellChanged(ShellPreference),
    SettingsLaunchAtLoginToggled(bool),
    SettingsStartOnLaunchToggled(bool),
    SettingsCloseToTrayToggled(bool),
    SettingsPortChanged(String),
    SettingsAccountTypeChanged(AccountType),
    SaveSettings,
    DiscardSettings,
    DismissActionError,
    RetryBridge,
    QuitApp,
    ScreenshotCaptured(iced::window::Screenshot),
}

pub struct PendingCommand {
    pub kind_key: &'static str,
    pub confirmation: Option<String>,
}

pub struct ScreenshotPlan {
    pub dir: std::path::PathBuf,
    pub steps: Vec<(&'static str, Page, Option<ThemePreference>, Option<AgentTarget>)>,
    pub index: usize,
    pub settle_ticks: u8,
    pub capturing: bool,
}

pub struct AppState {
    pub window_id: Option<iced::window::Id>,
    pub tray: Option<TrayController>,
    pub bridge: Option<BridgeClient>,
    pub bridge_config: BridgeConfig,
    pub bridge_restart_token: u64,
    pub background_launch: bool,
    pub shutting_down: bool,
    pub system_dark: bool,
    pub snapshot: Option<DesktopSnapshot>,
    pub fatal_error: Option<String>,
    pub action_error: Option<String>,
    pub toast: Option<(String, u8)>,
    pub page: Page,
    pub next_command_id: u64,
    pub pending: HashMap<u64, PendingCommand>,
    pub pending_kinds: BTreeSet<&'static str>,
    // Overview test probe state
    pub test_panel_open: bool,
    pub probe_model_id: String,
    pub probe_prompt: String,
    // Agents state
    pub agent_tab: AgentTarget,
    pub http_model_id: String,
    // Models filters
    pub model_query: String,
    pub model_vendor_filter: String,
    pub model_feature_filter: String,
    // Activity filters & expansion
    pub activity_model_filter: String,
    pub activity_outcome_filter: String,
    pub expanded_activity_key: Option<String>,
    // Settings draft
    pub settings_draft: DesktopSettings,
    pub port_input: String,
    pub settings_synced_revision: Option<u64>,
    // Optional automated screenshot capture mode
    pub screenshot_plan: Option<ScreenshotPlan>,
}

impl AppState {
    pub fn palette(&self) -> Palette {
        let pref = if self.page == Page::Settings {
            self.settings_draft.theme
        } else {
            self.snapshot
                .as_ref()
                .map(|s| s.settings.theme)
                .unwrap_or(ThemePreference::System)
        };
        theme::resolve_palette(pref, self.system_dark)
    }

    pub fn is_pending(&self, key: &str) -> bool {
        self.pending_kinds.contains(key)
    }

    pub fn recompute_pending_kinds(&mut self) {
        self.pending_kinds.clear();
        for item in self.pending.values() {
            self.pending_kinds.insert(item.kind_key);
        }
    }

    pub fn sync_settings_from_snapshot(&mut self, snapshot: &DesktopSnapshot) {
        let should_reset = self.settings_synced_revision.is_none() || !self.is_settings_dirty();
        if should_reset {
            self.settings_draft = snapshot.settings.clone();
            self.port_input = snapshot.settings.port.to_string();
        }
        self.settings_synced_revision = Some(snapshot.revision);
    }

    pub fn parsed_port(&self) -> Option<u16> {
        let trimmed = self.port_input.trim();
        if trimmed.is_empty() || trimmed.len() > 5 || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let port: u16 = trimmed.parse().ok()?;
        if port >= 1024 { Some(port) } else { None }
    }

    pub fn is_settings_dirty(&self) -> bool {
        let Some(saved) = self.snapshot.as_ref().map(|s| &s.settings) else {
            return false;
        };
        let external = self
            .snapshot
            .as_ref()
            .map(|s| s.source.is_legacy_cli())
            .unwrap_or(false);
        let d = &self.settings_draft;
        let port_changed = self.port_input.trim() != saved.port.to_string();
        d.theme != saved.theme
            || d.shell != saved.shell
            || d.launch_at_login != saved.launch_at_login
            || d.start_on_launch != saved.start_on_launch
            || d.close_to_tray != saved.close_to_tray
            || port_changed
            || (!external && d.account_type != saved.account_type)
    }

    pub fn authorization_active(&self) -> bool {
        let Some(snap) = &self.snapshot else {
            return false;
        };
        !matches!(snap.authorization, AuthorizationState::Idle)
            || matches!(
                snap.account,
                AccountState::Connecting | AccountState::AwaitingAuthorization { .. }
            )
    }
}

pub fn gateway_status_meta(gateway: &GatewayState) -> (&'static str, Tone) {
    match gateway {
        GatewayState::Running { .. } => ("Running", Tone::Success),
        GatewayState::Starting => ("Starting", Tone::Warning),
        GatewayState::Stopping => ("Stopping", Tone::Warning),
        GatewayState::Draining { .. } => ("Finishing", Tone::Warning),
        GatewayState::Error { .. } => ("Attention", Tone::Error),
        GatewayState::Stopped => ("Stopped", Tone::Neutral),
    }
}

pub fn mono_font() -> Font {
    Font::MONOSPACE
}

pub fn semibold_font() -> Font {
    Font {
        weight: iced::font::Weight::Semibold,
        ..Font::DEFAULT
    }
}

pub fn medium_font() -> Font {
    Font {
        weight: iced::font::Weight::Medium,
        ..Font::DEFAULT
    }
}

pub fn status_pill<'a>(
    p: Palette,
    tone: Tone,
    label: impl Into<String>,
    dot: bool,
) -> Element<'a, Message> {
    let (fg, _, _) = tone.colors(p);
    let dot_color = match tone {
        Tone::Success => p.success_dot,
        _ => fg,
    };
    let mut content = row![].spacing(6).align_y(Alignment::Center);
    if dot {
        content = content.push(
            container(space().width(6).height(6)).style(move |_| container::Style {
                background: Some(iced::Background::Color(dot_color)),
                border: Border {
                    radius: iced::border::Radius::new(999.0),
                    ..Default::default()
                },
                ..Default::default()
            }),
        );
    }
    content = content.push(text(label.into()).size(11).font(medium_font()).color(fg));
    container(content)
        .padding([4, 10])
        .style(theme::pill_style(p, tone))
        .into()
}

pub fn btn_primary<'a>(
    p: Palette,
    label: &'a str,
    icon_bytes: Option<&'static [u8]>,
    on_press: Option<Message>,
) -> Element<'a, Message> {
    let mut r = row![].spacing(7).align_y(Alignment::Center);
    if let Some(bytes) = icon_bytes {
        r = r.push(icons::icon(bytes, 14.0, p.on_accent));
    }
    r = r.push(text(label).size(13).font(medium_font()));
    let b = button(r)
        .padding([8, 14])
        .style(theme::primary_button_style(p));
    match on_press {
        Some(msg) => b.on_press(msg).into(),
        None => b.into(),
    }
}

pub fn btn_secondary<'a>(
    p: Palette,
    label: &'a str,
    icon_bytes: Option<&'static [u8]>,
    on_press: Option<Message>,
) -> Element<'a, Message> {
    let fg = if on_press.is_some() { p.text } else { p.faint };
    let mut r = row![].spacing(7).align_y(Alignment::Center);
    if let Some(bytes) = icon_bytes {
        r = r.push(icons::icon(bytes, 14.0, fg));
    }
    r = r.push(text(label).size(13).font(medium_font()));
    let b = button(r)
        .padding([8, 13])
        .style(theme::secondary_button_style(p));
    match on_press {
        Some(msg) => b.on_press(msg).into(),
        None => b.into(),
    }
}

pub fn btn_ghost<'a>(
    p: Palette,
    label: &'a str,
    icon_bytes: Option<&'static [u8]>,
    on_press: Option<Message>,
) -> Element<'a, Message> {
    let fg = if on_press.is_some() { p.muted } else { p.faint };
    let mut r = row![].spacing(6).align_y(Alignment::Center);
    if let Some(bytes) = icon_bytes {
        r = r.push(icons::icon(bytes, 14.0, fg));
    }
    if !label.is_empty() {
        r = r.push(text(label).size(12.5).font(medium_font()));
    }
    let b = button(r)
        .padding([7, 10])
        .style(theme::ghost_button_style(p));
    match on_press {
        Some(msg) => b.on_press(msg).into(),
        None => b.into(),
    }
}

pub fn btn_icon<'a>(
    p: Palette,
    icon_bytes: &'static [u8],
    on_press: Option<Message>,
) -> Element<'a, Message> {
    let fg = if on_press.is_some() { p.muted } else { p.faint };
    let b = button(icons::icon(icon_bytes, 15.0, fg))
        .padding([7, 8])
        .style(theme::ghost_button_style(p));
    match on_press {
        Some(msg) => b.on_press(msg).into(),
        None => b.into(),
    }
}

pub fn card<'a>(p: Palette, content: impl Into<Element<'a, Message>>) -> Container<'a, Message> {
    container(content).style(theme::card_style(p))
}

pub fn hairline_h<'a>(p: Palette) -> Element<'a, Message> {
    container(space().width(Length::Fill).height(1))
        .style(theme::hairline_style(p))
        .into()
}

pub fn hairline_v<'a>(p: Palette) -> Element<'a, Message> {
    container(space().width(1).height(Length::Fill))
        .style(theme::hairline_style(p))
        .into()
}

pub fn empty_state<'a>(
    p: Palette,
    icon_bytes: &'static [u8],
    title: &'a str,
    subtitle: &'a str,
    action: Option<Element<'a, Message>>,
) -> Element<'a, Message> {
    let mut col = column![
        container(icons::icon(icon_bytes, 20.0, p.muted))
            .center_x(42)
            .center_y(42)
            .style(theme::icon_well_style(p, false)),
        text(title).size(14).font(semibold_font()).color(p.text),
        text(subtitle).size(12.5).color(p.muted),
    ]
    .spacing(8)
    .align_x(Alignment::Center);

    if let Some(act) = action {
        col = col.push(container(act).padding(Padding {
            top: 8.0,
            ..Padding::ZERO
        }));
    }

    container(col)
        .width(Length::Fill)
        .padding([26, 24])
        .align_x(Alignment::Center)
        .into()
}

pub fn format_number(value: Option<u64>) -> String {
    let Some(n) = value else {
        return "-".to_string();
    };
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

pub fn format_compact_limit(value: Option<u64>) -> String {
    let Some(n) = value else {
        return "-".to_string();
    };
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{}k", (n + 500) / 1_000)
    } else {
        n.to_string()
    }
}

pub fn format_duration(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{} ms", ms.round() as u64)
    } else {
        format!("{:.1} s", ms / 1000.0)
    }
}

pub fn format_timestamp_short(iso: &str) -> String {
    if let Some((y, mo, d, h, mi, s)) = parse_utc_iso_timestamp(iso)
        && let Some((lh, lmi, ls)) = utc_to_local_hms(y, mo, d, h, mi, s)
    {
        return format!("{lh:02}:{lmi:02}:{ls:02}");
    }
    if let Some((_, time_part)) = iso.split_once('T') {
        let clean = time_part
            .split(['.', 'Z', '+'])
            .next()
            .unwrap_or(time_part);
        return clean.chars().take(8).collect();
    }
    iso.to_string()
}

fn parse_utc_iso_timestamp(iso: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    let trimmed = iso.trim();
    if !trimmed.ends_with('Z') {
        return None;
    }
    let (date, time_raw) = trimmed.strip_suffix('Z')?.split_once('T')?;
    let mut d_parts = date.split('-');
    let y: i32 = d_parts.next()?.parse().ok()?;
    let mo: u32 = d_parts.next()?.parse().ok()?;
    let d: u32 = d_parts.next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let time_no_frac = time_raw.split('.').next()?;
    let mut t_parts = time_no_frac.split(':');
    let h: u32 = t_parts.next()?.parse().ok()?;
    let mi: u32 = t_parts.next()?.parse().ok()?;
    let s: u32 = t_parts.next()?.parse().ok()?;
    if h >= 24 || mi >= 60 || s >= 60 {
        return None;
    }
    Some((y, mo, d, h, mi, s))
}

#[cfg(unix)]
fn utc_to_local_hms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<(u32, u32, u32)> {
    // Howard Hinnant civil-from-days formula -> Unix epoch seconds (UTC)
    let y_adj = if mo <= 2 { y - 1 } else { y } as i64;
    let era = y_adj.div_euclid(400);
    let yoe = (y_adj - era * 400) as u64;
    let m = mo as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + (doe as i64) - 719_468;
    let epoch = days * 86_400 + (h as i64) * 3_600 + (mi as i64) * 60 + (s as i64);

    let time_t = epoch as libc::time_t;
    let mut local_tm: libc::tm = unsafe { std::mem::zeroed() };
    let ptr = unsafe { libc::localtime_r(&time_t, &mut local_tm) };
    if ptr.is_null() {
        return None;
    }
    Some((
        local_tm.tm_hour as u32,
        local_tm.tm_min as u32,
        local_tm.tm_sec as u32,
    ))
}

#[cfg(not(unix))]
fn utc_to_local_hms(_y: i32, _mo: u32, _d: u32, h: u32, mi: u32, s: u32) -> Option<(u32, u32, u32)> {
    Some((h, mi, s))
}

pub fn infer_model_from_path(path: &str) -> Option<&str> {
    let rest = path
        .strip_prefix("/v1beta/models/")
        .or_else(|| path.strip_prefix("/v1/models/"))?;
    let model = rest.split(':').next()?.split('?').next()?;
    if model.is_empty() || model.contains('/') {
        None
    } else {
        Some(model)
    }
}

pub fn format_date_short(iso: &str) -> String {
    iso.split('T').next().unwrap_or(iso).to_string()
}

pub fn view_root<'a>(state: &'a AppState) -> Element<'a, Message> {
    let p = state.palette();

    let sidebar = view_sidebar(state, p);
    let main_area = view_main_area(state, p);

    let shell = row![sidebar, hairline_v(p), main_area]
        .width(Length::Fill)
        .height(Length::Fill);

    let base = container(shell)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(theme::canvas_style(p));

    let mut layers: Vec<Element<'a, Message>> = vec![base.into()];

    if let Some((msg, _)) = &state.toast {
        let toast_pill = container(
            row![
                icons::icon(icons::CHECK, 14.0, p.success),
                text(msg.as_str()).size(12.5).font(medium_font()).color(p.text),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        )
        .padding([10, 16])
        .style(theme::toast_style(p));

        let toast_layer = container(
            container(toast_pill)
                .width(Length::Fill)
                .center_x(Length::Fill)
                .padding(Padding {
                    bottom: 24.0,
                    left: 216.0,
                    ..Padding::ZERO
                }),
        )
        .width(Length::Fill)
        .height(Length::Fill)
        .align_y(Alignment::End);

        layers.push(toast_layer.into());
    }

    if state.authorization_active()
        && let Some(snap) = &state.snapshot
    {
        layers.push(view_sign_in_modal(state, snap, p));
    }

    iced::widget::Stack::with_children(layers)
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn view_sidebar<'a>(state: &'a AppState, p: Palette) -> Element<'a, Message> {
    // Top drag zone accommodates native macOS traffic lights cleanly
    let top_pad = if cfg!(target_os = "macos") { 42.0 } else { 20.0 };

    let brand_header = mouse_area(
        container(
            row![
                container(icons::brand_mark(20.0, p.dark))
                    .center_x(34)
                    .center_y(34)
                    .style(theme::card_style(p)),
                column![
                    text("Copilot Proxy")
                        .size(13.5)
                        .font(semibold_font())
                        .color(p.text),
                    text(sidebar_subtitle(state)).size(11).color(p.muted),
                ]
                .spacing(2),
            ]
            .spacing(10)
            .align_y(Alignment::Center),
        )
        .width(Length::Fill)
        .padding(Padding {
            top: top_pad,
            right: 16.0,
            bottom: 18.0,
            left: 16.0,
        }),
    )
    .on_press(Message::DragWindow);

    let mut nav_col = column![].spacing(4).padding([0, 10]);
    for page in Page::ALL {
        let active = state.page == page;
        let icon_color = if active { p.accent } else { p.muted };
        let mut inner = row![
            icons::icon(page.icon(), 16.0, icon_color),
            text(page.label())
                .size(13)
                .font(if active { medium_font() } else { Font::DEFAULT }),
            space().width(Length::Fill),
        ]
        .spacing(10)
        .align_y(Alignment::Center);

        if page == Page::Models
            && let Some(snap) = &state.snapshot
            && !snap.models.is_empty()
        {
            inner = inner.push(
                text(snap.models.len().to_string())
                    .size(11)
                    .color(p.faint),
            );
        }

        nav_col = nav_col.push(
            button(inner)
                .width(Length::Fill)
                .padding([9, 12])
                .style(theme::nav_button_style(p, active))
                .on_press(Message::Navigate(page)),
        );
    }

    // Compact gateway status indicator at bottom of sidebar
    let gateway_chip: Element<'a, Message> = if let Some(snap) = &state.snapshot {
        let (label, tone) = gateway_status_meta(&snap.gateway);
        let detail = snap
            .connection
            .as_ref()
            .map(|c| c.host_label())
            .unwrap_or_else(|| label.to_string());
        container(
            row![
                status_pill(p, tone, label, true),
                space().width(Length::Fill),
                text(detail).size(11).font(mono_font()).color(p.faint),
            ]
            .align_y(Alignment::Center)
            .spacing(6),
        )
        .padding([10, 14])
        .into()
    } else {
        space().height(0).into()
    };

    let account_btn = view_sidebar_account(state, p);

    let version_text = state
        .snapshot
        .as_ref()
        .map(|s| format!("v{} · Native Rust", s.version))
        .unwrap_or_else(|| "v0.0.8 · Native Rust".to_string());

    let bottom = column![
        gateway_chip,
        hairline_h(p),
        container(account_btn).padding([10, 10]),
        container(text(version_text).size(10.5).color(p.faint)).padding(Padding {
            top: 0.0,
            right: 14.0,
            bottom: 12.0,
            left: 14.0,
        }),
    ];

    container(
        column![brand_header, nav_col, space().height(Length::Fill), bottom]
            .width(Length::Fill)
            .height(Length::Fill),
    )
    .width(Length::Fixed(216.0))
    .height(Length::Fill)
    .style(theme::sidebar_style(p))
    .into()
}

fn sidebar_subtitle(state: &AppState) -> String {
    let Some(snap) = &state.snapshot else {
        return "Local gateway".to_string();
    };
    if snap.fixture {
        "Fixture mode".to_string()
    } else if snap.source.is_legacy_cli() {
        "CLI proxy".to_string()
    } else {
        "Local gateway".to_string()
    }
}

fn view_sidebar_account<'a>(state: &'a AppState, p: Palette) -> Element<'a, Message> {
    let (avatar_char, title, subtitle, msg): (String, String, String, Option<Message>) =
        match state.snapshot.as_ref().map(|s| &s.account) {
            Some(AccountState::SignedIn { login, plan, .. }) => (
                login.chars().next().unwrap_or('G').to_uppercase().to_string(),
                login.clone(),
                if plan.is_empty() {
                    "GitHub Copilot".to_string()
                } else {
                    plan.clone()
                },
                Some(Message::Navigate(Page::Settings)),
            ),
            Some(AccountState::ExternalUnverified) => (
                ">".to_string(),
                "CLI proxy".to_string(),
                "Observing Terminal".to_string(),
                Some(Message::Navigate(Page::Settings)),
            ),
            _ => (
                "G".to_string(),
                if state.authorization_active() {
                    "Connecting...".to_string()
                } else {
                    "Sign in".to_string()
                },
                "GitHub Copilot".to_string(),
                if state.snapshot.is_some() && !state.authorization_active() {
                    Some(Message::RunCommand(DesktopCommand::SignIn, None))
                } else {
                    None
                },
            ),
        };

    let avatar = container(
        text(avatar_char)
            .size(12)
            .font(semibold_font())
            .color(p.text),
    )
    .center_x(30)
    .center_y(30)
    .style(move |_| container::Style {
        background: Some(iced::Background::Color(p.surface)),
        border: Border {
            color: p.border_strong,
            width: 1.0,
            radius: iced::border::Radius::new(999.0),
        },
        ..Default::default()
    });

    let inner = row![
        avatar,
        column![
            text(title).size(12.5).font(medium_font()).color(p.text),
            text(subtitle).size(11).color(p.muted),
        ]
        .spacing(1)
        .width(Length::Fill),
        icons::icon(icons::CHEVRON_RIGHT, 14.0, p.faint),
    ]
    .spacing(10)
    .align_y(Alignment::Center);

    let b = button(inner)
        .width(Length::Fill)
        .padding([8, 8])
        .style(theme::ghost_button_style(p));

    match msg {
        Some(m) => b.on_press(m).into(),
        None => b.into(),
    }
}

fn view_main_area<'a>(state: &'a AppState, p: Palette) -> Element<'a, Message> {
    let mut stack = column![].spacing(18).max_width(980);

    // Subtle top drag strip on macOS so clicking/dragging the top bar moves the window
    let drag_strip = mouse_area(space().width(Length::Fill).height(16)).on_press(Message::DragWindow);

    if let Some(snap) = &state.snapshot {
        if snap.fixture {
            stack = stack.push(notice_banner(
                p,
                Tone::Warning,
                "Fixture mode active. Account, model catalog, and usage data are local test fixtures.",
                None,
            ));
        }
        if snap.storage_mode == "session-only" && !snap.fixture {
            stack = stack.push(notice_banner(
                p,
                Tone::Warning,
                "Session-only credentials. macOS Keychain encryption is unavailable.",
                None,
            ));
        }
        if let Some(notice) = &snap.notice {
            let tone = if notice.kind == "error" {
                Tone::Error
            } else {
                Tone::Accent
            };
            stack = stack.push(notice_banner(
                p,
                tone,
                &notice.message,
                Some(Message::RunCommand(DesktopCommand::DismissNotice, None)),
            ));
        }
    }

    if let Some(err) = &state.action_error
        && !state.authorization_active()
    {
        stack = stack.push(notice_banner(
            p,
            Tone::Error,
            err,
            Some(Message::DismissActionError),
        ));
    }

    if let Some(fatal) = &state.fatal_error {
        stack = stack.push(card(
            p,
            empty_state(
                p,
                icons::ALERT,
                "Copilot Proxy backend unavailable",
                fatal,
                Some(btn_primary(
                    p,
                    "Reconnect",
                    Some(icons::REFRESH),
                    Some(Message::RetryBridge),
                )),
            ),
        ));
    } else if let Some(snap) = &state.snapshot {
        let body: Element<'a, Message> = match state.page {
            Page::Overview => overview::view(state, snap, p),
            Page::Agents => agents::view(state, snap, p),
            Page::Models => models::view(state, snap, p),
            Page::Activity => activity::view(state, snap, p),
            Page::Settings => settings::view(state, snap, p),
        };
        stack = stack.push(body);
    } else {
        stack = stack.push(card(
            p,
            empty_state(
                p,
                icons::REFRESH,
                "Starting Copilot Proxy",
                "Connecting to the local gateway controller...",
                None,
            ),
        ));
    }

    let padded = container(stack)
        .width(Length::Fill)
        .padding(Padding {
            top: 12.0,
            right: 32.0,
            bottom: 36.0,
            left: 32.0,
        })
        .align_x(Alignment::Center);

    let scroll = scrollable(padded)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(theme::scrollable_style(p));

    column![drag_strip, scroll]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn notice_banner<'a>(
    p: Palette,
    tone: Tone,
    message: impl Into<String>,
    dismiss: Option<Message>,
) -> Element<'a, Message> {
    let (fg, _, _) = tone.colors(p);
    let mut r = row![
        icons::icon(icons::ALERT, 15.0, fg),
        text(message.into()).size(12.5).color(fg).width(Length::Fill),
    ]
    .spacing(10)
    .align_y(Alignment::Center);

    if let Some(msg) = dismiss {
        r = r.push(btn_icon(p, icons::CLOSE, Some(msg)));
    }

    container(r)
        .width(Length::Fill)
        .padding([10, 14])
        .style(theme::notice_style(p, tone))
        .into()
}

fn view_sign_in_modal<'a>(
    _state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let auth = match &snap.authorization {
        AuthorizationState::Idle => match &snap.account {
            AccountState::Connecting => AuthorizationState::Connecting { id: String::new() },
            AccountState::AwaitingAuthorization {
                code,
                verification_uri,
                expires_at,
            } => AuthorizationState::Awaiting {
                id: String::new(),
                code: code.clone(),
                verification_uri: verification_uri.clone(),
                expires_at: expires_at.clone(),
            },
            _ => AuthorizationState::Idle,
        },
        other => other.clone(),
    };

    let header = container(
        row![
            text("Sign in with GitHub")
                .size(15)
                .font(semibold_font())
                .color(p.text),
            space().width(Length::Fill),
            btn_icon(
                p,
                icons::CLOSE,
                Some(Message::RunCommand(DesktopCommand::CancelSignIn, None)),
            ),
        ]
        .align_y(Alignment::Center),
    )
    .padding([16, 20]);

    let body: Element<'a, Message> = match auth {
        AuthorizationState::Awaiting {
            code, expires_at, ..
        } => column![
            container(icons::icon(icons::GITHUB, 26.0, p.text))
                .center_x(52)
                .center_y(52)
                .style(theme::icon_well_style(p, false)),
            text("Enter this one-time code on GitHub to authorize your Copilot account.")
                .size(13)
                .color(p.muted),
            container(
                text(code)
                    .size(28)
                    .font(mono_font())
                    .color(p.text)
            )
            .width(Length::Fill)
            .padding([18, 16])
            .align_x(Alignment::Center)
            .style(theme::well_style(p)),
            btn_secondary(
                p,
                "Copy code",
                Some(icons::COPY),
                Some(Message::RunCommand(
                    DesktopCommand::Copy {
                        target: "device-code".to_string(),
                    },
                    Some("Device code copied".to_string()),
                )),
            ),
            text(format!(
                "Waiting for approval on GitHub · Expires {}",
                format_timestamp_short(&expires_at)
            ))
            .size(11.5)
            .color(p.accent),
        ]
        .spacing(14)
        .align_x(Alignment::Center)
        .into(),
        AuthorizationState::Error { message, .. } => column![
            notice_banner(p, Tone::Error, message, None),
        ]
        .spacing(12)
        .into(),
        AuthorizationState::Validating { .. } => column![
            text("Checking your Copilot access...")
                .size(13.5)
                .color(p.muted),
        ]
        .align_x(Alignment::Center)
        .padding([24, 0])
        .into(),
        _ => column![
            text("Requesting your GitHub device code...")
                .size(13.5)
                .color(p.muted),
        ]
        .align_x(Alignment::Center)
        .padding([24, 0])
        .into(),
    };

    let is_awaiting = matches!(
        snap.authorization,
        AuthorizationState::Awaiting { .. }
    ) || matches!(snap.account, AccountState::AwaitingAuthorization { .. });

    let mut footer_row = row![
        space().width(Length::Fill),
        btn_secondary(
            p,
            "Cancel",
            None,
            Some(Message::RunCommand(DesktopCommand::CancelSignIn, None)),
        ),
    ]
    .spacing(10)
    .align_y(Alignment::Center);

    if is_awaiting {
        footer_row = footer_row.push(btn_primary(
            p,
            "Open GitHub",
            Some(icons::GITHUB),
            Some(Message::RunCommand(DesktopCommand::OpenDevicePage, None)),
        ));
    } else if matches!(snap.authorization, AuthorizationState::Error { .. }) {
        footer_row = footer_row.push(btn_primary(
            p,
            "Try again",
            Some(icons::GITHUB),
            Some(Message::RunCommand(DesktopCommand::SignIn, None)),
        ));
    }

    let modal = container(column![
        header,
        hairline_h(p),
        container(body).padding([24, 24]).width(Length::Fill),
        hairline_h(p),
        container(footer_row)
            .padding([14, 20])
            .style(theme::well_style(p)),
    ])
    .width(Length::Fixed(420.0))
    .style(theme::modal_card_style(p));

    container(modal)
        .width(Length::Fill)
        .height(Length::Fill)
        .center_x(Length::Fill)
        .center_y(Length::Fill)
        .style(theme::modal_backdrop_style(p))
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{ProxySource, ProxyTotals};
    use std::path::PathBuf;

    fn sample_snapshot(port: u16, revision: u64, legacy: bool) -> DesktopSnapshot {
        let mut settings = DesktopSettings::default();
        settings.port = port;
        DesktopSnapshot {
            session_id: "test-session".to_string(),
            revision,
            version: "0.0.8".to_string(),
            platform: "darwin".to_string(),
            fixture: false,
            storage_mode: "encrypted".to_string(),
            account: if legacy {
                AccountState::ExternalUnverified
            } else {
                AccountState::SignedOut
            },
            authorization: AuthorizationState::Idle,
            gateway: GatewayState::Stopped,
            connection: None,
            source: if legacy {
                ProxySource::LegacyCli {
                    status: "reachable".to_string(),
                    observed_at: "2026-11-26T22:00:00Z".to_string(),
                }
            } else {
                ProxySource::None
            },
            settings,
            agent_configs: Vec::new(),
            launch_agent_diagnostics: Vec::new(),
            last_configure_result: None,
            models: Vec::new(),
            models_fetched_at: None,
            usage: None,
            activity: Vec::new(),
            totals: ProxyTotals::default(),
            probe: crate::contracts::ProbeState::Idle,
            notice: None,
        }
    }

    fn sample_state(snap: DesktopSnapshot) -> AppState {
        let mut state = AppState {
            window_id: None,
            tray: None,
            bridge: None,
            bridge_config: BridgeConfig {
                node_path: PathBuf::from("node"),
                bridge_script: PathBuf::from("bridge.cjs"),
                engine_script: PathBuf::from("engine.cjs"),
                data_dir: PathBuf::from("/tmp"),
                state_dir: None,
                fixture_mode: true,
                version: "0.0.8".to_string(),
            },
            bridge_restart_token: 0,
            background_launch: false,
            shutting_down: false,
            system_dark: true,
            snapshot: None,
            fatal_error: None,
            action_error: None,
            toast: None,
            page: Page::Settings,
            next_command_id: 1,
            pending: HashMap::new(),
            pending_kinds: BTreeSet::new(),
            test_panel_open: false,
            probe_model_id: String::new(),
            probe_prompt: String::new(),
            agent_tab: AgentTarget::ClaudeCode,
            http_model_id: String::new(),
            model_query: String::new(),
            model_vendor_filter: String::new(),
            model_feature_filter: String::new(),
            activity_model_filter: String::new(),
            activity_outcome_filter: String::new(),
            expanded_activity_key: None,
            settings_draft: DesktopSettings::default(),
            port_input: "4141".to_string(),
            settings_synced_revision: None,
            screenshot_plan: None,
        };
        state.sync_settings_from_snapshot(&snap);
        state.snapshot = Some(snap);
        state
    }

    #[test]
    fn editing_port_in_legacy_cli_mode_marks_dirty_and_survives_poll_snapshots() {
        let mut state = sample_state(sample_snapshot(4141, 1, true));
        assert!(!state.is_settings_dirty());

        state.port_input = "4142".to_string();
        assert!(state.is_settings_dirty());
        assert_eq!(state.parsed_port(), Some(4142));

        let poll_snap = sample_snapshot(4141, 2, true);
        state.sync_settings_from_snapshot(&poll_snap);
        state.snapshot = Some(poll_snap);
        assert_eq!(state.port_input, "4142");
        assert!(state.is_settings_dirty());
    }

    #[test]
    fn partial_port_typing_stays_dirty_while_invalid_and_does_not_reset() {
        let mut state = sample_state(sample_snapshot(4141, 1, true));
        state.port_input = "41".to_string();
        assert!(state.is_settings_dirty());
        assert_eq!(state.parsed_port(), None);

        let poll_snap = sample_snapshot(4141, 2, true);
        state.sync_settings_from_snapshot(&poll_snap);
        state.snapshot = Some(poll_snap);
        assert_eq!(state.port_input, "41");
    }
}
