require_relative File.join(__dir__, "..", "lib", "cask_helpers")

cask "vscode" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.135.0"
  sha256 arm64_linux:  "0eab42483854cd45ea4578d0b8e8419c44d5cb65eb008132684a055f70ce0575",
         x86_64_linux: "d8dfcbaac47713d87a62f0d72b4a9eb87f442f6bd1a6d26225b74fea208aff79"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/vscode-v#{version}/vscode-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap"
  name "Visual Studio Code"
  desc "Repackage of Visual Studio Code as an AppImage"
  homepage "https://code.visualstudio.com/"

  livecheck do
    url "https://github.com/edgarcnp/homebrew-tap.git"
    regex(/^vscode-v(\d+\.\d+\.\d+(?:[.-]\w+)*)$/)
    strategy :git
  end

  auto_updates false
  conflicts_with cask: ["visual-studio-code", "vscodium"]
  depends_on :linux

  app_image "vscode-#{version}-#{arch}.AppImage"
  binary "vscode-#{version}-#{arch}.AppImage", target: "code"

  preflight do
    CaskHelpers.extract_appimage(staged_path/"vscode-#{version}-#{arch}.AppImage")
    CaskHelpers.install_desktop_integration(
      app_name:  "vscode",
      icon_path: staged_path/"squashfs-root/vscode.png",
      icon_dir:  "#{CaskHelpers.xdg_data_home}/icons/hicolor/256x256/apps",
      entry:     CaskHelpers.desktop_entry(
        name:      "Visual Studio Code",
        comment:   "Code Editing. Redefined.",
        exec:      "\"#{HOMEBREW_PREFIX}/bin/code\" %F",
        icon:      "vscode",
        wm_class:  "Code",
        mime_type: "application/x-code-workspace;",
      ),
    )
  end

  zap trash: [
    "#{CaskHelpers.xdg_cache_home}/Code",
    "#{CaskHelpers.xdg_config_home}/Code",
    "#{Dir.home}/.vscode-cli",
    "#{Dir.home}/.vscode-server",
    "~/.vscode",
    *CaskHelpers.desktop_files("vscode", icon_dir: "256x256"),
  ]

  caveats <<~EOS
    This cask installs an AppImage that requires unprivileged user namespaces or FUSE.
    On some systems you may need to enable unprivileged_userns_clone or install FUSE3.
    The desktop entry and icon are only removed by the zap stanza. If you uninstalled
    without --zap, clean them up with:
      brew uninstall --zap --force vscode
  EOS
end
