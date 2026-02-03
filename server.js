require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;

// Local mock mode - no real database
const LOCAL_MODE = process.env.LOCAL_MODE === 'true' || (!process.env.SUPABASE_ANON_KEY && process.env.SERVICE_NAME !== 'production' && process.env.SERVICE_NAME !== 'staging');

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERVICE_NAME = process.env.SERVICE_NAME || 'local';
const GIST_ID = process.env.GIST_ID || 'efa1580eefda602e38d5517799c7e84e';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let supabase = null;
let supabaseAdmin = null;

if (LOCAL_MODE) {
  console.log('🧪 Running in LOCAL MOCK MODE - no database connection');
} else {
  if (!SUPABASE_ANON_KEY) {
    console.error('❌ FATAL: SUPABASE_ANON_KEY environment variable is required');
    console.error('   Set it in your environment or .env file');
    console.error('   Or set LOCAL_MODE=true for mock data');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  supabaseAdmin = SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : supabase;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// API Authentication
const API_TOKEN = process.env.API_TOKEN; // Optional: set for production security

// CORS Configuration
const ALLOWED_ORIGINS = [
  'http://localhost:3456',
  'http://127.0.0.1:3456',
  'https://the-lamp.onrender.com',
  'https://lamp.michaelmatias.com'
];

// Rate Limiting (simple in-memory, per IP)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMITS = {
  'generate-image': { max: 5, window: RATE_LIMIT_WINDOW },
  'transcribe': { max: 20, window: RATE_LIMIT_WINDOW },
  'default': { max: 100, window: RATE_LIMIT_WINDOW }
};

function checkRateLimit(ip, endpoint) {
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const limit = RATE_LIMITS[endpoint] || RATE_LIMITS.default;
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, { count: 1, resetAt: now + limit.window });
    return { allowed: true, remaining: limit.max - 1 };
  }
  
  const entry = rateLimits.get(key);
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + limit.window;
    return { allowed: true, remaining: limit.max - 1 };
  }
  
  if (entry.count >= limit.max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  
  entry.count++;
  return { allowed: true, remaining: limit.max - entry.count };
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, 5 * 60 * 1000);

const COLUMNS = ['genie', 'inbox', 'in_progress', 'blocked', 'review', 'done'];

// ============ IN-MEMORY CACHE ============
const cache = {
  tasks: null,
  tasksExpiry: 0,
  TTL: 10000, // 10 seconds cache
  
  invalidate() {
    this.tasks = null;
    this.tasksExpiry = 0;
    console.log('[cache] Invalidated');
  },
  
  isValid() {
    return this.tasks && Date.now() < this.tasksExpiry;
  },
  
  set(data) {
    this.tasks = data;
    this.tasksExpiry = Date.now() + this.TTL;
  }
};

