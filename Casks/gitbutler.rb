require_relative File.join(__dir__, "..", "lib", "cask_helpers")

cask "gitbutler" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.22.3"
  sha256 arm64_linux:  "d0e4f8432b6b836e807eb7be9e685bd39aafdce82a32ac39099f68ff84bf5015",
         x86_64_linux: "09b8cd639053d4962e31b7dc00c320d4fac1cddfcb10ecf4ece2ade826139b51"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/gitbutler-v#{version}/gitbutler-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap"
  name "GitButler"
  desc "Git, finally designed for humans"
  homepage "https://gitbutler.com/"

  livecheck do
    url "https://github.com/edgarcnp/homebrew-tap.git"
    regex(/^gitbutler-v(\d+\.\d+\.\d+(?:[.-]\w+)*)$/)
    strategy :git
  end

  auto_updates false
  depends_on :linux

  app_image "gitbutler-#{version}-#{arch}.AppImage"
  binary "gitbutler-#{version}-#{arch}.AppImage", target: "gitbutler-tauri"
  binary "gitbutler-#{version}-#{arch}.AppImage", target: "but"

  preflight do
    CaskHelpers.extract_appimage(staged_path/"gitbutler-#{version}-#{arch}.AppImage")
    CaskHelpers.install_desktop_integration(
      app_name:  "gitbutler",
      icon_path: staged_path/"squashfs-root/gitbutler.png",
      icon_dir:  "#{CaskHelpers.xdg_data_home}/icons/hicolor/128x128/apps",
      entry:     CaskHelpers.desktop_entry(
        name:      "GitButler",
        comment:   "Git, finally designed for humans",
        exec:      "\"#{HOMEBREW_PREFIX}/bin/gitbutler-tauri\" %U",
        icon:      "gitbutler",
        wm_class:  "gitbutler-tauri",
        mime_type: "x-scheme-handler/but;",
      ),
    )
  end

  uninstall trash: CaskHelpers.desktop_files("gitbutler", icon_dir: "128x128")

  zap trash: [
    "#{CaskHelpers.xdg_cache_home}/gitbutler",
    "#{CaskHelpers.xdg_config_home}/com.gitbutler.app",
    "#{CaskHelpers.xdg_config_home}/gitbutler",
    "#{CaskHelpers.xdg_data_home}/com.gitbutler.app",
    "#{CaskHelpers.xdg_data_home}/gitbutler",
    *CaskHelpers.desktop_files("gitbutler", icon_dir: "128x128"),
  ]

  caveats <<~EOS
    This cask installs an AppImage that requires unprivileged user namespaces or FUSE.
    On some systems you may need to enable unprivileged_userns_clone or install FUSE3.
  EOS
end
