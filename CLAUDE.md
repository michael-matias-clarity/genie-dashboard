# CLAUDE.md - The Lamp

## Project Overview

The Lamp is a Kanban dashboard for AI task management — "mission control for your AI assistant." It tracks tasks across a 6-column board (genie, inbox, in_progress, blocked, review, done) with real-time updates, project grouping, and an immutable audit log. The primary user is Michael, collaborating with an AI assistant named "Genie."

## Tech Stack

- **Runtime**: Node.js >= 18 (vanilla JavaScript, no TypeScript)
- **Server**: Raw `http` module (no Express or framework)
- **Database**: Supabase (PostgreSQL) with Row-Level Security
- **Frontend**: Single `index.html` file with embedded CSS/JS (no build step, no framework)
- **Real-time**: Server-Sent Events (SSE), not WebSocket
- **Deployment**: Render.com (free tier), configured via `render.yaml`
- **Dependencies**: Only 2 — `@supabase/supabase-js` and `dotenv`

## File Structure

```
server.js              # Main server (all API endpoints, ~1700 lines)
index.html             # Frontend UI (embedded CSS + JS, ~3850 lines)
package.json           # Minimal deps, npm scripts
manifest.json          # PWA manifest
render.yaml            # Render.com deployment config
deploy.sh              # Deployment script with integration tests
sync.sh                # Data sync/backup utility
find-unread.js         # CLI tool for finding unread comments
supabase/
  schema.sql           # Full database schema (v3)
  migrate.js           # Redis -> Supabase migration
  migration-v4.sql     # Added archived, needs_mobile, celebration_image
  migration-v5-projects.sql  # Projects feature
  migration-v6-comment-images.sql  # Image URLs in comments
  audit-table.sql      # Immutable audit log table
```

## Quick Start

