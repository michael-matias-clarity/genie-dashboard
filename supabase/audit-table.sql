-- Lamp Audit Log Table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/dokdvzlvtqqehadqvshn/sql/new

CREATE TABLE IF NOT EXISTS lamp_audit (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,  -- 'add', 'move', 'delete', 'comment'
  task_id TEXT NOT NULL,
  task_title TEXT,
  from_column TEXT,
  to_column TEXT,
  author TEXT,  -- 'michael', 'genie', 'unknown'
  metadata JSONB,  -- extra data like comment text
  session_id TEXT  -- for grouping related events
);

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_lamp_audit_created_at ON lamp_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lamp_audit_task_id ON lamp_audit(task_id);
CREATE INDEX IF NOT EXISTS idx_lamp_audit_event_type ON lamp_audit(event_type);

-- Enable Row Level Security but allow all inserts (audit log is append-only)
ALTER TABLE lamp_audit ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can INSERT (for logging from server)
CREATE POLICY "Allow insert for all" ON lamp_audit FOR INSERT WITH CHECK (true);

-- Policy: Anyone can SELECT (for viewing audit log)
CREATE POLICY "Allow select for all" ON lamp_audit FOR SELECT USING (true);

-- No UPDATE or DELETE policies = immutable audit log!
