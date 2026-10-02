# qiwei66/homebrew-tap

Homebrew tap for [Sesame](https://github.com/qiwei66/sesame): the menu-bar library of what your AI delivered.

```bash
brew install qiwei66/tap/sesame
open "$(brew --prefix)/opt/sesame/Sesame.app"
```

The formula builds the app from source on your Mac (Xcode Command Line Tools, `xcode-select --install`) and
ad-hoc signs it, so there is no Gatekeeper warning and no Apple Developer account is involved. Node.js comes in as a
dependency. The index stays in `~/Library/Application Support/Sesame` across `brew upgrade`.

```bash
brew upgrade sesame     # new version
brew uninstall sesame   # removes the app and the core; your settings in ~/.config/voice-agent stay
```

## Layout of this repository

```
Formula/sesame.rb       # copied from packaging/homebrew/sesame.rb in the Sesame repository at each release
README.md
```

## Releasing a version (maintainers)

1. In the Sesame repository: tag `vX.Y.Z` and push it.
2. `curl -L https://github.com/qiwei66/sesame/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256`
3. Copy `packaging/homebrew/sesame.rb` here as `Formula/sesame.rb`, set `url` and `sha256`.
4. `brew install --build-from-source ./Formula/sesame.rb && brew test sesame && brew audit --strict sesame`
5. Commit and push.

---

# qiwei66/homebrew-tap（中文）

[Sesame](https://github.com/qiwei66/sesame) 的 Homebrew 源：菜单栏里的 AI 产物库。

```bash
brew install qiwei66/tap/sesame
open "$(brew --prefix)/opt/sesame/Sesame.app"
```

在你的 Mac 上从源码编译并 ad-hoc 签名（需要 Xcode 命令行工具 `xcode-select --install`），不弹 Gatekeeper 警告，也不需要苹果开发者账号；Node.js 作为依赖自动装上。索引放在 `~/Library/Application Support/Sesame`，`brew upgrade` 不会丢。卸载用 `brew uninstall sesame`，`~/.config/voice-agent` 里的设置会保留。
