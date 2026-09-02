#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="heygen-avatar-oauth"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_AGENT="${1:-}"
FORCE="${2:-}"

show_help() {
  cat <<'HELP'
Установка heygen-avatar-oauth

Использование:
  bash scripts/install.sh codex
  bash scripts/install.sh claude
  bash scripts/install.sh both

Для обновления уже установленной копии добавьте --force вторым аргументом.
HELP
}

install_for() {
  local agent="$1"
  local skills_dir

  case "$agent" in
    codex) skills_dir="$HOME/.agents/skills" ;;
    claude) skills_dir="$HOME/.claude/skills" ;;
    *)
      echo "Неизвестная среда: $agent" >&2
      exit 2
      ;;
  esac

  local destination="$skills_dir/$SKILL_NAME"
  if [[ -e "$destination" && "$FORCE" != "--force" ]]; then
    echo "Скилл уже установлен: $destination" >&2
    echo "Для обновления повторите команду с --force." >&2
    exit 3
  fi

  mkdir -p "$destination/scripts"
  install -m 0644 "$SOURCE_DIR/SKILL.md" "$destination/SKILL.md"
  install -m 0755 "$SOURCE_DIR/scripts/heygen-client.mjs" \
    "$destination/scripts/heygen-client.mjs"

  echo "Установлено для $agent: $destination"
}

case "$TARGET_AGENT" in
  codex|claude) install_for "$TARGET_AGENT" ;;
  both)
    install_for codex
    install_for claude
    ;;
  -h|--help|"") show_help ;;
  *)
    show_help >&2
    exit 2
    ;;
esac
