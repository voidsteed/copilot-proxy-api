use iced::border::Radius;
use iced::widget::{button, container, pick_list, scrollable, text_input};
use iced::{Background, Border, Color, Shadow, Theme, Vector};

use crate::contracts::ThemePreference;

#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub dark: bool,
    pub canvas: Color,
    pub sidebar: Color,
    pub surface: Color,
    pub surface_elevated: Color,
    pub well: Color,
    pub hover: Color,
    pub border: Color,
    pub border_strong: Color,
    pub text: Color,
    pub muted: Color,
    pub faint: Color,
    pub accent: Color,
    pub accent_hover: Color,
    pub accent_soft: Color,
    pub accent_border: Color,
    pub on_accent: Color,
    pub success: Color,
    pub success_dot: Color,
    pub success_soft: Color,
    pub success_border: Color,
    pub warning: Color,
    pub warning_soft: Color,
    pub warning_border: Color,
    pub error: Color,
    pub error_soft: Color,
    pub error_border: Color,
    pub shadow: Color,
}

const fn hex(rgb: u32) -> Color {
    Color::from_rgb(
        ((rgb >> 16) & 0xFF) as f32 / 255.0,
        ((rgb >> 8) & 0xFF) as f32 / 255.0,
        (rgb & 0xFF) as f32 / 255.0,
    )
}

const fn hex_a(rgb: u32, a: f32) -> Color {
    Color::from_rgba(
        ((rgb >> 16) & 0xFF) as f32 / 255.0,
        ((rgb >> 8) & 0xFF) as f32 / 255.0,
        (rgb & 0xFF) as f32 / 255.0,
        a,
    )
}

/// Alabaster Pearl (Light) — calm, crisp, Apple/Linear minimalist light mode
pub const LIGHT: Palette = Palette {
    dark: false,
    canvas: hex(0xF8F9FB),
    sidebar: hex(0xF2F4F7),
    surface: hex(0xFFFFFF),
    surface_elevated: hex(0xFFFFFF),
    well: hex(0xF3F5F8),
    hover: hex(0xE9EDF3),
    border: hex(0xE5E8EE),
    border_strong: hex(0xD2D8E2),
    text: hex(0x111318),
    muted: hex(0x5B6472),
    faint: hex(0x848E9C),
    accent: hex(0x2563EB),
    accent_hover: hex(0x1D4ED8),
    accent_soft: hex(0xEFF4FF),
    accent_border: hex(0xC7D8FE),
    on_accent: hex(0xFFFFFF),
    success: hex(0x15803D),
    success_dot: hex(0x22C55E),
    success_soft: hex(0xECFDF3),
    success_border: hex(0xBBF7D0),
    warning: hex(0xB45309),
    warning_soft: hex(0xFEF9EC),
    warning_border: hex(0xFDE68A),
    error: hex(0xDC2626),
    error_soft: hex(0xFEF2F2),
    error_border: hex(0xFECACA),
    shadow: hex_a(0x0F172A, 0.06),
};

/// Obsidian Mist (Dark) — refined neutral obsidian with luminous cobalt accent
pub const DARK: Palette = Palette {
    dark: true,
    canvas: hex(0x0D0F14),
    sidebar: hex(0x11141B),
    surface: hex(0x161A22),
    surface_elevated: hex(0x1B202A),
    well: hex(0x10131A),
    hover: hex(0x1F2531),
    border: hex(0x222836),
    border_strong: hex(0x31394B),
    text: hex(0xF3F4F6),
    muted: hex(0x98A2B3),
    faint: hex(0x6B7280),
    accent: hex(0x4C8DFF),
    accent_hover: hex(0x69A1FF),
    accent_soft: hex(0x152238),
    accent_border: hex(0x274270),
    on_accent: hex(0xFFFFFF),
    success: hex(0x34D399),
    success_dot: hex(0x34D399),
    success_soft: hex(0x0E2920),
    success_border: hex(0x1A4939),
    warning: hex(0xFBBF24),
    warning_soft: hex(0x281F10),
    warning_border: hex(0x4A3A1B),
    error: hex(0xF87171),
    error_soft: hex(0x2B1618),
    error_border: hex(0x52252A),
    shadow: hex_a(0x000000, 0.38),
};

