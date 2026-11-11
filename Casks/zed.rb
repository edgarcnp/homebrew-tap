cask "zed" do
  version "1.28.1"
  sha256 "f9550e8d90933f56a4d1028f8e0514728f363a74a57be7823a63533422e2f83a"

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

  postflight_steps do
    run "{{HOMEBREW_PREFIX}}/bin/zed", args: ["--appimage-extract"], chdir: "{{staged_path}}",
                                               writable_paths: ["{{staged_path}}"]
    # A run step rewrites the entry: a cask sandbox pre-creates the parent of
    # every path an inreplace names, and that collides with the AppImage's own
    # squashfs-root during extraction.
    run "sed",
        args: ["-i", "s|^Exec=zed|Exec=\"{{HOMEBREW_PREFIX}}/bin/zed\"|",
               "squashfs-root/share/applications/dev.zed.Zed.desktop"],
        chdir: "{{staged_path}}", writable_paths: ["{{staged_path}}"]
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
