require_relative File.join(__dir__, "..", "lib", "cask_helpers")

cask "gitbutler" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.22.3"
  sha256 arm64_linux:  "f75a1568a2a4892cd3c3763d2865a2ece38bd7ca196f9efad06970896e7b6d11",
         x86_64_linux: "33b24802b60cb33abf88609579e9ff780717e098a4a55faeacb6eb739c92c5ec"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/gitbutler-v#{version}/gitbutler-#{version}-#{arch}.AppImage"
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
    The desktop entry and icon are only removed by the zap stanza. If you uninstalled
    without --zap, clean them up with:
      brew uninstall --zap --force gitbutler
  EOS
end