// ============ LOCAL MOCK DATA (from server-local.js) ============
const mockData = {
  tasks: [
    {
      id: 'task-1',
      title: 'Fix login page responsive design',
      description: 'The login page breaks on mobile devices under 380px width',
      successCriteria: 'Login form works on all screen sizes down to 320px',
      userJourney: 'User opens app on phone → sees broken layout → frustration',
      column: 'done',
      priority: 'high',
      type: 'single',
      created: '2026-01-28',
      needsLaptop: false,
      comments: [
        { author: 'genie', text: 'Fixed flexbox layout and added media queries', time: '2026-01-29T10:30:00Z' },
        { author: 'michael', text: 'Looks great! Approved.', time: '2026-01-29T14:00:00Z' }
      ]
    },
    {
      id: 'task-2',
      title: 'Implement dark mode toggle',
      description: 'Add a toggle in settings to switch between light and dark themes',
      successCriteria: 'Toggle persists across sessions, smooth transition animation',
      userJourney: 'User clicks settings → toggles dark mode → theme changes instantly',
      column: 'review',
      priority: 'medium',
      type: 'single',
      created: '2026-01-30',
      needsLaptop: false,
      comments: [
        { author: 'genie', text: 'Implemented using CSS variables. Ready for review.', time: '2026-02-01T16:00:00Z' }
      ]
    },
    {
      id: 'task-3',
      title: 'Add keyboard shortcuts documentation',
      description: 'Create a help modal showing all available keyboard shortcuts',
      successCriteria: 'Press ? to show modal with all shortcuts listed',
      userJourney: 'Power user wants to know shortcuts → presses ? → sees comprehensive list',
      column: 'in_progress',
      priority: 'low',
      type: 'single',
      created: '2026-02-01',
      needsLaptop: false,
      comments: [
        { author: 'genie', text: 'Working on the modal design now', time: '2026-02-02T09:00:00Z' }
      ]
    },
    {
      id: 'task-4',
      title: 'Optimize image loading performance',
      description: 'Images are loading slowly on the dashboard. Implement lazy loading and compression.',
      successCriteria: 'LCP under 2.5s, images lazy load below the fold',
      userJourney: 'User loads dashboard → sees fast initial render → images load as they scroll',
      column: 'in_progress',
      priority: 'high',
      type: 'single',
      created: '2026-02-01',
      needsLaptop: true,
      comments: []
    },
    {
      id: 'task-5',
      title: 'Weekly database backup verification',
      description: 'Check that automated backups are running and restorable',
      successCriteria: 'Backup exists, test restore succeeds',
      userJourney: 'Ops runs weekly → verifies backup integrity → peace of mind',
      column: 'inbox',
      priority: 'medium',
      type: 'recurring',
      created: '2026-02-02',
      needsLaptop: false,
      comments: []
    },
    {
      id: 'task-6',
      title: 'Research OAuth2 providers for SSO',
      description: 'Evaluate Google, GitHub, and Microsoft for single sign-on integration',
      successCriteria: 'Comparison doc with pros/cons and recommendation',
      userJourney: 'Team reviews options → picks best fit → implements SSO',
      column: 'genie',
      priority: 'medium',
      type: 'single',
      created: '2026-02-02',
      needsLaptop: false,
      comments: [
        { author: 'michael', text: 'Please focus on ease of implementation and cost', time: '2026-02-02T08:00:00Z' }
      ]
    },
    {
      id: 'task-7',
      title: 'Fix memory leak in websocket handler',
      description: 'WebSocket connections are not being cleaned up properly on disconnect',
      successCriteria: 'Memory usage stable after 1000+ connection cycles',
      userJourney: 'Server runs for days → memory stays constant → no crashes',
      column: 'blocked',
      priority: 'high',
      type: 'single',
      created: '2026-02-02',
      needsLaptop: true,
      comments: []
    },
    {
      id: 'task-8',
      title: 'Update dependencies to latest versions',
      description: 'Run npm audit and update all packages with security vulnerabilities',
      successCriteria: 'npm audit shows 0 vulnerabilities, all tests pass',
      userJourney: 'Dev runs update → fixes vulnerabilities → CI passes',
      column: 'inbox',
      priority: 'medium',
      type: 'single',
      created: '2026-02-02',
      needsLaptop: false,
      comments: []
    }
  ],
  history: [
    { type: 'add', taskId: 'task-1', taskTitle: 'Fix login page responsive design', author: 'michael', time: '2026-01-28T09:00:00Z', service: 'local' },
    { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'inbox', to: 'in_progress', author: 'genie', time: '2026-01-28T10:00:00Z', service: 'local' },
    { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'in_progress', to: 'review', author: 'genie', time: '2026-01-29T10:30:00Z', service: 'local' },
    { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'review', to: 'done', author: 'michael', time: '2026-01-29T14:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-2', taskTitle: 'Implement dark mode toggle', author: 'michael', time: '2026-01-30T11:00:00Z', service: 'local' },
    { type: 'move', taskId: 'task-2', taskTitle: 'Implement dark mode toggle', from: 'inbox', to: 'review', author: 'genie', time: '2026-02-01T16:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-3', taskTitle: 'Add keyboard shortcuts documentation', author: 'michael', time: '2026-02-01T08:00:00Z', service: 'local' },
    { type: 'move', taskId: 'task-3', taskTitle: 'Add keyboard shortcuts documentation', from: 'inbox', to: 'in_progress', author: 'genie', time: '2026-02-02T09:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-4', taskTitle: 'Optimize image loading performance', author: 'michael', time: '2026-02-01T14:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-5', taskTitle: 'Weekly database backup verification', author: 'michael', time: '2026-02-02T07:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-6', taskTitle: 'Research OAuth2 providers for SSO', author: 'michael', time: '2026-02-02T07:30:00Z', service: 'local' },
    { type: 'add', taskId: 'task-7', taskTitle: 'Fix memory leak in websocket handler', author: 'michael', time: '2026-02-02T10:00:00Z', service: 'local' },
    { type: 'add', taskId: 'task-8', taskTitle: 'Update dependencies to latest versions', author: 'michael', time: '2026-02-02T11:00:00Z', service: 'local' }
  ],
  genieStatus: { active: false, sessions: [], currentTask: null, updatedAt: null },
  projects: [
    {
      id: 'project-1',
      title: 'Podcast Processing',
      description: 'Process all 1171 podcast episodes: transcribe, create summaries, extract quotes, prepare social media posts.',
      status: 'planning',
      created: '2026-02-02',
      comments: [
        { author: 'michael', text: 'We need to process all episodes efficiently. Let\'s break this into batches.', time: '2026-02-02T10:00:00Z' }
      ]
    }
  ]
};

// ============ VALIDATION HELPERS ============

function sanitizeId(id) {
  if (!id || typeof id !== 'string') return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return sanitized.length > 0 && sanitized.length <= 50 ? sanitized : null;
}

