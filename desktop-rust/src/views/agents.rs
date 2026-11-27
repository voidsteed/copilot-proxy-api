use iced::widget::{button, column, container, pick_list, row, space, text};
use iced::{Alignment, Border, Element, Length};

use crate::contracts::{
    create_config_file_preview, create_http_preview, create_launch_preview, AccountState,
    AgentConfigView, AgentModel, AgentTarget, CatalogModel, ConfigureResult, DesktopCommand,
    DesktopSettingsPatch, DesktopSnapshot, GatewayState, LaunchAgentDiagnostics, ShellPreference,
};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::views::{
    btn_ghost, btn_icon, btn_primary, btn_secondary, card, empty_state, gateway_status_meta,
    hairline_h, medium_font, mono_font, semibold_font, status_pill, AppState, Message,
};

pub fn view<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let (gw_label, gw_tone) = gateway_status_meta(&snap.gateway);
    let badge_text = if snap.connection.is_some() {
        "Gateway ready".to_string()
    } else {
        format!("Gateway {}", gw_label.to_lowercase())
    };

    let header = row![
        column![
            text("Agents")
                .size(24)
                .font(semibold_font())
                .color(p.text),
            text("Copy the exact config snippet or add missing settings safely without duplicates.")
                .size(13)
                .color(p.muted),
        ]
        .spacing(4)
        .width(Length::Fill),
        status_pill(p, gw_tone, badge_text, true),
    ]
    .align_y(Alignment::Center);

    let mut tabs = row![].spacing(4);
    for agent in AgentTarget::ALL {
        let active = state.agent_tab == agent;
        let dot_color = tab_status_dot_color(snap, agent, p);
        let icon_bytes = if agent == AgentTarget::Curl {
            icons::CODE
        } else {
            icons::AGENTS
        };
        let fg = if active { p.text } else { p.muted };

        let mut tab_content = row![
            icons::icon(icon_bytes, 14.0, if active { p.accent } else { fg }),
            text(agent.label())
                .size(12.5)
                .font(if active { medium_font() } else { iced::Font::DEFAULT }),
        ]
        .spacing(7)
        .align_y(Alignment::Center);

        if let Some(color) = dot_color {
            tab_content = tab_content.push(
                container(space().width(6).height(6)).style(move |_| container::Style {
                    background: Some(iced::Background::Color(color)),
                    border: Border {
                        radius: iced::border::Radius::new(999.0),
                        ..Default::default()
                    },
                    ..Default::default()
                }),
            );
        }

        tabs = tabs.push(
            button(tab_content)
                .padding([8, 14])
                .style(theme::segment_button_style(p, active))
                .on_press(Message::SelectAgentTab(agent)),
        );
    }

    let tab_bar = container(tabs).padding(4).style(theme::well_style(p));

    let panel_body: Element<'a, Message> = if state.agent_tab.is_launch_configured() {
        view_launch_agent(state, snap, p, state.agent_tab)
    } else if state.agent_tab == AgentTarget::Curl {
        view_http_agent(state, snap, p)
    } else {
        view_config_file_agent(state, snap, p, state.agent_tab)
    };

    column![header, tab_bar, card(p, panel_body).width(Length::Fill)]
        .spacing(18)
        .into()
}

fn tab_status_dot_color(
    snap: &DesktopSnapshot,
    target: AgentTarget,
    p: Palette,
) -> Option<iced::Color> {
    if target.is_file_configured() {
        let cfg = snap.agent_configs.iter().find(|c| c.target == target)?;
        return match cfg.status.as_str() {
            "configured" => Some(p.success_dot),
            "missing" | "conflicting" => Some(p.warning),
            "invalid" => Some(p.error),
            _ => None,
        };
    }
    if target.is_launch_configured() {
        let diag = snap
            .launch_agent_diagnostics
            .iter()
            .find(|d| d.target() == target)?;
        return match diag {
            LaunchAgentDiagnostics::Compatible { .. } => Some(p.success_dot),
            LaunchAgentDiagnostics::Warning { .. } | LaunchAgentDiagnostics::InvalidFile { .. } => {
                Some(p.warning)
            }
            LaunchAgentDiagnostics::Absent { .. } => None,
        };
    }
    None
}

