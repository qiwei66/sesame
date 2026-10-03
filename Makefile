# Sesame: build and install from source (no Apple Developer account needed).
#   make            build macos/build/Sesame.app
#   make test       core (node --test) + app logic (swift test)
#   make install    build, then install Sesame.app into $(APP_DIR) and the TypeScript core into $(CORE_DIR)
#   make uninstall
# Signing: ad-hoc by default; set SESAME_SIGN_IDENTITY="<codesign identity>" to sign with a real identity.
# An app built on this Mac carries no quarantine attribute, so Gatekeeper does not prompt.

APP_DIR  ?= $(HOME)/Applications
# keep CORE_DIR in sync with CoreLocator.installedCoreRelative (macos/Sources/SesameCore/CoreLocator.swift)
CORE_DIR ?= $(HOME)/.local/share/sesame/core
BIN_DIR  ?= $(HOME)/.local/bin
NODE     ?= node
NPM      ?= npm
# 0 = do not create $(BIN_DIR)/va
LINK_VA  ?= 1
# 1 = when CORE_DIR is not the default, tell the app where the core is (defaults write <bundle id> corePath)
SET_CORE_PATH ?= 1
BUNDLE_ID ?= io.github.sesame.app
export SESAME_SIGN_IDENTITY
export SESAME_BUNDLE_ID = $(BUNDLE_ID)

DEFAULT_CORE_DIR := $(HOME)/.local/share/sesame/core
CORE_FILES := bin src skills package.json package-lock.json LICENSE

.PHONY: all app test install install-app install-core uninstall check-node clean

all: app

check-node:
	@$(NODE) -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("[sesame] node >= 22.18 required, found "+process.versions.node); process.exit(1) }' \
	  || { echo "[sesame] install Node.js 22.18+ (https://nodejs.org or brew install node)"; exit 1; }

app:
	bash macos/scripts/build-app.sh

test: check-node
	npm test
	swift test --package-path macos

install: check-node app install-core install-app
	@echo "[sesame] installed: $(APP_DIR)/Sesame.app, core in $(CORE_DIR) (va linked into $(BIN_DIR))"
	@echo "[sesame] start it with: open \"$(APP_DIR)/Sesame.app\"   (hot key ⌥⇧Space; switch to ⌘Space in Settings › Hot key)"

install-app:
	mkdir -p "$(APP_DIR)"
	rm -rf "$(APP_DIR)/Sesame.app"
	ditto macos/build/Sesame.app "$(APP_DIR)/Sesame.app"

install-core:
	mkdir -p "$(CORE_DIR)" "$(BIN_DIR)"
	rsync -a --delete --exclude '*.local.ts' --exclude node_modules $(CORE_FILES) "$(CORE_DIR)/"
	@# runtime packages (the MCP SDK for `va mcp`), exactly as pinned in package-lock.json; no install scripts run
	cd "$(CORE_DIR)" && $(NPM) ci --omit=dev --ignore-scripts --no-audit --no-fund
	@# marker: an installed core keeps its data (index, cache, logs) in ~/Library/Application Support/Sesame, never in CORE_DIR (src/config.ts defaultDataDir)
	touch "$(CORE_DIR)/.sesame-install"
	@# never replace someone else's `va` (e.g. a git checkout's): only create the link or refresh our own
	@if [ "$(LINK_VA)" != 1 ]; then echo "[sesame] LINK_VA=0: not linking va into $(BIN_DIR)"; \
	elif [ -e "$(BIN_DIR)/va" ] && [ "$$(readlink "$(BIN_DIR)/va")" != "$(CORE_DIR)/bin/va" ]; then \
	  echo "[sesame] $(BIN_DIR)/va already points elsewhere ($$(readlink "$(BIN_DIR)/va" || echo file)); left as is"; \
	else ln -sf "$(CORE_DIR)/bin/va" "$(BIN_DIR)/va"; fi
	@# va-index: the manual re-index command that `va doctor` and the "run va-index" hints point at (same ownership rule as va)
	@if [ "$(LINK_VA)" != 1 ]; then :; \
	elif [ -e "$(BIN_DIR)/va-index" ] && [ "$$(readlink "$(BIN_DIR)/va-index")" != "$(CORE_DIR)/bin/va-index" ]; then \
	  echo "[sesame] $(BIN_DIR)/va-index already points elsewhere; left as is"; \
	else ln -sf "$(CORE_DIR)/bin/va-index" "$(BIN_DIR)/va-index"; fi
	@printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ping"}' | "$(CORE_DIR)/bin/va" serve --stdio | grep -q '"rpcVersion"' \
	  && echo "[sesame] core ping ok" || { echo "[sesame] core did not answer ping"; exit 1; }
	@printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"make","version":"0"}}}' | VA_NO_AUTO_INDEX=1 "$(CORE_DIR)/bin/va" mcp 2>/dev/null | grep -q '"serverInfo"' \
	  && echo "[sesame] va mcp ok" || { echo "[sesame] va mcp did not answer initialize"; exit 1; }
	@if [ "$(SET_CORE_PATH)" = 1 ] && [ "$(CORE_DIR)" != "$(DEFAULT_CORE_DIR)" ]; then \
	  defaults write $(BUNDLE_ID) corePath "$(CORE_DIR)/bin/va"; echo "[sesame] corePath set to $(CORE_DIR)/bin/va"; fi

uninstall:
	rm -rf "$(APP_DIR)/Sesame.app" "$(CORE_DIR)"
	@[ -L "$(BIN_DIR)/va" ] && [ "$$(readlink "$(BIN_DIR)/va")" = "$(CORE_DIR)/bin/va" ] && rm -f "$(BIN_DIR)/va" || true
	@[ -L "$(BIN_DIR)/va-index" ] && [ "$$(readlink "$(BIN_DIR)/va-index")" = "$(CORE_DIR)/bin/va-index" ] && rm -f "$(BIN_DIR)/va-index" || true
	@echo "[sesame] removed app and core (settings in ~/.config/voice-agent and the app's defaults are kept)"

clean:
	rm -rf macos/build macos/.build
