mod bridge;
mod contracts;
mod icons;
mod theme;
mod tray;
mod vault;
mod views;

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::Duration;

use iced::widget::space;
use iced::{window, Element, Size, Subscription, Task, Theme};

use crate::bridge::{
    default_data_dir, resolve_bridge_scripts, resolve_node_binary, spawn_bridge_worker,
    BridgeConfig, BridgeEvent,
};
use crate::contracts::{
    AgentTarget, CommandOutcome, DesktopCommand, DesktopSettings, DesktopSettingsPatch,
    DesktopSnapshot, GatewayState, ThemePreference,
};
use crate::tray::{install_tray_event_handlers, TrayAction, TrayController};
use crate::views::{AppState, Message, Page, PendingCommand, ScreenshotPlan};

#[derive(Debug, Clone)]
struct CliArgs {
    fixture: bool,
    background: bool,
    data_dir: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    screenshot_dir: Option<PathBuf>,
}

fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut fixture = false;
    let mut background = false;
    let mut data_dir = None;
    let mut state_dir = None;
    let mut screenshot_dir = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--fixture" => fixture = true,
            "--background" => background = true,
            "--data-dir" if i + 1 < args.len() => {
                i += 1;
                data_dir = Some(PathBuf::from(&args[i]));
            }
            "--state-dir" if i + 1 < args.len() => {
                i += 1;
                state_dir = Some(PathBuf::from(&args[i]));
            }
            "--screenshot-dir" if i + 1 < args.len() => {
                i += 1;
                screenshot_dir = Some(PathBuf::from(&args[i]));
            }
            _ => {}
        }
        i += 1;
    }

    CliArgs {
        fixture,
        background,
        data_dir,
        state_dir,
        screenshot_dir,
    }
}

fn main_window_settings() -> window::Settings {
    window::Settings {
        size: Size::new(1140.0, 810.0),
        min_size: Some(Size::new(820.0, 580.0)),
        position: window::Position::Centered,
        exit_on_close_request: false,
        #[cfg(target_os = "macos")]
        platform_specific: window::settings::PlatformSpecific {
            title_hidden: true,
            titlebar_transparent: true,
            fullsize_content_view: true,
        },
        ..window::Settings::default()
    }
}

fn main() -> iced::Result {
    let args = parse_args();
    iced::daemon(move || boot(args.clone()), update, view)
        .title(|_state: &AppState, _id| "Copilot Proxy".to_string())
        .theme(|state: &AppState, _id| -> Option<Theme> { Some(theme::iced_theme(state.palette())) })
        .subscription(subscription)
        .antialiasing(true)
        .run()
}

fn boot(args: CliArgs) -> (AppState, Task<Message>) {
    let screenshot_plan = args.screenshot_dir.map(|dir| ScreenshotPlan {
        dir,
        steps: vec![
            (
                "rust-overview-dark",
                Page::Overview,
                Some(ThemePreference::Dark),
                None,
            ),
            (
                "rust-overview-light",
                Page::Overview,
                Some(ThemePreference::Light),
                None,
            ),
            (
                "rust-agents-antigravity-dark",
                Page::Agents,
                Some(ThemePreference::Dark),
                Some(AgentTarget::Antigravity),
            ),
            (
                "rust-models-dark",
                Page::Models,
                Some(ThemePreference::Dark),
                None,
            ),
            (
                "rust-settings-dark",
                Page::Settings,
                Some(ThemePreference::Dark),
                None,
            ),
            (
                "rust-settings-light",
                Page::Settings,
                Some(ThemePreference::Light),
                None,
            ),
        ],
        index: 0,
        settle_ticks: 0,
        capturing: false,
    });

    let fixture_mode = args.fixture || screenshot_plan.is_some();
    let data_dir = args
        .data_dir
        .unwrap_or_else(|| default_data_dir(fixture_mode));
    let (bridge_script, engine_script) = resolve_bridge_scripts();
    let bridge_config = BridgeConfig {
        node_path: resolve_node_binary(),
        bridge_script,
        engine_script,
        data_dir,
        state_dir: args.state_dir,
        fixture_mode,
        version: env!("CARGO_PKG_VERSION").to_string(),
    };

    let state = AppState {
        window_id: None,
        tray: None,
        bridge: None,
        bridge_config,
        bridge_restart_token: 0,
        background_launch: args.background && screenshot_plan.is_none(),
        shutting_down: false,
        system_dark: theme::detect_system_dark_mode(),
        snapshot: None,
        fatal_error: None,
        action_error: None,
        toast: None,
        page: Page::Overview,
        next_command_id: 1,
        pending: HashMap::new(),
        pending_kinds: BTreeSet::new(),
        test_panel_open: false,
        probe_model_id: String::new(),
        probe_prompt: "Say hello in one short sentence.".to_string(),
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
        screenshot_plan,
    };

    let init_tray = Task::done(Message::InitTray);
    let open_task = if state.background_launch {
        Task::none()
    } else {
        let (_id, task) = window::open(main_window_settings());
        task.map(Message::WindowOpened)
    };

    (state, Task::batch([init_tray, open_task]))
}

