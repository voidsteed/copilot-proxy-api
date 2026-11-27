use iced::widget::{button, column, container, pick_list, row, space, text, text_input};
use iced::{Alignment, Border, Element, Length, Padding};

use crate::contracts::{
    AccountState, DesktopCommand, DesktopSnapshot, GatewayState, ProbeState, QuotaEntry,
};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::views::activity::view_request_table;
use crate::views::{
    btn_ghost, btn_icon, btn_primary, btn_secondary, card, empty_state, format_date_short,
    format_duration, format_number, gateway_status_meta, hairline_h, medium_font,
    mono_font, semibold_font, status_pill, AppState, Message, Page,
};

pub fn view<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let signed_in = matches!(snap.account, AccountState::SignedIn { .. });
    let external = snap.source.is_legacy_cli();
    let running = matches!(snap.gateway, GatewayState::Running { .. });
    let starting = matches!(snap.gateway, GatewayState::Starting);
    let stopping = matches!(
        snap.gateway,
        GatewayState::Stopping | GatewayState::Draining { .. }
    );
    let can_stop = running || starting;
    let (_, gw_tone) = gateway_status_meta(&snap.gateway);

    let subtitle = if let Some(conn) = &snap.connection {
        if external {
            format!("Observing Terminal CLI on {}", conn.host_label())
        } else {
            format!("Managed gateway on {}", conn.host_label())
        }
    } else if signed_in {
        "Gateway is stopped. Start it whenever you need local routing.".to_string()
    } else {
        "Sign in with GitHub Copilot to start your local gateway.".to_string()
    };

    let gateway_btn_label = if external {
        "Managed in Terminal"
    } else if stopping {
        "Stopping..."
    } else if can_stop {
        "Stop gateway"
    } else {
        "Start gateway"
    };

    let gateway_btn_msg = if signed_in && !stopping && !external {
        Some(Message::RunCommand(
            if can_stop {
                DesktopCommand::StopGateway
            } else {
                DesktopCommand::StartGateway
            },
            None,
        ))
    } else {
        None
    };

    let gateway_action: Element<'a, Message> = if can_stop || external {
        btn_secondary(
            p,
            gateway_btn_label,
            Some(if can_stop { icons::STOP } else { icons::PLAY }),
            gateway_btn_msg,
        )
    } else {
        btn_primary(p, gateway_btn_label, Some(icons::PLAY), gateway_btn_msg)
    };

    let header = row![
        column![
            text("Overview")
                .size(24)
                .font(semibold_font())
                .color(p.text),
            text(subtitle).size(13).color(p.muted),
        ]
        .spacing(4)
        .width(Length::Fill),
        row![
            btn_icon(
                p,
                icons::REFRESH,
                if signed_in || snap.connection.is_some() {
                    Some(Message::RunCommand(DesktopCommand::Refresh, None))
                } else {
                    None
                },
            ),
            btn_secondary(
                p,
                "Test request",
                Some(icons::SEND),
                Some(Message::ToggleTestPanel(!state.test_panel_open)),
            ),
            gateway_action,
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    ]
    .align_y(Alignment::Center)
    .spacing(16);

    let connection_card = view_connection_card(snap, p, gw_tone, running, external);

    let mut content = column![header, connection_card].spacing(18);

    if state.test_panel_open {
        content = content.push(view_test_panel(state, snap, p));
    }

    content = content.push(view_session_metrics(snap, p));

    let lower = row![
        container(view_recent_activity(snap, p, state)).width(Length::FillPortion(13)),
        container(view_usage_panel(snap, p)).width(Length::FillPortion(7)),
    ]
    .spacing(18)
    .align_y(Alignment::Start);

    content = content.push(lower);

    let policy_text = match &snap.connection {
        Some(conn) if conn.is_keyed() => "Requests stay on 127.0.0.1 and require your local gateway key.",
        Some(_) => "Connected gateway accepts unauthenticated loopback requests.",
        None => "Start the gateway to view its loopback endpoint and policy.",
    };
    let footer = container(
        row![
            icons::icon(icons::LOCK, 12.0, p.faint),
            text(policy_text).size(11.5).color(p.faint),
        ]
        .spacing(6)
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .align_x(Alignment::Center);

    content.push(footer).into()
}

fn view_connection_card<'a>(
    snap: &'a DesktopSnapshot,
    p: Palette,
    gw_tone: Tone,
    running: bool,
    external: bool,
) -> Element<'a, Message> {
    let connected = matches!(
        snap.account,
        AccountState::SignedIn { .. } | AccountState::ExternalUnverified
    );

    // Node 1: GitHub Copilot
    let provider_meta: Element<'a, Message> = match &snap.account {
        AccountState::SignedIn { login, .. } => column![
            text(format!("@{login}")).size(12).color(p.muted),
            status_pill(p, Tone::Success, "Connected", true),
        ]
        .spacing(8)
        .align_x(Alignment::Center)
        .into(),
        AccountState::ExternalUnverified => column![
            text("Terminal account").size(12).color(p.muted),
            status_pill(p, Tone::Success, "Connected", true),
        ]
        .spacing(8)
        .align_x(Alignment::Center)
        .into(),
        _ => column![
            text("Not signed in").size(12).color(p.muted),
            btn_primary(
                p,
                "Sign in",
                Some(icons::GITHUB),
                Some(Message::RunCommand(DesktopCommand::SignIn, None)),
            ),
        ]
        .spacing(10)
        .align_x(Alignment::Center)
        .into(),
    };

    let node_provider = container(
        column![
            container(icons::icon(icons::GITHUB, 20.0, p.text))
                .center_x(42)
                .center_y(42)
                .style(theme::icon_well_style(p, false)),
            text("GitHub Copilot")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            provider_meta,
        ]
        .spacing(8)
        .align_x(Alignment::Center),
    )
    .width(Length::FillPortion(1))
    .padding([18, 12])
    .align_x(Alignment::Center);

    // Node 2: Local Gateway
    let (gw_label, _) = gateway_status_meta(&snap.gateway);
    let host_label = snap
        .connection
        .as_ref()
        .map(|c| c.host_label())
        .unwrap_or_else(|| "Not running".to_string());

    let gateway_glyph = if running {
        icons::brand_mark_on_accent(22.0)
    } else {
        icons::brand_mark(22.0, p.dark)
    };

    let node_gateway = container(
        column![
            container(gateway_glyph)
                .center_x(42)
                .center_y(42)
                .style(theme::icon_well_style(p, running)),
            text("Local gateway")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            text(host_label)
                .size(11.5)
                .font(mono_font())
                .color(p.muted),
            status_pill(p, gw_tone, gw_label, true),
        ]
        .spacing(8)
        .align_x(Alignment::Center),
    )
    .width(Length::FillPortion(1))
    .padding([18, 14])
    .align_x(Alignment::Center)
    .style(theme::gateway_node_style(p, running));

    // Node 3: Coding Agents
    let node_agents = container(
        column![
            container(icons::icon(icons::AGENTS, 20.0, p.muted))
                .center_x(42)
                .center_y(42)
                .style(theme::icon_well_style(p, false)),
            text("Coding agents")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            text("Claude · Codex · OpenCode · agy")
                .size(11.5)
                .color(p.muted),
            button(
                row![
                    text("Set up an agent").size(12).font(medium_font()),
                    icons::icon(icons::ARROW_RIGHT, 12.0, p.accent),
                ]
                .spacing(5)
                .align_y(Alignment::Center),
            )
            .padding([4, 6])
            .style(theme::link_button_style(p))
            .on_press(Message::Navigate(Page::Agents)),
        ]
        .spacing(8)
        .align_x(Alignment::Center),
    )
    .width(Length::FillPortion(1))
    .padding([18, 12])
    .align_x(Alignment::Center);

    let arrow_1 = container(icons::icon(
        icons::ARROW_RIGHT,
        16.0,
        if connected { p.accent } else { p.border_strong },
    ))
    .padding([0, 4]);

    let arrow_2 = container(icons::icon(
        icons::ARROW_RIGHT,
        16.0,
        if running { p.accent } else { p.border_strong },
    ))
    .padding([0, 4]);

    let flow = container(
        row![node_provider, arrow_1, node_gateway, arrow_2, node_agents]
            .align_y(Alignment::Center)
            .spacing(8)
            .width(Length::Fill),
    )
    .padding([20, 22]);

    // Clean integrated endpoint strip
    let endpoint_str = snap
        .connection
        .as_ref()
        .map(|c| c.api_url.as_str())
        .unwrap_or("Gateway stopped");
    let keyed = snap.connection.as_ref().map(|c| c.is_keyed()).unwrap_or(false);
    let can_copy = running && snap.connection.is_some();

    let endpoint_bar = container(
        row![
            row![
                icons::icon(
                    if keyed { icons::LOCK } else { icons::AGENTS },
                    14.0,
                    p.faint,
                ),
                text(endpoint_str)
                    .size(12)
                    .font(mono_font())
                    .color(p.muted),
            ]
            .spacing(8)
            .align_y(Alignment::Center)
            .width(Length::Fill),
            row![
                btn_ghost(
                    p,
                    "Copy URL",
                    Some(icons::COPY),
                    if can_copy {
                        Some(Message::RunCommand(
                            DesktopCommand::Copy {
                                target: "base-url".to_string(),
                            },
                            Some("Endpoint copied".to_string()),
                        ))
                    } else {
                        None
                    },
                ),
                btn_ghost(
                    p,
                    if snap.connection.is_some() && !keyed {
                        "No key required"
                    } else {
                        "Copy key"
                    },
                    Some(icons::KEY),
                    if can_copy && keyed {
                        Some(Message::RunCommand(
                            DesktopCommand::Copy {
                                target: "gateway-key".to_string(),
                            },
                            Some("Local key copied".to_string()),
                        ))
                    } else {
                        None
                    },
                ),
            ]
            .spacing(4)
            .align_y(Alignment::Center),
        ]
        .align_y(Alignment::Center)
        .spacing(12),
    )
    .width(Length::Fill)
    .padding([10, 18])
    .style(move |_| container::Style {
        background: Some(iced::Background::Color(p.well)),
        ..Default::default()
    });

    let mut card_col = column![flow, hairline_h(p), endpoint_bar];

    if let GatewayState::Error { message } = &snap.gateway {
        let mut err_row = row![
            icons::icon(icons::ALERT, 15.0, p.error),
            text(message.as_str())
                .size(12.5)
                .color(p.error)
                .width(Length::Fill),
        ]
        .spacing(10)
        .align_y(Alignment::Center);
        if external {
            err_row = err_row.push(btn_secondary(
                p,
                "Disconnect CLI",
                None,
                Some(Message::RunCommand(
                    DesktopCommand::DetachLegacy,
                    Some("Disconnected from CLI proxy".to_string()),
                )),
            ));
        }
        err_row = err_row.push(btn_ghost(
            p,
            "Settings",
            None,
            Some(Message::Navigate(Page::Settings)),
        ));
        card_col = card_col.push(hairline_h(p)).push(
            container(err_row)
                .padding([12, 18])
                .style(theme::notice_style(p, Tone::Error)),
        );
    }

    card(p, card_col).width(Length::Fill).into()
}

