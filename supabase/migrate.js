// Migration script: Redis -> Supabase
// Run: node supabase/migrate.js

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yjvecmrsfivmgfnikxsc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const RENDER_API = 'https://genie-dashboard.onrender.com/api/tasks';

async function migrate() {
  if (!SUPABASE_KEY) {
    console.error('Set SUPABASE_ANON_KEY env var');
    process.exit(1);
  }

  console.log('Fetching current tasks from Redis...');
  const response = await fetch(RENDER_API);
  const data = await response.json();
  
  console.log(`Found ${data.tasks.length} tasks to migrate`);

  for (const task of data.tasks) {
    console.log(`Migrating: ${task.id} - ${task.title.substring(0, 40)}...`);
    
    // Insert task
    const taskPayload = {
      id: task.id,
      title: task.title,
      description: task.description || null,
      success_criteria: task.successCriteria || null,
      user_journey: task.userJourney || null,
      column_name: task.column,
      priority: task.priority || 'medium',
      task_type: task.type || 'single',
      created_at: task.created ? new Date(task.created).toISOString() : new Date().toISOString(),
      seen_at: task.seenAt || null,
      needs_laptop: task.needsLaptop || false
    };

    const taskRes = await fetch(`${SUPABASE_URL}/rest/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal,resolution=merge-duplicates'
      },
      body: JSON.stringify(taskPayload)
    });

    if (!taskRes.ok) {
      const err = await taskRes.text();
      console.error(`  Task failed: ${err}`);
      continue;
    }

    // Insert comments
    if (task.comments && task.comments.length > 0) {
      for (const comment of task.comments) {
        const commentPayload = {
          task_id: task.id,
          author: comment.author,
          text: comment.text,
          created_at: comment.time ? new Date(comment.time).toISOString() : new Date().toISOString()
        };

        const commentRes = await fetch(`${SUPABASE_URL}/rest/v1/comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(commentPayload)
        });

        if (!commentRes.ok) {
          console.error(`  Comment failed: ${await commentRes.text()}`);
        }
      }
      console.log(`  + ${task.comments.length} comments`);
    }
  }

  console.log('\n✓ Migration complete!');
}

migrate().catch(console.error);
