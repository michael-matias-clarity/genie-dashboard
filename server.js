const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TASKS_KEY = 'lamp:tasks';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const DEFAULT_DATA = { columns: ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'], tasks: [] };

// In-memory cache
let tasksCache = null;

// Upstash Redis REST API - using fetch for simplicity
async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.log('Redis: Missing URL or TOKEN');
    return null;
  }
  
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (data.result) {
      return JSON.parse(data.result);
    }
    console.log('Redis GET: no result');
    return null;
  } catch (e) {
    console.error('Redis GET error:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  
  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(["SET", key, JSON.stringify(value)])
    });
    const data = await res.json();
    return data.result === 'OK';
  } catch (e) {
    console.error('Redis SET error:', e.message);
    return false;
  }
}

// Get tasks - from cache or Redis
async function getTasks() {
  if (tasksCache && tasksCache.tasks && tasksCache.tasks.length > 0) {
    return tasksCache;
  }
  
  console.log(`[${new Date().toLocaleTimeString()}] Loading tasks from Redis...`);
  const data = await redisGet(TASKS_KEY);
  
  if (data && data.tasks && data.tasks.length > 0) {
    tasksCache = data;
    console.log(`[${new Date().toLocaleTimeString()}] ✓ Loaded ${data.tasks.length} tasks from Redis`);
    return data;
  }
  
  // Fallback to local file
  try {
    const fileData = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
    if (fileData.tasks && fileData.tasks.length > 0) {
      tasksCache = fileData;
      // Migrate to Redis
      await redisSet(TASKS_KEY, fileData);
      console.log(`[${new Date().toLocaleTimeString()}] ✓ Migrated ${fileData.tasks.length} tasks to Redis`);
      return fileData;
    }
  } catch (e) {}
  
  return DEFAULT_DATA;
}

// Save tasks - to cache and Redis
async function saveTasks(data) {
  if (!data || !data.tasks) return;
  
  tasksCache = data;
  const saved = await redisSet(TASKS_KEY, data);
  
  if (saved) {
    console.log(`[${new Date().toLocaleTimeString()}] ✓ Saved ${data.tasks.length} tasks to Redis`);
  } else {
    console.log(`[${new Date().toLocaleTimeString()}] ⚠ Redis save failed, using cache only`);
  }
  
  // Also save locally as backup
  try {
    fs.writeFileSync(path.join(__dirname, 'tasks.json'), JSON.stringify(data, null, 2));
  } catch (e) {}
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
      }
      break;
      
    case 'update':
      const toUpdate = data.tasks.find(t => t.id === taskId);
      if (toUpdate && updates) {
        Object.assign(toUpdate, updates);
      }
      break;
      
    case 'delete':
      data.tasks = data.tasks.filter(t => t.id !== taskId);
      break;
      
    case 'comment':
      const toComment = data.tasks.find(t => t.id === taskId);
      if (toComment && comment) {
        toComment.comments = toComment.comments || [];
        toComment.comments.push(comment);
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
Database: ${UPSTASH_URL ? 'Upstash Redis ✓' : 'Local only ⚠'}
`);
  
  // Load initial data
  const data = await getTasks();
  console.log(`✓ Ready with ${data.tasks?.length || 0} tasks`);
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

  // POST /api/generate-image - DALL-E celebration image
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

        const prompt = `A cute, celebratory cartoon illustration for completing the task: "${taskTitle}". Style: minimal, friendly, warm colors, simple shapes, like a greeting card. No text.`;
        
        const requestData = JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard'
        });

        const options = {
          hostname: 'api.openai.com',
          path: '/v1/images/generations',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(requestData)
          }
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.data && result.data[0] && result.data[0].url) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, imageUrl: result.data[0].url }));
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No image generated', details: result }));
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

  // GET /api/health
  if (req.url === '/api/health' && req.method === 'GET') {
    const tasks = await getTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      tasks: tasks.tasks?.length || 0,
      redis: !!UPSTASH_URL
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
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Running at: http://localhost:${PORT}
    `);
  });
});
