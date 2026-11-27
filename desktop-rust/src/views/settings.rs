use iced::widget::{button, column, container, pick_list, row, space, text, text_input};
use iced::{Alignment, Border, Element, Length};

use crate::contracts::{
    AccountState, AccountType, DesktopCommand, DesktopSnapshot, GatewayState, ShellPreference,
    ThemePreference,
};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::views::{
    btn_ghost, btn_icon, btn_primary, btn_secondary, card, hairline_h, medium_font, mono_font,
    semibold_font, status_pill, AppState, Message,
};

pub fn view<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let external = snap.source.is_legacy_cli();
    let dirty = state.is_settings_dirty();
    let valid_port = external || state.parsed_port().is_some();
    let signed_in = matches!(snap.account, AccountState::SignedIn { .. });
    let keyed = snap.connection.as_ref().map(|c| c.is_keyed()).unwrap_or(false);
    let can_copy =
        matches!(snap.gateway, GatewayState::Running { .. }) && snap.connection.is_some();

    let mut actions = row![].spacing(8).align_y(Alignment::Center);
    if dirty {
        actions = actions.push(btn_secondary(
            p,
            "Discard",
            None,
            Some(Message::DiscardSettings),
        ));
    }
    actions = actions.push(btn_primary(
        p,
        if state.is_pending("save-settings") {
            "Saving..."
        } else {
            "Save changes"
        },
        Some(icons::CHECK),
        if dirty && valid_port && !state.is_pending("save-settings") {
            Some(Message::SaveSettings)
        } else {
            None
        },
    ));

    let mut title_row = row![
        text("Settings")
            .size(24)
            .font(semibold_font())
            .color(p.text),
    ]
    .spacing(10)
    .align_y(Alignment::Center);

    if dirty {
        title_row = title_row.push(status_pill(p, Tone::Warning, "Unsaved", true));
    }

    let header = row![
        column![
            title_row,
            text("Appearance, gateway preferences, and GitHub Copilot account.")
                .size(13)
                .color(p.muted),
        ]
        .spacing(4)
        .width(Length::Fill),
        actions,
    ]
    .align_y(Alignment::Center);

    // Card 1: General
    let appearance_control = container(
        row![
            theme_seg(p, state.settings_draft.theme, ThemePreference::Light, "Light", icons::SUN),
            theme_seg(p, state.settings_draft.theme, ThemePreference::Dark, "Dark", icons::MOON),
            theme_seg(p, state.settings_draft.theme, ThemePreference::System, "System", icons::MONITOR),
        ]
        .spacing(4),
    )
    .padding(3)
    .style(theme::well_style(p));

    let shell_control = container(
        row![
            shell_seg(p, state.settings_draft.shell, ShellPreference::Posix, "POSIX"),
            shell_seg(
                p,
                state.settings_draft.shell,
                ShellPreference::Powershell,
                "PowerShell",
            ),
        ]
        .spacing(4),
    )
    .padding(3)
    .style(theme::well_style(p));

    let general_card = card(
        p,
        column![
            section_heading(p, "General"),
            hairline_h(p),
            setting_row(p, "Appearance", Some("Follows macOS appearance in System mode."), appearance_control.into()),
            hairline_h(p),
            setting_row(p, "Default shell", Some("Format copied launch commands for your shell."), shell_control.into()),
            hairline_h(p),
            setting_row(
                p,
                "Open at login",
                Some("Launch Copilot Proxy quietly in the background when you sign in."),
                toggle_switch(
                    p,
                    state.settings_draft.launch_at_login,
                    Message::SettingsLaunchAtLoginToggled(!state.settings_draft.launch_at_login),
                ),
            ),
            hairline_h(p),
            setting_row(
                p,
                "Start gateway on launch",
                Some("Automatically bring up the local listener when the app opens."),
                toggle_switch(
                    p,
                    state.settings_draft.start_on_launch,
                    Message::SettingsStartOnLaunchToggled(!state.settings_draft.start_on_launch),
                ),
            ),
            hairline_h(p),
            setting_row(
                p,
                "Keep running in menu bar",
                Some("Closing the window frees UI memory while keeping the menu bar tray active."),
                toggle_switch(
                    p,
                    state.settings_draft.close_to_tray,
                    Message::SettingsCloseToTrayToggled(!state.settings_draft.close_to_tray),
                ),
            ),
        ],
    )
    .width(Length::Fill);

    // Card 2: Gateway
    let mut port_col = column![
        text_input("4141", &state.port_input)
            .on_input(Message::SettingsPortChanged)
            .width(Length::Fixed(104.0))
            .padding([8, 12])
            .size(13)
            .font(mono_font())
            .style(theme::input_style(p, !valid_port)),
    ]
    .spacing(4)
    .align_x(Alignment::End);

    if !valid_port {
        port_col = port_col.push(
            text("Use a port from 1024 to 65535.")
                .size(11)
                .color(p.error),
        );
    }

    let key_label = if snap.connection.is_none() {
        "Not running"
    } else if keyed {
        "••••••••••••"
    } else {
        "Not required"
    };

    let key_control = row![
        text(key_label).size(12.5).font(mono_font()).color(p.muted),
        btn_icon(
            p,
            icons::COPY,
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
        btn_secondary(
            p,
            "Rotate key",
            Some(icons::REFRESH),
            if signed_in && !external && keyed {
                Some(Message::RunCommand(DesktopCommand::RotateKey, None))
            } else {
                None
            },
        ),
    ]
    .spacing(8)
    .align_y(Alignment::Center);

    let gateway_card = card(
        p,
        column![
            section_heading(p, "Gateway"),
            hairline_h(p),
            setting_row(
                p,
                "Local port",
                Some(if external {
                    "Controlled by your running Terminal CLI."
                } else {
                    "Loopback listener bound strictly to 127.0.0.1."
                }),
                port_col.into(),
            ),
            hairline_h(p),
            setting_row(
                p,
                "Local API key",
                Some(if keyed {
                    "Rotating generates a fresh key; update connected agents afterward."
                } else {
                    "The connected proxy does not require a local key."
                }),
                key_control.into(),
            ),
        ],
    )
    .width(Length::Fill);

    // Card 3: GitHub Copilot Account
    let account_info: Element<'a, Message> = match &snap.account {
        AccountState::SignedIn { login, name, plan } => column![
            text(name.as_deref().filter(|s| !s.is_empty()).unwrap_or(login.as_str()))
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            row![
                text(format!("@{login}")).size(12).color(p.muted),
                status_pill(
                    p,
                    Tone::Success,
                    if plan.is_empty() { "Connected" } else { plan.as_str() },
                    false,
                ),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        ]
        .spacing(4)
        .into(),
        AccountState::ExternalUnverified => column![
            text("Connected through Terminal")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            text("Observing an active CLI proxy session on port 4141.")
                .size(12)
                .color(p.muted),
        ]
        .spacing(4)
        .into(),
        _ => column![
            text("No account connected")
                .size(13.5)
                .font(semibold_font())
                .color(p.text),
            text("Sign in with your GitHub Copilot subscription.")
                .size(12)
                .color(p.muted),
        ]
        .spacing(4)
        .into(),
    };

    let account_action: Element<'a, Message> = if external {
        status_pill(p, Tone::Neutral, "Managed in Terminal", false)
    } else if signed_in {
        btn_ghost(
            p,
            "Sign out",
            Some(icons::LOGOUT),
            Some(Message::RunCommand(
                DesktopCommand::SignOut,
                Some("Signed out".to_string()),
            )),
        )
    } else {
        btn_primary(
            p,
            "Sign in with GitHub",
            Some(icons::GITHUB),
            Some(Message::RunCommand(DesktopCommand::SignIn, None)),
        )
    };

    let account_row = container(
        row![
            container(icons::icon(icons::GITHUB, 20.0, p.text))
                .center_x(42)
                .center_y(42)
                .style(theme::icon_well_style(p, false)),
            container(account_info).width(Length::Fill),
            account_action,
        ]
        .spacing(14)
        .align_y(Alignment::Center),
    )
    .padding([18, 22]);

    let account_type_picker = pick_list(
        AccountType::ALL.as_slice(),
        Some(state.settings_draft.account_type),
        Message::SettingsAccountTypeChanged,
    )
    .padding([8, 12])
    .text_size(12.5)
    .width(Length::Fixed(160.0))
    .style(theme::pick_list_style(p))
    .menu_style(theme::pick_list_menu_style(p));

    let storage_footer = container(
        row![
            icons::icon(icons::SHIELD, 14.0, p.success),
            text(if snap.storage_mode == "encrypted" {
                "Credentials are encrypted using your macOS Keychain."
            } else {
                "Credentials are kept in memory for this session only."
            })
            .size(11.5)
            .color(p.muted),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .padding([12, 22])
    .style(move |_| container::Style {
        background: Some(iced::Background::Color(p.well)),
        ..Default::default()
    });

    let account_card = card(
        p,
        column![
            section_heading(p, "GitHub Copilot"),
            hairline_h(p),
            account_row,
            hairline_h(p),
            setting_row(
                p,
                "Account type",
                Some("Match your GitHub Copilot subscription tier."),
                account_type_picker.into(),
            ),
            hairline_h(p),
            storage_footer,
        ],
    )
    .width(Length::Fill);

    column![header, general_card, gateway_card, account_card]
        .spacing(18)
        .into()
}

fn section_heading<'a>(p: Palette, title: &'a str) -> Element<'a, Message> {
    container(
        text(title)
            .size(12.5)
            .font(semibold_font())
            .color(p.muted),
    )
    .width(Length::Fill)
    .padding([13, 22])
    .style(move |_| container::Style {
        background: Some(iced::Background::Color(p.well)),
        ..Default::default()
    })
    .into()
}

