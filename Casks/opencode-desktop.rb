require_relative File.join(__dir__, "..", "lib", "cask_helpers")

cask "opencode-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.18.28"
  sha256 arm64_linux:  "51321000926c076b05808b22574e5b29f4878093af4616899788de7a1b0dbf41",
         x86_64_linux: "2ccd93e5e0648d1cf075c0484a420979dfe85a171416b0dde6f72bea3b56b3c2"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/opencode-desktop-v#{version}/opencode-desktop-#{version}-#{arch}.AppImage"
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
      app_name:  "opencode-desktop",
      icon_path: staged_path/"squashfs-root/opencode-desktop.png",
      icon_dir:  "#{CaskHelpers.xdg_data_home}/icons/hicolor/128x128/apps",
      entry:     CaskHelpers.desktop_entry(
        name:      "OpenCode",
        comment:   "Open source AI coding agent",
        exec:      "\"#{HOMEBREW_PREFIX}/bin/opencode-desktop\" %U",
        icon:      "opencode-desktop",
        wm_class:  "ai.opencode.desktop",
        mime_type: "x-scheme-handler/opencode;",
      ),
    )
  end

  zap trash: [
    "#{CaskHelpers.xdg_cache_home}/ai.opencode.desktop",
    "#{CaskHelpers.xdg_config_home}/ai.opencode.desktop",
    "#{CaskHelpers.xdg_data_home}/ai.opencode.desktop",
    *CaskHelpers.desktop_files("opencode-desktop", icon_dir: "128x128"),
  ]

  caveats <<~EOS
    This cask installs an AppImage that requires unprivileged user namespaces or FUSE.
    On some systems you may need to enable unprivileged_userns_clone or install FUSE3.
    The desktop entry and icon are only removed by the zap stanza. If you uninstalled
    without --zap, clean them up with:
      brew uninstall --zap --force opencode-desktop
  EOS
end
