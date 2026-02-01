const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const TASKS_FILE = path.join(__dirname, 'tasks.json');
// Use Gist API instead of raw URL (raw URL has aggressive caching)
const GIST_API_URL = 'https://api.github.com/gists/efa1580eefda602e38d5517799c7e84e';
const REFRESH_INTERVAL = 5 * 60 * 1000; // Refresh from gist every 5 minutes

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const DEFAULT_DATA = { columns: ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'], tasks: [] };

// In-memory cache (source of truth while server is running)
let tasksCache = null;
let lastGistFetch = 0;

function loadTasksFromFile() {
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (data.tasks && data.tasks.length > 0) return data;
    return null;
  } catch (e) {
    return null;
  }
}

function saveTasksToFile(data) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save to file:', e.message);
  }
}

// Fetch from Gist API (no caching issues unlike raw URL)
function fetchFromGist() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/gists/efa1580eefda602e38d5517799c7e84e',
      headers: {
        'User-Agent': 'Genie-Dashboard',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const gist = JSON.parse(data);
          const content = gist.files?.['tasks.json']?.content;
          if (!content) {
            reject(new Error('No tasks.json in gist'));
            return;
          }
          const parsed = JSON.parse(content);
          if (parsed.tasks && Array.isArray(parsed.tasks)) {
            resolve(parsed);
          } else {
            reject(new Error('Invalid gist data structure'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Get tasks - always returns valid data
async function getTasks() {
  // If cache is empty or stale, try to refresh from gist
  const now = Date.now();
  const cacheEmpty = !tasksCache || tasksCache.tasks.length === 0;
  const cacheStale = (now - lastGistFetch) > REFRESH_INTERVAL;
  
  if (cacheEmpty || cacheStale) {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Fetching from Gist (${cacheEmpty ? 'cache empty' : 'cache stale'})...`);
      const gistData = await fetchFromGist();
      if (gistData.tasks.length > 0) {
        tasksCache = gistData;
        lastGistFetch = now;
        saveTasksToFile(gistData);
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Loaded ${gistData.tasks.length} tasks from Gist`);
      }
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Gist fetch failed:`, e.message);
      // Fall back to file if gist fails
      if (cacheEmpty) {
        const fileData = loadTasksFromFile();
        if (fileData) {
          tasksCache = fileData;
          console.log(`[${new Date().toLocaleTimeString()}] ✓ Loaded ${fileData.tasks.length} tasks from file`);
        }
      }
    }
  }
  
  return tasksCache || DEFAULT_DATA;
}

// Save tasks - updates cache and file
function saveTasks(data) {
  if (!data || !data.tasks) return;
  tasksCache = data;
  saveTasksToFile(data);
  console.log(`[${new Date().toLocaleTimeString()}] Saved ${data.tasks.length} tasks`);
}

// Handle task operations (add, update, delete, comment)
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
      // Full replace (legacy)
      if (body.tasks) {
        data.columns = body.columns || data.columns;
        data.tasks = body.tasks;
      }
  }
  
  return data;
}

// Initialize on startup
async function init() {
  console.log(`
🧞 Genie Task Dashboard
━━━━━━━━━━━━━━━━━━━━━━━
Starting up...
`);
  
  // Always fetch from gist on startup
  try {
    const gistData = await fetchFromGist();
    if (gistData.tasks.length > 0) {
      tasksCache = gistData;
      lastGistFetch = Date.now();
      saveTasksToFile(gistData);
      console.log(`✓ Initialized with ${gistData.tasks.length} tasks from Gist`);
    } else {
      throw new Error('Gist has no tasks');
    }
  } catch (e) {
    console.log('Gist fetch failed, trying local file...');
    const fileData = loadTasksFromFile();
    if (fileData && fileData.tasks.length > 0) {
      tasksCache = fileData;
      console.log(`✓ Initialized with ${fileData.tasks.length} tasks from file`);
    } else {
      tasksCache = DEFAULT_DATA;
      console.log('⚠ Starting with empty data');
    }
  }
  
  // Periodic refresh from gist
  setInterval(async () => {
    try {
      const gistData = await fetchFromGist();
      if (gistData.tasks.length > 0) {
        // Only update if gist has more or equal tasks (prevent data loss)
        if (gistData.tasks.length >= (tasksCache?.tasks?.length || 0)) {
          tasksCache = gistData;
          lastGistFetch = Date.now();
          saveTasksToFile(gistData);
          console.log(`[${new Date().toLocaleTimeString()}] ✓ Refreshed ${gistData.tasks.length} tasks from Gist`);
        }
      }
    } catch (e) {
      // Silent fail on periodic refresh
    }
  }, REFRESH_INTERVAL);
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

  // GET /api/tasks - return current tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const tasks = await getTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  // POST /api/tasks - update tasks
  if (req.url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let data = await getTasks();
        data = handleTaskOperation({ ...data }, payload);
        saveTasks(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/restore - force refresh from gist
  if (req.url === '/api/restore' && req.method === 'POST') {
    try {
      const gistData = await fetchFromGist();
      tasksCache = gistData;
      lastGistFetch = Date.now();
      saveTasksToFile(gistData);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restored: gistData.tasks?.length || 0 }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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

// Start server
init().then(() => {
  server.listen(PORT, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━
Running at: http://localhost:${PORT}
Cloud backup: GitHub Gist
Auto-refresh: Every 5 minutes
    `);
  });
});