fn view_test_panel<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let probe_models: Vec<String> = snap
        .models
        .iter()
        .filter(|m| m.supports_probe())
        .map(|m| m.id.clone())
        .collect();

    let selected_model = if probe_models.iter().any(|id| id == &state.probe_model_id) {
        Some(state.probe_model_id.clone())
    } else if probe_models
        .iter()
        .any(|id| id == &snap.settings.preferred_model)
    {
        Some(snap.settings.preferred_model.clone())
    } else {
        probe_models.first().cloned()
    };

    let running = matches!(snap.probe, ProbeState::Running { .. }) || state.is_pending("run-probe");
    let can_send = matches!(snap.gateway, GatewayState::Running { .. })
        && snap.connection.is_some()
        && selected_model.is_some()
        && !state.probe_prompt.trim().is_empty()
        && !running;

    let heading = container(
        row![
            icons::icon(icons::SEND, 15.0, p.accent),
            text("Test request")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            space().width(Length::Fill),
            btn_icon(p, icons::CLOSE, Some(Message::ToggleTestPanel(false))),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    )
    .padding([14, 18]);

    let form = container(
        column![
            row![
                column![
                    text("Model").size(11.5).font(medium_font()).color(p.muted),
                    pick_list(
                        probe_models,
                        selected_model,
                        Message::ProbeModelChanged,
                    )
                    .placeholder("Select a model")
                    .width(Length::Fill)
                    .padding([8, 12])
                    .text_size(12.5)
                    .style(theme::pick_list_style(p))
                    .menu_style(theme::pick_list_menu_style(p)),
                ]
                .spacing(6)
                .width(Length::Fixed(240.0)),
                column![
                    text("Prompt").size(11.5).font(medium_font()).color(p.muted),
                    text_input("Say hello in one short sentence.", &state.probe_prompt)
                        .on_input(Message::ProbePromptChanged)
                        .on_submit(Message::SubmitProbe)
                        .padding([8, 12])
                        .size(12.5)
                        .style(theme::input_style(p, false)),
                ]
                .spacing(6)
                .width(Length::Fill),
            ]
            .spacing(14),
            row![
                text(if matches!(snap.gateway, GatewayState::Running { .. }) {
                    "Uses your Copilot allowance."
                } else {
                    "Start the gateway before sending a test request."
                })
                .size(12)
                .color(p.faint),
                space().width(Length::Fill),
                btn_primary(
                    p,
                    if running { "Sending..." } else { "Send request" },
                    Some(icons::SEND),
                    if can_send {
                        Some(Message::SubmitProbe)
                    } else {
                        None
                    },
                ),
            ]
            .align_y(Alignment::Center),
        ]
        .spacing(14),
    )
    .padding([16, 18]);

    let mut col = column![heading, hairline_h(p), form];

    match &snap.probe {
        ProbeState::Running { model } => {
            col = col.push(hairline_h(p)).push(
                container(
                    text(format!("Sending test prompt to {model}..."))
                        .size(12.5)
                        .color(p.muted),
                )
                .width(Length::Fill)
                .padding([14, 18])
                .style(move |_| container::Style {
                    background: Some(iced::Background::Color(p.well)),
                    ..Default::default()
                }),
            );
        }
        ProbeState::Complete {
            model,
            text: reply,
            duration_ms,
        } => {
            col = col.push(hairline_h(p)).push(
                container(
                    column![
                        row![
                            icons::icon(icons::CHECK, 14.0, p.success),
                            text("Response").size(12).font(semibold_font()).color(p.success),
                            space().width(Length::Fill),
                            text(format!("{model} · {}", format_duration(*duration_ms)))
                                .size(11.5)
                                .font(mono_font())
                                .color(p.faint),
                            btn_icon(
                                p,
                                icons::CLOSE,
                                Some(Message::RunCommand(DesktopCommand::ClearProbe, None)),
                            ),
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                        text(if reply.is_empty() {
                            "The model returned an empty response."
                        } else {
                            reply.as_str()
                        })
                        .size(13)
                        .color(p.text),
                    ]
                    .spacing(10),
                )
                .width(Length::Fill)
                .padding([14, 18])
                .style(move |_| container::Style {
                    background: Some(iced::Background::Color(p.well)),
                    ..Default::default()
                }),
            );
        }
        ProbeState::Error { message } => {
            col = col.push(hairline_h(p)).push(
                container(
                    row![
                        icons::icon(icons::ALERT, 15.0, p.error),
                        text(message.as_str())
                            .size(12.5)
                            .color(p.error)
                            .width(Length::Fill),
                        btn_icon(
                            p,
                            icons::CLOSE,
                            Some(Message::RunCommand(DesktopCommand::ClearProbe, None)),
                        ),
                    ]
                    .spacing(10)
                    .align_y(Alignment::Center),
                )
                .width(Length::Fill)
                .padding([14, 18])
                .style(theme::notice_style(p, Tone::Error)),
            );
        }
        ProbeState::Idle => {}
    }

    card(p, col).width(Length::Fill).into()
}

fn view_session_metrics<'a>(snap: &'a DesktopSnapshot, p: Palette) -> Element<'a, Message> {
    let external = snap.source.is_legacy_cli();
    let req_val = if external {
        Some(snap.activity.len() as u64)
    } else {
        snap.totals.requests
    };
    let req_sub = if external {
        "Observed in CLI"
    } else {
        "This session"
    };
    let cached_sub = match snap.totals.cached_tokens {
        Some(c) => format!("{} cached", format_number(Some(c))),
        None => "Not reported".to_string(),
    };
    let out_sub = if snap.totals.output_tokens.is_some() {
        "This session"
    } else {
        "Not reported"
    };
    let err_count = snap.totals.errors.unwrap_or(0);
    let err_sub = if snap.totals.errors.is_some() {
        "This session"
    } else {
        "Not reported"
    };

    let cell = |label: &'a str, val: String, sub: String, val_color: iced::Color| {
        container(
            column![
                text(label).size(11.5).font(medium_font()).color(p.muted),
                text(val).size(26).font(semibold_font()).color(val_color),
                text(sub).size(11).color(p.faint),
            ]
            .spacing(5),
        )
        .width(Length::FillPortion(1))
        .padding([18, 22])
    };

    let err_color = if err_count > 0 { p.error } else { p.text };
    let v_sep = || {
        container(space().width(1).height(64)).style(theme::hairline_style(p))
    };

    card(
        p,
        row![
            cell(
                if external { "Recent requests" } else { "Requests" },
                format_number(req_val),
                req_sub.to_string(),
                p.text,
            ),
            v_sep(),
            cell(
                "Input tokens",
                format_number(snap.totals.input_tokens),
                cached_sub,
                p.text,
            ),
            v_sep(),
            cell(
                "Output tokens",
                format_number(snap.totals.output_tokens),
                out_sub.to_string(),
                p.text,
            ),
            v_sep(),
            cell(
                "Errors",
                format_number(snap.totals.errors),
                err_sub.to_string(),
                err_color,
            ),
        ]
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .into()
}