fn subscription(state: &AppState) -> Subscription<Message> {
    // Only run a timer while a transient toast or screenshot sequence is active — 0.0% CPU when idle.
    let toast_timer = if state.toast.is_some() || state.screenshot_plan.is_some() {
        let ms = if state.screenshot_plan.is_some() {
            350
        } else {
            1000
        };
        iced::time::every(Duration::from_millis(ms)).map(|_| Message::ToastTick)
    } else {
        Subscription::none()
    };

    let close_reqs = window::close_requests().map(Message::WindowCloseRequested);
    let closed = window::close_events().map(Message::WindowClosed);
    let focus_events = window::events().filter_map(|(_id, event)| match event {
        window::Event::Focused => Some(Message::WindowFocused),
        _ => None,
    });

    // Event-driven macOS menu bar subscription (push callbacks, zero polling!)
    let tray_sub = if state.screenshot_plan.is_some() || state.shutting_down {
        Subscription::none()
    } else {
        Subscription::run(|| {
            iced::stream::channel(
                32,
                move |mut output: iced::futures::channel::mpsc::Sender<TrayAction>| async move {
                    use iced::futures::SinkExt;
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                    install_tray_event_handlers(tx);
                    while let Some(action) = rx.recv().await {
                        if output.send(action).await.is_err() {
                            break;
                        }
                    }
                },
            )
        })
        .map(Message::Tray)
    };

    let bridge_sub = if state.shutting_down {
        Subscription::none()
    } else {
        let token = state.bridge_restart_token;
        let cfg = state.bridge_config.clone();
        Subscription::run_with((token, cfg), |(_token, cfg)| {
            let cfg = cfg.clone();
            iced::stream::channel(64, move |output| async move {
                spawn_bridge_worker(cfg, output);
                std::future::pending::<()>().await;
            })
        })
        .map(Message::Bridge)
    };

    Subscription::batch([
        toast_timer,
        close_reqs,
        closed,
        focus_events,
        tray_sub,
        bridge_sub,
    ])
}

fn ensure_window_open(state: &mut AppState) -> Task<Message> {
    state.system_dark = theme::detect_system_dark_mode();
    if let Some(id) = state.window_id {
        #[cfg(target_os = "macos")]
        activate_macos_app();
        return window::gain_focus(id);
    }
    #[cfg(target_os = "macos")]
    activate_macos_app();
    let (_id, task) = window::open(main_window_settings());
    task.map(Message::WindowOpened)
}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    use objc2_foundation::MainThreadMarker;
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }
}

fn dispatch_command(
    state: &mut AppState,
    command: DesktopCommand,
    confirmation: Option<String>,
) {
    let Some(client) = &state.bridge else {
        state.action_error = Some("Connecting to the local proxy controller...".to_string());
        return;
    };
    let id = state.next_command_id;
    state.next_command_id += 1;
    let kind_key = command.kind_key();
    if let Err(err) = client.send_command(id, command) {
        state.action_error = Some(err);
        return;
    }
    state.pending.insert(
        id,
        PendingCommand {
            kind_key,
            confirmation,
        },
    );
    state.recompute_pending_kinds();
}

fn apply_snapshot(state: &mut AppState, incoming: DesktopSnapshot) {
    let accept = match &state.snapshot {
        None => true,
        Some(current) => {
            incoming.session_id != current.session_id || incoming.revision > current.revision
        }
    };
    if !accept {
        return;
    }
    if let Some(tray) = state.tray.as_mut() {
        tray.sync(&incoming);
    }
    state.sync_settings_from_snapshot(&incoming);
    state.fatal_error = None;
    state.snapshot = Some(incoming);
}

