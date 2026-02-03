-- The Lamp - Migration v5: Add Projects feature
-- Run this in SQL Editor: https://supabase.com/dashboard/project/yjvecmrsfivmgfnikxsc/sql/new

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'planning',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project comments table (planning discussions)
CREATE TABLE IF NOT EXISTS project_comments (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add project_id to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_comments_project ON project_comments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_comments_created ON project_comments(created_at DESC);

-- Enable RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_comments ENABLE ROW LEVEL SECURITY;

-- Anon key: read-only access
CREATE POLICY "projects_select_anon" ON projects FOR SELECT USING (true);
CREATE POLICY "project_comments_select_anon" ON project_comments FOR SELECT USING (true);

-- Service key: full access
CREATE POLICY "projects_all_service" ON projects FOR ALL 
  USING (auth.role() = 'service_role') 
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "project_comments_all_service" ON project_comments FOR ALL 
  USING (auth.role() = 'service_role') 
  WITH CHECK (auth.role() = 'service_role');

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE projects;
ALTER PUBLICATION supabase_realtime ADD TABLE project_comments;

-- Verify
SELECT table_name FROM information_schema.tables WHERE table_name IN ('projects', 'project_comments');
SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'project_id';