fn view_recent_activity<'a>(
    snap: &'a DesktopSnapshot,
    p: Palette,
    state: &'a AppState,
) -> Element<'a, Message> {
    let header = container(
        row![
            text("Recent requests")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            space().width(Length::Fill),
            button(
                row![
                    text("View all").size(12).font(medium_font()),
                    icons::icon(icons::ARROW_RIGHT, 12.0, p.accent),
                ]
                .spacing(4)
                .align_y(Alignment::Center),
            )
            .padding([4, 6])
            .style(theme::link_button_style(p))
            .on_press(Message::Navigate(Page::Activity)),
        ]
        .align_y(Alignment::Center),
    )
    .padding([14, 18]);

    let body: Element<'a, Message> = if snap.activity.is_empty() {
        empty_state(
            p,
            icons::ACTIVITY,
            "No requests yet",
            "Connect an agent or send a test request to see activity.",
            Some(btn_ghost(
                p,
                "Send a test request",
                Some(icons::SEND),
                Some(Message::ToggleTestPanel(true)),
            )),
        )
    } else {
        let slice = &snap.activity[..snap.activity.len().min(5)];
        view_request_table(slice, true, &state.expanded_activity_key, p)
    };

    card(p, column![header, hairline_h(p), body])
        .width(Length::Fill)
        .into()
}

