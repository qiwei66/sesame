# Source of truth: github.com/qiwei66/homebrew-tap Formula/sesame.rb (copy changes back there).
# Builds Sesame from source on the user's Mac (ad-hoc signed, no quarantine, no Apple Developer account).
# Release bump: update url + sha256 (`shasum -a 256 <tarball>`), then
#   brew install --build-from-source ./sesame.rb && brew test sesame
class Sesame < Formula
  desc "Find anything Claude Code & Codex made for you — just say it"
  homepage "https://github.com/qiwei66/sesame"
  url "https://github.com/qiwei66/sesame/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "c684181c8c320531a4c8b3e9f8311e2bf590d952b87b31bac70fbf83f65adc64"
  license "MIT"
  head "https://github.com/qiwei66/sesame.git", branch: "main"

  # Swift comes from the Xcode Command Line Tools, which Homebrew already requires; full Xcode is not needed.
  depends_on macos: :ventura
  depends_on "node"

  def install
    # SwiftPM's own sandbox cannot nest inside Homebrew's build sandbox
    ENV["SESAME_SWIFT_FLAGS"] = "--disable-sandbox"
    system "bash", "macos/scripts/build-app.sh" # ad-hoc signed unless SESAME_SIGN_IDENTITY is set
    prefix.install "macos/build/Sesame.app"

    libexec.install "bin", "src", "skills", "package.json", "LICENSE"
    # marks an installed core: the index lives in ~/Library/Application Support/Sesame, so upgrades keep it
    touch libexec/".sesame-install"
    # the app finds the core at $(brew --prefix)/bin/va on its own (CoreLocator), no corePath setting needed
    (bin/"va").write_env_script libexec/"bin/va", PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  def caveats
    <<~EOS
      One step left: put Sesame in ~/Applications and start it.
        mkdir -p ~/Applications && { [ ! -e ~/Applications/Sesame.app ] || [ -L ~/Applications/Sesame.app ] || mv ~/Applications/Sesame.app ~/Applications/Sesame.app.bak-$(date +%Y%m%d%H%M%S); } && ln -sfn #{opt_prefix}/Sesame.app ~/Applications/Sesame.app && open ~/Applications/Sesame.app
      (An older Sesame.app copied there by `make install` is kept as Sesame.app.bak-<time>; delete it when you like.)

      Hot key: ⌥⇧Space (switch to ⌘Space in Settings › Hot key).
    EOS
  end

  test do
    out = pipe_output("#{bin}/va serve --stdio", %Q({"jsonrpc":"2.0","id":1,"method":"ping"}\n))
    assert_match "\"rpcVersion\":1", out
    assert_predicate prefix/"Sesame.app/Contents/MacOS/Sesame", :executable?
    system "codesign", "--verify", prefix/"Sesame.app"
  end
end
