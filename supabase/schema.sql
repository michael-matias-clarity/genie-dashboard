-- The Lamp - Supabase Schema v3
-- Run this in SQL Editor: https://supabase.com/dashboard/project/yjvecmrsfivmgfnikxsc/sql/new

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  success_criteria TEXT,
  user_journey TEXT,
  column_name TEXT NOT NULL DEFAULT 'inbox',
  priority TEXT DEFAULT 'medium',
  task_type TEXT DEFAULT 'single',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  seen_at BIGINT,
  needs_laptop BOOLEAN DEFAULT FALSE,
  needs_mobile BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  celebration_image TEXT,
  metadata JSONB
);

-- Comments table (separate from tasks for data integrity)
CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Genie Status table (replaces Redis TTL keys for console feature)
CREATE TABLE IF NOT EXISTS genie_status (
  session_key TEXT PRIMARY KEY,
  label TEXT,
  active BOOLEAN DEFAULT FALSE,
  current_task TEXT,
  model TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_name);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_genie_status_updated ON genie_status(updated_at DESC);

-- Enable RLS
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_status ENABLE ROW LEVEL SECURITY;

-- Drop old permissive policies (run these manually if they exist)
-- DROP POLICY IF EXISTS "tasks_all" ON tasks;
-- DROP POLICY IF EXISTS "comments_all" ON comments;

-- Anon key: read-only access for frontend
CREATE POLICY "tasks_select_anon" ON tasks FOR SELECT USING (true);
CREATE POLICY "comments_select_anon" ON comments FOR SELECT USING (true);
CREATE POLICY "genie_status_select_anon" ON genie_status FOR SELECT USING (true);

-- Service key: full access for server-side operations
CREATE POLICY "tasks_all_service" ON tasks FOR ALL 
  USING (auth.role() = 'service_role') 
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "comments_all_service" ON comments FOR ALL 
  USING (auth.role() = 'service_role') 
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "genie_status_all_service" ON genie_status FOR ALL 
  USING (auth.role() = 'service_role') 
  WITH CHECK (auth.role() = 'service_role');

-- Enable Realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE comments;
ALTER PUBLICATION supabase_realtime ADD TABLE genie_status;

-- Add service column to audit table if not exists
ALTER TABLE lamp_audit ADD COLUMN IF NOT EXISTS service TEXT;
