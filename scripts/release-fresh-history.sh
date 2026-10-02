#!/bin/bash
# release-fresh-history.sh — build a LOCAL `public` branch with a brand-new single-commit history
# (orphan commit = the tree of the source ref, no parents), authored with a GitHub noreply address.
# It never pushes and never touches the working tree or other branches (plumbing only: commit-tree + update-ref).
#
#   PUBLIC_AUTHOR_NAME="Jane Doe" PUBLIC_AUTHOR_EMAIL="12345+jane@users.noreply.github.com" \
#     scripts/release-fresh-history.sh [--source oss-core] [--branch public] [--message "..."] [--deny-file FILE] [--force]
#
# Self-check after building (any failure → the branch is deleted again and the script exits 1):
#   1. the branch reaches exactly ONE commit, with no parents, sharing no history with the source ref
#   2. author/committer emails are *@users.noreply.github.com
#   3. deny patterns have 0 hits in: the commit message, every path, every blob reachable from the branch
#      (author/committer are checked by rule 2 only: a GitHub noreply address contains your GitHub handle by design)
# Deny patterns = lines of the deny file (default: $VA_CONFIG_DIR/release-deny-patterns.txt, extended regex,
# case-insensitive, '#' comments) + automatic ones from this machine: login name, $HOME, git user.email, hostname.
# Keep the deny file outside the repo (it lists exactly the strings that must not be published).
set -euo pipefail

SOURCE=oss-core
BRANCH=public
MESSAGE="Initial public release"
FORCE=0
VA_CONFIG_DIR="${VA_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/voice-agent}"
DENY_FILE="$VA_CONFIG_DIR/release-deny-patterns.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --deny-file) DENY_FILE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
say() { printf '[release] %s\n' "$*"; }
die() { printf '[release] FAIL: %s\n' "$*" >&2; exit 1; }

: "${PUBLIC_AUTHOR_NAME:?set PUBLIC_AUTHOR_NAME}"
: "${PUBLIC_AUTHOR_EMAIL:?set PUBLIC_AUTHOR_EMAIL (a GitHub noreply address)}"
case "$PUBLIC_AUTHOR_EMAIL" in *@users.noreply.github.com) ;; *) die "PUBLIC_AUTHOR_EMAIL must end with @users.noreply.github.com" ;; esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
SRC_COMMIT="$(git rev-parse --verify "$SOURCE^{commit}")" || die "source ref not found: $SOURCE"
TREE="$(git rev-parse "$SRC_COMMIT^{tree}")"
if git show-ref --verify --quiet "refs/heads/$BRANCH" && [ "$FORCE" != 1 ]; then
  die "branch $BRANCH already exists (use --force to rebuild it)"
fi

# ── deny patterns ──
escape() { printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|/]/\\&/g'; }
PATTERNS=()
if [ -f "$DENY_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$line" ] && PATTERNS+=("$line")
  done < "$DENY_FILE"
  say "deny file: $DENY_FILE (${#PATTERNS[@]} patterns)"
else
  say "WARN: no deny file at $DENY_FILE — only automatic patterns are checked"
fi
for v in "$(id -un)" "$HOME" "$(git config user.email || true)" "$(hostname -s 2>/dev/null || true)"; do
  [ -n "$v" ] && [ "${#v}" -ge 3 ] && PATTERNS+=("$(escape "$v")")
done
[ "${#PATTERNS[@]}" -gt 0 ] || die "no deny patterns"
RE="$(IFS='|'; printf '%s' "${PATTERNS[*]}")"
if printf '%s\n' "$MESSAGE" | grep -qiE -- "$RE"; then die "commit message matches a deny pattern"; fi

# ── build: one parentless commit with the source tree ──
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NEW="$(GIT_AUTHOR_NAME="$PUBLIC_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$PUBLIC_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$NOW" \
       GIT_COMMITTER_NAME="$PUBLIC_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$PUBLIC_AUTHOR_EMAIL" GIT_COMMITTER_DATE="$NOW" \
       git commit-tree "$TREE" -m "$MESSAGE")"
git update-ref "refs/heads/$BRANCH" "$NEW"
say "built $BRANCH = $NEW (tree $TREE from $SOURCE @ ${SRC_COMMIT:0:12})"

rollback() { git update-ref -d "refs/heads/$BRANCH" "$NEW" || true; die "$1 — branch $BRANCH removed"; }

# ── self-check ──
COUNT="$(git rev-list --count "$BRANCH")"
[ "$COUNT" = 1 ] || rollback "expected 1 reachable commit, got $COUNT"
PARENTS="$(git rev-list --parents -n 1 "$BRANCH" | wc -w | tr -d ' ')"
[ "$PARENTS" = 1 ] || rollback "the commit has parents"
if git merge-base "$BRANCH" "$SRC_COMMIT" >/dev/null 2>&1; then rollback "shares history with $SOURCE"; fi
say "check 1 ok: 1 commit, no parents, no shared history with $SOURCE"

EMAILS="$(git log --format='%ae%n%ce' "$BRANCH" | sort -u)"
if printf '%s\n' "$EMAILS" | grep -qv '@users\.noreply\.github\.com$'; then rollback "non-noreply email in history: $EMAILS"; fi
say "check 2 ok: author/committer = $EMAILS"

META_HITS="$(git log --format='%B' "$BRANCH" | grep -ciE -- "$RE" || true)"
PATH_HITS="$(git ls-tree -r --name-only "$BRANCH" | grep -ciE -- "$RE" || true)"
BLOB_HITS="$(git grep -I -c -iE -e "$RE" "$BRANCH" -- . | wc -l | tr -d ' ' || true)"
BIN_HITS=0
while IFS=$'\t' read -r meta path; do
  read -r _mode type sha <<< "$meta"
  [ "$type" = blob ] || continue
  if git cat-file blob "$sha" | LC_ALL=C grep -aqiE -- "$RE"; then BIN_HITS=$((BIN_HITS + 1)); echo "  hit: $path" >&2; fi
done < <(git ls-tree -r "$BRANCH")
OBJECTS="$(git rev-list --objects "$BRANCH" | wc -l | tr -d ' ')"
say "check 3: reachable objects=$OBJECTS · message hits=$META_HITS · path hits=$PATH_HITS · text-file hits=$BLOB_HITS · any-blob hits=$BIN_HITS"
if [ "$META_HITS" != 0 ] || [ "$PATH_HITS" != 0 ] || [ "$BLOB_HITS" != 0 ] || [ "$BIN_HITS" != 0 ]; then
  git grep -I -n -iE -e "$RE" "$BRANCH" -- . | head -20 >&2 || true
  rollback "deny patterns found"
fi
say "OK: local branch $BRANCH is clean (not pushed). Review with: git log --stat $BRANCH"
