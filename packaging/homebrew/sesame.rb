# Source of truth: github.com/qiwei66/homebrew-tap Formula/sesame.rb (copy changes back there).
# Builds Sesame from source on the user's Mac (ad-hoc signed, no quarantine, no Apple Developer account).
# Release bump: update url + sha256 (`shasum -a 256 <tarball>`), then
#   brew install --build-from-source ./sesame.rb && brew test sesame
class Sesame < Formula
  desc "Find anything Claude Code & Codex made for you — just say it"
  homepage "https://github.com/qiwei66/sesame"
  url "https://codeload.github.com/qiwei66/sesame/tar.gz/refs/tags/v0.2.2"
  sha256 "643024fec447f14f07da5dd3a7a15334f247f7335e26e6ab561746998b0f265e"
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

    libexec.install "bin", "src", "skills", "package.json", "package-lock.json", "LICENSE"
    # runtime packages (the MCP SDK for `va mcp`), exactly as pinned in package-lock.json; no install scripts run
    cd libexec do
      system "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    end
    # marks an installed core: the index lives in ~/Library/Application Support/Sesame, so upgrades keep it
    touch libexec/".sesame-install"
    # the app finds the core at $(brew --prefix)/bin/va on its own (CoreLocator), no corePath setting needed
    (bin/"va").write_env_script libexec/"bin/va", PATH: "#{Formula["node"].opt_bin}:$PATH"

    # `sesame`: link Sesame.app into ~/Applications and open it; safe to run again
    (bin/"sesame").write <<~SH
      #!/bin/bash
      set -euo pipefail
      case "${1:-}" in
        "") ;;
        -h|--help) echo "sesame: put Sesame.app in ~/Applications (a link to this Homebrew install) and open it; safe to run again"; exit 0 ;;
        *) echo "sesame: unknown option '$1' (try sesame --help)" >&2; exit 2 ;;
      esac
      dest="$HOME/Applications/Sesame.app"
      mkdir -p "$HOME/Applications"
      if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        bak="$dest.bak-$(date +%Y%m%d%H%M%S)"
        mv "$dest" "$bak"
        echo "sesame: kept the older copy as $bak"
      fi
      ln -sfn "#{opt_prefix}/Sesame.app" "$dest"
      open "$dest"
    SH
    chmod 0755, bin/"sesame"
  end

  def caveats
    <<~EOS
      Run `sesame` to open Sesame (it puts Sesame.app in ~/Applications).
      An older Sesame.app copied there by `make install` is kept as Sesame.app.bak-<time>; delete it when you like.

      Hot key: ⌥⇧Space (switch to ⌘Space in Settings › Hot key).
    EOS
  end

  test do
    out = pipe_output("#{bin}/va serve --stdio", %Q({"jsonrpc":"2.0","id":1,"method":"ping"}\n))
    assert_match "\"rpcVersion\":1", out
    init = %Q({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"brew","version":"0"}}}\n)
    assert_match "\"serverInfo\"", pipe_output("env VA_NO_AUTO_INDEX=1 #{bin}/va mcp", init)
    assert_predicate prefix/"Sesame.app/Contents/MacOS/Sesame", :executable?
    assert_match "~/Applications", shell_output("#{bin}/sesame --help")
    system "codesign", "--verify", prefix/"Sesame.app"
  end
end
