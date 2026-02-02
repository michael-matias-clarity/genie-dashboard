#!/usr/bin/env node
/**
 * Automated tests for server-supabase.js
 * Run: node test-supabase.js [staging|production]
 * 
 * Tests all critical paths before deployment.
 */

const BASE_URL = process.argv[2] === 'production' 
  ? 'https://genie-dashboard.onrender.com'
  : 'https://genie-dashboard-staging.onrender.com';

const SUPABASE_URL = 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

let passed = 0;
let failed = 0;
const errors = [];

// Test utilities
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    console.log(`✗ ${name}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function apiGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  return res.json();
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function supabaseGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
}

async function supabaseDelete(table, query) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
}

// ============ TESTS ============

async function runTests() {
  console.log(`\n🧪 Testing: ${BASE_URL}\n`);
  
  const testTaskId = `test-${Date.now()}`;
  const testTaskId2 = `test-${Date.now()}-2`;
  
  // --- GET /api/tasks ---
  await test('GET /api/tasks returns tasks array', async () => {
    const data = await apiGet('/api/tasks');
    assert(Array.isArray(data.tasks), 'tasks should be array');
    assert(Array.isArray(data.columns), 'columns should be array');
  });

  await test('GET /api/tasks includes comments', async () => {
    const data = await apiGet('/api/tasks');
    const withComments = data.tasks.find(t => t.comments && t.comments.length > 0);
    // May not always have comments, so just check structure
    assert(data.tasks.every(t => Array.isArray(t.comments)), 'all tasks should have comments array');
  });

  // --- Bulk save: Add new task ---
  await test('Bulk save: creates new task', async () => {
    const beforeCount = (await supabaseGet('tasks', '?select=id')).length;
    
    await apiPost('/api/tasks', {
      columns: ['genie','inbox','todo','in_progress','review','done'],
      tasks: [{
        id: testTaskId,
        title: 'Test Task - Automated',
        column: 'inbox',
        type: 'single',
        priority: 'medium',
        comments: []
      }]
    });
    
    const afterCount = (await supabaseGet('tasks', '?select=id')).length;
    assert(afterCount >= beforeCount, 'task count should not decrease');
    
    const created = await supabaseGet('tasks', `?id=eq.${testTaskId}`);
    assert(created.length === 1, 'task should exist in Supabase');
    assert(created[0].title === 'Test Task - Automated', 'title should match');
  });

  // --- CRITICAL: Bulk save doesn't delete other tasks ---
  await test('CRITICAL: Bulk save does NOT delete existing tasks', async () => {
    const beforeTasks = await supabaseGet('tasks', '?select=id');
    const beforeCount = beforeTasks.length;
    
    // Send bulk save with just ONE task (simulates frontend partial save)
    await apiPost('/api/tasks', {
      columns: ['genie','inbox','todo','in_progress','review','done'],
      tasks: [{
        id: testTaskId2,
        title: 'Single Task Save Test',
        column: 'inbox',
        type: 'single',
        priority: 'low',
        comments: []
      }]
    });
    
    const afterTasks = await supabaseGet('tasks', '?select=id');
    const afterCount = afterTasks.length;
    
    // Should have added 1, not deleted all others
    assert(afterCount >= beforeCount, `Task count dropped from ${beforeCount} to ${afterCount}! DATA LOSS BUG!`);
    assert(afterCount === beforeCount + 1 || afterCount === beforeCount, 'Should add task, not delete others');
  });

  // --- Bulk save: Updates existing task ---
  await test('Bulk save: updates existing task', async () => {
    await apiPost('/api/tasks', {
      columns: ['genie','inbox','todo','in_progress','review','done'],
      tasks: [{
        id: testTaskId,
        title: 'Test Task - UPDATED',
        column: 'todo',
        type: 'single',
        priority: 'high',
        comments: []
      }]
    });
    
    const updated = await supabaseGet('tasks', `?id=eq.${testTaskId}`);
    assert(updated[0].title === 'Test Task - UPDATED', 'title should be updated');
    assert(updated[0].column_name === 'todo', 'column should be updated');
    assert(updated[0].priority === 'high', 'priority should be updated');
  });

  // --- Bulk save: Syncs new comments ---
  await test('Bulk save: syncs new comments', async () => {
    await apiPost('/api/tasks', {
      columns: ['genie','inbox','todo','in_progress','review','done'],
      tasks: [{
        id: testTaskId,
        title: 'Test Task - UPDATED',
        column: 'todo',
        type: 'single',
        priority: 'high',
        comments: [
          { author: 'test-bot', text: 'Automated test comment' }
        ]
      }]
    });
    
    const comments = await supabaseGet('comments', `?task_id=eq.${testTaskId}`);
    assert(comments.length >= 1, 'comment should exist');
    assert(comments.some(c => c.text === 'Automated test comment'), 'comment text should match');
  });

  // --- Individual action: add ---
  await test('Action add: creates task', async () => {
    const actionTaskId = `action-test-${Date.now()}`;
    
    const result = await apiPost('/api/tasks', {
      action: 'add',
      task: {
        id: actionTaskId,
        title: 'Action Add Test',
        column: 'inbox'
      }
    });
    
    assert(result.ok === true, 'should return ok');
    
    const created = await supabaseGet('tasks', `?id=eq.${actionTaskId}`);
    assert(created.length === 1, 'task should exist');
    
    // Cleanup
    await supabaseDelete('tasks', `?id=eq.${actionTaskId}`);
  });

  // --- Individual action: comment ---
  await test('Action comment: adds comment', async () => {
    const result = await apiPost('/api/tasks', {
      action: 'comment',
      taskId: testTaskId,
      comment: { author: 'test-bot', text: 'Action comment test' }
    });
    
    assert(result.ok === true, 'should return ok');
    
    const comments = await supabaseGet('comments', `?task_id=eq.${testTaskId}&text=eq.Action%20comment%20test`);
    assert(comments.length >= 1, 'comment should exist');
  });

  // --- GET /api/history ---
  await test('GET /api/history returns audit log', async () => {
    const history = await apiGet('/api/history');
    assert(Array.isArray(history), 'history should be array');
  });

  // --- Data integrity: GET returns what was POSTed ---
  await test('Data integrity: GET returns saved data', async () => {
    const data = await apiGet('/api/tasks');
    const task = data.tasks.find(t => t.id === testTaskId);
    
    assert(task, 'test task should be in GET response');
    assert(task.title === 'Test Task - UPDATED', 'title should match');
    assert(task.comments.some(c => c.text === 'Automated test comment'), 'comments should be included');
  });

  // --- Validation tests ---
  await test('Validation: rejects empty title', async () => {
    const result = await apiPost('/api/tasks', {
      action: 'add',
      task: { title: '', column: 'inbox' }
    });
    assert(result.ok === false, 'should reject empty title');
    assert(result.errors && result.errors.length > 0, 'should have errors');
  });

  await test('Validation: rejects invalid column', async () => {
    const result = await apiPost('/api/tasks', {
      action: 'add',
      task: { title: 'Test', column: 'invalid_column' }
    });
    assert(result.ok === false, 'should reject invalid column');
  });

  await test('Health check endpoint works', async () => {
    const result = await apiGet('/api/health');
    assert(result.status === 'ok', 'should return ok status');
    assert(result.supabase === true, 'should have supabase configured');
  });

  // --- Cleanup ---
  await test('Cleanup: delete test tasks', async () => {
    await supabaseDelete('comments', `?task_id=eq.${testTaskId}`);
    await supabaseDelete('comments', `?task_id=eq.${testTaskId2}`);
    await supabaseDelete('tasks', `?id=eq.${testTaskId}`);
    await supabaseDelete('tasks', `?id=eq.${testTaskId2}`);
    
    const remaining = await supabaseGet('tasks', `?id=eq.${testTaskId}`);
    assert(remaining.length === 0, 'test task should be deleted');
  });

  // --- Summary ---
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\nFailures:');
    errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed! Safe to deploy.\n');
    process.exit(0);
  }
}

// Run
if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_ANON_KEY environment variable required');
  process.exit(1);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