fn view_usage_panel<'a>(snap: &'a DesktopSnapshot, p: Palette) -> Element<'a, Message> {
    let quota = snap.usage.as_ref().and_then(|u| {
        u.quotas
            .iter()
            .find(|q| {
                let (id, label) = match q {
                    QuotaEntry::Limited { id, label, .. }
                    | QuotaEntry::Unlimited { id, label } => (id, label),
                };
                id.to_lowercase().contains("premium") || label.to_lowercase().contains("premium")
            })
            .or_else(|| u.quotas.first())
    });

    let heading_title = match quota {
        Some(QuotaEntry::Limited { label, .. } | QuotaEntry::Unlimited { label, .. }) => {
            label.as_str()
        }
        None => "Premium allowance",
    };

    let can_refresh =
        matches!(snap.account, AccountState::SignedIn { .. }) || snap.connection.is_some();

    let header = container(
        row![
            text(heading_title)
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            space().width(Length::Fill),
            btn_icon(
                p,
                icons::REFRESH,
                if can_refresh {
                    Some(Message::RunCommand(DesktopCommand::Refresh, None))
                } else {
                    None
                },
            ),
        ]
        .align_y(Alignment::Center),
    )
    .padding([14, 18]);

    let mut body = column![].spacing(10);

    match quota {
        None => {
            body = body
                .push(
                    text("Unavailable")
                        .size(20)
                        .font(semibold_font())
                        .color(p.muted),
                )
                .push(
                    text(if can_refresh {
                        "Refresh to check your Copilot allowance."
                    } else {
                        "Sign in to see your Copilot allowance."
                    })
                    .size(12)
                    .color(p.muted),
                );
        }
        Some(QuotaEntry::Unlimited { .. }) => {
            body = body
                .push(
                    text("Unlimited")
                        .size(24)
                        .font(semibold_font())
                        .color(p.text),
                )
                .push(
                    text(
                        snap.usage
                            .as_ref()
                            .map(|u| u.plan.as_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("GitHub Copilot"),
                    )
                    .size(12)
                    .color(p.muted),
                );
        }
        Some(QuotaEntry::Limited {
            remaining,
            limit,
            percent_remaining,
            ..
        }) => {
            let pct = percent_remaining.clamp(0.0, 100.0);
            let bar_color = if pct <= 12.0 { p.warning } else { p.accent };
            let fill_units = (pct.round() as u16).max(if pct > 0.0 { 1 } else { 0 });
            let rem_units = 100u16.saturating_sub(fill_units);

            let mut meter_row = row![].width(Length::Fill).height(6);
            if fill_units > 0 {
                meter_row = meter_row.push(
                    container(space().width(Length::Fill).height(6))
                        .width(Length::FillPortion(fill_units))
                        .style(move |_| container::Style {
                            background: Some(iced::Background::Color(bar_color)),
                            border: Border {
                                radius: iced::border::Radius::new(999.0),
                                ..Default::default()
                            },
                            ..Default::default()
                        }),
                );
            }
            if rem_units > 0 {
                meter_row = meter_row
                    .push(space().width(Length::FillPortion(rem_units)).height(6));
            }

            let meter = container(meter_row)
                .width(Length::Fill)
                .height(6)
                .style(move |_| container::Style {
                    background: Some(iced::Background::Color(p.well)),
                    border: Border {
                        radius: iced::border::Radius::new(999.0),
                        ..Default::default()
                    },
                    ..Default::default()
                });

            body = body
                .push(
                    row![
                        text(format_number(Some(remaining.round() as u64)))
                            .size(26)
                            .font(semibold_font())
                            .color(p.text),
                        text(format!(" / {}", format_number(Some(limit.round() as u64))))
                            .size(15)
                            .color(p.faint),
                    ]
                    .align_y(Alignment::End),
                )
                .push(text("requests remaining").size(12).color(p.muted))
                .push(container(meter).padding(Padding {
                    top: 6.0,
                    ..Padding::ZERO
                }))
                .push(
                    row![
                        text(format!("{:.0}% left", pct)).size(11).color(p.muted),
                        space().width(Length::Fill),
                        text(
                            snap.usage
                                .as_ref()
                                .and_then(|u| u.reset_at.as_deref())
                                .map(|r| format!("Resets {}", format_date_short(r)))
                                .unwrap_or_default()
                        )
                        .size(11)
                        .color(p.faint),
                    ]
                    .align_y(Alignment::Center),
                );
        }
    }

    if let Some(usage) = &snap.usage {
        body = body.push(
            container(
                text(format!("Checked {}", format_timestamp_short(&usage.fetched_at)))
                    .size(11)
                    .color(p.faint),
            )
            .padding(Padding {
                top: 8.0,
                ..Padding::ZERO
            }),
        );
    }

    card(
        p,
        column![header, hairline_h(p), container(body).padding([18, 18])],
    )
    .width(Length::Fill)
    .into()
}

fn format_timestamp_short(iso: &str) -> String {
    crate::views::format_timestamp_short(iso)
}
