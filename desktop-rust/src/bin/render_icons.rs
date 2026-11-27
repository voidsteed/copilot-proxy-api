use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn render_svg_to_png(svg_bytes: &[u8], width: u32, height: u32, out_path: &Path) {
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_data(svg_bytes, &options)
        .expect("failed to parse SVG");
    let mut pixmap = tiny_skia::Pixmap::new(width, height).expect("failed to allocate pixmap");
    let sx = width as f32 / tree.size().width();
    let sy = height as f32 / tree.size().height();
    let transform = tiny_skia::Transform::from_scale(sx, sy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).expect("failed to create output directory");
    }
    pixmap.save_png(out_path).expect("failed to write PNG");
}

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let assets_dir = manifest_dir.join("assets");
    let generated_dir = assets_dir.join("generated");
    fs::create_dir_all(&generated_dir).expect("failed to create generated dir");

    let app_svg = fs::read(assets_dir.join("app-icon.svg")).expect("read app-icon.svg");
    let tray_running_svg =
        fs::read(assets_dir.join("tray-running.svg")).expect("read tray-running.svg");
    let tray_stopped_svg =
        fs::read(assets_dir.join("tray-stopped.svg")).expect("read tray-stopped.svg");

    // App icon 1024x1024
    render_svg_to_png(&app_svg, 1024, 1024, &generated_dir.join("icon.png"));

    // Menu bar template icons (1x = 22x22, 2x Retina = 44x44)
    render_svg_to_png(
        &tray_running_svg,
        22,
        22,
        &generated_dir.join("trayTemplate.png"),
    );
    render_svg_to_png(
        &tray_running_svg,
        44,
        44,
        &generated_dir.join("trayTemplate@2x.png"),
    );
    render_svg_to_png(
        &tray_stopped_svg,
        22,
        22,
        &generated_dir.join("trayStoppedTemplate.png"),
    );
    render_svg_to_png(
        &tray_stopped_svg,
        44,
        44,
        &generated_dir.join("trayStoppedTemplate@2x.png"),
    );

    // Build macOS .icns via iconutil if available
    if cfg!(target_os = "macos") {
        let iconset_dir = std::env::temp_dir().join("CopilotProxyRust.iconset");
        let _ = fs::remove_dir_all(&iconset_dir);
        fs::create_dir_all(&iconset_dir).expect("create iconset dir");

        let sizes: &[(&str, u32)] = &[
            ("icon_16x16.png", 16),
            ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32),
            ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128),
            ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256),
            ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512),
            ("icon_512x512@2x.png", 1024),
        ];
        for (name, size) in sizes {
            render_svg_to_png(&app_svg, *size, *size, &iconset_dir.join(name));
        }

        let icns_path = generated_dir.join("AppIcon.icns");
        let status = Command::new("iconutil")
            .args([
                "-c",
                "icns",
                iconset_dir.to_str().unwrap(),
                "-o",
                icns_path.to_str().unwrap(),
            ])
            .status()
            .expect("run iconutil");
        assert!(status.success(), "iconutil failed");
        let _ = fs::remove_dir_all(&iconset_dir);
    }

    // Generate a clean visual review sheet (app icon + light/dark menu bar mockups)
    let preview_svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 440" width="960" height="440">
  <rect width="960" height="440" fill="#141820"/>
  <g transform="translate(40, 40) scale(0.3515625)">
    {app_inner}
  </g>
  <!-- Light macOS menu bar preview -->
  <rect x="440" y="72" width="480" height="56" rx="12" fill="#F3F4F6"/>
  <text x="466" y="106" font-family="-apple-system, sans-serif" font-size="16" font-weight="500" fill="#111827">Light Menu Bar</text>
  <g transform="translate(758, 84) scale(1.45)">
    <path d="M 4.1 14.0 A 7.5 7.5 0 0 1 14.0 4.1" fill="none" stroke="#111827" stroke-width="2.25" stroke-linecap="round"/>
    <path d="M 17.9 8.0 A 7.5 7.5 0 0 1 8.0 17.9" fill="none" stroke="#111827" stroke-width="2.25" stroke-linecap="round"/>
    <circle cx="11" cy="11" r="2.75" fill="#111827"/>
  </g>
  <g transform="translate(838, 84) scale(1.45)">
    <path d="M 4.1 14.0 A 7.5 7.5 0 0 1 14.0 4.1" fill="none" stroke="#111827" stroke-width="2.15" stroke-linecap="round" stroke-opacity="0.72"/>
    <path d="M 17.9 8.0 A 7.5 7.5 0 0 1 8.0 17.9" fill="none" stroke="#111827" stroke-width="2.15" stroke-linecap="round" stroke-opacity="0.72"/>
    <circle cx="11" cy="11" r="2.55" fill="none" stroke="#111827" stroke-width="1.65" stroke-opacity="0.72"/>
  </g>
  <!-- Dark macOS menu bar preview -->
  <rect x="440" y="156" width="480" height="56" rx="12" fill="#1E222B" stroke="#2D3443" stroke-width="1"/>
  <text x="466" y="190" font-family="-apple-system, sans-serif" font-size="16" font-weight="500" fill="#F3F4F6">Dark Menu Bar</text>
  <g transform="translate(758, 168) scale(1.45)">
    <path d="M 4.1 14.0 A 7.5 7.5 0 0 1 14.0 4.1" fill="none" stroke="#FFFFFF" stroke-width="2.25" stroke-linecap="round"/>
    <path d="M 17.9 8.0 A 7.5 7.5 0 0 1 8.0 17.9" fill="none" stroke="#FFFFFF" stroke-width="2.25" stroke-linecap="round"/>
    <circle cx="11" cy="11" r="2.75" fill="#FFFFFF"/>
  </g>
  <g transform="translate(838, 168) scale(1.45)">
    <path d="M 4.1 14.0 A 7.5 7.5 0 0 1 14.0 4.1" fill="none" stroke="#FFFFFF" stroke-width="2.15" stroke-linecap="round" stroke-opacity="0.72"/>
    <path d="M 17.9 8.0 A 7.5 7.5 0 0 1 8.0 17.9" fill="none" stroke="#FFFFFF" stroke-width="2.15" stroke-linecap="round" stroke-opacity="0.72"/>
    <circle cx="11" cy="11" r="2.55" fill="none" stroke="#FFFFFF" stroke-width="1.65" stroke-opacity="0.72"/>
  </g>
  <!-- 1:1 Retina comparison box -->
  <rect x="440" y="246" width="480" height="122" rx="12" fill="#0E1117" stroke="#222836" stroke-width="1"/>
  <text x="466" y="280" font-family="-apple-system, sans-serif" font-size="13" fill="#98A2B3">Left: Running (solid core)   Right: Stopped (hollow core)</text>
  <g transform="translate(466, 304) scale(2.2)">
    <path d="M 4.1 14.0 A 7.5 7.5 0 0 1 14.0 4.1" fill="none" stroke="#FFFFFF" stroke-width="2.25" stroke-linecap="round"/>
    <path d="M 17.9 8.0 A 7.5 7.5 0 0 1 8.0 17.9" fill="none" stroke="#FFFFFF" stroke-width="2.25" stroke-linecap="round"/>
    <circle cx="11" cy="11" r="2.75" fill="#3B82F6"/>
  </g>
</svg>"##,
        app_inner = String::from_utf8_lossy(&app_svg)
            .split_once('>')
            .map(|(_, rest)| rest.trim_end().trim_end_matches("</svg>"))
            .unwrap_or("")
    );
    if let Ok(preview_path) = std::env::var("COPILOT_PROXY_ICON_PREVIEW")
        && !preview_path.trim().is_empty()
    {
        let preview_out = PathBuf::from(preview_path);
        render_svg_to_png(preview_svg.as_bytes(), 960, 440, &preview_out);
        println!("Preview sheet: {}", preview_out.display());
    }

    println!("Rendered icons into {}", generated_dir.display());
}
