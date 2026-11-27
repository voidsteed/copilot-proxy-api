use std::sync::Arc;

use muda::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::contracts::{AccountState, DesktopSnapshot, GatewayState};

const TRAY_RUNNING_SVG: &[u8] = include_bytes!("../assets/tray-running.svg");
const TRAY_STOPPED_SVG: &[u8] = include_bytes!("../assets/tray-stopped.svg");

pub const MENU_OPEN: &str = "open";
pub const MENU_TOGGLE_GATEWAY: &str = "toggle-gateway";
pub const MENU_COPY_URL: &str = "copy-url";
pub const MENU_REFRESH: &str = "refresh";
pub const MENU_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    OpenWindow,
    ToggleGateway,
    CopyUrl,
    Refresh,
    Quit,
}

pub struct TrayController {
    tray: TrayIcon,
    running_icon: Icon,
    stopped_icon: Icon,
    last_running: Option<bool>,
    status_item: MenuItem,
    toggle_item: MenuItem,
    copy_url_item: MenuItem,
}

impl TrayController {
    pub fn new() -> Result<Self, String> {
        let running_icon = rasterize_tray_icon(TRAY_RUNNING_SVG)?;
        let stopped_icon = rasterize_tray_icon(TRAY_STOPPED_SVG)?;

        let status_item = MenuItem::with_id(MenuId::new("status"), "Gateway stopped", false, None);
        let open_item = MenuItem::with_id(MenuId::new(MENU_OPEN), "Open Copilot Proxy", true, None);
        let toggle_item =
            MenuItem::with_id(MenuId::new(MENU_TOGGLE_GATEWAY), "Start gateway", false, None);
        let copy_url_item =
            MenuItem::with_id(MenuId::new(MENU_COPY_URL), "Copy endpoint URL", false, None);
        let refresh_item =
            MenuItem::with_id(MenuId::new(MENU_REFRESH), "Refresh models & usage", true, None);
        let quit_item =
            MenuItem::with_id(MenuId::new(MENU_QUIT), "Quit Copilot Proxy", true, None);

        let menu = Menu::new();
        let _ = menu.append(&status_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&open_item);
        let _ = menu.append(&copy_url_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&toggle_item);
        let _ = menu.append(&refresh_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&quit_item);

        let tray = TrayIconBuilder::new()
            .with_icon_templated(stopped_icon.clone())
            .with_tooltip("Copilot Proxy")
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(true)
            .build()
            .map_err(|err| format!("Failed to create menu bar icon: {err}"))?;

        Ok(Self {
            tray,
            running_icon,
            stopped_icon,
            last_running: Some(false),
            status_item,
            toggle_item,
            copy_url_item,
        })
    }

    pub fn sync(&mut self, snapshot: &DesktopSnapshot) {
        let running = matches!(snapshot.gateway, GatewayState::Running { .. });
        if self.last_running != Some(running) {
            let icon = if running {
                self.running_icon.clone()
            } else {
                self.stopped_icon.clone()
            };
            let _ = self.tray.set_icon_templated(Some(icon));
            self.last_running = Some(running);
        }

        let status_text = match &snapshot.gateway {
            GatewayState::Running { .. } => {
                if let Some(conn) = &snapshot.connection {
                    if snapshot.source.is_legacy_cli() {
                        format!("CLI proxy on {}", conn.host_label())
                    } else {
                        format!("Gateway running on {}", conn.host_label())
                    }
                } else {
                    "Gateway running".to_string()
                }
            }
            GatewayState::Starting => "Gateway starting...".to_string(),
            GatewayState::Stopping => "Gateway stopping...".to_string(),
            GatewayState::Draining { in_flight } => {
                format!("Finishing {in_flight} request(s)...")
            }
            GatewayState::Error { .. } => "Gateway needs attention".to_string(),
            GatewayState::Stopped => "Gateway stopped".to_string(),
        };

        self.status_item.set_text(&status_text);
        let _ = self.tray.set_tooltip(Some(format!("Copilot Proxy · {status_text}")));

        let signed_in = matches!(snapshot.account, AccountState::SignedIn { .. });
        let transitional = matches!(
            snapshot.gateway,
            GatewayState::Starting | GatewayState::Stopping | GatewayState::Draining { .. }
        );
        let toggle_enabled = signed_in && !snapshot.source.is_legacy_cli() && !transitional;
        self.toggle_item.set_text(if snapshot.source.is_legacy_cli() {
            "Controlled in Terminal"
        } else if running {
            "Stop gateway"
        } else {
            "Start gateway"
        });
        self.toggle_item.set_enabled(toggle_enabled);
        self.copy_url_item
            .set_enabled(running && snapshot.connection.is_some());
    }
}

pub fn install_tray_event_handlers(
    tx: tokio::sync::mpsc::UnboundedSender<TrayAction>,
) {
    let menu_tx = tx.clone();
    MenuEvent::set_event_handler(Some(Arc::new(move |event: MenuEvent| {
        let action = match event.id.0.as_str() {
            MENU_OPEN => Some(TrayAction::OpenWindow),
            MENU_TOGGLE_GATEWAY => Some(TrayAction::ToggleGateway),
            MENU_COPY_URL => Some(TrayAction::CopyUrl),
            MENU_REFRESH => Some(TrayAction::Refresh),
            MENU_QUIT => Some(TrayAction::Quit),
            _ => None,
        };
        if let Some(a) = action {
            let _ = menu_tx.send(a);
        }
    })));

    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } = event
        {
            let _ = tx.send(TrayAction::OpenWindow);
        }
    }));
}

fn rasterize_tray_icon(svg_bytes: &[u8]) -> Result<Icon, String> {
    // 36x36 pixels at 2.0 scale factor = crisp 18x18pt Apple HIG macOS menu bar icon
    let size = 36u32;
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_data(svg_bytes, &options)
        .map_err(|err| format!("Failed to parse tray SVG: {err}"))?;
    let mut pixmap = tiny_skia::Pixmap::new(size, size)
        .ok_or_else(|| "Failed to allocate tray pixmap".to_string())?;
    let sx = size as f32 / tree.size().width();
    let sy = size as f32 / tree.size().height();
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(sx, sy),
        &mut pixmap.as_mut(),
    );
    // Un-premultiply alpha for tray-icon RGBA input
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for px in pixmap.pixels() {
        let a = px.alpha();
        if a == 0 {
            rgba.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let unpre = |c: u8| -> u8 { ((c as u16 * 255 + (a as u16 / 2)) / a as u16).min(255) as u8 };
            rgba.push(unpre(px.red()));
            rgba.push(unpre(px.green()));
            rgba.push(unpre(px.blue()));
            rgba.push(a);
        }
    }
    Icon::from_rgba_with_scale(rgba, size, size, 2.0)
        .map_err(|err| format!("Failed to construct Retina tray icon: {err}"))
}
