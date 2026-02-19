#!/bin/bash
# Deploy Edge Functions to Supabase Cloud
#
# IMPORTANT: Functions triggered by pg_cron via net.http_post() require --no-verify-jwt
# because the database doesn't have a browser session JWT. Authentication is handled
# via x-cron-secret header instead.
#
# Usage:
#   ./scripts/deploy-functions.sh              # Deploy all functions
#   ./scripts/deploy-functions.sh slack-channel-sync  # Deploy specific function
#   ./scripts/deploy-functions.sh --list       # List available functions

set -e

PROJECT_REF="your-supabase-project-id"
FUNCTIONS_DIR="supabase/functions"

# Functions that require --no-verify-jwt (called by pg_cron)
# These use x-cron-secret header for authentication instead of JWT
CRON_TRIGGERED_FUNCTIONS=(
  "slack-channel-sync"
  "hubspot-tickets-sync"
  "notion-pages-sync"
  "team-roadmap-sync"
  "meeting-notes-sync"
  "ampeco-changelog-monitor"
  "slack-messages-embed"
  "hubspot-ticket-contacted-backfill"
)

# Functions that should verify JWT (called by authenticated clients)
JWT_REQUIRED_FUNCTIONS=(
  "mcp-readonly"
)

function is_cron_triggered() {
  local func_name="$1"
  for f in "${CRON_TRIGGERED_FUNCTIONS[@]}"; do
    if [[ "$f" == "$func_name" ]]; then
      return 0
    fi
  done
  return 1
}

function deploy_function() {
  local func_name="$1"
  local func_path="$FUNCTIONS_DIR/$func_name"

  if [[ ! -d "$func_path" ]]; then
    echo "Error: Function directory not found: $func_path"
    return 1
  fi

  if is_cron_triggered "$func_name"; then
    echo "Deploying $func_name (cron-triggered, --no-verify-jwt)..."
    supabase functions deploy "$func_name" --project-ref "$PROJECT_REF" --no-verify-jwt
  else
    echo "Deploying $func_name (JWT verification enabled)..."
    supabase functions deploy "$func_name" --project-ref "$PROJECT_REF"
  fi
}

function list_functions() {
  echo "Available Edge Functions:"
  echo ""
  echo "Cron-triggered (--no-verify-jwt):"
  for f in "${CRON_TRIGGERED_FUNCTIONS[@]}"; do
    if [[ -d "$FUNCTIONS_DIR/$f" ]]; then
      echo "  - $f"
    fi
  done
  echo ""
  echo "JWT-required:"
  for f in "${JWT_REQUIRED_FUNCTIONS[@]}"; do
    if [[ -d "$FUNCTIONS_DIR/$f" ]]; then
      echo "  - $f"
    fi
  done
}

function deploy_all() {
  echo "Deploying all Edge Functions to project $PROJECT_REF..."
  echo ""

  for func_dir in "$FUNCTIONS_DIR"/*/; do
    if [[ -f "${func_dir}index.ts" ]]; then
      func_name=$(basename "$func_dir")
      deploy_function "$func_name"
      echo ""
    fi
  done

  echo "All functions deployed successfully!"
}

# Main
cd "$(dirname "$0")/.."

case "${1:-}" in
  --list|-l)
    list_functions
    ;;
  --help|-h)
    echo "Usage: $0 [function-name|--list|--all]"
    echo ""
    echo "Options:"
    echo "  (no args)     Deploy all functions"
    echo "  function-name Deploy specific function"
    echo "  --list, -l    List available functions"
    echo "  --all, -a     Deploy all functions (same as no args)"
    echo "  --help, -h    Show this help"
    ;;
  --all|-a|"")
    deploy_all
    ;;
  *)
    deploy_function "$1"
    ;;
esac
