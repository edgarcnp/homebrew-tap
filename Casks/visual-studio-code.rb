cask "visual-studio-code" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.133.0"
  sha256 arm64_linux:  "433321820b563889a781b36e7211379c9bb405e6cff8042f6607aae9e3b92b63",
         x86_64_linux: "99a65a64968117081dee990ff5963d349975e563082011ffce8e2df7859da043"

  on_linux do
    app_image "vscode-#{version}-#{arch}.AppImage"
  end

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/vscode-v#{version}/vscode-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap/"
  name "Visual Studio Code"
  desc "Repackage of Visual Studio Code as an AppImage"
  homepage "https://code.visualstudio.com/"

  livecheck do
    url "https://api.github.com/repos/edgarcnp/homebrew-tap/releases?per_page=100"
    strategy :json do |json|
      versions = json.filter_map do |release|
        tag = release["tag_name"]
        tag.delete_prefix("vscode-v") if tag&.start_with?("vscode-v")
      end
      versions.max_by { |tag| Gem::Version.new(tag) }
    end
  end

  depends_on :linux

  binary "vscode-#{version}-#{arch}.AppImage", target: "code"
  artifact "vscode.desktop", target: "#{Dir.home}/.local/share/applications/vscode.desktop"

  preflight do
    FileUtils.chmod "+x", staged_path/"vscode-#{version}-#{arch}.AppImage"
    system staged_path/"vscode-#{version}-#{arch}.AppImage", "--appimage-extract",
           chdir: staged_path

    icon_dir = "#{Dir.home}/.local/share/icons/hicolor/256x256/apps"
    applications_dir = "#{Dir.home}/.local/share/applications"
    FileUtils.mkdir_p icon_dir
    FileUtils.mkdir_p applications_dir

    FileUtils.cp staged_path/"squashfs-root/vscode.png", "#{icon_dir}/vscode.png"
    FileUtils.rm_r(staged_path/"squashfs-root")

    File.write(staged_path/"vscode.desktop", <<~EOS)
      [Desktop Entry]
      Name=Visual Studio Code
      Comment=Code Editing. Redefined.
      Exec=#{HOMEBREW_PREFIX}/bin/code %F
      Icon=vscode
      Terminal=false
      Type=Application
      Categories=Development;
      StartupWMClass=Code
    EOS
  end

  zap trash: [
    "~/.local/share/applications/vscode.desktop",
    "~/.local/share/icons/hicolor/256x256/apps/vscode.png",
  ]
end