function validateTask(task) {
  const errors = [];
  if (!task) return { valid: false, errors: ['Task is required'] };
  if (!task.title || typeof task.title !== 'string' || task.title.trim().length === 0) {
    errors.push('Title is required and must be non-empty');
  }
  if (task.title && task.title.length > 500) {
    errors.push('Title must be 500 characters or less');
  }
  if (task.column && !COLUMNS.includes(task.column)) {
    errors.push(`Invalid column: ${task.column}`);
  }
  if (task.priority && !['low', 'medium', 'high'].includes(task.priority)) {
    errors.push(`Invalid priority: ${task.priority}`);
  }
  if (task.type && !['single', 'recurring'].includes(task.type)) {
    errors.push(`Invalid type: ${task.type}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateComment(comment) {
  const errors = [];
  if (!comment) return { valid: false, errors: ['Comment is required'] };
  if (!comment.text || typeof comment.text !== 'string' || comment.text.trim().length === 0) {
    errors.push('Comment text is required');
  }
  if (!comment.author || typeof comment.author !== 'string') {
    errors.push('Comment author is required');
  }
  return { valid: errors.length === 0, errors };
}

// ============ DATA ACCESS ============

async function getTasks() {
  // Local mock mode
  if (LOCAL_MODE) {
    return { columns: COLUMNS, tasks: mockData.tasks };
  }

  if (cache.isValid()) {
    console.log('[cache] HIT - returning cached tasks');
    return cache.tasks;
  }

  try {
    const [tasksResult, commentsResult] = await Promise.all([
      supabase.from('tasks').select('*').order('created_at', { ascending: false }),
      supabase.from('comments').select('*').order('created_at', { ascending: true })
    ]);

    if (tasksResult.error) throw tasksResult.error;
    if (commentsResult.error) throw commentsResult.error;

    const commentsByTask = {};
    for (const c of commentsResult.data || []) {
      if (!commentsByTask[c.task_id]) commentsByTask[c.task_id] = [];
      commentsByTask[c.task_id].push({
        author: c.author,
        text: c.text,
        time: c.created_at
      });
    }

    const formattedTasks = (tasksResult.data || []).map(t => ({
      id: t.id,
      title: t.title,
      description: t.description || '',
      successCriteria: t.success_criteria || '',
      userJourney: t.user_journey || '',
      column: t.column_name,
      priority: t.priority || 'medium',
      type: t.task_type || 'single',
      created: t.created_at ? t.created_at.split('T')[0] : '',
      seenAt: t.seen_at,
      needsLaptop: t.needs_laptop || false,
      needsMobile: t.needs_mobile || false,
      archived: t.archived || false,
      archivedAt: t.archived_at,
      celebrationImage: t.celebration_image || null,
      projectId: t.project_id || null,
      comments: commentsByTask[t.id] || []
    }));

    const result = { columns: COLUMNS, tasks: formattedTasks };
    cache.set(result);
    
    console.log(`✓ Fetched ${formattedTasks.length} tasks from Supabase`);
    return result;
  } catch (e) {
    console.error('getTasks error:', e.message);
    return { columns: COLUMNS, tasks: [] };
  }
}

async function getHistory() {
  // Local mock mode
  if (LOCAL_MODE) {
    return mockData.history;
  }

  try {
    const { data, error } = await supabase
      .from('lamp_audit')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    
    if (error) throw error;
    
    return (data || []).map(h => ({
      type: h.event_type,
      taskId: h.task_id,
      taskTitle: h.task_title,
      from: h.from_column,
      to: h.to_column,
      author: h.author,
      time: h.created_at,
      service: h.service
    }));
  } catch (e) {
    console.error('getHistory error:', e.message);
    return [];
  }
}

async function addAuditLog(entry) {
  // Local mock mode
  if (LOCAL_MODE) {
    mockData.history.unshift({ ...entry, time: new Date().toISOString(), service: 'local' });
    console.log(`[mock] Audit: ${entry.type} ${entry.taskId}`);
    return;
  }

  try {
    await supabaseAdmin.from('lamp_audit').insert({
      event_type: entry.type,
      task_id: entry.taskId,
      task_title: entry.taskTitle,
      from_column: entry.from || null,
      to_column: entry.to || null,
      author: entry.author || 'unknown',
      service: SERVICE_NAME
    });
    console.log(`✓ Audit: ${entry.type} ${entry.taskId}`);
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// ============ GENIE STATUS (replaces Redis) ============

async function getGenieStatus() {
  // Local mock mode
  if (LOCAL_MODE) {
    return mockData.genieStatus;
  }

  try {
    const { data, error } = await supabase
      .from('genie_status')
      .select('*')
      .order('updated_at', { ascending: false });
    
    if (error) throw error;
    
    const now = Date.now();
    const sessions = (data || [])
      .filter(s => now - new Date(s.updated_at).getTime() < 5 * 60 * 1000)
      .map(s => ({
        sessionKey: s.session_key,
        label: s.label,
        active: s.active,
        currentTask: s.current_task,
        model: s.model,
        updatedAt: s.updated_at
      }));
    
    const activeSession = sessions.find(s => s.active);
    
    return {
      active: sessions.some(s => s.active),
      currentTask: activeSession?.currentTask || null,
      updatedAt: sessions[0]?.updatedAt || null,
      sessions
    };
  } catch (e) {
    console.error('getGenieStatus error:', e.message);
    return { active: false, sessions: [], error: e.message };
  }
}

async function updateGenieStatus(sessionKey, status) {
  // Local mock mode
  if (LOCAL_MODE) {
    mockData.genieStatus = {
      active: status.active || false,
      currentTask: status.currentTask || null,
      updatedAt: new Date().toISOString(),
      sessions: [{
        sessionKey,
        label: status.label || sessionKey,
        active: status.active || false,
        currentTask: status.currentTask || null,
        model: status.model || null,
        updatedAt: new Date().toISOString()
      }]
    };
    console.log(`[mock] Genie status updated: ${sessionKey}`);
    return { ok: true };
  }

  try {
    const { error } = await supabaseAdmin.from('genie_status').upsert({
      session_key: sessionKey,
      label: status.label || sessionKey,
      active: status.active || false,
      current_task: status.currentTask || null,
      model: status.model || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'session_key' });
    
    if (error) throw error;
    console.log(`✓ Genie status updated: ${sessionKey}`);
    return { ok: true };
  } catch (e) {
    console.error('updateGenieStatus error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============ TASK OPERATIONS ============

async function addTask(task) {
  const id = task.id || Date.now().toString();
  
  // Local mock mode
  if (LOCAL_MODE) {
    mockData.tasks.push({
      id,
      title: task.title,
      description: task.description || '',
      column: task.column || 'inbox',
      priority: task.priority || 'medium',
      type: task.type || 'single',
      created: new Date().toISOString().split('T')[0],
      projectId: task.projectId || null,
      comments: []
    });
    addAuditLog({ type: 'add', taskId: id, taskTitle: task.title, author: 'michael' });
    console.log(`[mock] Added task: ${id}`);
    return id;
  }
  
  const { error } = await supabaseAdmin.from('tasks').insert({
    id,
    title: task.title,
    description: task.description || null,
    success_criteria: task.successCriteria || null,
    user_journey: task.userJourney || null,
    column_name: task.column || 'inbox',
    priority: task.priority || 'medium',
    task_type: task.type || 'single',
    needs_laptop: task.needsLaptop || false,
    project_id: task.projectId || null
  });
  
  if (error) throw error;
  
  cache.invalidate();
  addAuditLog({ type: 'add', taskId: id, taskTitle: task.title, author: 'michael' });
  return id;
}

async function updateTask(taskId, updates, author = 'unknown') {
  const safeId = sanitizeId(taskId);
  if (!safeId) throw new Error('Invalid taskId');
  
  // Local mock mode
  if (LOCAL_MODE) {
    const task = mockData.tasks.find(t => t.id === safeId);
    if (task) {
      const oldColumn = task.column;
      if (updates.title !== undefined) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.column !== undefined) task.column = updates.column;
      if (updates.priority !== undefined) task.priority = updates.priority;
      if (updates.column && updates.column !== oldColumn) {
        addAuditLog({ type: 'move', taskId: safeId, taskTitle: task.title, from: oldColumn, to: updates.column, author });
      }
      console.log(`[mock] Updated task: ${safeId}`);
    }
    return;
  }
  
  const { data: current } = await supabase
    .from('tasks')
    .select('column_name, title')
    .eq('id', safeId)
    .single();
  
  const payload = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.successCriteria !== undefined) payload.success_criteria = updates.successCriteria;
  if (updates.userJourney !== undefined) payload.user_journey = updates.userJourney;
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if (updates.type !== undefined) payload.task_type = updates.type;
  if (updates.needsLaptop !== undefined) payload.needs_laptop = updates.needsLaptop;
  if (updates.needsMobile !== undefined) payload.needs_mobile = updates.needsMobile;
  if (updates.seenAt !== undefined) payload.seen_at = updates.seenAt;
  if (updates.column !== undefined) payload.column_name = updates.column;
  if (updates.archived !== undefined) {
    payload.archived = updates.archived;
    if (updates.archived) payload.archived_at = new Date().toISOString();
  }
  if (updates.celebrationImage !== undefined) payload.celebration_image = updates.celebrationImage;
  if (updates.projectId !== undefined) payload.project_id = updates.projectId;
  
  const { error } = await supabaseAdmin.from('tasks').update(payload).eq('id', safeId);
  if (error) throw error;
  
  cache.invalidate();
  
  if (updates.column && current && updates.column !== current.column_name) {
    let moveAuthor = author;
    if (moveAuthor === 'unknown') {
      if (updates.column === 'done') moveAuthor = 'michael';
      else if (['review', 'in_progress'].includes(updates.column)) moveAuthor = 'genie';
    }
    addAuditLog({
      type: 'move',
      taskId: safeId,
      taskTitle: current.title,
      from: current.column_name,
      to: updates.column,
      author: moveAuthor
    });
  }
}

async function deleteTask(taskId) {
  const safeId = sanitizeId(taskId);
  if (!safeId) throw new Error('Invalid taskId');
  
  // Local mock mode
  if (LOCAL_MODE) {
    const idx = mockData.tasks.findIndex(t => t.id === safeId);
    if (idx !== -1) {
      const task = mockData.tasks[idx];
      mockData.tasks.splice(idx, 1);
      addAuditLog({ type: 'delete', taskId: safeId, taskTitle: task.title, author: 'michael' });
      console.log(`[mock] Deleted task: ${safeId}`);
    }
    return;
  }
  
  const { data: task } = await supabase.from('tasks').select('title').eq('id', safeId).single();
  
  const { error } = await supabaseAdmin.from('tasks').delete().eq('id', safeId);
  if (error) throw error;
  
  cache.invalidate();
  
  if (task) {
    addAuditLog({ type: 'delete', taskId: safeId, taskTitle: task.title, author: 'michael' });
  }
}

async function addComment(taskId, comment) {
  const safeId = sanitizeId(taskId);
  if (!safeId) throw new Error('Invalid taskId');
  
  // Local mock mode
  if (LOCAL_MODE) {
    const task = mockData.tasks.find(t => t.id === safeId);
    if (task) {
      task.comments.push({ author: comment.author, text: comment.text, time: new Date().toISOString() });
      addAuditLog({ type: 'comment', taskId: safeId, taskTitle: task.title, author: comment.author });
      console.log(`[mock] Added comment to: ${safeId}`);
    }
    return;
  }
  
  const { data: task } = await supabase.from('tasks').select('title').eq('id', safeId).single();
  
  const { error } = await supabaseAdmin.from('comments').insert({
    task_id: safeId,
    author: comment.author,
    text: comment.text
  });
  
  if (error) throw error;
  
  cache.invalidate();
  
  if (task) {
    addAuditLog({ type: 'comment', taskId: safeId, taskTitle: task.title, author: comment.author });
  }
}

// ============ BULK SAVE WITH UPSERT ============

async function bulkSaveTasks(frontendTasks) {
  // Local mock mode - just replace the mock data
  if (LOCAL_MODE) {
    mockData.tasks = frontendTasks.map(t => ({
      ...t,
      comments: t.comments || []
    }));
    console.log(`[mock] Bulk saved ${frontendTasks.length} tasks`);
    return;
  }

  try {
    const [tasksResult, commentsResult] = await Promise.all([
      supabase.from('tasks').select('id,title,description,success_criteria,user_journey,column_name,priority,task_type,seen_at,needs_laptop'),
      supabase.from('comments').select('id,task_id,author,text')
    ]);
    
    const dbTaskMap = new Map((tasksResult.data || []).map(t => [t.id, t]));
    const dbCommentMap = new Map();
    for (const c of commentsResult.data || []) {
      if (!dbCommentMap.has(c.task_id)) dbCommentMap.set(c.task_id, []);
      dbCommentMap.get(c.task_id).push({ author: c.author, text: c.text });
    }

    const tasksToUpsert = [];
    const commentsToInsert = [];
    const auditEntries = [];

    for (const task of frontendTasks) {
      const dbTask = dbTaskMap.get(task.id);
      
      const taskRow = {
        id: task.id,
        title: task.title,
        description: task.description || null,
        success_criteria: task.successCriteria || null,
        user_journey: task.userJourney || null,
        column_name: task.column,
        priority: task.priority || 'medium',
        task_type: task.type || 'single',
        seen_at: task.seenAt || null,
        needs_laptop: task.needsLaptop || false,
        needs_mobile: task.needsMobile || false,
        archived: task.archived || false,
        archived_at: task.archivedAt || null,
        celebration_image: task.celebrationImage || null,
        project_id: task.projectId || null,
        updated_at: new Date().toISOString()
      };
      
      if (!dbTask) {
        taskRow.created_at = new Date().toISOString();
        auditEntries.push({ type: 'add', taskId: task.id, taskTitle: task.title, author: 'michael' });
      }
      
      tasksToUpsert.push(taskRow);
      
      const dbComments = dbCommentMap.get(task.id) || [];
      const dbCommentSet = new Set(dbComments.map(c => `${c.author}:${c.text}`));
      
      for (const c of task.comments || []) {
        const key = `${c.author}:${c.text}`;
        if (!dbCommentSet.has(key)) {
          commentsToInsert.push({ task_id: task.id, author: c.author, text: c.text });
          auditEntries.push({ type: 'comment', taskId: task.id, taskTitle: task.title, author: c.author });
        }
      }
    }

    if (tasksToUpsert.length > 0) {
      const { error } = await supabaseAdmin.from('tasks').upsert(tasksToUpsert, { 
        onConflict: 'id',
        ignoreDuplicates: false 
      });
      if (error) throw error;
    }

    if (commentsToInsert.length > 0) {
      const { error } = await supabaseAdmin.from('comments').insert(commentsToInsert);
      if (error) throw error;
    }

    for (const entry of auditEntries) {
      addAuditLog(entry);
    }

    cache.invalidate();
    console.log(`[bulkSave] ✓ Upserted ${tasksToUpsert.length} tasks, ${commentsToInsert.length} comments`);
  } catch (e) {
    console.error('[bulkSave] Error:', e.message);
    throw e;
  }
}

// ============ PROJECT OPERATIONS ============

async function getProjects() {
  // Local mock mode
  if (LOCAL_MODE) {
    return mockData.projects.map(p => ({
      ...p,
      taskCount: mockData.tasks.filter(t => t.projectId === p.id).length,
      doneCount: mockData.tasks.filter(t => t.projectId === p.id && t.column === 'done').length
    }));
  }

  try {
    const [projectsResult, commentsResult, tasksResult] = await Promise.all([
      supabase.from('projects').select('*').order('created_at', { ascending: false }),
      supabase.from('project_comments').select('*').order('created_at', { ascending: true }),
      supabase.from('tasks').select('id, project_id, column_name').not('project_id', 'is', null)
    ]);

    if (projectsResult.error) throw projectsResult.error;

    const commentsByProject = {};
    for (const c of commentsResult.data || []) {
      if (!commentsByProject[c.project_id]) commentsByProject[c.project_id] = [];
      commentsByProject[c.project_id].push({
        author: c.author,
        text: c.text,
        time: c.created_at
      });
    }

    // Count tasks per project
    const taskCounts = {};
    const doneCounts = {};
    for (const t of tasksResult.data || []) {
      if (t.project_id) {
        taskCounts[t.project_id] = (taskCounts[t.project_id] || 0) + 1;
        if (t.column_name === 'done') {
          doneCounts[t.project_id] = (doneCounts[t.project_id] || 0) + 1;
        }
      }
    }

    return (projectsResult.data || []).map(p => ({
      id: p.id,
      title: p.title,
      description: p.description || '',
      status: p.status || 'planning',
      created: p.created_at ? p.created_at.split('T')[0] : '',
      updatedAt: p.updated_at,
      comments: commentsByProject[p.id] || [],
      taskCount: taskCounts[p.id] || 0,
      doneCount: doneCounts[p.id] || 0
    }));
  } catch (e) {
    console.error('getProjects error:', e.message);
    return [];
  }
}

async function getProject(projectId) {
  const safeId = sanitizeId(projectId);
  if (!safeId) return null;

  // Local mock mode
  if (LOCAL_MODE) {
    const project = mockData.projects.find(p => p.id === safeId);
    if (!project) return null;
    return {
      ...project,
      tasks: mockData.tasks.filter(t => t.projectId === safeId)
    };
  }

  try {
    const [projectResult, commentsResult, tasksResult] = await Promise.all([
      supabase.from('projects').select('*').eq('id', safeId).single(),
      supabase.from('project_comments').select('*').eq('project_id', safeId).order('created_at', { ascending: true }),
      supabase.from('tasks').select('*').eq('project_id', safeId).order('created_at', { ascending: false })
    ]);

    if (projectResult.error) return null;

    const project = projectResult.data;
    return {
      id: project.id,
      title: project.title,
      description: project.description || '',
      status: project.status || 'planning',
      created: project.created_at ? project.created_at.split('T')[0] : '',
      updatedAt: project.updated_at,
      comments: (commentsResult.data || []).map(c => ({
        author: c.author,
        text: c.text,
        time: c.created_at
      })),
      tasks: (tasksResult.data || []).map(t => ({
        id: t.id,
        title: t.title,
        column: t.column_name,
        priority: t.priority
      }))
    };
  } catch (e) {
    console.error('getProject error:', e.message);
    return null;
  }
}

async function addProject(project) {
  const id = project.id || Date.now().toString();

  // Local mock mode
  if (LOCAL_MODE) {
    mockData.projects.push({
      id,
      title: project.title,
      description: project.description || '',
      status: 'planning',
      created: new Date().toISOString().split('T')[0],
      comments: []
    });
    console.log(`[mock] Added project: ${id}`);
    return id;
  }

  const { error } = await supabaseAdmin.from('projects').insert({
    id,
    title: project.title,
    description: project.description || null,
    status: 'planning'
  });

  if (error) throw error;
  console.log(`✓ Added project: ${id}`);
  return id;
}

async function updateProject(projectId, updates) {
  const safeId = sanitizeId(projectId);
  if (!safeId) throw new Error('Invalid projectId');

  // Local mock mode
  if (LOCAL_MODE) {
    const project = mockData.projects.find(p => p.id === safeId);
    if (project) {
      if (updates.title !== undefined) project.title = updates.title;
      if (updates.description !== undefined) project.description = updates.description;
      if (updates.status !== undefined) project.status = updates.status;
      console.log(`[mock] Updated project: ${safeId}`);
    }
    return;
  }

  const payload = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.status !== undefined) payload.status = updates.status;

  const { error } = await supabaseAdmin.from('projects').update(payload).eq('id', safeId);
  if (error) throw error;
  console.log(`✓ Updated project: ${safeId}`);
}

async function deleteProject(projectId) {
  const safeId = sanitizeId(projectId);
  if (!safeId) throw new Error('Invalid projectId');

  // Local mock mode
  if (LOCAL_MODE) {
    const idx = mockData.projects.findIndex(p => p.id === safeId);
    if (idx !== -1) {
      mockData.projects.splice(idx, 1);
      // Unlink tasks
      mockData.tasks.forEach(t => {
        if (t.projectId === safeId) t.projectId = null;
      });
      console.log(`[mock] Deleted project: ${safeId}`);
    }
    return;
  }

  // Unlink tasks first (don't delete them)
  await supabaseAdmin.from('tasks').update({ project_id: null }).eq('project_id', safeId);
  
  // Delete project (comments cascade)
  const { error } = await supabaseAdmin.from('projects').delete().eq('id', safeId);
  if (error) throw error;
  console.log(`✓ Deleted project: ${safeId}`);
}

async function addProjectComment(projectId, comment) {
  const safeId = sanitizeId(projectId);
  if (!safeId) throw new Error('Invalid projectId');

  // Local mock mode
  if (LOCAL_MODE) {
    const project = mockData.projects.find(p => p.id === safeId);
    if (project) {
      project.comments.push({
        author: comment.author,
        text: comment.text,
        time: new Date().toISOString()
      });
      console.log(`[mock] Added comment to project: ${safeId}`);
    }
    return;
  }

  const { error } = await supabaseAdmin.from('project_comments').insert({
    project_id: safeId,
    author: comment.author,
    text: comment.text
  });

  if (error) throw error;
  console.log(`✓ Added comment to project: ${safeId}`);
}

// ============ BACKUP TO GITHUB GIST ============

async function backupToGist() {
  if (!GITHUB_TOKEN || !GIST_ID) {
    return { ok: false, error: 'GITHUB_TOKEN or GIST_ID not configured' };
  }

  try {
    const [tasksData, historyData] = await Promise.all([
      getTasks(),
      getHistory()
    ]);

    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({
        files: {
          'tasks.json': { content: JSON.stringify(tasksData, null, 2) },
          'history.json': { content: JSON.stringify(historyData, null, 2) },
          'backup-meta.json': { content: JSON.stringify({
            timestamp: new Date().toISOString(),
            taskCount: tasksData.tasks.length,
            historyCount: historyData.length,
            service: SERVICE_NAME
          }, null, 2) }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    console.log(`✓ Backed up to Gist: ${tasksData.tasks.length} tasks, ${historyData.length} history`);
    return { ok: true, timestamp: new Date().toISOString(), tasks: tasksData.tasks.length };
  } catch (e) {
    console.error('Backup error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============ SCHEDULED BACKUP (every 6 hours) ============
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000;
setInterval(async () => {
  console.log('[scheduler] Running automated backup...');
  await backupToGist();
}, BACKUP_INTERVAL);

// ============ REAL-TIME BROADCAST (SSE) ============
const clients = new Set();

function broadcastToClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(message);
    } catch (e) {
      clients.delete(client);
    }
  }
}

function setupRealtimeSubscription() {
  if (LOCAL_MODE || !supabase) {
    console.log('[realtime] Skipped - running in local mode');
    return null;
  }
  
  const channel = supabase.channel('lamp-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
      console.log('[realtime] Task change:', payload.eventType);
      cache.invalidate();
      broadcastToClients('tasks', { type: payload.eventType, record: payload.new || payload.old });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
      console.log('[realtime] Comment change:', payload.eventType);
      cache.invalidate();
      broadcastToClients('comments', { type: payload.eventType, record: payload.new || payload.old });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'genie_status' }, (payload) => {
      console.log('[realtime] Genie status change');
      broadcastToClients('genie', payload.new);
    })
    .subscribe((status) => {
      console.log(`[realtime] Subscription status: ${status}`);
    });
    
  return channel;
}

setupRealtimeSubscription();

// ============ REQUEST HANDLER ============

// Helper to check API token for write operations
function checkAuth(req, res) {
  // Skip auth in local mode or if no token configured
  if (LOCAL_MODE || !API_TOKEN) return true;
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization required', code: 'AUTH_REQUIRED' }));
    return false;
  }
  
  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token', code: 'INVALID_TOKEN' }));
    return false;
  }
  
  return true;
}

// Helper to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.socket?.remoteAddress || 
         'unknown';
}

async function handleApiRequest(req, res, body) {
  const clientIP = getClientIP(req);
  
  try {
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('event: connected\ndata: {}\n\n');
      
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        console.log(`[sse] Client disconnected (${clients.size} remaining)`);
      });
      console.log(`[sse] Client connected (${clients.size} total)`);
      return;
    }

    if (req.method === 'GET') {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          version: '3.1.0',
          service: SERVICE_NAME,
          supabase: true,
          realtime: true,
          cache: cache.isValid(),
          clients: clients.size,
          authEnabled: !!API_TOKEN,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (req.url === '/api/tasks') {
        const data = await getTasks();
        // Add server timestamp to help clients detect stale data
        data.serverTime = Date.now();
        data.serverVersion = '3.2.0'; // Version with data integrity fixes
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }
      
      if (req.url.startsWith('/api/history')) {
        const history = await getHistory();
        const url = new URL(req.url, `http://${req.headers.host}`);
        const author = url.searchParams.get('author');
        let filtered = history;
        if (author && author !== 'all') {
          filtered = history.filter(h => h.author === author);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(filtered.slice(0, 100)));
        return;
      }
      
      if (req.url === '/api/console') {
        const status = await getGenieStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }
      
      // Projects API - GET
      if (req.url === '/api/projects') {
        const projects = await getProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
        return;
      }
      
      if (req.url.startsWith('/api/projects/')) {
        const projectId = req.url.split('/')[3];
        const project = await getProject(projectId);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
        return;
      }
    }
    
    if (req.method === 'POST') {
      // Projects API - POST
      if (req.url === '/api/projects') {
        const { action, projectId, project, updates, comment } = body;
        
        switch (action) {
          case 'add': {
            if (!project?.title) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Project title is required'] }));
              return;
            }
            const id = await addProject(project);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id }));
            return;
          }
          case 'update': {
            const safeId = sanitizeId(projectId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid projectId'] }));
              return;
            }
            await updateProject(safeId, updates);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          case 'delete': {
            const safeId = sanitizeId(projectId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid projectId'] }));
              return;
            }
            await deleteProject(safeId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          case 'comment': {
            const safeId = sanitizeId(projectId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid projectId'] }));
              return;
            }
            if (!comment?.text || !comment?.author) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Comment text and author required'] }));
              return;
            }
            await addProjectComment(safeId, comment);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          default: {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, errors: ['Invalid action'] }));
            return;
          }
        }
      }
      
      if (req.url === '/api/tasks') {
        // SECURITY: Bulk save disabled to prevent data corruption from stale clients
        // All updates must use action-based API (add, update, delete, comment)
        if (body.tasks && Array.isArray(body.tasks)) {
          console.warn('[SECURITY] Bulk save attempted and blocked - use action-based API');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            ok: false, 
            error: 'Bulk save disabled for data integrity. Use action-based API.',
            code: 'BULK_SAVE_DISABLED'
          }));
          return;
        }
        
        const { action, taskId, task, updates, comment, author } = body;
        
        switch (action) {
          case 'add': {
            const validation = validateTask(task);
            if (!validation.valid) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: validation.errors }));
              return;
            }
            await addTask(task);
            break;
          }
          case 'update': {
            const safeId = sanitizeId(taskId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid taskId'] }));
              return;
            }
            if (updates) await updateTask(safeId, updates, author);
            break;
          }
          case 'delete': {
            const safeId = sanitizeId(taskId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid taskId'] }));
              return;
            }
            await deleteTask(safeId);
            break;
          }
          case 'comment': {
            const safeId = sanitizeId(taskId);
            if (!safeId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: ['Invalid taskId'] }));
              return;
            }
            const validation = validateComment(comment);
            if (!validation.valid) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, errors: validation.errors }));
              return;
            }
            await addComment(safeId, comment);
            break;
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
        return;
      }
      
      if (req.url === '/api/console') {
        const { sessionKey, ...status } = body;
        if (!sessionKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'sessionKey required' }));
          return;
        }
        const result = await updateGenieStatus(sessionKey, status);
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      
      if (req.url === '/api/backup') {
        if (!checkAuth(req, res)) return;
        const result = await backupToGist();
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/upload-image') {
        // Upload image to Supabase Storage
        const rateCheck = checkRateLimit(clientIP, 'generate-image');
        if (!rateCheck.allowed) {
          res.writeHead(429, { 
            'Content-Type': 'application/json',
            'Retry-After': rateCheck.retryAfter.toString()
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter }));
          return;
        }

        const { imageData, filename, taskId } = body;
        
        if (!imageData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'imageData (base64) is required' }));
          return;
        }

        if (LOCAL_MODE) {
          // Mock response for local mode
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            ok: true, 
            url: 'https://placeholder.com/mock-image.png',
            message: 'Local mode - image not actually uploaded'
          }));
          return;
        }

        try {
          // Decode base64 image
          const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
          const imageBuffer = Buffer.from(base64Data, 'base64');
          
          // Generate filename if not provided
          const finalFilename = filename || `celebration-${Date.now()}.png`;
          const filePath = `celebrations/${finalFilename}`;
          
          // Upload to Supabase Storage
          const { data, error } = await supabaseAdmin.storage
            .from('images')
            .upload(filePath, imageBuffer, {
              contentType: 'image/png',
              upsert: true
            });

          if (error) {
            console.error('Supabase storage error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
            return;
          }

          // Get public URL
          const { data: urlData } = supabaseAdmin.storage
            .from('images')
            .getPublicUrl(filePath);

          const publicUrl = urlData.publicUrl;

          // If taskId provided, update the task with the image
          if (taskId) {
            const { error: updateError } = await supabaseAdmin
              .from('tasks')
              .update({ celebration_image: publicUrl, updated_at: new Date().toISOString() })
              .eq('id', taskId);
            
            if (updateError) {
              console.error('Failed to update task with image:', updateError);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: publicUrl }));
        } catch (e) {
          console.error('Image upload error:', e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (req.url === '/api/generate-image') {
        // Rate limit image generation (expensive API)
        const rateCheck = checkRateLimit(clientIP, 'generate-image');
        if (!rateCheck.allowed) {
          res.writeHead(429, { 
            'Content-Type': 'application/json',
            'Retry-After': rateCheck.retryAfter.toString()
          });
          res.end(JSON.stringify({ 
            error: 'Rate limit exceeded', 
            retryAfter: rateCheck.retryAfter,
            code: 'RATE_LIMITED'
          }));
          return;
        }
        
        const { taskTitle } = body;
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI API key not configured' }));
          return;
        }

        const prompt = `Create a cheerful, whimsical celebration cartoon for completing this task: "${taskTitle}". Style: cute kawaii characters celebrating, soft pastel colors with golden sparkles, warm and cozy feeling, no text or words in the image. The scene should capture the joy and satisfaction of accomplishment.`;
        
        const requestData = JSON.stringify({
          model: 'gpt-image-1',
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'medium'
        });

        const apiReq = https.request({
          hostname: 'api.openai.com',
          path: '/v1/images/generations',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(requestData)
          }
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.data?.[0]?.url) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, imageUrl: result.data[0].url }));
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No image generated' }));
              }
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });

        apiReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });

        apiReq.write(requestData);
        apiReq.end();
        return;
      }

      if (req.url === '/api/transcribe') {
        // Rate limit transcription
        const rateCheck = checkRateLimit(clientIP, 'transcribe');
        if (!rateCheck.allowed) {
          res.writeHead(429, { 
            'Content-Type': 'application/json',
            'Retry-After': rateCheck.retryAfter.toString()
          });
          res.end(JSON.stringify({ 
            error: 'Rate limit exceeded', 
            retryAfter: rateCheck.retryAfter,
            code: 'RATE_LIMITED'
          }));
          return;
        }
        
        const { audio } = body;
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI API key not configured' }));
          return;
        }

        const audioBuffer = Buffer.from(audio, 'base64');
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2);
        const formData = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
          audioBuffer,
          Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`)
        ]);

        const apiReq = https.request({
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': formData.length
          }
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ text: result.text || '' }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });

        apiReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });

        apiReq.write(formData);
        apiReq.end();
        return;
      }
    }
    
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('API error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============ SERVER ============

const server = http.createServer(async (req, res) => {
  // CORS: Allow specific origins or localhost in dev
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || LOCAL_MODE)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Same-origin requests (no Origin header)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.url.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (e) {}
    }
    return handleApiRequest(req, res, body);
  }
  
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, filePath);
  
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🪔 The Lamp v3.0 running on port ${PORT}`);
  console.log(`   Service: ${SERVICE_NAME}`);
  console.log(`   Supabase: ${SUPABASE_URL.substring(0, 40)}...`);
  console.log(`   Realtime: enabled`);
  console.log(`   Cache TTL: ${cache.TTL}ms`);
  console.log(`   Auto-backup: every 6 hours`);
  if (!GITHUB_TOKEN) {
    console.log(`   ⚠️  GITHUB_TOKEN not set - backups disabled`);
  }
  if (!SUPABASE_SERVICE_KEY) {
    console.log(`   ⚠️  SUPABASE_SERVICE_KEY not set - using anon key for writes`);
  }
});
