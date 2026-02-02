const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;

// Supabase configuration (primary data store)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown';

// Fail fast if Supabase not configured
if (!SUPABASE_KEY) {
  console.error('❌ FATAL: SUPABASE_ANON_KEY environment variable is required');
  console.error('   Set it in your Render environment variables');
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const COLUMNS = ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'];

// ============ VALIDATION HELPERS ============

function sanitizeId(id) {
  // Only allow alphanumeric, dash, underscore
  if (!id || typeof id !== 'string') return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return sanitized.length > 0 && sanitized.length <= 50 ? sanitized : null;
}

function validateTask(task) {
  const errors = [];
  
  if (!task) {
    return { valid: false, errors: ['Task is required'] };
  }
  
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
  
  if (!comment) {
    return { valid: false, errors: ['Comment is required'] };
  }
  
  if (!comment.text || typeof comment.text !== 'string' || comment.text.trim().length === 0) {
    errors.push('Comment text is required');
  }
  
  if (!comment.author || typeof comment.author !== 'string') {
    errors.push('Comment author is required');
  }
  
  return { valid: errors.length === 0, errors };
}

// ============ SUPABASE HELPERS ============

async function supabaseQuery(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    ...options.headers
  };
  
  const response = await fetch(url, { ...options, headers });
  
  if (!response.ok) {
    const error = await response.text();
    console.error(`[supabase] ERROR ${options.method || 'GET'} ${endpoint}: ${error}`);
    throw new Error(`Supabase error: ${response.status} - ${error}`);
  }
  
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ============ DATA ACCESS ============

async function getTasks() {
  if (!SUPABASE_KEY) {
    console.log('Supabase not configured');
    return { columns: COLUMNS, tasks: [] };
  }

  try {
    // Fetch all tasks
    const tasks = await supabaseQuery('tasks?select=*&order=created_at.desc');
    
    // Fetch all comments
    const comments = await supabaseQuery('comments?select=*&order=created_at.asc');
    
    // Group comments by task_id
    const commentsByTask = {};
    for (const c of comments || []) {
      if (!commentsByTask[c.task_id]) commentsByTask[c.task_id] = [];
      commentsByTask[c.task_id].push({
        author: c.author,
        text: c.text,
        time: c.created_at
      });
    }
    
    // Transform to API format
    const formattedTasks = (tasks || []).map(t => ({
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
      comments: commentsByTask[t.id] || []
    }));

    console.log(`✓ Fetched ${formattedTasks.length} tasks from Supabase`);
    return { columns: COLUMNS, tasks: formattedTasks };
  } catch (e) {
    console.error('getTasks error:', e.message);
    return { columns: COLUMNS, tasks: [] };
  }
}

async function getHistory() {
  if (!SUPABASE_KEY) return [];
  
  try {
    const history = await supabaseQuery('lamp_audit?select=*&order=created_at.desc&limit=500');
    return (history || []).map(h => ({
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
  if (!SUPABASE_KEY) return;
  
  try {
    await supabaseQuery('lamp_audit', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        event_type: entry.type,
        task_id: entry.taskId,
        task_title: entry.taskTitle,
        from_column: entry.from || null,
        to_column: entry.to || null,
        author: entry.author || 'unknown',
        service: SERVICE_NAME
      })
    });
    console.log(`✓ Audit: ${entry.type} ${entry.taskId}`);
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// ============ TASK OPERATIONS ============

async function addTask(task) {
  const id = task.id || Date.now().toString();
  
  console.log(`[addTask] Creating task ${id}: ${task.title}`);
  
  try {
    await supabaseQuery('tasks', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        id,
        title: task.title,
        description: task.description || null,
        success_criteria: task.successCriteria || null,
        user_journey: task.userJourney || null,
        column_name: task.column || 'inbox',
        priority: task.priority || 'medium',
        task_type: task.type || 'single',
        needs_laptop: task.needsLaptop || false
      })
    });
    console.log(`[addTask] ✓ Task ${id} created in Supabase`);
  } catch (e) {
    console.error(`[addTask] ✗ Failed to create task ${id}:`, e.message);
    throw e; // Re-throw to propagate error
  }
  
  addAuditLog({ type: 'add', taskId: id, taskTitle: task.title, author: 'michael' });
  return id;
}

async function updateTask(taskId, updates, author = 'unknown') {
  // Sanitize taskId
  const safeId = sanitizeId(taskId);
  if (!safeId) throw new Error('Invalid taskId');
  
  // Get current task for audit
  const [current] = await supabaseQuery(`tasks?id=eq.${safeId}&select=column_name,title`);
  
  const payload = {};
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.successCriteria !== undefined) payload.success_criteria = updates.successCriteria;
  if (updates.userJourney !== undefined) payload.user_journey = updates.userJourney;
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if (updates.type !== undefined) payload.task_type = updates.type;
  if (updates.needsLaptop !== undefined) payload.needs_laptop = updates.needsLaptop;
  if (updates.seenAt !== undefined) payload.seen_at = updates.seenAt;
  if (updates.column !== undefined) payload.column_name = updates.column;
  
  payload.updated_at = new Date().toISOString();
  
  await supabaseQuery(`tasks?id=eq.${safeId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(payload)
  });
  
  // Log column moves
  if (updates.column && current && updates.column !== current.column_name) {
    let moveAuthor = author;
    if (moveAuthor === 'unknown') {
      if (updates.column === 'done') moveAuthor = 'michael';
      else if (updates.column === 'review') moveAuthor = 'genie';
      else if (updates.column === 'in_progress') moveAuthor = 'genie';
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
  
  const [task] = await supabaseQuery(`tasks?id=eq.${safeId}&select=title`);
  
  await supabaseQuery(`tasks?id=eq.${safeId}`, {
    method: 'DELETE'
  });
  
  if (task) {
    addAuditLog({ type: 'delete', taskId: safeId, taskTitle: task.title, author: 'michael' });
  }
}

async function addComment(taskId, comment) {
  const safeId = sanitizeId(taskId);
  if (!safeId) throw new Error('Invalid taskId');
  
  const [task] = await supabaseQuery(`tasks?id=eq.${safeId}&select=title`);
  
  await supabaseQuery('comments', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      task_id: safeId,
      author: comment.author,
      text: comment.text
    })
  });
  
  if (task) {
    addAuditLog({
      type: 'comment',
      taskId: safeId,
      taskTitle: task.title,
      author: comment.author
    });
  }
}

// ============ BULK SAVE (for frontend compatibility) ============

async function bulkSaveTasks(frontendTasks) {
  if (!SUPABASE_KEY) {
    console.log('[bulkSave] Supabase not configured');
    return;
  }

  try {
    // Get current state from Supabase (single query each)
    const [currentTasks, currentComments] = await Promise.all([
      supabaseQuery('tasks?select=id,title,description,success_criteria,user_journey,column_name,priority,task_type,seen_at,needs_laptop'),
      supabaseQuery('comments?select=id,task_id,author,text')
    ]);
    
    // Build lookup maps
    const dbTaskMap = new Map((currentTasks || []).map(t => [t.id, t]));
    const dbCommentMap = new Map();
    for (const c of currentComments || []) {
      if (!dbCommentMap.has(c.task_id)) dbCommentMap.set(c.task_id, []);
      dbCommentMap.get(c.task_id).push({ author: c.author, text: c.text });
    }

    let added = 0, updated = 0, commentsAdded = 0;

    for (const task of frontendTasks) {
      const dbTask = dbTaskMap.get(task.id);
      
      if (!dbTask) {
        // NEW TASK - insert it
        await supabaseQuery('tasks', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            id: task.id,
            title: task.title,
            description: task.description || null,
            success_criteria: task.successCriteria || null,
            user_journey: task.userJourney || null,
            column_name: task.column,
            priority: task.priority || 'medium',
            task_type: task.type || 'single',
            seen_at: task.seenAt || null,
            needs_laptop: task.needsLaptop || false
          })
        });
        added++;
        
        // Add comments for new task
        for (const c of task.comments || []) {
          await supabaseQuery('comments', {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ task_id: task.id, author: c.author, text: c.text })
          });
          commentsAdded++;
        }
        
        addAuditLog({ type: 'add', taskId: task.id, taskTitle: task.title, author: 'michael' });
      } else {
        // EXISTING TASK - check if anything changed
        const changed = 
          dbTask.title !== task.title ||
          (dbTask.description || '') !== (task.description || '') ||
          (dbTask.success_criteria || '') !== (task.successCriteria || '') ||
          (dbTask.user_journey || '') !== (task.userJourney || '') ||
          dbTask.column_name !== task.column ||
          dbTask.priority !== (task.priority || 'medium') ||
          dbTask.task_type !== (task.type || 'single') ||
          dbTask.needs_laptop !== (task.needsLaptop || false);
        
        if (changed) {
          await supabaseQuery(`tasks?id=eq.${task.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              title: task.title,
              description: task.description || null,
              success_criteria: task.successCriteria || null,
              user_journey: task.userJourney || null,
              column_name: task.column,
              priority: task.priority || 'medium',
              task_type: task.type || 'single',
              seen_at: task.seenAt || null,
              needs_laptop: task.needsLaptop || false,
              updated_at: new Date().toISOString()
            })
          });
          updated++;
        }
        
        // Check for new comments
        const dbComments = dbCommentMap.get(task.id) || [];
        const dbCommentSet = new Set(dbComments.map(c => `${c.author}:${c.text}`));
        
        for (const c of task.comments || []) {
          const key = `${c.author}:${c.text}`;
          if (!dbCommentSet.has(key)) {
            await supabaseQuery('comments', {
              method: 'POST',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify({ task_id: task.id, author: c.author, text: c.text })
            });
            commentsAdded++;
            addAuditLog({ type: 'comment', taskId: task.id, taskTitle: task.title, author: c.author });
          }
        }
      }
    }

    console.log(`[bulkSave] ✓ Added: ${added}, Updated: ${updated}, Comments: ${commentsAdded}`);
  } catch (e) {
    console.error('[bulkSave] Error:', e.message);
    throw e;
  }
}

// ============ REQUEST HANDLER ============

async function handleApiRequest(req, res, body) {
  try {
    if (req.method === 'GET') {
      // Health check endpoint
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          service: SERVICE_NAME,
          supabase: !!SUPABASE_KEY,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (req.url === '/api/tasks') {
        const data = await getTasks();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.url === '/api/history') {
        const history = await getHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
        return;
      }
    }
    
    if (req.method === 'POST' && req.url === '/api/tasks') {
      // Handle bulk save from frontend (full tasks array)
      if (body.tasks && Array.isArray(body.tasks)) {
        console.log(`[bulkSave] Syncing ${body.tasks.length} tasks from frontend`);
        await bulkSaveTasks(body.tasks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
        return;
      }
      
      // Handle individual actions with validation
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // API routes
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
  
  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
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
  console.log(`\n🪔 The Lamp (Supabase) running on port ${PORT}`);
  console.log(`   Service: ${SERVICE_NAME}`);
  console.log(`   Supabase: ${SUPABASE_URL.substring(0, 40)}...`);
});
// Force deploy Mon Feb  2 18:04:49 IST 2026
