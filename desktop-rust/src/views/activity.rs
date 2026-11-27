use std::collections::BTreeSet;

use iced::widget::{button, column, container, pick_list, row, space, text};
use iced::{Alignment, Element, Length};

use crate::contracts::{ActivityRecord, DesktopCommand, DesktopSnapshot};
use crate::icons;
use crate::theme::{self, Palette, Tone};
use crate::views::{
    btn_secondary, card, empty_state, format_duration, format_number, format_timestamp_short,
    hairline_h, infer_model_from_path, medium_font, mono_font, semibold_font, status_pill,
    AppState, Message,
};

pub fn view<'a>(
    state: &'a AppState,
    snap: &'a DesktopSnapshot,
    p: Palette,
) -> Element<'a, Message> {
    let external = snap.source.is_legacy_cli();
    let subtitle = if external {
        format!("{} recent CLI requests", format_number(Some(snap.activity.len() as u64)))
    } else {
        format!("{} requests this session", format_number(snap.totals.requests))
    };

    let can_clear = !external && !snap.activity.is_empty();

    let header = row![
        column![
            text("Activity")
                .size(24)
                .font(semibold_font())
                .color(p.text),
            text(subtitle).size(13).color(p.muted),
        ]
        .spacing(4)
        .width(Length::Fill),
        btn_secondary(
            p,
            "Clear activity",
            Some(icons::TRASH),
            if can_clear {
                Some(Message::RunCommand(
                    DesktopCommand::ClearActivity,
                    Some("Activity cleared".to_string()),
                ))
            } else {
                None
            },
        ),
    ]
    .align_y(Alignment::Center);

    let mut model_set = BTreeSet::new();
    for rec in &snap.activity {
        if let Some(m) = &rec.model {
            model_set.insert(m.clone());
        }
    }
    let mut model_options = vec!["All models".to_string()];
    model_options.extend(model_set);

    let outcome_options = vec![
        "All statuses".to_string(),
        "Completed".to_string(),
        "Failed".to_string(),
        "Cancelled".to_string(),
        "Observed".to_string(),
    ];

    let selected_model = if state.activity_model_filter.is_empty() {
        "All models".to_string()
    } else {
        state.activity_model_filter.clone()
    };
    let selected_outcome = if state.activity_outcome_filter.is_empty() {
        "All statuses".to_string()
    } else {
        state.activity_outcome_filter.clone()
    };

    let outcome_key = state.activity_outcome_filter.to_lowercase();
    let filtered: Vec<ActivityRecord> = snap
        .activity
        .iter()
        .filter(|r| {
            let ok_model = state.activity_model_filter.is_empty()
                || r.model.as_deref() == Some(state.activity_model_filter.as_str());
            let ok_outcome = outcome_key.is_empty() || r.outcome == outcome_key;
            ok_model && ok_outcome
        })
        .cloned()
        .collect();

    let toolbar = container(
        row![
            pick_list(model_options, Some(selected_model), |v| {
                Message::ActivityModelFilterChanged(if v == "All models" {
                    String::new()
                } else {
                    v
                })
            })
            .padding([8, 12])
            .text_size(12)
            .width(Length::Fixed(190.0))
            .style(theme::pick_list_style(p))
            .menu_style(theme::pick_list_menu_style(p)),
            pick_list(outcome_options, Some(selected_outcome), |v| {
                Message::ActivityOutcomeFilterChanged(if v == "All statuses" {
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
            space().width(Length::Fill),
            text(format!(
                "{} {}",
                filtered.len(),
                if filtered.len() == 1 {
                    "request"
                } else {
                    "requests"
                }
            ))
            .size(12)
            .color(p.muted),
        ]
        .spacing(10)
        .align_y(Alignment::Center),
    )
    .padding([14, 18]);

    let body: Element<'a, Message> = if snap.activity.is_empty() {
        empty_state(
            p,
            icons::ACTIVITY,
            "No requests yet",
            "Requests routed through your local proxy appear here.",
            Some(btn_secondary(
                p,
                "Send a test request",
                Some(icons::SEND),
                Some(Message::OpenProbeForModel(String::new())),
            )),
        )
    } else if filtered.is_empty() {
        empty_state(
            p,
            icons::SEARCH,
            "No matching requests",
            "Try another model or status filter.",
            Some(btn_secondary(
                p,
                "Clear filters",
                None,
                Some(Message::ClearActivityFilters),
            )),
        )
    } else {
        view_request_table_owned(filtered, false, &state.expanded_activity_key, p)
    };

    let mut col = column![
        header,
        card(p, column![toolbar, hairline_h(p), body]).width(Length::Fill),
    ]
    .spacing(18);

    if external {
        col = col.push(
            text("Observed Terminal CLI reports HTTP status and handler timing only.")
                .size(11.5)
                .color(p.faint),
        );
    }

    col.push(
        text("Session activity stores request metadata only. Prompts and responses are never saved.")
            .size(11.5)
            .color(p.faint),
    )
    .into()
}

pub fn view_request_table<'a>(
    records: &[ActivityRecord],
    compact: bool,
    expanded_key: &Option<String>,
    p: Palette,
) -> Element<'a, Message> {
    view_request_table_owned(records.to_vec(), compact, expanded_key, p)
}

