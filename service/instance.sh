# Runs before either macOS entry point touches the supervisor or state.
BACKEND=${QQ_AGENT_BACKEND:-claude}
case "$BACKEND" in
  claude)
    STATE_DIR=${QQ_STATE_DIR:-$HOME/.claude/channels/qq}
    ;;
  codex)
    STATE_DIR=${QQ_STATE_DIR:?Codex requires a separate QQ_STATE_DIR}
    if [ -d "$STATE_DIR" ] && [ -d "$HOME/.claude/channels/qq" ] &&
       [ "$(cd "$STATE_DIR" && pwd -P)" = "$(cd "$HOME/.claude/channels/qq" && pwd -P)" ]; then
      echo 'Codex requires a separate QQ_STATE_DIR' >&2
      exit 1
    fi
    ;;
  *)
    echo 'QQ_AGENT_BACKEND must be claude or codex' >&2
    exit 1
    ;;
esac

bridge_processes() {
  # Older Claude processes have no backend argument.
  ps -axo pid=,args= | awk -v backend="$BACKEND" '
    $2 ~ /(^|\/)bun$/ && $0 ~ /src\/index\.ts([[:space:]]|$)/ {
      if (index($0, "--qq-agent-backend=" backend) ||
          (backend == "claude" && !index($0, "--qq-agent-backend="))) print
    }
  '
}
