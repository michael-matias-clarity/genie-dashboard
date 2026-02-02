-- The Lamp - Migration v4: Add archived, needs_mobile, and celebration_image columns
-- Run this in SQL Editor: https://supabase.com/dashboard/project/yjvecmrsfivmgfnikxsc/sql/new

-- Add new columns to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS needs_mobile BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS celebration_image TEXT;

-- Add performance indexes
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);

-- Verify columns exist
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'tasks' 
ORDER BY ordinal_position;