fn view_request_table_owned<'a>(
    records: Vec<ActivityRecord>,
    compact: bool,
    expanded_key: &Option<String>,
    p: Palette,
) -> Element<'a, Message> {
    let mut header_row = row![
        text("Time")
            .size(11)
            .font(medium_font())
            .color(p.muted)
            .width(Length::Fixed(86.0)),
        text("Model")
            .size(11)
            .font(medium_font())
            .color(p.muted)
            .width(Length::FillPortion(3)),
    ]
    .spacing(10)
    .align_y(Alignment::Center);

    if !compact {
        header_row = header_row.push(
            text("Endpoint")
                .size(11)
                .font(medium_font())
                .color(p.muted)
                .width(Length::FillPortion(3)),
        );
    }

    header_row = header_row
        .push(
            text("Status")
                .size(11)
                .font(medium_font())
                .color(p.muted)
                .width(Length::Fixed(92.0)),
        )
        .push(
            text("Tokens")
                .size(11)
                .font(medium_font())
                .color(p.muted)
                .width(Length::Fixed(72.0)),
        )
        .push(
            text("Duration")
                .size(11)
                .font(medium_font())
                .color(p.muted)
                .width(Length::Fixed(68.0)),
        );

    let table_head = container(header_row)
        .padding([10, 16])
        .style(move |_| container::Style {
            background: Some(iced::Background::Color(p.well)),
            ..Default::default()
        });

    let mut rows_col = column![table_head, hairline_h(p)];

    for (idx, record) in records.into_iter().enumerate() {
        if idx > 0 {
            rows_col = rows_col.push(hairline_h(p));
        }
        let key = format!("{}:{}", record.id, record.started_at);
        let expanded = expanded_key.as_deref() == Some(key.as_str());

        let (tone, status_text) = match record.outcome.as_str() {
            "completed" => (
                Tone::Success,
                if record.status > 0 {
                    record.status.to_string()
                } else {
                    "OK".to_string()
                },
            ),
            "failed" => (
                Tone::Error,
                if record.status > 0 {
                    record.status.to_string()
                } else {
                    "Failed".to_string()
                },
            ),
            "cancelled" => (Tone::Warning, "Cancelled".to_string()),
            "observed" => (Tone::Neutral, format!("{} obs", record.status)),
            _ => (Tone::Neutral, record.outcome.clone()),
        };

        let total_tokens = match (record.input_tokens, record.output_tokens) {
            (Some(i), Some(o)) => format_number(Some(i + o)),
            _ => "-".to_string(),
        };

        let display_model = record
            .model
            .clone()
            .or_else(|| infer_model_from_path(&record.path).map(str::to_string))
            .unwrap_or_else(|| "Not reported".to_string());

        let chevron = if expanded {
            icons::CHEVRON_DOWN
        } else {
            icons::CHEVRON_RIGHT
        };

        let mut line = row![
            row![
                icons::icon(chevron, 12.0, p.faint),
                text(format_timestamp_short(&record.started_at))
                    .size(11.5)
                    .font(mono_font())
                    .color(p.muted),
            ]
            .spacing(5)
            .align_y(Alignment::Center)
            .width(Length::Fixed(86.0)),
            container(
                text(display_model)
                    .size(12.5)
                    .font(medium_font())
                    .color(p.text)
                    .wrapping(text::Wrapping::None)
            )
            .width(Length::FillPortion(3))
            .clip(true),
        ]
        .spacing(10)
        .align_y(Alignment::Center);

        if !compact {
            line = line.push(
                container(
                    text(record.path.clone())
                        .size(11.5)
                        .font(mono_font())
                        .color(p.muted)
                        .wrapping(text::Wrapping::None),
                )
                .width(Length::FillPortion(3))
                .clip(true),
            );
        }

        line = line
            .push(
                container(status_pill(p, tone, status_text, false)).width(Length::Fixed(92.0)),
            )
            .push(
                text(total_tokens)
                    .size(12)
                    .font(mono_font())
                    .color(p.text)
                    .width(Length::Fixed(72.0)),
            )
            .push(
                text(format_duration(record.duration_ms))
                    .size(12)
                    .font(mono_font())
                    .color(p.muted)
                    .width(Length::Fixed(68.0)),
            );

        rows_col = rows_col.push(
            button(line)
                .width(Length::Fill)
                .padding([11, 16])
                .style(theme::ghost_button_style(p))
                .on_press(Message::ToggleActivityRow(key)),
        );

        if expanded {
            let status_code = if record.status > 0 {
                record.status.to_string()
            } else {
                "No response".to_string()
            };
            let detail = container(
                column![
                    detail_wide_kv(p, "Endpoint", format!("{} {}", record.method, record.path), true),
                    detail_wide_kv(p, "Request ID", record.id, true),
                    row![
                        detail_kv(p, "Outcome", record.outcome, false),
                        detail_kv(p, "HTTP status", status_code, true),
                        detail_kv(p, "Duration", format_duration(record.duration_ms), true),
                    ]
                    .spacing(16),
                    row![
                        detail_kv(p, "Input tokens", format_number(record.input_tokens), true),
                        detail_kv(p, "Output tokens", format_number(record.output_tokens), true),
                        detail_kv(p, "Cached tokens", format_number(record.cached_tokens), true),
                    ]
                    .spacing(16),
                ]
                .spacing(12),
            )
            .width(Length::Fill)
            .padding([16, 20])
            .style(move |_| container::Style {
                background: Some(iced::Background::Color(p.well)),
                ..Default::default()
            });

            rows_col = rows_col.push(detail);
        }
    }

    rows_col.into()
}

