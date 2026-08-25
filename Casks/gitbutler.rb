cask "gitbutler" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.22.1"
  sha256 arm64_linux:  "3ed9200a5a98d57734c16f17855a3b377396a0d5afc6964e45827ee225e51e7e",
         x86_64_linux: "45dd8990347f40458d84e7359dba3b2c1a494369a79c5a0df5daf21ad80bdd49"

  on_linux do
    app_image "gitbutler-#{version}-#{arch}.AppImage"
  end

  url "https://github.com/edgarcnp/homebrew-tap/releases/download/gitbutler-v#{version}/gitbutler-#{version}-#{arch}.AppImage",
      verified: "github.com/edgarcnp/homebrew-tap/"
  name "GitButler"
  desc "Git, finally designed for humans"
  homepage "https://gitbutler.com/"

  livecheck do
    url "https://api.github.com/repos/edgarcnp/homebrew-tap/releases?per_page=100"
    strategy :json do |json|
      versions = json.filter_map do |release|
        tag = release["tag_name"]
        tag.delete_prefix("gitbutler-v") if tag&.start_with?("gitbutler-v")
      end
      versions.max_by { |tag| Gem::Version.new(tag) }
    end
  end

  depends_on :linux

  binary "gitbutler-#{version}-#{arch}.AppImage", target: "gitbutler-tauri"
  binary "gitbutler-#{version}-#{arch}.AppImage", target: "but"
  artifact "gitbutler.desktop", target: "#{Dir.home}/.local/share/applications/gitbutler.desktop"

  preflight do
    FileUtils.chmod "+x", staged_path/"gitbutler-#{version}-#{arch}.AppImage"
    system staged_path/"gitbutler-#{version}-#{arch}.AppImage", "--appimage-extract",
           chdir: staged_path

    icon_dir = "#{Dir.home}/.local/share/icons/hicolor/256x256/apps"
    applications_dir = "#{Dir.home}/.local/share/applications"
    FileUtils.mkdir_p icon_dir
    FileUtils.mkdir_p applications_dir

    FileUtils.cp staged_path/"squashfs-root/gitbutler.png", "#{icon_dir}/gitbutler.png"
    FileUtils.rm_r(staged_path/"squashfs-root")

    File.write(staged_path/"gitbutler.desktop", <<~EOS)
      [Desktop Entry]
      Name=GitButler
      Comment=Git, finally designed for humans
      Exec=#{HOMEBREW_PREFIX}/bin/gitbutler-tauri %U
      Icon=gitbutler
      Terminal=false
      Type=Application
      Categories=Development;
      StartupWMClass=gitbutler-tauri
      MimeType=x-scheme-handler/but;
    EOS
  end

  zap trash: [
    "~/.local/share/applications/gitbutler.desktop",
    "~/.local/share/icons/hicolor/256x256/apps/gitbutler.png",
  ]
end
