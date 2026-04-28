#!/usr/bin/env bash
set -euo pipefail

# Dev server startup script for skill-swarm backend
# Usage: ./scripts/dev.sh [--watch|-w] [--port PORT] [--no-health-check]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$LOG_DIR/dev-server.pid"
LOG_FILE="$LOG_DIR/dev-server.log"

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
WATCH=false
HEALTH_CHECK=true
HEALTH_TIMEOUT=15

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch|-w)
      WATCH=true
      shift
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --no-health-check)
      HEALTH_CHECK=false
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--watch|-w] [--port PORT] [--no-health-check]"
      echo ""
      echo "Options:"
      echo "  -w, --watch           Use tsx watch mode (auto-reload on file changes)"
      echo "  --port PORT           Override port (default: 8000, env: PORT)"
      echo "  --no-health-check     Skip health check after startup"
      echo ""
      echo "Env vars required: DEEPSEEK_API_KEY, GEMINI_API_KEY"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run '$0 --help' for usage"
      exit 1
      ;;
  esac
done

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERR]${NC}  $1"; }

# Check env vars
check_env() {
  local missing=()
  if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    missing+=("DEEPSEEK_API_KEY")
  fi
  if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    missing+=("GEMINI_API_KEY")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    log_err "Missing required environment variables:"
    for var in "${missing[@]}"; do
      echo "       - $var"
    done
    echo ""
    log_info "Load from .env file if available:"
    local env_file="$PROJECT_DIR/.env"
    if [[ ! -f "$env_file" ]]; then
      env_file="$(dirname "$PROJECT_DIR")/.env"
    fi
    if [[ -f "$env_file" ]]; then
      set -a
      source "$env_file"
      set +a
      log_ok ".env loaded from $env_file"
      # Re-check
      missing=()
      if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then missing+=("DEEPSEEK_API_KEY"); fi
      if [[ -z "${GEMINI_API_KEY:-}" ]]; then missing+=("GEMINI_API_KEY"); fi
      if [[ ${#missing[@]} -gt 0 ]]; then
        log_err "Still missing after loading .env: ${missing[*]}"
        exit 1
      fi
    else
      log_err "No .env file found at $PROJECT_DIR/.env or $(dirname "$PROJECT_DIR")/.env"
      exit 1
    fi
  fi
  log_ok "Environment variables OK"
}

# Stop old dev server
stop_old() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      log_warn "Stopping old dev server (PID: $old_pid)"
      kill "$old_pid" 2>/dev/null || true
      local waited=0
      while kill -0 "$old_pid" 2>/dev/null && [[ $waited -lt 5 ]]; do
        sleep 1
        ((waited++))
      done
      if kill -0 "$old_pid" 2>/dev/null; then
        log_warn "Force killing old dev server"
        kill -9 "$old_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # Fallback: find by exact command pattern (avoid pkill matching our own shell)
  local pids
  pids=$(pgrep -f "tsx( watch)? src/index\.ts" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      if [[ "$pid" != "$$" ]]; then
        log_warn "Killing stray tsx process: $pid"
        kill "$pid" 2>/dev/null || true
      fi
    done
  fi
}

# Start dev server
start_server() {
  cd "$PROJECT_DIR"
  export PORT="$PORT"
  export HOST="$HOST"

  # Rotate old log
  if [[ -f "$LOG_FILE" ]]; then
    mv "$LOG_FILE" "${LOG_FILE}.old"
  fi

  local cmd
  if [[ "$WATCH" == true ]]; then
    cmd="npx tsx watch src/index.ts"
    log_info "Starting dev server in WATCH mode (port $PORT)..."
  else
    cmd="npx tsx src/index.ts"
    log_info "Starting dev server (port $PORT)..."
  fi

  # Start in background, write PID
  nohup bash -c "$cmd" > "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  log_info "Server PID: $new_pid, log: $LOG_FILE"
}

# Health check
health_check() {
  local url="http://localhost:$PORT/health"
  local waited=0
  log_info "Waiting for server at $url ..."

  while [[ $waited -lt $HEALTH_TIMEOUT ]]; do
    local resp
    resp=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    if [[ "$resp" == "200" ]]; then
      local body
      body=$(curl -s "$url" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "{}")
      log_ok "Server is healthy!"
      echo ""
      echo "$body"
      echo ""
      log_info "Server running at http://$HOST:$PORT"
      log_info "Logs: tail -f $LOG_FILE"
      return 0
    fi
    sleep 1
    ((waited++))
  done

  log_err "Health check failed after ${HEALTH_TIMEOUT}s"
  log_err "Check logs: tail -n 50 $LOG_FILE"
  return 1
}

# Main
main() {
  echo "======================================"
  echo "  Skill Swarm - Dev Server"
  echo "======================================"
  echo ""

  check_env
  stop_old
  start_server

  if [[ "$HEALTH_CHECK" == true ]]; then
    if health_check; then
      log_ok "Dev server ready!"
      echo ""
      echo "Quick commands:"
      echo "  Logs:     tail -f $LOG_FILE"
      echo "  Health:   curl http://localhost:$PORT/health"
      echo "  Stop:     kill \$(cat $PID_FILE)"
      exit 0
    else
      exit 1
    fi
  else
    log_ok "Dev server started (health check skipped)"
  fi
}

main "$@"