```bash
# Local development (no database needed)
npm install
npm run start:local    # Runs with LOCAL_MODE=true, mock data on port 3456

# With Supabase
cp .env.example .env   # Add your Supabase keys
npm start              # Connects to Supabase, port 3456
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes (prod) | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes (prod) | Supabase anon key (frontend reads) |
| `SUPABASE_SERVICE_KEY` | Yes (prod) | Supabase service role key (server writes) |
| `API_TOKEN` | Optional | Bearer token for write operation auth |
| `GITHUB_TOKEN` | Optional | GitHub token for Gist backups |
| `GIST_ID` | Optional | GitHub Gist ID for backups |
| `SERVICE_NAME` | Optional | Identifies environment: `local`, `staging`, `render-production` |
| `LOCAL_MODE` | Optional | Set `true` to use mock data without Supabase |
| `PORT` | Optional | Server port (default: 3456) |

## Key Architecture Decisions

- **Action-based API**: All mutations use POST with an `action` field (`add`, `update`, `delete`, `comment`) rather than REST verbs. Do not introduce bulk save endpoints — they are intentionally disabled to prevent data corruption.
- **Service-role pattern**: The anon key gives read-only access; the service role key is used server-side for all writes. RLS enforces this at the database level.
- **In-memory cache**: Tasks are cached for 10 seconds to reduce DB load. Cache is invalidated on writes.
- **Local mock mode**: When `LOCAL_MODE=true` or no Supabase key is set, the server uses in-memory mock data. All features work offline.
- **Single-file frontend**: `index.html` contains all HTML, CSS, and JS. There is no build pipeline, bundler, or component framework.
- **Immutable audit log**: Every task change (add, move, delete, comment) is logged to `lamp_audit`. Never delete or modify audit records.

## API Endpoints

### GET
- `/api/health` — Server status, cache state, connected clients
- `/api/tasks` — All tasks with comments
- `/api/history?author=<name>` — Audit log (filterable by author)
- `/api/console` — Genie status (active sessions, current task)
- `/api/projects` — All projects with task summaries
- `/api/projects/:id` — Single project detail
- `/api/events` — SSE stream for real-time updates

### POST (require auth if `API_TOKEN` is set)
- `/api/tasks` — Task operations: `{ action: "add"|"update"|"delete"|"comment", ... }`
- `/api/projects` — Project operations: `{ action: "add"|"update"|"delete"|"comment", ... }`
- `/api/console` — Update Genie status
- `/api/backup` — Trigger GitHub Gist backup
- `/api/upload-image` — Upload image to Supabase Storage
- `/api/generate-image` — Generate celebration image (OpenAI DALL-E)
- `/api/transcribe` — Transcribe audio (OpenAI Whisper)

## Database Schema

Six tables in Supabase PostgreSQL:

- **tasks** — Main task table (id, title, description, success_criteria, user_journey, column_name, priority, task_type, project_id, metadata JSONB, etc.)
- **comments** — Task comments with optional image_url; FK to tasks with CASCADE delete
- **projects** — Project grouping (id, title, description, status)
- **project_comments** — Project planning discussions; FK to projects with CASCADE delete
- **genie_status** — AI assistant session tracking (replaces Redis)
- **lamp_audit** — Immutable event log (event_type, task_id, from_column, to_column, author, etc.)

### Kanban Columns
```
genie | inbox | in_progress | blocked | review | done
```

### Task Properties
- **priority**: `low`, `medium`, `high`
- **type**: `single`, `recurring`
- **column**: One of the 6 kanban columns above

## Development Conventions

### Code Style
- Vanilla JavaScript (CommonJS `require`), no TypeScript
- No linter or formatter configured — follow existing style
- Use `camelCase` for JS variables/functions, `snake_case` for database columns
- The server maps between these conventions when reading/writing to Supabase

### Security
- All IDs are validated with `sanitizeId()` — alphanumeric, underscore, hyphen only, max 50 chars
- Tasks and comments are validated before writes (`validateTask`, `validateComment`)
- CORS whitelist: localhost, the-lamp.onrender.com, lamp.michaelmatias.com
- Never commit `.env` files or secrets

### When Modifying the Server
- All API routes are handled in `handleApiRequest()` (~line 1157 in server.js)
- Cache invalidation happens via `cache.invalidate()` — call it after any write
- Broadcast changes to SSE clients via `broadcast(event, data)` after mutations
- Log audit events via `addAuditLog()` for task changes
- Support `LOCAL_MODE` — any new feature should have a mock fallback

### When Modifying the Frontend
- Everything is in `index.html` — HTML structure, `<style>` block, `<script>` block
- No framework; DOM manipulation is done directly
- Dark theme with glassmorphism design; maintain visual consistency
- Mobile-responsive with safe-area awareness for PWA

### Database Migrations
- Schema changes go in `supabase/migration-vN-*.sql` files
- Increment version number for each new migration
- Always add `IF NOT EXISTS` / `IF EXISTS` guards
- Maintain backward compatibility — the server should handle both old and new schemas

## Deployment

```bash
./deploy.sh staging      # Push to staging branch, run tests
./deploy.sh production   # Push to main, run tests, verify data integrity
```

The deploy script: (1) checks syntax, (2) commits and pushes, (3) waits for Render deploy, (4) runs integration tests. Production deploys also verify task count >= 50 as a data integrity check.

## Testing

There is no automated test suite or test framework. Verification is done through:
- `node --check server.js` — syntax validation
- `deploy.sh` runs integration tests via `test-supabase.js` post-deploy
- `LOCAL_MODE=true` enables offline development with mock data
- `/api/health` endpoint for monitoring

## Backup Strategy

- **Primary**: Supabase (persistent PostgreSQL)
- **Secondary**: GitHub Gist auto-backup every 6 hours (if `GITHUB_TOKEN` set)
- **Manual**: `sync.sh` utility for pull/backup operations
- Bulk restore is intentionally disabled as a safety measure
