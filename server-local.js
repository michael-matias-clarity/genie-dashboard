const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const COLUMNS = ['genie', 'inbox', 'todo', 'in_progress', 'review', 'done'];

// ============ MOCK DATA ============

const MOCK_TASKS = [
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
    column: 'todo',
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
    column: 'todo',
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
];

const MOCK_HISTORY = [
  { type: 'add', taskId: 'task-1', taskTitle: 'Fix login page responsive design', author: 'michael', time: '2026-01-28T09:00:00Z' },
  { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'inbox', to: 'in_progress', author: 'genie', time: '2026-01-28T10:00:00Z' },
  { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'in_progress', to: 'review', author: 'genie', time: '2026-01-29T10:30:00Z' },
  { type: 'comment', taskId: 'task-1', taskTitle: 'Fix login page responsive design', author: 'genie', time: '2026-01-29T10:30:00Z' },
  { type: 'move', taskId: 'task-1', taskTitle: 'Fix login page responsive design', from: 'review', to: 'done', author: 'michael', time: '2026-01-29T14:00:00Z' },
  { type: 'add', taskId: 'task-2', taskTitle: 'Implement dark mode toggle', author: 'michael', time: '2026-01-30T11:00:00Z' },
  { type: 'move', taskId: 'task-2', taskTitle: 'Implement dark mode toggle', from: 'inbox', to: 'in_progress', author: 'genie', time: '2026-01-31T09:00:00Z' },
  { type: 'move', taskId: 'task-2', taskTitle: 'Implement dark mode toggle', from: 'in_progress', to: 'review', author: 'genie', time: '2026-02-01T16:00:00Z' },
  { type: 'add', taskId: 'task-3', taskTitle: 'Add keyboard shortcuts documentation', author: 'michael', time: '2026-02-01T08:00:00Z' },
  { type: 'move', taskId: 'task-3', taskTitle: 'Add keyboard shortcuts documentation', from: 'inbox', to: 'in_progress', author: 'genie', time: '2026-02-02T09:00:00Z' },
  { type: 'add', taskId: 'task-4', taskTitle: 'Optimize image loading performance', author: 'michael', time: '2026-02-01T14:00:00Z' },
  { type: 'move', taskId: 'task-4', taskTitle: 'Optimize image loading performance', from: 'inbox', to: 'todo', author: 'michael', time: '2026-02-01T14:05:00Z' },
  { type: 'add', taskId: 'task-5', taskTitle: 'Weekly database backup verification', author: 'michael', time: '2026-02-02T07:00:00Z' },
  { type: 'add', taskId: 'task-6', taskTitle: 'Research OAuth2 providers for SSO', author: 'michael', time: '2026-02-02T07:30:00Z' },
  { type: 'move', taskId: 'task-6', taskTitle: 'Research OAuth2 providers for SSO', from: 'inbox', to: 'genie', author: 'michael', time: '2026-02-02T07:35:00Z' },
  { type: 'add', taskId: 'task-7', taskTitle: 'Fix memory leak in websocket handler', author: 'michael', time: '2026-02-02T10:00:00Z' },
  { type: 'add', taskId: 'task-8', taskTitle: 'Update dependencies to latest versions', author: 'michael', time: '2026-02-02T11:00:00Z' }
];

// ============ IN-MEMORY STATE ============

let tasks = JSON.parse(JSON.stringify(MOCK_TASKS));
let history = JSON.parse(JSON.stringify(MOCK_HISTORY));

// ============ DATA ACCESS ============

function getTasks() {
  return { columns: COLUMNS, tasks };
}

function getHistory() {
  return history.slice(0, 100);
}

function addHistoryEntry(entry) {
  entry.time = entry.time || new Date().toISOString();
  history.unshift(entry);
  history = history.slice(0, 1000);
}

// ============ TASK OPERATIONS ============

function handleTaskOperation(body) {
  const { action, taskId, task, updates, comment, author: requestAuthor } = body;
  
  switch (action) {
    case 'add':
      if (task) {
        task.id = task.id || Date.now().toString();
        task.created = task.created || new Date().toISOString().split('T')[0];
        task.comments = task.comments || [];
        tasks.push(task);
        addHistoryEntry({
          type: 'add',
          taskId: task.id,
          taskTitle: task.title,
          author: 'michael'
        });
      }
      break;
      
    case 'update':
      const toUpdate = tasks.find(t => t.id === taskId);
      if (toUpdate && updates) {
        const oldColumn = toUpdate.column;
        Object.assign(toUpdate, updates);
        if (updates.column && updates.column !== oldColumn) {
          let moveAuthor = requestAuthor || 'unknown';
          if (moveAuthor === 'unknown') {
            if (updates.column === 'done') moveAuthor = 'michael';
            else if (updates.column === 'review') moveAuthor = 'genie';
            else if (updates.column === 'in_progress') moveAuthor = 'genie';
          }
          addHistoryEntry({
            type: 'move',
            taskId,
            taskTitle: toUpdate.title,
            from: oldColumn,
            to: updates.column,
            author: moveAuthor
          });
        }
      }
      break;
      
    case 'delete':
      const toDelete = tasks.find(t => t.id === taskId);
      if (toDelete) {
        addHistoryEntry({
          type: 'delete',
          taskId,
          taskTitle: toDelete.title,
          author: 'michael'
        });
      }
      tasks = tasks.filter(t => t.id !== taskId);
      break;
      
    case 'comment':
      const toComment = tasks.find(t => t.id === taskId);
      if (toComment && comment) {
        toComment.comments = toComment.comments || [];
        toComment.comments.push(comment);
        addHistoryEntry({
          type: 'comment',
          taskId,
          taskTitle: toComment.title,
          author: comment.author || 'unknown'
        });
      }
      break;
      
    default:
      // Full replace (bulk save)
      if (body.tasks) {
        tasks = body.tasks;
      }
  }
}

// ============ SERVER ============

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // GET /api/tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const data = getTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  
  // POST /api/tasks
  if (req.url === '/api/tasks' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      handleTaskOperation(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/history
  if (req.url.startsWith('/api/history') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const author = url.searchParams.get('author');
    let filtered = getHistory();
    if (author && author !== 'all') {
      filtered = filtered.filter(h => h.author === author);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filtered));
    return;
  }
  
  // GET /api/health
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      mode: 'local',
      tasks: tasks.length,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  // GET /api/console (mock - always inactive locally)
  if (req.url === '/api/console' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active: false, sessions: [], message: 'Local dev mode' }));
    return;
  }
  
  // Static files
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
  console.log(`
🪔 The Lamp - LOCAL DEV MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 http://localhost:${PORT}
📦 ${tasks.length} mock tasks loaded
📝 ${history.length} history entries

⚠️  Data is in-memory only (resets on restart)
`);
});
