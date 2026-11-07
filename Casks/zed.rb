cask "zed" do
  version "1.27.0"
  sha256 "35f9f2d53e55df12f6fd052b8248eb0fc5ab4f1bc84390447a413d5115c5f8fc"

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/zed-v#{version}/zed-#{version}-x86_64.AppImage"
  name "Zed"
  desc "Repackage of Zed as an AppImage"
  homepage "https://zed.dev/"

  livecheck do
    url "https://github.com/edgarcnp/homebrew-tap.git"
    regex(/^zed-v(\d+\.\d+\.\d+(?:[.-]\w+)*)$/)
    strategy :git
  end

  auto_updates false
  depends_on arch: :x86_64
  depends_on :linux

  app_image "zed-#{version}-x86_64.AppImage", target: "zed-x86_64.AppImage"
  binary "zed-#{version}-x86_64.AppImage", target: "zed"
  generate_completions_from_executable "#{HOMEBREW_PREFIX}/bin/zed", "--completions",
                                       shells: [:bash, :zsh, :fish, :pwsh]

  postflight_steps do
    run "{{HOMEBREW_PREFIX}}/bin/zed", args: ["--appimage-extract"], chdir: "{{staged_path}}"
    inreplace "squashfs-root/share/applications/dev.zed.Zed.desktop",
              "Exec=zed",
              "Exec=\"{{HOMEBREW_PREFIX}}/bin/zed\""
    copy "squashfs-root/share/applications/dev.zed.Zed.desktop",
         ".local/share/applications/dev.zed.Zed.desktop",
         target_base: :home
    copy "squashfs-root/zed.png",
         ".local/share/icons/hicolor/512x512/apps/zed.png",
         target_base: :home
    # earlier installs wrote a generated entry under a different name
    remove ".local/share/applications/zed.desktop", base: :home
    remove "{{staged_path}}/squashfs-root", recursive: true
  end

  zap trash: [
    "~/.cache/zed",
    "~/.config/zed",
    "~/.local/share/applications/dev.zed.Zed.desktop",
    "~/.local/share/applications/zed.desktop",
    "~/.local/share/icons/hicolor/512x512/apps/zed.png",
    "~/.local/share/zed",
    "~/.zed_server",
  ]

  caveats <<~EOS
    This cask installs an AppImage that requires unprivileged user namespaces or FUSE.
    On some systems you may need to enable unprivileged_userns_clone or install FUSE3.
    The desktop entry and icon are only removed by the zap stanza. If you uninstalled
    without --zap, clean them up with:
      brew uninstall --zap --force zed
  EOS
end
