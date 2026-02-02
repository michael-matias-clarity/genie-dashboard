const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const PORT = process.env.PORT || 3456;
const TASKS_KEY = 'lamp:tasks';

// Initialize Redis client
let redis = null;
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (redisUrl && redisToken) {
  try {
    redis = new Redis({ url: redisUrl, token: redisToken });
    console.log('Redis URL:', redisUrl.substring(0, 30) + '...');
  } catch (e) {
    console.error('Redis init error:', e.message);
  }
} else {
  console.log('Redis env vars missing:', { url: !!redisUrl, token: !!redisToken });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const DEFAULT_DATA = { columns: ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'], tasks: [], history: [] };
const HISTORY_KEY = 'lamp:history';

// Supabase configuration for persistent audit logging
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

// Log to Supabase audit table (fire-and-forget, non-blocking)
async function logToSupabase(entry) {
  if (!SUPABASE_KEY) {
    console.log('Supabase not configured, skipping audit log');
    return;
  }
  
  try {
    const payload = {
      event_type: entry.type,
      task_id: entry.taskId,
      task_title: entry.taskTitle,
      from_column: entry.from || null,
      to_column: entry.to || null,
      author: entry.author || 'unknown',
      metadata: entry.metadata || null,
      session_id: entry.sessionId || null
    };
    
    const response = await fetch(`${SUPABASE_URL}/rest/v1/lamp_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      console.log(`✓ Audit logged to Supabase: ${entry.type} ${entry.taskId}`);
    } else {
      console.log(`⚠ Supabase audit log failed: ${response.status}`);
    }
  } catch (e) {
    console.log(`⚠ Supabase audit error: ${e.message}`);
  }
}

// Get tasks - ALWAYS fetch from Redis (no memory cache)
async function getTasks() {
  // Always try Redis first
  if (redis) {
    try {
      let data = await redis.get(TASKS_KEY);
      
      // Handle string data (from REST API storage)
      if (typeof data === 'string') {
        data = JSON.parse(data);
      }
      if (data && data.tasks && data.tasks.length > 0) {
        console.log(`✓ Fetched ${data.tasks.length} tasks from Redis`);
        return data;
      } else {
        console.log('Redis data empty or invalid');
      }
    } catch (e) {
      console.error('Redis GET error:', e.message);
    }
  }
  
  // Fallback to local file ONLY if Redis failed or not configured
  try {
    const fileData = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
    if (fileData.tasks && fileData.tasks.length > 0) {
      console.log(`⚠️ Fallback: Loaded ${fileData.tasks.length} tasks from local file`);
      return fileData;
    }
  } catch (e) {
    console.log('No local backup file');
  }
  
  return DEFAULT_DATA;
}

// Save tasks - Redis primary, local backup
async function saveTasks(data) {
  if (!data || !data.tasks) return;
  
  // Save to Redis (primary)
  if (redis) {
    try {
      await redis.set(TASKS_KEY, data);
      console.log(`✓ Saved ${data.tasks.length} tasks to Redis`);
    } catch (e) {
      console.error('Redis SET error:', e.message);
    }
  }
  
  // Also save locally as backup
  try {
    fs.writeFileSync(path.join(__dirname, 'tasks.json'), JSON.stringify(data, null, 2));
  } catch (e) {}
}

// Get history - ALWAYS fetch from Redis
async function getHistory() {
  if (redis) {
    try {
      let data = await redis.get(HISTORY_KEY);
      if (typeof data === 'string') data = JSON.parse(data);
      if (Array.isArray(data)) {
        return data;
      }
    } catch (e) {
      console.error('History GET error:', e.message);
    }
  }
  return [];
}

// Save history entry
async function addHistoryEntry(entry) {
  // Log to Redis (in-memory history for quick access)
  if (redis) {
    try {
      let history = await getHistory();
      history.unshift(entry); // Add to front
      history = history.slice(0, 1000); // Keep last 1000
      await redis.set(HISTORY_KEY, history);
    } catch (e) {
      console.error('History SET error:', e.message);
    }
  }
  
  // Log to Supabase (persistent audit trail - fire and forget)
  logToSupabase(entry).catch(() => {}); // Non-blocking
}

// Handle task operations
function handleTaskOperation(data, body) {
  const { action, taskId, task, updates, comment, author: requestAuthor } = body;
  
  switch (action) {
    case 'add':
      if (task) {
        task.id = task.id || Date.now().toString();
        task.created = task.created || new Date().toISOString().split('T')[0];
        task.comments = task.comments || [];
        data.tasks.push(task);
        // Log to history
        addHistoryEntry({
          type: 'add',
          taskId: task.id,
          taskTitle: task.title,
          author: 'michael',
          time: new Date().toISOString()
        });
      }
      break;
      
    case 'update':
      const toUpdate = data.tasks.find(t => t.id === taskId);
      if (toUpdate && updates) {
        const oldColumn = toUpdate.column;
        Object.assign(toUpdate, updates);
        // Log column moves to history
        if (updates.column && updates.column !== oldColumn) {
          // Determine author: use explicit author, or infer from move direction
          let moveAuthor = requestAuthor || 'unknown';
          if (moveAuthor === 'unknown') {
            // Infer: only Michael can move to 'done', Genie typically moves to 'review' or 'in_progress'
            if (updates.column === 'done') moveAuthor = 'michael';
            else if (updates.column === 'review' && oldColumn === 'in_progress') moveAuthor = 'genie';
            else if (updates.column === 'in_progress' && oldColumn === 'inbox') moveAuthor = 'genie';
          }
          addHistoryEntry({
            type: 'move',
            taskId,
            taskTitle: toUpdate.title,
            from: oldColumn,
            to: updates.column,
            author: moveAuthor,
            time: new Date().toISOString()
          });
        }
      }
      break;
      
    case 'delete':
      const toDelete = data.tasks.find(t => t.id === taskId);
      if (toDelete) {
        addHistoryEntry({
          type: 'delete',
          taskId,
          taskTitle: toDelete.title,
          author: 'michael',
          time: new Date().toISOString()
        });
      }
      data.tasks = data.tasks.filter(t => t.id !== taskId);
      break;
      
    case 'comment':
      const toComment = data.tasks.find(t => t.id === taskId);
      if (toComment && comment) {
        toComment.comments = toComment.comments || [];
        toComment.comments.push(comment);
        // Log comment to history
        addHistoryEntry({
          type: 'comment',
          taskId,
          taskTitle: toComment.title,
          author: comment.author || 'unknown',
          commentText: comment.text?.substring(0, 100),
          time: new Date().toISOString()
        });
      }
      break;
      
    default:
      // Full replace
      if (body.tasks) {
        data.columns = body.columns || data.columns;
        data.tasks = body.tasks;
      }
  }
  
  return data;
}

// Initialize
async function init() {
  console.log(`
🪔 The Lamp - Task Dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Redis: ${redis ? '✓ Connected' : '✗ Not configured'}
`);
  
  const data = await getTasks();
  console.log(`Ready with ${data.tasks?.length || 0} tasks`);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /api/tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const tasks = await getTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  // POST /api/tasks
  if (req.url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let data = await getTasks();
        data = handleTaskOperation({ ...data }, payload);
        await saveTasks(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/generate-image
  if (req.url === '/api/generate-image' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { taskTitle } = JSON.parse(body);
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI API key not configured' }));
          return;
        }

        const prompt = `A cute, celebratory cartoon for: "${taskTitle}". Style: minimal, friendly, warm colors. No text.`;
        
        const requestData = JSON.stringify({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard'
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
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/transcribe (Whisper)
  if (req.url === '/api/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { audio } = JSON.parse(body);
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI API key not configured' }));
          return;
        }

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(audio, 'base64');
        
        // Create multipart form data manually
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
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/history
  if (req.url.startsWith('/api/history') && req.method === 'GET') {
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

  // GET /api/health
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      tasks: 'check /api/tasks',
      redis: !!redis
    }));
    return;
  }

  // GET /api/console - Real-time Genie status
  if (req.url === '/api/console' && req.method === 'GET') {
    if (redis) {
      try {
        let status = await redis.get('genie:status');
        if (typeof status === 'string') status = JSON.parse(status);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status || { active: false, sessions: [] }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: false, sessions: [], message: 'Redis not configured' }));
    }
    return;
  }

  // POST /api/console - Update Genie status (called by Genie)
  if (req.url === '/api/console' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const status = JSON.parse(body);
        status.updatedAt = new Date().toISOString();
        if (redis) {
          await redis.set('genie:status', status);
          // Set TTL of 5 minutes so stale status auto-clears
          await redis.expire('genie:status', 300);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

// Start
init().then(() => {
  server.listen(PORT, () => {
    console.log(`Running at http://localhost:${PORT}`);
  });
});
