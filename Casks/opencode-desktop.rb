cask "opencode-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.18.21"
  sha256 arm64_linux:  "0000000000000000000000000000000000000000000000000000000000000000",
         x86_64_linux: "0000000000000000000000000000000000000000000000000000000000000000"

  on_linux do
    app_image "opencode-desktop-#{version}-#{arch}.AppImage"
  end

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/opencode-desktop-v#{version}/opencode-desktop-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap/"
  name "OpenCode Desktop"
  desc "Open source AI coding agent"
  homepage "https://opencode.ai/"

  livecheck do
    url "https://api.github.com/repos/edgarcnp/homebrew-tap/releases?per_page=100"
    strategy :json do |json|
      versions = json.filter_map do |release|
        tag = release["tag_name"]
        tag.delete_prefix("opencode-desktop-v") if tag&.start_with?("opencode-desktop-v")
      end
      versions.max_by { |tag| Gem::Version.new(tag) }
    end
  end

  depends_on :linux

  binary "opencode-desktop-#{version}-#{arch}.AppImage", target: "opencode-desktop"
  artifact "opencode-desktop.desktop", target: "#{Dir.home}/.local/share/applications/opencode-desktop.desktop"

  preflight do
    FileUtils.chmod "+x", staged_path/"opencode-desktop-#{version}-#{arch}.AppImage"
    system staged_path/"opencode-desktop-#{version}-#{arch}.AppImage", "--appimage-extract",
           chdir: staged_path

    icon_dir = "#{Dir.home}/.local/share/icons/hicolor/128x128/apps"
    applications_dir = "#{Dir.home}/.local/share/applications"
    FileUtils.mkdir_p icon_dir
    FileUtils.mkdir_p applications_dir

    FileUtils.cp staged_path/"squashfs-root/opencode-desktop.png", "#{icon_dir}/opencode-desktop.png"
    FileUtils.rm_r(staged_path/"squashfs-root")

    File.write(staged_path/"opencode-desktop.desktop", <<~EOS)
      [Desktop Entry]
      Name=OpenCode
      Comment=Open source AI coding agent
      Exec=#{HOMEBREW_PREFIX}/bin/opencode-desktop %U
      Icon=opencode-desktop
      Terminal=false
      Type=Application
      Categories=Development;
      StartupWMClass=ai.opencode.desktop
    EOS
  end

  zap trash: [
    "~/.local/share/applications/opencode-desktop.desktop",
    "~/.local/share/icons/hicolor/128x128/apps/opencode-desktop.png",
  ]
end
