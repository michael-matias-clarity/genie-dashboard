const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const GIST_URL = 'https://gist.githubusercontent.com/michael-matias-clarity/efa1580eefda602e38d5517799c7e84e/raw/tasks.json';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const DEFAULT_DATA = { columns: ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'], tasks: [] };

function loadTasks() {
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (data.tasks && data.tasks.length > 0) return data;
    return DEFAULT_DATA;
  } catch (e) {
    return DEFAULT_DATA;
  }
}

function saveTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// Fetch from Gist (cloud backup)
function fetchFromGist() {
  return new Promise((resolve, reject) => {
    https.get(GIST_URL + '?t=' + Date.now(), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// On startup, try to restore from gist if local is empty
async function initData() {
  const local = loadTasks();
  if (local.tasks.length === 0) {
    console.log('Local data empty, fetching from Gist...');
    try {
      const gistData = await fetchFromGist();
      if (gistData.tasks && gistData.tasks.length > 0) {
        saveTasks(gistData);
        console.log(`✓ Restored ${gistData.tasks.length} tasks from Gist`);
      }
    } catch (e) {
      console.log('Could not fetch from Gist:', e.message);
    }
  } else {
    console.log(`✓ Loaded ${local.tasks.length} tasks from local file`);
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/api/tasks' && req.method === 'GET') {
    const tasks = loadTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  if (req.url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        saveTasks(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
        console.log(`[${new Date().toLocaleTimeString()}] Saved ${data.tasks?.length || 0} tasks`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Endpoint to trigger gist restore
  if (req.url === '/api/restore' && req.method === 'POST') {
    fetchFromGist()
      .then(data => {
        saveTasks(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: data.tasks?.length || 0 }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
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

// Initialize and start
initData().then(() => {
  server.listen(PORT, () => {
    console.log(`
🧞 Genie Task Dashboard
━━━━━━━━━━━━━━━━━━━━━━━
Running at: http://localhost:${PORT}
Tasks file: ${TASKS_FILE}
Cloud backup: GitHub Gist

Press Ctrl+C to stop
    `);
  });
});