fn select_launch_model<'a>(
    models: &'a [&'a CatalogModel],
    saved: Option<&str>,
) -> Option<&'a CatalogModel> {
    if let Some(id) = saved
        && let Some(found) = models.iter().copied().find(|m| m.id == id)
    {
        return Some(found);
    }
    models
        .iter()
        .copied()
        .find(|m| m.id == "gemini-4-neon")
        .or_else(|| models.iter().copied().find(|m| !m.preview))
        .or_else(|| models.first().copied())
}

fn view_config_file_agent<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
    target: AgentTarget,
) -> Element<'a, Message> {
    let compatible: Vec<&CatalogModel> = snap
        .models
        .iter()
        .filter(|m| m.supports_agent(target))
        .collect();
    let config: Option<&AgentConfigView> = snap.agent_configs.iter().find(|c| c.target == target);

    let configured_exact = config.and_then(|c| match &c.model {
        AgentModel::Configured { exact, .. } => Some(exact.as_str()),
        _ => None,
    });

    let preferred_id: Option<&str> = if let Some(cfg) = config {
        match &cfg.model {
            AgentModel::Configured {
                catalog_id, exact, ..
            } => catalog_id.as_deref().or(Some(exact.as_str())),
            AgentModel::Proposed { catalog_id } => Some(catalog_id.as_str()),
            AgentModel::Missing => snap.settings.agent_model_choices.get(target),
        }
    } else {
        snap.settings.agent_model_choices.get(target)
    };

    let selected_model = preferred_id
        .and_then(|id| compatible.iter().copied().find(|m| m.id == id))
        .or_else(|| compatible.first().copied());

    let effective_model_id = configured_exact
        .map(str::to_string)
        .or_else(|| selected_model.map(|m| m.id.clone()));

    let ready = snap.connection.is_some() && matches!(snap.gateway, GatewayState::Running { .. });
    let can_refresh =
        matches!(snap.account, AccountState::SignedIn { .. }) || snap.connection.is_some();

    let (badge_label, badge_tone) = match config.map(|c| c.status.as_str()) {
        Some("configured") => ("Already in config", Tone::Success),
        Some("missing") => ("Ready to add", Tone::Accent),
        Some("conflicting") => ("Conflict detected", Tone::Warning),
        Some("invalid") => ("Invalid syntax", Tone::Error),
        _ => ("Inspecting...", Tone::Neutral),
    };

    let intro = row![
        column![
            text(target.label())
                .size(18)
                .font(semibold_font())
                .color(p.text),
            text(format!("{} · Config file integration", target.protocol()))
                .size(12)
                .color(p.muted),
        ]
        .spacing(3)
        .width(Length::Fill),
        status_pill(p, badge_tone, badge_label, true),
    ]
    .align_y(Alignment::Center);

    let mut col = column![intro].spacing(16);

    // Compact config file bar with inline Re-check & Open folder actions
    let default_path = match target {
        AgentTarget::ClaudeCode => "~/.claude/settings.json",
        AgentTarget::Codex => "~/.codex/config.toml",
        AgentTarget::OpenCode => "~/.config/opencode/opencode.jsonc",
        _ => "",
    };
    let display_path = config.map(|c| c.path.as_str()).unwrap_or(default_path);
    let path_bar = container(
        row![
            icons::icon(icons::FOLDER, 14.0, p.muted),
            container(
                text(display_path)
                    .size(12)
                    .font(mono_font())
                    .color(p.text)
                    .wrapping(text::Wrapping::None),
            )
            .width(Length::Fill)
            .clip(true),
            btn_ghost(
                p,
                "Open folder",
                Some(icons::FOLDER),
                Some(Message::RunCommand(
                    DesktopCommand::OpenConfigFolder { target },
                    None,
                )),
            ),
            btn_icon(
                p,
                icons::REFRESH,
                if !state.is_pending("inspect-agent-config") {
                    Some(Message::RunCommand(
                        DesktopCommand::InspectAgentConfig { target },
                        None,
                    ))
                } else {
                    None
                },
            ),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .padding([8, 14])
    .style(theme::well_style(p));

    col = col.push(path_bar);

    if snap.models.is_empty() && configured_exact.is_none() {
        col = col.push(empty_state(
            p,
            icons::AGENTS,
            if can_refresh {
                "No models available"
            } else {
                "Sign in to choose a model"
            },
            "Your Copilot model catalog is used to generate the config file snippet.",
            Some(btn_primary(
                p,
                if can_refresh {
                    "Refresh models"
                } else {
                    "Sign in with GitHub"
                },
                None,
                Some(Message::RunCommand(
                    if can_refresh {
                        DesktopCommand::Refresh
                    } else {
                        DesktopCommand::SignIn
                    },
                    None,
                )),
            )),
        ));
        return container(col).padding([24, 24]).width(Length::Fill).into();
    }

    if compatible.is_empty() && configured_exact.is_none() {
        col = col.push(empty_state(
            p,
            icons::MODELS,
            "No compatible models",
            target.incompatible_message(),
            Some(btn_secondary(
                p,
                "Refresh models",
                Some(icons::REFRESH),
                Some(Message::RunCommand(DesktopCommand::Refresh, None)),
            )),
        ));
        return container(col).padding([24, 24]).width(Length::Fill).into();
    }

    // Model + Proxy URL row (clean, no unnecessary Shell selector for file-based configs)
    let model_control: Element<'a, Message> = if let Some(exact) = configured_exact {
        column![
            text("Configured model")
                .size(11.5)
                .font(medium_font())
                .color(p.muted),
            container(
                text(exact)
                    .size(12.5)
                    .font(mono_font())
                    .color(p.text)
                    .wrapping(text::Wrapping::None)
            )
            .width(Length::Fill)
            .padding([9, 12])
            .clip(true)
            .style(theme::well_style(p)),
        ]
        .spacing(6)
        .width(Length::FillPortion(3))
        .into()
    } else {
        let model_ids: Vec<String> = compatible.iter().map(|m| m.id.clone()).collect();
        let chosen = selected_model.map(|m| m.id.clone());
        column![
            text("Model")
                .size(11.5)
                .font(medium_font())
                .color(p.muted),
            pick_list(model_ids, chosen, move |value| {
                Message::RunCommand(
                    DesktopCommand::SelectAgentModel {
                        target,
                        model_id: value,
                    },
                    None,
                )
            })
            .width(Length::Fill)
            .padding([9, 12])
            .text_size(12.5)
            .style(theme::pick_list_style(p))
            .menu_style(theme::pick_list_menu_style(p)),
        ]
        .spacing(6)
        .width(Length::FillPortion(3))
        .into()
    };

    let saved_url = config.and_then(|c| {
        if target == AgentTarget::ClaudeCode {
            c.root_url.as_deref()
        } else {
            c.api_url.as_deref()
        }
    });
    let display_url = saved_url
        .map(str::to_string)
        .or_else(|| snap.connection.as_ref().map(|c| c.url_for_agent(target)))
        .unwrap_or_else(|| "http://127.0.0.1:4141".to_string());

    let url_box = column![
        text("Gateway endpoint")
            .size(11.5)
            .font(medium_font())
            .color(p.muted),
        container(
            text(display_url)
                .size(12.5)
                .font(mono_font())
                .color(p.text)
                .wrapping(text::Wrapping::None)
        )
        .width(Length::Fill)
        .padding([9, 12])
        .clip(true)
        .style(theme::well_style(p)),
    ]
    .spacing(6)
    .width(Length::FillPortion(2));

    col = col.push(row![model_control, url_box].spacing(14));

    // Smart Duplicate & Conflict Check Callout
    if let Some(cfg) = config {
        col = col.push(view_duplicate_check_callout(cfg, p));
    }

    // Always-visible copyable Config File Snippet Block
    if let (Some(model_id), Some(model_ref)) = (&effective_model_id, selected_model.or_else(|| compatible.first().copied())) {
        if let Some((snippet_title, snippet_body)) =
            create_config_file_preview(target, snap.connection.as_ref(), model_ref, model_id)
        {
            let copy_snippet_msg = if ready {
                Some(Message::RunCommand(
                    DesktopCommand::CopyConfig {
                        target,
                        model_id: model_id.clone(),
                        shell: snap.settings.shell,
                        format: Some("config-file".to_string()),
                    },
                    Some("Config snippet copied".to_string()),
                ))
            } else {
                None
            };
            let keyed = snap.connection.as_ref().map(|c| c.is_keyed()).unwrap_or(false);
            col = col.push(view_code_preview(
                p,
                snippet_title,
                keyed,
                snippet_body,
                copy_snippet_msg.clone(),
            ));

            // Clean Footer Action Bar
            let is_configured = config.map(|c| c.status.as_str()) == Some("configured");
            let is_missing = config.map(|c| c.status.as_str()) == Some("missing");
            let is_conflict_or_invalid = matches!(
                config.map(|c| c.status.as_str()),
                Some("conflicting" | "invalid")
            );

            let add_button: Element<'a, Message> = if is_configured {
                btn_secondary(p, "Already in config", Some(icons::CHECK), None)
            } else if is_conflict_or_invalid {
                btn_secondary(p, "Resolve conflict first", Some(icons::ALERT), None)
            } else {
                let can_add = is_missing
                    && ready
                    && !state.is_pending("configure-agent")
                    && !state.is_pending("select-agent-model")
                    && !state.is_pending("inspect-agent-config");
                btn_primary(
                    p,
                    if state.is_pending("configure-agent") {
                        "Adding..."
                    } else {
                        "Add to config"
                    },
                    Some(icons::WRENCH),
                    if can_add {
                        Some(Message::RunCommand(
                            DesktopCommand::ConfigureAgent { target },
                            Some("Added missing settings to config".to_string()),
                        ))
                    } else {
                        None
                    },
                )
            };

            let step_hint = if is_configured {
                format!(
                    "Ready to use. Run `{}` in your terminal.",
                    target.launch_command()
                )
            } else {
                format!(
                    "Paste the snippet above or click Add to config, then run `{}`.",
                    target.launch_command()
                )
            };

            let right_btns = if is_configured && ready {
                row![
                    btn_ghost(
                        p,
                        "Copy command",
                        Some(icons::AGENTS),
                        Some(Message::RunCommand(
                            DesktopCommand::CopyConfig {
                                target,
                                model_id: model_id.clone(),
                                shell: snap.settings.shell,
                                format: Some("command".to_string()),
                            },
                            Some("Launch command copied".to_string()),
                        )),
                    ),
                    btn_secondary(p, "Copy config", Some(icons::COPY), copy_snippet_msg),
                    add_button,
                ]
                .spacing(8)
                .align_y(Alignment::Center)
            } else {
                row![
                    btn_secondary(p, "Copy config", Some(icons::COPY), copy_snippet_msg),
                    add_button,
                ]
                .spacing(8)
                .align_y(Alignment::Center)
            };

            let footer = row![
                text(step_hint)
                    .size(12)
                    .color(p.muted)
                    .width(Length::Fill),
                right_btns,
            ]
            .spacing(12)
            .align_y(Alignment::Center);

            col = col.push(footer);
        }
    }

    if let Some(res) = &snap.last_configure_result
        && res.view().target == target
    {
        let (msg, tone) = match res {
            ConfigureResult::Added { fields, .. } => (
                format!("Added cleanly ({}) with zero duplicates.", fields.join(", ")),
                Tone::Success,
            ),
            ConfigureResult::Unchanged { .. } => (
                "No changes needed. All required keys are already present.".to_string(),
                Tone::Success,
            ),
            ConfigureResult::Conflict { fields, .. } => (
                format!(
                    "Skipped write to protect existing keys ({}).",
                    fields.join(", ")
                ),
                Tone::Warning,
            ),
            ConfigureResult::Invalid { message, .. } => (message.clone(), Tone::Error),
        };
        let (fg, _, _) = tone.colors(p);
        col = col.push(text(msg).size(12).color(fg));
    }

    container(col).padding([24, 24]).width(Length::Fill).into()
}

