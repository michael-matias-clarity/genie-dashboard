const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://yjvecmrsfivmgfnikxsc.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqdmVjbXJzZml2bWdmbmlreHNjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA0MjczMCwiZXhwIjoyMDg1NjE4NzMwfQ.0JUMsZRaRJtnjvVKNjHgE8EQakL_fktym7Kvb9xZqiY'
);

async function findUnread() {
  // Get tasks
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, title, column_name, archived')
    .eq('archived', false);
  
  if (error) { console.error('Error tasks:', error); return; }
  
  // Get comments
  const { data: comments, error: commentsError } = await supabase
    .from('task_comments')
    .select('*');
    
  if (commentsError) { console.error('Error comments:', commentsError); return; }
  
  // Get last reads
  const { data: lastReads, error: readsError } = await supabase
    .from('task_reads')
    .select('*');
    
  if (readsError) { console.error('Error reads:', readsError); return; }
  
  const lastReadMap = {};
  lastReads.forEach(r => { lastReadMap[r.task_id] = new Date(r.last_read_at).getTime(); });
  
  const taskComments = {};
  comments.forEach(c => {
    if (!taskComments[c.task_id]) taskComments[c.task_id] = [];
    taskComments[c.task_id].push(c);
  });
  
  const unreadTasks = tasks.filter(t => {
    const tComments = taskComments[t.id] || [];
    const lastRead = lastReadMap[t.id] || 0;
    const genieComments = tComments.filter(c => c.author === 'genie');
    const unreadCount = genieComments.filter(c => {
      const commentTime = new Date(c.created_at).getTime();
      return commentTime > lastRead;
    }).length;
    return unreadCount > 0;
  });
  
  console.log('Found ' + unreadTasks.length + ' tasks with unread Genie comments:\n');
  
  unreadTasks.forEach((t, i) => {
    const tComments = taskComments[t.id] || [];
    const lastRead = lastReadMap[t.id] || 0;
    const genieComments = tComments.filter(c => c.author === 'genie');
    const unreadComments = genieComments.filter(c => new Date(c.created_at).getTime() > lastRead);
    console.log((i+1) + '. "' + t.title + '"');
    console.log('   Column: ' + t.column_name);
    console.log('   Unread: ' + unreadComments.length + ' genie comment(s)');
    if (unreadComments.length > 0) {
      unreadComments.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      const latestMsg = unreadComments[0].content || '';
      console.log('   Latest genie msg: "' + latestMsg.substring(0, 120) + (latestMsg.length > 120 ? '...' : '') + '"');
    }
    console.log('');
  });
}

findUnread().catch(e => console.error(e));