fn setting_row<'a>(
    p: Palette,
    label: &'a str,
    description: Option<&'a str>,
    control: Element<'a, Message>,
) -> Element<'a, Message> {
    let mut left = column![text(label).size(13).font(medium_font()).color(p.text)].spacing(3);
    if let Some(desc) = description {
        left = left.push(text(desc).size(11.5).color(p.muted));
    }

    container(
        row![left.width(Length::Fill), control]
            .spacing(20)
            .align_y(Alignment::Center),
    )
    .padding([15, 22])
    .width(Length::Fill)
    .into()
}

fn theme_seg<'a>(
    p: Palette,
    current: ThemePreference,
    value: ThemePreference,
    label: &'a str,
    icon_bytes: &'static [u8],
) -> Element<'a, Message> {
    let active = current == value;
    button(
        row![
            icons::icon(icon_bytes, 13.0, if active { p.accent } else { p.muted }),
            text(label)
                .size(12)
                .font(if active { medium_font() } else { iced::Font::DEFAULT }),
        ]
        .spacing(6)
        .align_y(Alignment::Center),
    )
    .padding([6, 11])
    .style(theme::segment_button_style(p, active))
    .on_press(Message::SettingsThemeChanged(value))
    .into()
}

fn shell_seg<'a>(
    p: Palette,
    current: ShellPreference,
    value: ShellPreference,
    label: &'a str,
) -> Element<'a, Message> {
    let active = current == value;
    button(
        text(label)
            .size(12)
            .font(if active { medium_font() } else { iced::Font::DEFAULT }),
    )
    .padding([6, 12])
    .style(theme::segment_button_style(p, active))
    .on_press(Message::SettingsShellChanged(value))
    .into()
}

fn toggle_switch<'a>(p: Palette, checked: bool, on_press: Message) -> Element<'a, Message> {
    let knob = container(space().width(16).height(16)).style(move |_| container::Style {
        background: Some(iced::Background::Color(iced::Color::WHITE)),
        border: Border {
            radius: iced::border::Radius::new(999.0),
            ..Default::default()
        },
        ..Default::default()
    });

    let track = if checked {
        row![space().width(Length::Fill), knob]
    } else {
        row![knob, space().width(Length::Fill)]
    }
    .align_y(Alignment::Center)
    .width(Length::Fixed(34.0));

    button(track)
        .padding([2, 2])
        .width(Length::Fixed(38.0))
        .height(Length::Fixed(22.0))
        .style(theme::toggle_button_style(p, checked))
        .on_press(on_press)
        .into()
}
