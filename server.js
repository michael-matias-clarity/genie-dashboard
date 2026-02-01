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

// In-memory cache
let tasksCache = null;

// Get tasks from Redis
async function getTasks() {
  // Return cache if valid
  if (tasksCache && tasksCache.tasks && tasksCache.tasks.length > 0) {
    return tasksCache;
  }
  
  // Try Redis
  if (redis) {
    try {
      console.log('Loading tasks from Redis...');
      let data = await redis.get(TASKS_KEY);
      console.log('Redis response type:', typeof data);
      console.log('Redis response preview:', JSON.stringify(data)?.substring(0, 100));
      
      // Handle string data (from REST API storage)
      if (typeof data === 'string') {
        console.log('Parsing string data...');
        data = JSON.parse(data);
      }
      if (data && data.tasks && data.tasks.length > 0) {
        tasksCache = data;
        console.log(`✓ Loaded ${data.tasks.length} tasks from Redis`);
        return data;
      } else {
        console.log('Redis data empty or invalid:', { hasTasks: !!data?.tasks, length: data?.tasks?.length });
      }
    } catch (e) {
      console.error('Redis GET error:', e.message, e.stack);
    }
  }
  
  // Fallback to local file ONLY if Redis is not configured
  // If Redis IS configured but failed, don't use stale file - it could overwrite real data
  if (!redis) {
    try {
      const fileData = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
      if (fileData.tasks && fileData.tasks.length > 0) {
        tasksCache = fileData;
        console.log(`✓ Loaded ${fileData.tasks.length} tasks from file (no Redis configured)`);
        return fileData;
      }
    } catch (e) {
      console.log('No local file');
    }
  } else {
    console.log('⚠️ Redis configured but returned no data - NOT falling back to potentially stale file');
  }
  
  return DEFAULT_DATA;
}

// Save tasks
async function saveTasks(data) {
  if (!data || !data.tasks) return;
  
  tasksCache = data;
  
  // Save to Redis
  if (redis) {
    try {
      await redis.set(TASKS_KEY, data);
      console.log(`✓ Saved ${data.tasks.length} tasks to Redis`);
    } catch (e) {
      console.error('Redis SET error:', e.message);
    }
  }
  
  // Also save locally
  try {
    fs.writeFileSync(path.join(__dirname, 'tasks.json'), JSON.stringify(data, null, 2));
  } catch (e) {}
}

// History cache
let historyCache = [];

// Get history from Redis
async function getHistory() {
  if (historyCache.length > 0) return historyCache;
  if (redis) {
    try {
      let data = await redis.get(HISTORY_KEY);
      if (typeof data === 'string') data = JSON.parse(data);
      if (Array.isArray(data)) {
        historyCache = data;
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
  historyCache.unshift(entry); // Add to front
  historyCache = historyCache.slice(0, 500); // Keep last 500
  if (redis) {
    try {
      await redis.set(HISTORY_KEY, historyCache);
    } catch (e) {
      console.error('History SET error:', e.message);
    }
  }
}

// Handle task operations
function handleTaskOperation(data, body) {
  const { action, taskId, task, updates, comment } = body;
  
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
          addHistoryEntry({
            type: 'move',
            taskId,
            taskTitle: toUpdate.title,
            from: oldColumn,
            to: updates.column,
            author: 'unknown',
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
      tasks: tasksCache?.tasks?.length || 0,
      redis: !!redis
    }));
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
