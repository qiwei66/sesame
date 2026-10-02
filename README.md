<p align="center">
  <img src="docs/assets/sesame-icon.png" width="112" height="112" alt="Sesame icon">
</p>

<h1 align="center">Sesame</h1>

<p align="center"><b>Stop digging through chats.</b><br>Your library of AI creations: say a sentence and get back anything Claude Code or Codex delivered.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black.svg" alt="macOS 13+">
  <a href="https://github.com/qiwei66/sesame/releases/latest"><img src="https://img.shields.io/github/v/release/qiwei66/sesame" alt="Release"></a>
  <img src="https://img.shields.io/badge/index-local%20only-2ea44f.svg" alt="Index stays on your Mac">
</p>

<p align="center"><a href="README_zh.md">中文</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-firstrun-en-dark.gif">
    <img src="docs/assets/hero-firstrun-en-light.gif" width="960" alt="Sesame's first run: 'Just say it. It's there.' with a count of 2,708 AI creations rolling up from zero, split into dashboards, reports, decks, sites, PRs and files">
  </picture>
</p>

<p align="center"><a href="https://github.com/qiwei66/sesame/releases/download/v0.1.0/sesame-promo-en.mp4">▶ Watch the full promo (44 s)</a></p>

Your AI builds dashboards, reports, decks, sites and pull requests. A week later they are buried in long chats.
Sesame keeps a local library of every artifact your AI delivered, so a few words bring it back: the artifact itself, not the chat it came from.

## What it does

<table>
  <tr>
    <td width="36%">
      <h3>Type, and it's already there</h3>
      Results show up with the first letters. ↑ ↓ to pick, ↵ to open. If nothing local fits, ↵ lets Sesame search everything.
    </td>
    <td width="64%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/typing-en-dark.gif">
        <img src="docs/assets/typing-en-light.gif" width="560" alt="Typing 'tra' lists the Trading Dashboard first; 'trading da' narrows to it; 'trading dashboard v2' offers a full search">
      </picture>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="64%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/voice-en-dark.gif">
        <img src="docs/assets/voice-en-light.gif" width="560" alt="Holding the hot key: a waveform and a live transcript, then on release the Trading Dashboard opens">
      </picture>
    </td>
    <td width="36%">
      <h3>Hold the hot key and say it</h3>
      Hot key: ⌥⇧Space (switch to ⌘Space in Settings). Tap it to type; hold it to talk, let go to send. "Open last week's trading dashboard" opens the dashboard itself.
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="36%">
      <h3>Useful the moment you install it</h3>
      On first launch it reads your existing Claude Code and Codex history and counts every artifact your AI delivered.
    </td>
    <td width="64%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/firstrun-en-dark.gif">
        <img src="docs/assets/firstrun-en-light.gif" width="560" alt="First run: 'Just say it. It's there.' and 2,708 AI creations counted up, split into dashboards, reports, decks, sites, PRs and files">
      </picture>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="64%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pick-en-dark.gif">
        <img src="docs/assets/pick-en-light.gif" width="560" alt="Three candidates for the trading dashboard; arrow keys move the selection and Return opens it">
      </picture>
    </td>
    <td width="36%">
      <h3>More than one match? Pick one</h3>
      When several names fit, you get a short list instead of a guess; when none fits, it says so instead of offering filler. Local services, Claude pages, files, PRs, sites and online docs all count.
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="36%">
      <h3>Share your number</h3>
      Share on the first-run panel turns your number into a 1200×675 image, saves it to Downloads and copies it, ready to paste into a post. Only counts are on it: no titles, paths or names.
    </td>
    <td width="64%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/share-en-dark.png">
        <img src="docs/assets/share-en-light.png" width="560" alt="Share card: 'My 2,708 AI creations, one sentence away.' with counts by type">
      </picture>
    </td>
  </tr>
</table>

## Install

```bash
brew install qiwei66/tap/sesame
mkdir -p ~/Applications && { [ ! -e ~/Applications/Sesame.app ] || [ -L ~/Applications/Sesame.app ] || mv ~/Applications/Sesame.app ~/Applications/Sesame.app.bak-$(date +%Y%m%d%H%M%S); } && ln -sfn "$(brew --prefix)/opt/sesame/Sesame.app" ~/Applications/Sesame.app && open ~/Applications/Sesame.app
```
<!-- the tap is github.com/qiwei66/homebrew-tap (formula source: packaging/homebrew/) -->

The second line puts Sesame.app in `~/Applications` and starts it (an older copy from `make install` is kept as
`Sesame.app.bak-<time>`). Homebrew brings Node.js, builds the app from source on your Mac and ad-hoc signs it: no Gatekeeper warning, no Apple
Developer account needed.

Or install from source (Node.js 22.18+ and the Xcode Command Line Tools, `xcode-select --install`):

```bash
git clone https://github.com/qiwei66/sesame.git
cd sesame
make install
open ~/Applications/Sesame.app
```

`make uninstall` removes it and keeps your settings. The hot key is ⌥⇧Space; switch to ⌘Space in Settings › Hot key.

## Privacy

- The index stays on your Mac (`~/Library/Application Support/Sesame`) and is never uploaded.
- Sesame only reads `~/.claude/projects` and `~/.codex/sessions`, and never writes to them.
- A model is optional. If you set one up, it gets your sentence, your app names and, when local search can't
  decide, each candidate's type, title and a few keywords. Never full links, file paths or your clipboard.

## More

System actions (disk space, moving files to the Trash), custom commands, skills and model setup: [docs/advanced.md](docs/advanced.md).

## License

MIT, see [LICENSE](LICENSE).
