cask "codex-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.0.0"
  sha256 arm64_linux:  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
         x86_64_linux: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

  on_linux do
    app_image "codex-desktop-#{version}-#{arch}.AppImage"
  end

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/v#{version}/codex-desktop-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap/"
  name "Codex Desktop"
  desc "OpenAI Codex Desktop for Linux, repackaged from the signed official package"
  homepage "https://openai.com/codex/"

  livecheck do
    url "https://api.github.com/repos/edgarcnp/homebrew-tap/releases/latest"
    strategy :json do |json|
      json["tag_name"]&.delete_prefix("v")
    end
  end

  depends_on :linux

  binary "codex-desktop-#{version}-#{arch}.AppImage", target: "codex-desktop"
  artifact "codex-desktop.desktop", target: "#{Dir.home}/.local/share/applications/codex-desktop.desktop"

  preflight do
    FileUtils.chmod "+x", staged_path/"codex-desktop-#{version}-#{arch}.AppImage"
    system staged_path/"codex-desktop-#{version}-#{arch}.AppImage", "--appimage-extract",
           chdir: staged_path

    icon_dir = "#{Dir.home}/.local/share/icons/hicolor/256x256/apps"
    applications_dir = "#{Dir.home}/.local/share/applications"
    FileUtils.mkdir_p icon_dir
    FileUtils.mkdir_p applications_dir

    FileUtils.cp staged_path/"squashfs-root/codex-desktop.png", "#{icon_dir}/codex-desktop.png"
    FileUtils.rm_r(staged_path/"squashfs-root")

    File.write(staged_path/"codex-desktop.desktop", <<~EOS)
      [Desktop Entry]
      Name=Codex Desktop
      Comment=OpenAI Codex Desktop for Linux, repackaged from the signed official package
      Exec=#{HOMEBREW_PREFIX}/bin/codex-desktop %U
      Icon=codex-desktop
      Terminal=false
      Type=Application
      Categories=Development;
    EOS
  end

  zap trash: [
    "~/.local/share/applications/codex-desktop.desktop",
    "~/.local/share/icons/hicolor/256x256/apps/codex-desktop.png",
  ]
end