fn view_duplicate_check_callout<'a>(
    cfg: &'a AgentConfigView,
    p: Palette,
) -> Element<'a, Message> {
    match cfg.status.as_str() {
        "configured" => container(
            row![
                icons::icon(icons::CHECK, 15.0, p.success),
                column![
                    text("Already configured")
                        .size(12.5)
                        .font(semibold_font())
                        .color(p.success),
                    text("Every required proxy setting is already present in this config file. Add to config is locked to prevent duplicate entries.")
                        .size(11.5)
                        .color(p.muted),
                ]
                .spacing(2),
            ]
            .spacing(10)
            .align_y(Alignment::Start),
        )
        .width(Length::Fill)
        .padding([12, 14])
        .style(theme::notice_style(p, Tone::Success))
        .into(),
        "missing" => {
            let mut inner = column![
                row![
                    icons::icon(icons::SHIELD, 15.0, p.accent),
                    text("Safe merge ready, missing keys only")
                        .size(12.5)
                        .font(semibold_font())
                        .color(p.accent),
                ]
                .spacing(8)
                .align_y(Alignment::Center),
                text("Existing keys, comments, and formatting stay untouched. Already-present keys are skipped automatically so nothing is duplicated.")
                    .size(11.5)
                    .color(p.muted),
            ]
            .spacing(6);

            if !cfg.missing_fields.is_empty() {
                inner = inner.push(view_key_chips(p, "Will add:", &cfg.missing_fields));
            }

            container(inner)
                .width(Length::Fill)
                .padding([12, 14])
                .style(theme::notice_style(p, Tone::Accent))
                .into()
        }
        "conflicting" => {
            let mut inner = column![
                row![
                    icons::icon(icons::ALERT, 15.0, p.warning),
                    text("Existing keys conflict, automatic add paused")
                        .size(12.5)
                        .font(semibold_font())
                        .color(p.warning),
                ]
                .spacing(8)
                .align_y(Alignment::Center),
                text("One or more keys in your config file already have different values. Review or update them manually using the snippet below so nothing is overwritten or duplicated.")
                    .size(11.5)
                    .color(p.muted),
            ]
            .spacing(6);

            if !cfg.conflict_fields.is_empty() {
                inner = inner.push(view_key_chips(p, "Conflicts:", &cfg.conflict_fields));
            }

            container(inner)
                .width(Length::Fill)
                .padding([12, 14])
                .style(theme::notice_style(p, Tone::Warning))
                .into()
        }
        _ => {
            let msg = cfg
                .message
                .as_deref()
                .unwrap_or("The configuration file could not be parsed. Fix its syntax before adding settings.");
            container(
                row![
                    icons::icon(icons::ALERT, 15.0, p.error),
                    text(msg).size(12).color(p.error),
                ]
                .spacing(10)
                .align_y(Alignment::Center),
            )
            .width(Length::Fill)
            .padding([12, 14])
            .style(theme::notice_style(p, Tone::Error))
            .into()
        }
    }
}

