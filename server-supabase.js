const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;

// Supabase configuration (primary data store)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const COLUMNS = ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'];

// ============ SUPABASE HELPERS ============

async function supabaseQuery(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    ...options.headers
  };
  
  console.log(`[supabaseQuery] ${options.method || 'GET'} ${endpoint}`);
  
  const response = await fetch(url, { ...options, headers });
  
  console.log(`[supabaseQuery] Response: ${response.status} ${response.statusText}`);
  
  if (!response.ok) {
    const error = await response.text();
    console.error(`[supabaseQuery] Error: ${error}`);
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
  // Get current task for audit
  const [current] = await supabaseQuery(`tasks?id=eq.${taskId}&select=column_name,title`);
  
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
  
  await supabaseQuery(`tasks?id=eq.${taskId}`, {
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
      taskId,
      taskTitle: current.title,
      from: current.column_name,
      to: updates.column,
      author: moveAuthor
    });
  }
}

async function deleteTask(taskId) {
  const [task] = await supabaseQuery(`tasks?id=eq.${taskId}&select=title`);
  
  await supabaseQuery(`tasks?id=eq.${taskId}`, {
    method: 'DELETE'
  });
  
  if (task) {
    addAuditLog({ type: 'delete', taskId, taskTitle: task.title, author: 'michael' });
  }
}

async function addComment(taskId, comment) {
  const [task] = await supabaseQuery(`tasks?id=eq.${taskId}&select=title`);
  
  await supabaseQuery('comments', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      task_id: taskId,
      author: comment.author,
      text: comment.text
    })
  });
  
  if (task) {
    addAuditLog({
      type: 'comment',
      taskId,
      taskTitle: task.title,
      author: comment.author
    });
  }
}

// ============ REQUEST HANDLER ============

async function handleApiRequest(req, res, body) {
  try {
    if (req.method === 'GET') {
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
      const { action, taskId, task, updates, comment, author } = body;
      
      switch (action) {
        case 'add':
          if (task) await addTask(task);
          break;
        case 'update':
          if (taskId && updates) await updateTask(taskId, updates, author);
          break;
        case 'delete':
          if (taskId) await deleteTask(taskId);
          break;
        case 'comment':
          if (taskId && comment) await addComment(taskId, comment);
          break;
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