fn update(state: &mut AppState, message: Message) -> Task<Message> {
    match message {
        Message::InitTray => {
            if state.tray.is_none() && state.screenshot_plan.is_none() {
                match TrayController::new() {
                    Ok(mut tray) => {
                        if let Some(snap) = &state.snapshot {
                            tray.sync(snap);
                        }
                        state.tray = Some(tray);
                    }
                    Err(err) => {
                        eprintln!("[tray] {err}");
                    }
                }
            }
            Task::none()
        }
        Message::Tray(action) => match action {
            TrayAction::OpenWindow => ensure_window_open(state),
            TrayAction::ToggleGateway => {
                if let Some(snap) = &state.snapshot {
                    let running = matches!(snap.gateway, GatewayState::Running { .. });
                    dispatch_command(
                        state,
                        if running {
                            DesktopCommand::StopGateway
                        } else {
                            DesktopCommand::StartGateway
                        },
                        None,
                    );
                }
                Task::none()
            }
            TrayAction::CopyUrl => {
                dispatch_command(
                    state,
                    DesktopCommand::Copy {
                        target: "base-url".to_string(),
                    },
                    Some("Endpoint copied".to_string()),
                );
                Task::none()
            }
            TrayAction::Refresh => {
                dispatch_command(state, DesktopCommand::Refresh, None);
                Task::none()
            }
            TrayAction::Quit => update(state, Message::QuitApp),
        },
        Message::WindowFocused => {
            state.system_dark = theme::detect_system_dark_mode();
            Task::none()
        }
        Message::ToastTick => {
            if let Some((_, ttl)) = &mut state.toast {
                if *ttl <= 1 {
                    state.toast = None;
                } else {
                    *ttl -= 1;
                }
            }

            if let Some(win_id) = state.window_id
                && let Some(snap) = state.snapshot.as_ref()
                && state.screenshot_plan.is_some()
            {
                let signed_in =
                    matches!(snap.account, crate::contracts::AccountState::SignedIn { .. });
                let running = matches!(snap.gateway, GatewayState::Running { .. });
                if !signed_in && !state.authorization_active() && !state.is_pending("sign-in") {
                    dispatch_command(state, DesktopCommand::SignIn, None);
                } else if signed_in
                    && running
                    && let Some(plan) = state.screenshot_plan.as_mut()
                    && !plan.capturing
                {
                    if plan.index >= plan.steps.len() {
                        return update(state, Message::QuitApp);
                    }
                    let (_name, page, theme_override, agent_override) = plan.steps[plan.index];
                    if plan.settle_ticks == 0 {
                        state.page = page;
                        if let Some(t) = theme_override {
                            state.settings_draft.theme = t;
                            if let Some(snap_mut) = state.snapshot.as_mut() {
                                snap_mut.settings.theme = t;
                            }
                        }
                        if let Some(agent) = agent_override {
                            state.agent_tab = agent;
                        }
                        plan.settle_ticks = 1;
                    } else if plan.settle_ticks < 3 {
                        plan.settle_ticks += 1;
                    } else {
                        plan.capturing = true;
                        return window::screenshot(win_id).map(Message::ScreenshotCaptured);
                    }
                }
            }

            Task::none()
        }
        Message::ScreenshotCaptured(shot) => {
            if let Some(plan) = state.screenshot_plan.as_mut() {
                if let Some((name, _, _, _)) = plan.steps.get(plan.index) {
                    let _ = std::fs::create_dir_all(&plan.dir);
                    let out = plan.dir.join(format!("{name}.png"));
                    if let Some(mut pixmap) =
                        tiny_skia::Pixmap::new(shot.size.width, shot.size.height)
                    {
                        let src = shot.rgba.as_ref();
                        let dst = pixmap.data_mut();
                        for (c_src, c_dst) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                            let a = c_src[3] as u16;
                            c_dst[0] = ((c_src[0] as u16 * a + 127) / 255) as u8;
                            c_dst[1] = ((c_src[1] as u16 * a + 127) / 255) as u8;
                            c_dst[2] = ((c_src[2] as u16 * a + 127) / 255) as u8;
                            c_dst[3] = c_src[3];
                        }
                        let _ = pixmap.save_png(&out);
                    }
                }
                plan.index += 1;
                plan.settle_ticks = 0;
                plan.capturing = false;
                if plan.index >= plan.steps.len() {
                    return update(state, Message::QuitApp);
                }
            }
            Task::none()
        }
        Message::Bridge(event) => match event {
            BridgeEvent::Connected(client) => {
                state.bridge = Some(client);
                Task::none()
            }
            BridgeEvent::Ready(snap) | BridgeEvent::Snapshot(snap) => {
                apply_snapshot(state, snap);
                Task::none()
            }
            BridgeEvent::Response { id, response } => {
                let meta = state.pending.remove(&id);
                state.recompute_pending_kinds();
                apply_snapshot(state, response.snapshot);
                match response.outcome {
                    CommandOutcome::Ok { message } => {
                        state.action_error = None;
                        if let Some(toast_msg) =
                            message.or_else(|| meta.and_then(|m| m.confirmation))
                        {
                            state.toast = Some((toast_msg, 3));
                        }
                    }
                    CommandOutcome::Rejected { message } => {
                        state.action_error = Some(message);
                    }
                }
                Task::none()
            }
            BridgeEvent::ShowUi => ensure_window_open(state),
            BridgeEvent::Fatal(message) => {
                state.fatal_error = Some(message);
                Task::none()
            }
            BridgeEvent::Disconnected(reason) => {
                state.bridge = None;
                if !state.shutting_down {
                    state.fatal_error = Some(reason);
                }
                Task::none()
            }
        },
        Message::WindowOpened(id) => {
            state.window_id = Some(id);
            if state.screenshot_plan.is_some() {
                #[cfg(target_os = "macos")]
                activate_macos_app();
                return window::gain_focus(id);
            }
            Task::none()
        }
        Message::WindowCloseRequested(id) => {
            let keep_in_tray = state
                .snapshot
                .as_ref()
                .map(|s| s.settings.close_to_tray)
                .unwrap_or(true)
                && state.tray.is_some();
            if keep_in_tray {
                // Closing the window in iced::daemon frees the window framebuffer while keeping the menu bar active.
                window::close(id)
            } else {
                update(state, Message::QuitApp)
            }
        }
        Message::WindowClosed(id) => {
            if state.window_id == Some(id) {
                state.window_id = None;
            }
            Task::none()
        }
        Message::DragWindow => {
            if let Some(id) = state.window_id {
                window::drag(id)
            } else {
                Task::none()
            }
        }
        Message::Navigate(page) => {
            state.page = page;
            if page == Page::Agents {
                if state.agent_tab.is_file_configured() {
                    dispatch_command(
                        state,
                        DesktopCommand::InspectAgentConfig {
                            target: state.agent_tab,
                        },
                        None,
                    );
                } else if state.agent_tab.is_launch_configured() {
                    dispatch_command(
                        state,
                        DesktopCommand::InspectLaunchAgent {
                            target: state.agent_tab,
                        },
                        None,
                    );
                }
            }
            Task::none()
        }
        Message::RunCommand(cmd, confirmation) => {
            dispatch_command(state, cmd, confirmation);
            Task::none()
        }
        Message::ToggleTestPanel(open) => {
            state.test_panel_open = open;
            if !open {
                state.probe_model_id.clear();
            }
            Task::none()
        }
        Message::OpenProbeForModel(model_id) => {
            state.probe_model_id = model_id;
            state.test_panel_open = true;
            state.page = Page::Overview;
            Task::none()
        }
        Message::ProbeModelChanged(model_id) => {
            state.probe_model_id = model_id;
            Task::none()
        }
        Message::ProbePromptChanged(prompt) => {
            state.probe_prompt = prompt;
            Task::none()
        }
        Message::SubmitProbe => {
            let prompt = state.probe_prompt.trim().to_string();
            if prompt.is_empty() {
                return Task::none();
            }
            let model_id = if !state.probe_model_id.is_empty() {
                Some(state.probe_model_id.clone())
            } else {
                state.snapshot.as_ref().and_then(|s| {
                    s.models
                        .iter()
                        .find(|m| m.id == s.settings.preferred_model && m.supports_probe())
                        .or_else(|| s.models.iter().find(|m| m.supports_probe()))
                        .map(|m| m.id.clone())
                })
            };
            if let Some(model_id) = model_id {
                dispatch_command(state, DesktopCommand::RunProbe { model_id, prompt }, None);
            }
            Task::none()
        }
        Message::SelectAgentTab(target) => {
            state.agent_tab = target;
            if target.is_file_configured() {
                dispatch_command(state, DesktopCommand::InspectAgentConfig { target }, None);
            } else if target.is_launch_configured() {
                dispatch_command(state, DesktopCommand::InspectLaunchAgent { target }, None);
            }
            Task::none()
        }
        Message::SelectHttpModel(model_id) => {
            state.http_model_id = model_id;
            Task::none()
        }
        Message::ModelSearchChanged(q) => {
            state.model_query = q;
            Task::none()
        }
        Message::ModelVendorFilterChanged(v) => {
            state.model_vendor_filter = v;
            Task::none()
        }
        Message::ModelFeatureFilterChanged(f) => {
            state.model_feature_filter = f;
            Task::none()
        }
        Message::ClearModelFilters => {
            state.model_query.clear();
            state.model_vendor_filter.clear();
            state.model_feature_filter.clear();
            Task::none()
        }
        Message::ActivityModelFilterChanged(m) => {
            state.activity_model_filter = m;
            Task::none()
        }
        Message::ActivityOutcomeFilterChanged(o) => {
            state.activity_outcome_filter = o;
            Task::none()
        }
        Message::ClearActivityFilters => {
            state.activity_model_filter.clear();
            state.activity_outcome_filter.clear();
            Task::none()
        }
        Message::ToggleActivityRow(key) => {
            if state.expanded_activity_key.as_deref() == Some(key.as_str()) {
                state.expanded_activity_key = None;
            } else {
                state.expanded_activity_key = Some(key);
            }
            Task::none()
        }
        Message::SettingsThemeChanged(theme_pref) => {
            state.settings_draft.theme = theme_pref;
            Task::none()
        }
        Message::SettingsShellChanged(shell) => {
            state.settings_draft.shell = shell;
            Task::none()
        }
        Message::SettingsLaunchAtLoginToggled(v) => {
            state.settings_draft.launch_at_login = v;
            Task::none()
        }
        Message::SettingsStartOnLaunchToggled(v) => {
            state.settings_draft.start_on_launch = v;
            Task::none()
        }
        Message::SettingsCloseToTrayToggled(v) => {
            state.settings_draft.close_to_tray = v;
            Task::none()
        }
        Message::SettingsPortChanged(val) => {
            state.port_input = val;
            Task::none()
        }
        Message::SettingsAccountTypeChanged(t) => {
            state.settings_draft.account_type = t;
            Task::none()
        }
        Message::SaveSettings => {
            let external = state
                .snapshot
                .as_ref()
                .map(|s| s.source.is_legacy_cli())
                .unwrap_or(false);
            let Some(port) = state.parsed_port() else {
                return Task::none();
            };
            let patch = DesktopSettingsPatch {
                theme: Some(state.settings_draft.theme),
                shell: Some(state.settings_draft.shell),
                launch_at_login: Some(state.settings_draft.launch_at_login),
                start_on_launch: Some(state.settings_draft.start_on_launch),
                close_to_tray: Some(state.settings_draft.close_to_tray),
                port: Some(port),
                account_type: if external {
                    None
                } else {
                    Some(state.settings_draft.account_type)
                },
                preferred_model: None,
            };
            dispatch_command(
                state,
                DesktopCommand::SaveSettings { settings: patch },
                Some("Settings saved".to_string()),
            );
            Task::none()
        }
        Message::DiscardSettings => {
            if let Some(snap) = &state.snapshot {
                state.settings_draft = snap.settings.clone();
                state.port_input = snap.settings.port.to_string();
            }
            Task::none()
        }
        Message::DismissActionError => {
            state.action_error = None;
            Task::none()
        }
        Message::RetryBridge => {
            state.fatal_error = None;
            state.bridge_restart_token += 1;
            Task::none()
        }
        Message::QuitApp => {
            state.shutting_down = true;
            if let Some(client) = &state.bridge {
                client.shutdown();
            }
            state.tray = None;
            iced::exit()
        }
    }
}

fn view<'a>(state: &'a AppState, _window_id: window::Id) -> Element<'a, Message> {
    if state.window_id.is_none() {
        return space().into();
    }
    views::view_root(state)
}
