#!/usr/bin/env node
/**
 * Test suite for The Lamp dashboard
 * Run: node test.js
 */

const http = require('http');
const assert = require('assert');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3456';
let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn()
    .then(() => {
      console.log(`✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${err.message}`);
      failed++;
    });
}

function fetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function runTests() {
  console.log(`\n🧪 Testing The Lamp Dashboard`);
  console.log(`   URL: ${BASE_URL}\n`);

  // Test 1: Health endpoint
  await test('GET /api/health returns status ok', async () => {
    const res = await fetch('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
    assert.strictEqual(typeof res.data.redis, 'boolean');
    assert.strictEqual(typeof res.data.tasks, 'number');
  });

  // Test 2: Get tasks
  await test('GET /api/tasks returns tasks array', async () => {
    const res = await fetch('/api/tasks');
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.columns), 'columns should be array');
    assert(Array.isArray(res.data.tasks), 'tasks should be array');
  });

  // Test 3: Add a task
  const testTaskId = `test-${Date.now()}`;
  await test('POST /api/tasks can add a task', async () => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        action: 'add',
        task: {
          id: testTaskId,
          title: 'Test Task',
          description: 'This is a test',
          column: 'inbox',
          priority: 'medium',
          type: 'single'
        }
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
  });

  // Test 4: Verify task was added
  await test('Added task appears in task list', async () => {
    const res = await fetch('/api/tasks');
    const task = res.data.tasks.find(t => t.id === testTaskId);
    assert(task, 'Test task should exist');
    assert.strictEqual(task.title, 'Test Task');
  });

  // Test 5: Update task
  await test('POST /api/tasks can update a task', async () => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        action: 'update',
        taskId: testTaskId,
        updates: { column: 'todo', priority: 'high' }
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
  });

  // Test 6: Verify update
  await test('Updated task has new values', async () => {
    const res = await fetch('/api/tasks');
    const task = res.data.tasks.find(t => t.id === testTaskId);
    assert.strictEqual(task.column, 'todo');
    assert.strictEqual(task.priority, 'high');
  });

  // Test 7: Add comment
  await test('POST /api/tasks can add a comment', async () => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        action: 'comment',
        taskId: testTaskId,
        comment: { author: 'genie', text: 'Test comment', time: 'now' }
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
  });

  // Test 8: Verify comment
  await test('Comment appears on task', async () => {
    const res = await fetch('/api/tasks');
    const task = res.data.tasks.find(t => t.id === testTaskId);
    assert(task.comments.length > 0, 'Should have comments');
    assert.strictEqual(task.comments[0].text, 'Test comment');
  });

  // Test 9: Delete task
  await test('POST /api/tasks can delete a task', async () => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'delete', taskId: testTaskId }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
  });

  // Test 10: Verify deletion
  await test('Deleted task no longer exists', async () => {
    const res = await fetch('/api/tasks');
    const task = res.data.tasks.find(t => t.id === testTaskId);
    assert(!task, 'Test task should be deleted');
  });

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\n❌ Tests failed!\n');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