fn detail_wide_kv<'a>(
    p: Palette,
    label: &'a str,
    value: String,
    mono: bool,
) -> Element<'a, Message> {
    container(
        column![
            text(label).size(10.5).color(p.faint),
            text(value)
                .size(12)
                .font(if mono { mono_font() } else { iced::Font::DEFAULT })
                .color(p.text)
                .wrapping(text::Wrapping::WordOrGlyph),
        ]
        .spacing(3)
        .width(Length::Fill),
    )
    .width(Length::Fill)
    .clip(true)
    .into()
}

fn detail_kv<'a>(
    p: Palette,
    label: &'a str,
    value: String,
    mono: bool,
) -> Element<'a, Message> {
    container(
        column![
            text(label).size(10.5).color(p.faint),
            text(value)
                .size(12)
                .font(if mono { mono_font() } else { iced::Font::DEFAULT })
                .color(p.text)
                .wrapping(text::Wrapping::WordOrGlyph),
        ]
        .spacing(3)
        .width(Length::Fill),
    )
    .width(Length::FillPortion(1))
    .clip(true)
    .into()
}

#[cfg(test)]
mod tests {
    use crate::views::{format_timestamp_short, infer_model_from_path};

    #[test]
    fn infers_gemini_model_from_observed_paths() {
        assert_eq!(
            infer_model_from_path("/v1beta/models/gemini-4-neon:streamGenerateContent"),
            Some("gemini-4-neon")
        );
        assert_eq!(
            infer_model_from_path("/v1/models/gemini-3.8-flash:generateContent"),
            Some("gemini-3.8-flash")
        );
        assert_eq!(infer_model_from_path("/v1/messages"), None);
    }

    #[test]
    fn formats_utc_iso_timestamps_to_hh_mm_ss() {
        let formatted = format_timestamp_short("2026-11-27T03:58:04.123Z");
        assert_eq!(formatted.len(), 8);
        assert_eq!(&formatted[2..3], ":");
        assert_eq!(&formatted[5..6], ":");
    }
}
