# config.yaml

Location: `$VA_CONFIG_DIR`, else `$XDG_CONFIG_HOME/voice-agent`, else `~/.config/voice-agent`. Missing file = defaults.
YAML subset: mappings, lists, flow lists/maps, quoted/plain scalars, comments (see `src/yaml.ts`).

```yaml
locale: auto              # auto (per sentence: Han characters → zh, else en) | zh | en — picks the language packs AND the language of results, dialogs and plan lines
user_name: Jane           # "You are Jane's Mac voice command assistant"; empty = generic
voice: Samantha           # `say -v`; empty = system voice
speak: false              # read results aloud (env VA_SPEAK=1 also turns it on)

provider: deepseek        # deepseek | openai | ollama | lmstudio | any name defined below
providers:
  deepseek:
    model: deepseek-flash
    key:                  # tried in order; the value is never printed/logged
      - env: DEEPSEEK_API_KEY
      - keychain: { service: voice-agent.deepseek }      # security find-generic-password -s … -w
      - file: ~/.secrets/deepseek.key                    # single-line raw key or KEY=value
    price: { input: 1.0, cached_input: 0.1, output: 2.0, currency: ¥ }   # per 1M tokens, for the cost tag only
  myproxy:                # custom OpenAI-compatible endpoint
    base_url: https://llm.example.com/v1
    model: some-model
    key: [{ env: MYPROXY_KEY }]

sources: [claude, codex]  # transcripts to index (read-only)
self_hosts: [100.64.0.7]  # this machine's other addresses (e.g. Tailscale IP) → opened via 127.0.0.1
prompt_localized_app_names: true   # list "Lark（飞书/Feishu）" in the prompt

known_urls:               # the only URLs the model may open by name
  - name: My orders
    url: https://shop.example.com/orders
prompt_rules:             # appended to the numbered rules of the system prompt
  - '"NAS" means the home NAS unless the user says "office".'
app_aliases:              # spoken name → app bundle name (on top of auto-discovered localized names)
  browser: Google Chrome
synonyms:                 # your own search vocabulary: words that mean the same item to you (any language mix)
  - [库存, inventory, stock]
data_dir: ~/.local/state/voice-agent   # cache / logs / index (default: the repo directory)
index_dir: ~/.local/state/voice-agent/index   # optional; env VA_INDEX_DIR wins
log_dir: ~/.local/state/voice-agent/logs      # optional; env VA_LOG_DIR wins (va doctor reads the same dirs)
ui_locale: auto           # language for output without an input sentence (va doctor): auto = system language | zh | en
```

Preset defaults (`src/providers.ts`): deepseek `https://api.deepseek.com` · openai `https://api.openai.com/v1` ·
ollama `http://127.0.0.1:11434/v1` (no key) · lmstudio `http://127.0.0.1:1234/v1` (no key; set `model` to the loaded model id).
Default model names are starting points; set `model` explicitly. No prices are preset for paid providers.

Env overrides: `VA_PROVIDER`, `VA_MODEL`, `VA_BASE_URL`, `VA_KEY_FILE`, `VA_CONFIG_DIR`, `VA_INDEX_DIR`, `VA_CACHE_FILE`, `VA_LOG_DIR`,
`VA_PROJECTS_DIR` (Claude transcripts), `VA_CODEX_DIR` (Codex transcripts).
