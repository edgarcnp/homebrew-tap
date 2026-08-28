require_relative File.join(__dir__, "..", "lib", "cask_helpers")

cask "opencode-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.18.25"
  sha256 arm64_linux:  "b0ebfa68bd22c3ea5d1991ff85babc89265f1324aa311b6597e2ab4a6d2285fb",
         x86_64_linux: "a6b2439a6ed13747e880504fb795ef5efd69523aa834b276b5f6cdc153e32896"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/opencode-desktop-v#{version}/opencode-desktop-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap"
  name "OpenCode Desktop"
  desc "Open source AI coding agent"
  homepage "https://opencode.ai/"

  livecheck do
    url "https://github.com/edgarcnp/homebrew-tap.git"
    regex(/^opencode-desktop-v(\d+\.\d+\.\d+(?:[.-]\w+)*)$/)
    strategy :git
  end

  auto_updates false
  depends_on :linux

  app_image "opencode-desktop-#{version}-#{arch}.AppImage"
  binary "opencode-desktop-#{version}-#{arch}.AppImage", target: "opencode-desktop"

  preflight do
    CaskHelpers.extract_appimage(staged_path/"opencode-desktop-#{version}-#{arch}.AppImage")
    CaskHelpers.install_desktop_integration(
      app_name: "opencode-desktop",
      icon_path: staged_path/"squashfs-root/opencode-desktop.png",
      icon_dir: "#{CaskHelpers.xdg_data_home}/icons/hicolor/128x128/apps",
      entry: CaskHelpers.desktop_entry(
        name: "OpenCode",
        comment: "Open source AI coding agent",
        exec: "\"#{HOMEBREW_PREFIX}/bin/opencode-desktop\" %U",
        icon: "opencode-desktop",
        wm_class: "ai.opencode.desktop",
        mime_type: "x-scheme-handler/opencode;",
      ),
    )
  end

  uninstall trash: CaskHelpers.desktop_files("opencode-desktop", icon_dir: "128x128")

  zap trash: [
    *CaskHelpers.desktop_files("opencode-desktop", icon_dir: "128x128"),
    "#{CaskHelpers.xdg_cache_home}/ai.opencode.desktop",
    "#{CaskHelpers.xdg_config_home}/ai.opencode.desktop",
    "#{CaskHelpers.xdg_data_home}/ai.opencode.desktop",
  ]

  caveats <<~EOS
    This cask installs an AppImage that requires unprivileged user namespaces or FUSE.
    On some systems you may need to enable unprivileged_userns_clone or install FUSE3.
  EOS
end
