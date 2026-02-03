#!/bin/bash
# Task Dashboard Sync Script
# ⚠️ WARNING: Commands in this script can overwrite data
# The primary source of truth is SUPABASE (accessed via Render API)
# Local files and Gist backups are SECONDARY and may be stale

RENDER_URL="https://genie-dashboard.onrender.com/api/tasks"
LOCAL_FILE="$HOME/clawd/dashboard/tasks.json"
BACKUP_DIR="$HOME/clawd/dashboard/backups"
GIST_ID="efa1580eefda602e38d5517799c7e84e"
HISTORY_URL="https://genie-dashboard.onrender.com/api/history"
HISTORY_FILE="$HOME/clawd/dashboard/history.json"

mkdir -p "$BACKUP_DIR"

case "$1" in
  pull)
    curl -s "$RENDER_URL" > "$LOCAL_FILE"
    echo "✓ Pulled $(jq '.tasks | length' "$LOCAL_FILE") tasks from Render"
    ;;
  pull-history)
    curl -s "$HISTORY_URL" > "$HISTORY_FILE"
    echo "✓ Pulled $(jq 'length' "$HISTORY_FILE") history entries from Render"
    ;;
  push)
    # ⚠️ DANGEROUS: This was disabled to prevent data corruption
    # The bulk save endpoint is now disabled on the server
    echo "⚠️ PUSH IS DISABLED - Use the web UI for task operations"
    echo "The bulk save API is disabled to prevent accidental data overwrites."
    echo "If you really need to push data, use individual task operations in the UI."
    exit 1
    ;;
  backup)
    BACKUP_FILE="$BACKUP_DIR/tasks-$(date +%Y%m%d-%H%M%S).json"
    cp "$LOCAL_FILE" "$BACKUP_FILE"
    echo "✓ Local backup: $BACKUP_FILE"
    # Also backup history
    curl -s "$HISTORY_URL" > "$BACKUP_DIR/history-$(date +%Y%m%d-%H%M%S).json"
    echo "✓ History backup"
    ;;
  cloud)
    # Backup tasks and history to GitHub Gist
    gh gist edit "$GIST_ID" "$LOCAL_FILE" 2>/dev/null && echo "✓ Tasks backed up to Gist" || echo "✗ Tasks Gist backup failed"
    # Backup history to Gist (create history.json in Gist if needed)
    curl -s "$HISTORY_URL" > "$HISTORY_FILE"
    gh gist edit "$GIST_ID" -a "$HISTORY_FILE" 2>/dev/null && echo "✓ History backed up to Gist" || echo "✗ History Gist backup failed"
    ;;
  restore-cloud)
    # ⚠️ DANGEROUS: This could restore old/stale data
    echo "⚠️ RESTORE-CLOUD IS DISABLED FOR SAFETY"
    echo ""
    echo "This command would restore from Gist backup, which may contain STALE data"
    echo "and could overwrite your current tasks (causing 'granted' tasks to revert to inbox)."
    echo ""
    echo "The primary data source is Supabase (via Render API)."
    echo "Gist is only for disaster recovery backups."
    echo ""
    echo "If you REALLY need to restore from Gist (disaster recovery only):"
    echo "  1. First backup current state: sync.sh backup"
    echo "  2. Run: curl -sL 'https://gist.githubusercontent.com/michael-matias-clarity/$GIST_ID/raw/tasks.json' > \$LOCAL_FILE"
    echo "  3. Review the data carefully before any manual import"
    exit 1
    ;;
  full-backup)
    # Full backup: local + cloud (push removed for safety)
    $0 backup
    $0 cloud
    echo "✓ Full backup complete (push disabled for safety)"
    ;;
  status)
    # Show current data status
    echo "=== Data Source Status ==="
    echo ""
    echo "Render (Supabase - PRIMARY):"
    RENDER_COUNT=$(curl -s "$RENDER_URL" | jq '.tasks | length' 2>/dev/null || echo "ERROR")
    echo "  Tasks: $RENDER_COUNT"
    echo ""
    echo "Local file ($LOCAL_FILE):"
    if [ -f "$LOCAL_FILE" ]; then
      LOCAL_COUNT=$(jq '.tasks | length' "$LOCAL_FILE" 2>/dev/null || echo "ERROR")
      LOCAL_DATE=$(stat -f "%Sm" "$LOCAL_FILE" 2>/dev/null || stat -c "%y" "$LOCAL_FILE" 2>/dev/null)
      echo "  Tasks: $LOCAL_COUNT"
      echo "  Modified: $LOCAL_DATE"
    else
      echo "  NOT FOUND"
    fi
    echo ""
    echo "Gist backup (SECONDARY):"
    echo "  Gist ID: $GIST_ID"
    echo "  Use 'gh gist view $GIST_ID --files' to check"
    ;;
  *)
    echo "Usage: sync.sh [pull|backup|cloud|full-backup|status]"
    echo ""
    echo "Safe commands:"
    echo "  pull         - Download current tasks from Render to local file"
    echo "  pull-history - Download history from Render"
    echo "  backup       - Create local backup of current files"
    echo "  cloud        - Backup current local files to GitHub Gist"
    echo "  full-backup  - Run backup + cloud"
    echo "  status       - Show task counts from all sources"
    echo ""
    echo "Disabled commands (for safety):"
    echo "  push         - DISABLED: Use web UI for task changes"
    echo "  restore-cloud - DISABLED: Could restore stale data"
    ;;
esac