pub fn resolve_palette(pref: ThemePreference, system_dark: bool) -> Palette {
    let dark = match pref {
        ThemePreference::Dark => true,
        ThemePreference::Light => false,
        ThemePreference::System => system_dark,
    };
    if dark { DARK } else { LIGHT }
}

pub fn iced_theme(palette: Palette) -> Theme {
    Theme::custom(
        if palette.dark {
            "Obsidian Mist"
        } else {
            "Alabaster Pearl"
        }
        .to_string(),
        iced::theme::Palette {
            background: palette.canvas,
            text: palette.text,
            primary: palette.accent,
            success: palette.success,
            warning: palette.warning,
            danger: palette.error,
        },
    )
}

#[cfg(target_os = "macos")]
pub fn detect_system_dark_mode() -> bool {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("AppleInterfaceStyle");
    defaults
        .stringForKey(&key)
        .map(|style| style.to_string().eq_ignore_ascii_case("Dark"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn detect_system_dark_mode() -> bool {
    true
}

pub fn sidebar_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.sidebar)),
        border: Border {
            color: p.border,
            width: 0.0,
            radius: Radius::new(0.0),
        },
        ..Default::default()
    }
}

pub fn canvas_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.canvas)),
        ..Default::default()
    }
}

pub fn hairline_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.border)),
        ..Default::default()
    }
}

pub fn card_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.surface)),
        border: Border {
            color: p.border,
            width: 1.0,
            radius: Radius::new(12.0),
        },
        shadow: Shadow {
            color: p.shadow,
            offset: Vector::new(0.0, 2.0),
            blur_radius: 10.0,
        },
        ..Default::default()
    }
}

pub fn gateway_node_style(p: Palette, running: bool) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(if running { p.accent_soft } else { p.well })),
        border: Border {
            color: if running { p.accent_border } else { p.border },
            width: 1.0,
            radius: Radius::new(12.0),
        },
        ..Default::default()
    }
}

pub fn well_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.well)),
        border: Border {
            color: p.border,
            width: 1.0,
            radius: Radius::new(8.0),
        },
        ..Default::default()
    }
}

pub fn code_block_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.well)),
        border: Border {
            color: p.border,
            width: 1.0,
            radius: Radius::new(10.0),
        },
        ..Default::default()
    }
}

pub fn icon_well_style(p: Palette, active: bool) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(if active { p.accent } else { p.well })),
        border: Border {
            color: if active { p.accent } else { p.border },
            width: 1.0,
            radius: Radius::new(10.0),
        },
        ..Default::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Accent,
    Success,
    Warning,
    Error,
}

impl Tone {
    pub fn colors(self, p: Palette) -> (Color, Color, Color) {
        match self {
            Self::Neutral => (p.muted, p.well, p.border),
            Self::Accent => (p.accent, p.accent_soft, p.accent_border),
            Self::Success => (p.success, p.success_soft, p.success_border),
            Self::Warning => (p.warning, p.warning_soft, p.warning_border),
            Self::Error => (p.error, p.error_soft, p.error_border),
        }
    }
}

pub fn pill_style(p: Palette, tone: Tone) -> impl Fn(&Theme) -> container::Style {
    move |_| {
        let (fg, bg, border) = tone.colors(p);
        container::Style {
            text_color: Some(fg),
            background: Some(Background::Color(bg)),
            border: Border {
                color: border,
                width: 1.0,
                radius: Radius::new(999.0),
            },
            ..Default::default()
        }
    }
}

pub fn notice_style(p: Palette, tone: Tone) -> impl Fn(&Theme) -> container::Style {
    move |_| {
        let (fg, bg, border) = tone.colors(p);
        container::Style {
            text_color: Some(fg),
            background: Some(Background::Color(bg)),
            border: Border {
                color: border,
                width: 1.0,
                radius: Radius::new(10.0),
            },
            ..Default::default()
        }
    }
}

