cask "codex-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "26.818.41705"
  sha256 arm64_linux:  "4f275e14c9e85eff2dc4fe388e15073546ed16bcdef40f44b43c98c9f21f8e79",
         x86_64_linux: "8e80d9c932a8971d7d1a0b5b8ef6c297572c4a5133d1f49676451a968148a9b7"

  on_linux do
    app_image "codex-desktop-#{version}-#{arch}.AppImage"
  end

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/codex-desktop-v#{version}/codex-desktop-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap/"
  name "Codex Desktop"
  desc "OpenAI Codex Desktop for Linux"
  homepage "https://openai.com/codex/"

  livecheck do
    url "https://api.github.com/repos/edgarcnp/homebrew-tap/releases?per_page=100"
    strategy :json do |json|
      versions = json.filter_map do |release|
        tag = release["tag_name"]
        tag.delete_prefix("codex-desktop-v") if tag&.start_with?("codex-desktop-v")
      end
      versions.max_by { |tag| Gem::Version.new(tag) }
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
      Comment=OpenAI Codex Desktop for Linux
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