fn view_key_chips<'a>(
    p: Palette,
    prefix: &'a str,
    keys: &'a [String],
) -> Element<'a, Message> {
    let mut chips = row![text(prefix).size(11).font(medium_font()).color(p.muted)]
        .spacing(6)
        .align_y(Alignment::Center);

    for key in keys.iter().take(5) {
        chips = chips.push(
            container(text(key.as_str()).size(10.5).font(mono_font()).color(p.text))
                .padding([2, 7])
                .style(theme::well_style(p)),
        );
    }
    if keys.len() > 5 {
        chips = chips.push(
            text(format!("+{} more", keys.len() - 5))
                .size(10.5)
                .color(p.faint),
        );
    }
    chips.into()
}

fn view_launch_agent<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
    target: AgentTarget,
) -> Element<'a, Message> {
    let compatible: Vec<&CatalogModel> = snap
        .models
        .iter()
        .filter(|m| m.supports_agent(target))
        .collect();
    let diagnostics = snap
        .launch_agent_diagnostics
        .iter()
        .find(|d| d.target() == target);
    let selected_model =
        select_launch_model(&compatible, snap.settings.agent_model_choices.get(target));
    let ready = snap.connection.is_some() && matches!(snap.gateway, GatewayState::Running { .. });
    let can_refresh =
        matches!(snap.account, AccountState::SignedIn { .. }) || snap.connection.is_some();

    let (badge_label, badge_tone) = match diagnostics {
        Some(
            LaunchAgentDiagnostics::Warning { .. } | LaunchAgentDiagnostics::InvalidFile { .. },
        ) => ("Check settings", Tone::Warning),
        _ => (
            "Session command",
            if ready && selected_model.is_some() {
                Tone::Success
            } else {
                Tone::Neutral
            },
        ),
    };

    let intro = row![
        column![
            text(target.label())
                .size(18)
                .font(semibold_font())
                .color(p.text),
            text(format!("{} · Session-scoped launch", target.protocol()))
                .size(12)
                .color(p.muted),
        ]
        .spacing(3)
        .width(Length::Fill),
        status_pill(p, badge_tone, badge_label, true),
    ]
    .align_y(Alignment::Center);

    let mut col = column![intro].spacing(16);

    if snap.models.is_empty() {
        col = col.push(empty_state(
            p,
            icons::AGENTS,
            if can_refresh {
                "No models available"
            } else {
                "Sign in to choose a model"
            },
            "Your Copilot model catalog is used to generate the Antigravity CLI command.",
            Some(btn_primary(
                p,
                if can_refresh {
                    "Refresh models"
                } else {
                    "Sign in with GitHub"
                },
                None,
                Some(Message::RunCommand(
                    if can_refresh {
                        DesktopCommand::Refresh
                    } else {
                        DesktopCommand::SignIn
                    },
                    None,
                )),
            )),
        ));
    } else if compatible.is_empty() {
        col = col.push(empty_state(
            p,
            icons::MODELS,
            "No compatible models",
            target.incompatible_message(),
            Some(btn_secondary(
                p,
                "Refresh models",
                Some(icons::REFRESH),
                Some(Message::RunCommand(DesktopCommand::Refresh, None)),
            )),
        ));
    } else {
        if let Some(diag) = diagnostics {
            let path_bar = container(
                row![
                    icons::icon(icons::FOLDER, 14.0, p.muted),
                    container(
                        text(diag.path())
                            .size(12)
                            .font(mono_font())
                            .color(p.text)
                            .wrapping(text::Wrapping::None)
                    )
                    .width(Length::Fill)
                    .clip(true),
                    status_pill(p, Tone::Neutral, "Read-only", false),
                    btn_icon(
                        p,
                        icons::REFRESH,
                        if !state.is_pending("inspect-launch-agent") {
                            Some(Message::RunCommand(
                                DesktopCommand::InspectLaunchAgent { target },
                                None,
                            ))
                        } else {
                            None
                        },
                    ),
                ]
                .spacing(8)
                .align_y(Alignment::Center),
            )
            .width(Length::Fill)
            .padding([8, 14])
            .style(theme::well_style(p));
            col = col.push(path_bar);
        }

        let model_ids: Vec<String> = compatible.iter().map(|m| m.id.clone()).collect();
        let selected_id = selected_model.map(|m| m.id.clone());

        let fields = row![
            column![
                text("Model")
                    .size(11.5)
                    .font(medium_font())
                    .color(p.muted),
                pick_list(model_ids, selected_id, move |value| {
                    Message::RunCommand(
                        DesktopCommand::SelectAgentModel {
                            target,
                            model_id: value,
                        },
                        None,
                    )
                })
                .width(Length::Fill)
                .padding([9, 12])
                .text_size(12.5)
                .style(theme::pick_list_style(p))
                .menu_style(theme::pick_list_menu_style(p)),
            ]
            .spacing(6)
            .width(Length::FillPortion(3)),
            view_shell_picker(snap.settings.shell, p),
        ]
        .spacing(16);

        col = col.push(fields);

        // Non-destructive diagnostics callout
        let (diag_title, diag_body, diag_tone) = match diagnostics {
            Some(LaunchAgentDiagnostics::Warning { message, .. })
            | Some(LaunchAgentDiagnostics::InvalidFile { message, .. }) => {
                ("Check Antigravity settings.json", message.as_str(), Tone::Warning)
            }
            Some(LaunchAgentDiagnostics::Compatible { summary, .. }) => (
                "Settings file untouched, safe per-session launch",
                summary.as_str(),
                Tone::Success,
            ),
            _ => (
                "Safe per-session launch",
                "Copilot Proxy never mutates ~/.gemini/antigravity-cli/settings.json so bare `agy` keeps your normal Google login intact.",
                Tone::Accent,
            ),
        };
        let (fg, _, _) = diag_tone.colors(p);
        col = col.push(
            container(
                row![
                    icons::icon(icons::SHIELD, 15.0, fg),
                    column![
                        text(diag_title).size(12.5).font(semibold_font()).color(fg),
                        text(diag_body).size(11.5).color(p.muted),
                    ]
                    .spacing(2),
                ]
                .spacing(10)
                .align_y(Alignment::Start),
            )
            .width(Length::Fill)
            .padding([12, 14])
            .style(theme::notice_style(p, diag_tone)),
        );

        let copy_msg = if ready {
            selected_model.map(|m| {
                Message::RunCommand(
                    DesktopCommand::CopyConfig {
                        target,
                        model_id: m.id.clone(),
                        shell: snap.settings.shell,
                        format: Some("command".to_string()),
                    },
                    Some("Launch command copied".to_string()),
                )
            })
        } else {
            None
        };

        if let (Some(conn), Some(model)) = (&snap.connection, selected_model) {
            let preview = create_launch_preview(conn, &model.id, snap.settings.shell);
            col = col.push(view_code_preview(
                p,
                if snap.settings.shell == ShellPreference::Posix {
                    "Terminal · Session launch"
                } else {
                    "PowerShell · Session launch"
                },
                conn.is_keyed(),
                preview,
                copy_msg.clone(),
            ));
        }

        col = col.push(
            row![
                text("Paste in your terminal to launch Antigravity CLI through Copilot Proxy.")
                    .size(12)
                    .color(p.muted)
                    .width(Length::Fill),
                btn_primary(p, "Copy command", Some(icons::COPY), copy_msg),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
        );
    }

    container(col).padding([24, 24]).width(Length::Fill).into()
}