pub fn modal_backdrop_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(if p.dark {
            hex_a(0x000000, 0.62)
        } else {
            hex_a(0x0F172A, 0.34)
        })),
        ..Default::default()
    }
}

pub fn modal_card_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(p.surface_elevated)),
        border: Border {
            color: p.border_strong,
            width: 1.0,
            radius: Radius::new(14.0),
        },
        shadow: Shadow {
            color: hex_a(0x000000, if p.dark { 0.55 } else { 0.18 }),
            offset: Vector::new(0.0, 14.0),
            blur_radius: 36.0,
        },
        ..Default::default()
    }
}

pub fn toast_style(p: Palette) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        text_color: Some(p.text),
        background: Some(Background::Color(p.surface_elevated)),
        border: Border {
            color: p.border_strong,
            width: 1.0,
            radius: Radius::new(999.0),
        },
        shadow: Shadow {
            color: hex_a(0x000000, if p.dark { 0.45 } else { 0.12 }),
            offset: Vector::new(0.0, 8.0),
            blur_radius: 24.0,
        },
        ..Default::default()
    }
}

pub fn nav_button_style(p: Palette, active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let bg = if active {
            p.surface
        } else if matches!(status, button::Status::Hovered | button::Status::Pressed) {
            p.hover
        } else {
            Color::TRANSPARENT
        };
        let border_color = if active { p.border } else { Color::TRANSPARENT };
        let text_color = if active {
            p.text
        } else if matches!(status, button::Status::Hovered | button::Status::Pressed) {
            p.text
        } else {
            p.muted
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color,
            border: Border {
                color: border_color,
                width: if active { 1.0 } else { 0.0 },
                radius: Radius::new(8.0),
            },
            shadow: if active {
                Shadow {
                    color: p.shadow,
                    offset: Vector::new(0.0, 1.0),
                    blur_radius: 3.0,
                }
            } else {
                Shadow::default()
            },
            snap: true,
        }
    }
}

pub fn primary_button_style(p: Palette) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (bg, text) = match status {
            button::Status::Disabled => (hex_a(if p.dark { 0x4C8DFF } else { 0x2563EB }, 0.36), hex_a(0xFFFFFF, 0.72)),
            button::Status::Hovered | button::Status::Pressed => (p.accent_hover, p.on_accent),
            button::Status::Active => (p.accent, p.on_accent),
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: text,
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: Radius::new(8.0),
            },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn secondary_button_style(p: Palette) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (bg, border, text) = match status {
            button::Status::Disabled => (p.surface, p.border, p.faint),
            button::Status::Hovered | button::Status::Pressed => (p.hover, p.border_strong, p.text),
            button::Status::Active => (p.surface, p.border_strong, p.text),
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: text,
            border: Border {
                color: border,
                width: 1.0,
                radius: Radius::new(8.0),
            },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn ghost_button_style(p: Palette) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (bg, text) = match status {
            button::Status::Disabled => (Color::TRANSPARENT, p.faint),
            button::Status::Hovered | button::Status::Pressed => (p.hover, p.text),
            button::Status::Active => (Color::TRANSPARENT, p.muted),
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: text,
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: Radius::new(8.0),
            },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn link_button_style(p: Palette) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| button::Style {
        background: None,
        text_color: match status {
            button::Status::Hovered | button::Status::Pressed => p.accent_hover,
            button::Status::Disabled => p.faint,
            button::Status::Active => p.accent,
        },
        border: Border::default(),
        shadow: Shadow::default(),
        snap: true,
    }
}

pub fn segment_button_style(
    p: Palette,
    active: bool,
) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (bg, border, text) = if active {
            (p.surface, p.border, p.text)
        } else if matches!(status, button::Status::Hovered | button::Status::Pressed) {
            (p.hover, Color::TRANSPARENT, p.text)
        } else {
            (Color::TRANSPARENT, Color::TRANSPARENT, p.muted)
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: text,
            border: Border {
                color: border,
                width: if active { 1.0 } else { 0.0 },
                radius: Radius::new(7.0),
            },
            shadow: if active {
                Shadow {
                    color: p.shadow,
                    offset: Vector::new(0.0, 1.0),
                    blur_radius: 3.0,
                }
            } else {
                Shadow::default()
            },
            snap: true,
        }
    }
}

