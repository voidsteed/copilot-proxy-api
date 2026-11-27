use std::collections::BTreeSet;

use iced::widget::{column, container, pick_list, row, space, text, text_input};
use iced::{Alignment, Border, Element, Length};

use crate::contracts::{AccountState, DesktopCommand, DesktopSnapshot};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::views::{
    btn_icon, btn_primary, btn_secondary, card, empty_state, format_compact_limit,
    format_timestamp_short, hairline_h, medium_font, mono_font, semibold_font, status_pill,
    AppState, Message,
};

pub fn view<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let can_refresh =
        matches!(snap.account, AccountState::SignedIn { .. }) || snap.connection.is_some();

    let subtitle = format!(
        "{} {} available from your Copilot account",
        snap.models.len(),
        if snap.models.len() == 1 {
            "model"
        } else {
            "models"
        }
    );

    let mut heading_actions = row![].spacing(12).align_y(Alignment::Center);
    if let Some(fetched) = &snap.models_fetched_at {
        heading_actions = heading_actions.push(
            text(format!("Checked {}", format_timestamp_short(fetched)))
                .size(11.5)
                .color(p.faint),
        );
    }
    heading_actions = heading_actions.push(btn_secondary(
        p,
        "Refresh",
        Some(icons::REFRESH),
        if can_refresh {
            Some(Message::RunCommand(DesktopCommand::Refresh, None))
        } else {
            None
        },
    ));

    let header = row![
        column![
            text("Models")
                .size(24)
                .font(semibold_font())
                .color(p.text),
            text(subtitle).size(13).color(p.muted),
        ]
        .spacing(4)
        .width(Length::Fill),
        heading_actions,
    ]
    .align_y(Alignment::Center);

    let mut vendor_set = BTreeSet::new();
    for model in &snap.models {
        if !model.vendor.is_empty() {
            vendor_set.insert(model.vendor.clone());
        }
    }
    let mut vendor_options = vec!["All providers".to_string()];
    vendor_options.extend(vendor_set);

    let feature_options = vec![
        "All capabilities".to_string(),
        "Tools".to_string(),
        "Vision".to_string(),
        "Reasoning".to_string(),
        "Streaming".to_string(),
    ];

    let selected_vendor = if state.model_vendor_filter.is_empty() {
        "All providers".to_string()
    } else {
        state.model_vendor_filter.clone()
    };
    let selected_feature = if state.model_feature_filter.is_empty() {
        "All capabilities".to_string()
    } else {
        state.model_feature_filter.clone()
    };

    let toolbar = container(
        row![
            container(
                row![
                    icons::icon(icons::SEARCH, 14.0, p.faint),
                    text_input("Search models...", &state.model_query)
                        .on_input(Message::ModelSearchChanged)
                        .padding([6, 4])
                        .size(12.5)
                        .style(move |_theme, _status| iced::widget::text_input::Style {
                            background: iced::Background::Color(iced::Color::TRANSPARENT),
                            border: Border::default(),
                            icon: p.faint,
                            placeholder: p.faint,
                            value: p.text,
                            selection: p.accent_soft,
                        }),
                ]
                .spacing(6)
                .align_y(Alignment::Center),
            )
            .padding([2, 10])
            .width(Length::FillPortion(2))
            .style(theme::well_style(p)),
            pick_list(vendor_options, Some(selected_vendor), |v| {
                Message::ModelVendorFilterChanged(if v == "All providers" {
                    String::new()
                } else {
                    v
                })
            })
            .padding([8, 12])
            .text_size(12)
            .width(Length::Fixed(160.0))
            .style(theme::pick_list_style(p))
            .menu_style(theme::pick_list_menu_style(p)),
            pick_list(feature_options, Some(selected_feature), |f| {
                Message::ModelFeatureFilterChanged(if f == "All capabilities" {
                    String::new()
                } else {
                    f
                })
            })
            .padding([8, 12])
            .text_size(12)
            .width(Length::Fixed(160.0))
            .style(theme::pick_list_style(p))
            .menu_style(theme::pick_list_menu_style(p)),
        ]
        .spacing(10)
        .align_y(Alignment::Center),
    )
    .padding([14, 18]);

    let query = state.model_query.trim().to_lowercase();
    let feature_key = state.model_feature_filter.to_lowercase();

    let filtered: Vec<_> = snap
        .models
        .iter()
        .filter(|m| {
            let matches_query = query.is_empty()
                || m.id.to_lowercase().contains(&query)
                || m.name.to_lowercase().contains(&query)
                || m.vendor.to_lowercase().contains(&query);
            let matches_vendor = state.model_vendor_filter.is_empty()
                || m.vendor == state.model_vendor_filter;
            let matches_feature = feature_key.is_empty()
                || m.supports.iter().any(|s| s.eq_ignore_ascii_case(&feature_key));
            matches_query && matches_vendor && matches_feature
        })
        .collect();

    let mut panel_col = column![toolbar, hairline_h(p)];

    if snap.models.is_empty() {
        panel_col = panel_col.push(empty_state(
            p,
            icons::MODELS,
            if can_refresh {
                "No models available"
            } else {
                "Connect your Copilot account"
            },
            if can_refresh {
                "Refresh the catalog to load available models."
            } else {
                "Your available models will appear here after sign-in."
            },
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
    } else if filtered.is_empty() {
        panel_col = panel_col.push(empty_state(
            p,
            icons::SEARCH,
            "No matching models",
            "Try clearing or adjusting your search filters.",
            Some(btn_secondary(
                p,
                "Clear filters",
                None,
                Some(Message::ClearModelFilters),
            )),
        ));
    } else {
        // Table column header
        let col_header = container(
            row![
                text("Model")
                    .size(11)
                    .font(medium_font())
                    .color(p.muted)
                    .width(Length::FillPortion(6)),
                text("Capabilities")
                    .size(11)
                    .font(medium_font())
                    .color(p.muted)
                    .width(Length::FillPortion(5)),
                text("Context")
                    .size(11)
                    .font(medium_font())
                    .color(p.muted)
                    .width(Length::Fixed(72.0)),
                text("Output")
                    .size(11)
                    .font(medium_font())
                    .color(p.muted)
                    .width(Length::Fixed(72.0)),
                space().width(Length::Fixed(38.0)),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
        )
        .padding([10, 18])
        .style(move |_| container::Style {
            background: Some(iced::Background::Color(p.well)),
            ..Default::default()
        });

        panel_col = panel_col.push(col_header).push(hairline_h(p));

        for (idx, model) in filtered.iter().enumerate() {
            if idx > 0 {
                panel_col = panel_col.push(hairline_h(p));
            }
            let initial = model
                .vendor
                .chars()
                .next()
                .or_else(|| model.name.chars().next())
                .unwrap_or('M')
                .to_uppercase()
                .to_string();

            let mut name_row = row![
                text(&model.name)
                    .size(13)
                    .font(medium_font())
                    .color(p.text),
            ]
            .spacing(8)
            .align_y(Alignment::Center);

            if model.preview {
                name_row = name_row.push(status_pill(p, Tone::Neutral, "Preview", false));
            }

            let mut caps_row = row![].spacing(6).align_y(Alignment::Center);
            for cap in &model.supports {
                let cap_label = match cap.as_str() {
                    "tools" => "Tools",
                    "vision" => "Vision",
                    "reasoning" => "Reasoning",
                    "streaming" => "Streaming",
                    other => other,
                };
                caps_row = caps_row.push(
                    container(text(cap_label).size(10.5).color(p.muted))
                        .padding([2, 8])
                        .style(theme::well_style(p)),
                );
            }

            let row_item = container(
                row![
                    container(
                        row![
                            container(
                                text(initial)
                                    .size(12)
                                    .font(semibold_font())
                                    .color(p.muted)
                            )
                            .center_x(30)
                            .center_y(30)
                            .style(theme::icon_well_style(p, false)),
                            column![
                                name_row,
                                text(format!("{} · {}", model.vendor, model.id))
                                    .size(11)
                                    .color(p.faint)
                                    .wrapping(text::Wrapping::WordOrGlyph),
                            ]
                            .spacing(2),
                        ]
                        .spacing(10)
                        .align_y(Alignment::Center)
                    )
                    .width(Length::FillPortion(6))
                    .clip(true),
                    container(caps_row).width(Length::FillPortion(5)),
                    text(format_compact_limit(model.context_window))
                        .size(12)
                        .font(mono_font())
                        .color(p.text)
                        .width(Length::Fixed(72.0)),
                    text(format_compact_limit(model.max_output))
                        .size(12)
                        .font(mono_font())
                        .color(p.muted)
                        .width(Length::Fixed(72.0)),
                    btn_icon(
                        p,
                        icons::SEND,
                        Some(Message::OpenProbeForModel(model.id.clone())),
                    ),
                ]
                .spacing(12)
                .align_y(Alignment::Center),
            )
            .padding([12, 18]);

            panel_col = panel_col.push(row_item);
        }

        let footer = container(
            row![
                text(format!(
                    "{} of {} models",
                    filtered.len(),
                    snap.models.len()
                ))
                .size(11.5)
                .color(p.faint),
                space().width(Length::Fill),
                text("Limits are tokens per request")
                    .size(11.5)
                    .color(p.faint),
            ]
            .align_y(Alignment::Center),
        )
        .padding([10, 18])
        .style(move |_| container::Style {
            background: Some(iced::Background::Color(p.well)),
            ..Default::default()
        });

        panel_col = panel_col.push(hairline_h(p)).push(footer);
    }

    column![header, card(p, panel_col).width(Length::Fill)]
        .spacing(18)
        .into()
}