fn view_http_agent<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let target = AgentTarget::Curl;
    let compatible: Vec<&CatalogModel> = snap
        .models
        .iter()
        .filter(|m| m.supports_agent(target))
        .collect();
    let selected_model = if !state.http_model_id.is_empty() {
        compatible
            .iter()
            .copied()
            .find(|m| m.id == state.http_model_id)
            .or_else(|| compatible.first().copied())
    } else {
        compatible.first().copied()
    };
    let ready = snap.connection.is_some() && matches!(snap.gateway, GatewayState::Running { .. });

    let intro = row![
        column![
            text("HTTP")
                .size(18)
                .font(semibold_font())
                .color(p.text),
            text("OpenAI-compatible REST endpoint")
                .size(12)
                .color(p.muted),
        ]
        .spacing(3)
        .width(Length::Fill),
        status_pill(p, if ready { Tone::Success } else { Tone::Neutral }, "Direct API", true),
    ]
    .align_y(Alignment::Center);

    let mut col = column![intro].spacing(16);

    if compatible.is_empty() {
        col = col.push(empty_state(
            p,
            icons::MODELS,
            "No models loaded",
            "Refresh your model catalog to generate an HTTP request.",
            Some(btn_secondary(
                p,
                "Refresh models",
                Some(icons::REFRESH),
                Some(Message::RunCommand(DesktopCommand::Refresh, None)),
            )),
        ));
    } else {
        let model_ids: Vec<String> = compatible.iter().map(|m| m.id.clone()).collect();
        let chosen = selected_model.map(|m| m.id.clone());

        let fields = row![
            column![
                text("Model")
                    .size(11.5)
                    .font(medium_font())
                    .color(p.muted),
                pick_list(model_ids, chosen, Message::SelectHttpModel)
                    .width(Length::Fill)
                    .padding([9, 12])
                    .text_size(12.5)
                    .style(theme::pick_list_style(p))
                    .menu_style(theme::pick_list_menu_style(p)),
            ]
            .spacing(6)
            .width(Length::FillPortion(3)),
            view_shell_picker(snap.settings.shell, p),
        ]
        .spacing(16);

        col = col.push(fields);

        let copy_msg = if ready {
            selected_model.map(|m| {
                Message::RunCommand(
                    DesktopCommand::CopyConfig {
                        target,
                        model_id: m.id.clone(),
                        shell: snap.settings.shell,
                        format: Some("command".to_string()),
                    },
                    Some("Request copied".to_string()),
                )
            })
        } else {
            None
        };

        if let (Some(conn), Some(model)) = (&snap.connection, selected_model) {
            let (url, body) = create_http_preview(conn, model);
            col = col.push(view_code_preview(
                p,
                &format!("POST {url}"),
                conn.is_keyed(),
                body,
                copy_msg.clone(),
            ));
        }

        col = col.push(
            row![
                text("Copies a ready-to-run curl or PowerShell request.")
                    .size(12)
                    .color(p.muted)
                    .width(Length::Fill),
                btn_primary(p, "Copy request", Some(icons::COPY), copy_msg),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
        );
    }

    container(col).padding([24, 24]).width(Length::Fill).into()
}