pub fn toggle_button_style(
    p: Palette,
    checked: bool,
) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let bg = if checked {
            if matches!(status, button::Status::Hovered) {
                p.accent_hover
            } else {
                p.accent
            }
        } else if matches!(status, button::Status::Hovered) {
            p.faint
        } else {
            p.border_strong
        };
        button::Style {
            background: Some(Background::Color(bg)),
            text_color: p.on_accent,
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: Radius::new(999.0),
            },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn input_style(p: Palette, invalid: bool) -> impl Fn(&Theme, text_input::Status) -> text_input::Style {
    move |_, status| {
        let border_color = if invalid {
            p.error
        } else if matches!(status, text_input::Status::Focused { .. }) {
            p.accent
        } else if matches!(status, text_input::Status::Hovered) {
            p.border_strong
        } else {
            p.border
        };
        text_input::Style {
            background: Background::Color(if matches!(status, text_input::Status::Disabled) {
                p.well
            } else {
                p.surface
            }),
            border: Border {
                color: border_color,
                width: if matches!(status, text_input::Status::Focused { .. }) {
                    1.5
                } else {
                    1.0
                },
                radius: Radius::new(8.0),
            },
            icon: p.faint,
            placeholder: p.faint,
            value: if matches!(status, text_input::Status::Disabled) {
                p.muted
            } else {
                p.text
            },
            selection: p.accent_soft,
        }
    }
}

pub fn pick_list_style(p: Palette) -> impl Fn(&Theme, pick_list::Status) -> pick_list::Style {
    move |_, status| {
        let border_color = match status {
            pick_list::Status::Opened { .. } => p.accent,
            pick_list::Status::Hovered => p.border_strong,
            pick_list::Status::Active => p.border,
        };
        pick_list::Style {
            text_color: p.text,
            placeholder_color: p.faint,
            handle_color: p.muted,
            background: Background::Color(p.surface),
            border: Border {
                color: border_color,
                width: 1.0,
                radius: Radius::new(8.0),
            },
        }
    }
}

pub fn pick_list_menu_style(p: Palette) -> impl Fn(&Theme) -> iced::overlay::menu::Style {
    move |_| iced::overlay::menu::Style {
        background: Background::Color(p.surface_elevated),
        border: Border {
            color: p.border_strong,
            width: 1.0,
            radius: Radius::new(8.0),
        },
        text_color: p.text,
        selected_text_color: p.on_accent,
        selected_background: Background::Color(p.accent),
        shadow: Shadow {
            color: p.shadow,
            offset: Vector::new(0.0, 6.0),
            blur_radius: 18.0,
        },
    }
}

pub fn scrollable_style(p: Palette) -> impl Fn(&Theme, scrollable::Status) -> scrollable::Style {
    move |_, status| {
        let scroller_color = match status {
            scrollable::Status::Hovered {
                is_vertical_scrollbar_hovered: true,
                ..
            }
            | scrollable::Status::Dragged {
                is_vertical_scrollbar_dragged: true,
                ..
            } => p.faint,
            _ => p.border_strong,
        };
        let rail = scrollable::Rail {
            background: None,
            border: Border::default(),
            scroller: scrollable::Scroller {
                background: Background::Color(scroller_color),
                border: Border {
                    color: Color::TRANSPARENT,
                    width: 0.0,
                    radius: Radius::new(999.0),
                },
            },
        };
        scrollable::Style {
            container: container::Style::default(),
            vertical_rail: rail,
            horizontal_rail: rail,
            gap: None,
            auto_scroll: scrollable::AutoScroll {
                background: Background::Color(p.surface_elevated),
                border: Border {
                    color: p.border,
                    width: 1.0,
                    radius: Radius::new(999.0),
                },
                shadow: Shadow::default(),
                icon: p.muted,
            },
        }
    }
}
