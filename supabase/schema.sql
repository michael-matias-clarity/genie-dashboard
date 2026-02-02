-- The Lamp - Supabase Schema
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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_name);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at DESC);

-- Enable RLS
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- Policies (allow all for now - can tighten later)
CREATE POLICY "tasks_all" ON tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "comments_all" ON comments FOR ALL USING (true) WITH CHECK (true);

-- Add service column to audit table if not exists
ALTER TABLE lamp_audit ADD COLUMN IF NOT EXISTS service TEXT;