fn view_shell_picker<'a>(shell: ShellPreference, p: Palette) -> Element<'a, Message> {
    let seg = |pref: ShellPreference, label: &'a str| {
        let active = shell == pref;
        button(
            text(label)
                .size(12)
                .font(if active { medium_font() } else { iced::Font::DEFAULT }),
        )
        .padding([7, 12])
        .width(Length::FillPortion(1))
        .style(theme::segment_button_style(p, active))
        .on_press(Message::RunCommand(
            DesktopCommand::SaveSettings {
                settings: DesktopSettingsPatch {
                    shell: Some(pref),
                    ..Default::default()
                },
            },
            None,
        ))
    };

    column![
        text("Shell")
            .size(11.5)
            .font(medium_font())
            .color(p.muted),
        container(
            row![
                seg(ShellPreference::Posix, "POSIX"),
                seg(ShellPreference::Powershell, "PowerShell"),
            ]
            .spacing(4)
        )
        .padding(3)
        .width(Length::Fill)
        .style(theme::well_style(p)),
    ]
    .spacing(6)
    .width(Length::FillPortion(2))
    .into()
}

fn view_code_preview<'a>(
    p: Palette,
    label: &str,
    keyed_note: bool,
    code: String,
    copy_action: Option<Message>,
) -> Element<'a, Message> {
    let mut toolbar = row![
        icons::icon(icons::CODE, 13.0, p.accent),
        text(label.to_string())
            .size(11.5)
            .font(medium_font())
            .color(p.muted),
        space().width(Length::Fill),
    ]
    .spacing(7)
    .align_y(Alignment::Center);

    if keyed_note {
        toolbar = toolbar.push(text("Key filled on copy").size(11).color(p.faint));
    }

    if let Some(msg) = copy_action {
        toolbar = toolbar.push(btn_ghost(p, "Copy", Some(icons::COPY), Some(msg)));
    }

    container(column![
        container(toolbar).padding([7, 14]),
        hairline_h(p),
        container(
            text(code)
                .size(12)
                .font(mono_font())
                .color(p.text)
                .wrapping(text::Wrapping::WordOrGlyph)
        )
        .width(Length::Fill)
        .padding([14, 16])
        .clip(true),
    ])
    .width(Length::Fill)
    .style(theme::code_block_style(p))
    .into()
}

#[cfg(test)]
mod tests {
    use crate::contracts::{
        create_config_file_preview, AgentTarget, CatalogModel, PublicAuthentication,
        PublicConnection,
    };

    fn sample_model(id: &str) -> CatalogModel {
        CatalogModel {
            id: id.to_string(),
            name: id.to_string(),
            vendor: "Anthropic".to_string(),
            model_type: Some("chat".to_string()),
            context_window: Some(200_000),
            max_output: Some(16_384),
            supports: vec!["tools".to_string()],
            endpoints: vec!["/chat/completions".to_string(), "/responses".to_string()],
            preview: false,
        }
    }

    #[test]
    fn renders_masked_config_file_previews_for_all_configurable_agents() {
        let conn = PublicConnection {
            root_url: "http://127.0.0.1:4141".to_string(),
            api_url: "http://127.0.0.1:4141/v1".to_string(),
            authentication: PublicAuthentication::Keyed,
        };
        let (_, claude) = create_config_file_preview(
            AgentTarget::ClaudeCode,
            Some(&conn),
            &sample_model("claude-sonnet-4.6"),
            "claude-sonnet-4.6",
        )
        .expect("claude preview");
        assert!(claude.contains("ANTHROPIC_BASE_URL"));
        assert!(claude.contains("<LOCAL_API_KEY>"));

        let (_, codex) = create_config_file_preview(
            AgentTarget::Codex,
            Some(&conn),
            &sample_model("gpt-5.4"),
            "gpt-5.4",
        )
        .expect("codex preview");
        assert!(codex.contains("[model_providers.copilot_proxy]"));
        assert!(codex.contains("wire_api = \"responses\""));

        let (_, opencode) = create_config_file_preview(
            AgentTarget::OpenCode,
            Some(&conn),
            &sample_model("gpt-4.1"),
            "gpt-4.1",
        )
        .expect("opencode preview");
        assert!(opencode.contains("\"@ai-sdk/openai-compatible\""));
        assert!(opencode.contains("\"copilot_proxy/gpt-4.1\""));
    }
}
