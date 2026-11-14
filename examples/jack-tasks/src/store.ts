/**
 * Acme Tasks — the data layer. In memory, seeded with two users so the
 * example can show per-user isolation: Alice's key never sees Bob's work.
 *
 * Nothing here knows about Jack or MCP. That is the point of the example:
 * this is an ordinary API, and Jack is added without changing it.
 */
export type Status = 'todo' | 'in_progress' | 'done';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  ownerId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  labels: string[];
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface ActivityEvent {
  at: string;
  type: 'task.created' | 'task.updated' | 'task.completed' | 'task.deleted' | 'comment.added' | 'project.created';
  userId: string;
  taskId: string | null;
  summary: string;
}

/** Demo API keys. A real app stores hashes; these are printed in the README on purpose. */
export const DEMO_KEYS: Record<string, string> = {
  tk_demo_alice: 'usr_alice',
  tk_demo_bob: 'usr_bob',
};

export class TasksStore {
  readonly users = new Map<string, User>();
  readonly projects = new Map<string, Project>();
  readonly tasks = new Map<string, Task>();
  readonly comments = new Map<string, Comment>();
  readonly events: ActivityEvent[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, '0')}`;
  }

  private stamp() {
    return this.now().toISOString();
  }

  private log(userId: string, type: ActivityEvent['type'], taskId: string | null, summary: string) {
    this.events.push({ at: this.stamp(), type, userId, taskId, summary });
  }

  userForKey(key: string): User | null {
    const id = DEMO_KEYS[key];
    return id ? (this.users.get(id) ?? null) : null;
  }

  createProject(ownerId: string, input: { name: string; description?: string | undefined }): Project {
    const p: Project = { id: this.id('prj'), ownerId, name: input.name, description: input.description ?? null, createdAt: this.stamp() };
    this.projects.set(p.id, p);
    this.log(ownerId, 'project.created', null, `Created project "${p.name}"`);
    return p;
  }

  createTask(
    ownerId: string,
    input: { projectId: string; title: string; description?: string | undefined; priority?: Priority | undefined; labels?: string[] | undefined; dueDate?: string | undefined },
  ): Task {
    const t: Task = {
      id: this.id('tsk'),
      ownerId,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
      status: 'todo',
      priority: input.priority ?? 'normal',
      labels: [...new Set(input.labels ?? [])],
      dueDate: input.dueDate ?? null,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
    };
    this.tasks.set(t.id, t);
    this.log(ownerId, 'task.created', t.id, `Created "${t.title}"`);
    return t;
  }

  updateTask(task: Task, patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate' | 'projectId' | 'labels'>>): Task {
    const wasDone = task.status === 'done';
    Object.assign(task, patch, { updatedAt: this.stamp() });
    const completed = !wasDone && task.status === 'done';
    this.log(task.ownerId, completed ? 'task.completed' : 'task.updated', task.id, `${completed ? 'Completed' : 'Updated'} "${task.title}"`);
    return task;
  }

  deleteTask(task: Task): void {
    this.tasks.delete(task.id);
    for (const [id, c] of this.comments) if (c.taskId === task.id) this.comments.delete(id);
    this.log(task.ownerId, 'task.deleted', task.id, `Deleted "${task.title}"`);
  }

  addComment(task: Task, authorId: string, body: string): Comment {
    const c: Comment = { id: this.id('cmt'), taskId: task.id, authorId, body, createdAt: this.stamp() };
    this.comments.set(c.id, c);
    this.log(authorId, 'comment.added', task.id, `Commented on "${task.title}"`);
    return c;
  }

  commentCount(taskId: string): number {
    let n = 0;
    for (const c of this.comments.values()) if (c.taskId === taskId) n++;
    return n;
  }
}

/** Two users, a few projects and tasks, and a long activity history (to exercise truncation). */
export function seed(store: TasksStore): TasksStore {
  store.users.set('usr_alice', { id: 'usr_alice', name: 'Alice Martin', email: 'alice@acme.test' });
  store.users.set('usr_bob', { id: 'usr_bob', name: 'Bob Okafor', email: 'bob@acme.test' });

  const launch = store.createProject('usr_alice', { name: 'Website launch', description: 'Public launch of the new marketing site.' });
  const ops = store.createProject('usr_alice', { name: 'Operations' });
  const t1 = store.createTask('usr_alice', { projectId: launch.id, title: 'Write launch announcement', priority: 'high', labels: ['marketing'], dueDate: '2026-11-20' });
  store.createTask('usr_alice', { projectId: launch.id, title: 'Fix broken links on pricing page', priority: 'urgent', labels: ['bug', 'web'] });
  const t3 = store.createTask('usr_alice', { projectId: launch.id, title: 'Set up analytics', labels: ['web'] });
  store.createTask('usr_alice', { projectId: ops.id, title: 'Renew TLS certificates', priority: 'high', labels: ['infra'], dueDate: '2026-11-15' });
  store.createTask('usr_alice', { projectId: ops.id, title: 'Rotate on-call schedule', priority: 'low' });
  store.updateTask(t3, { status: 'done' });
  store.updateTask(t1, { status: 'in_progress' });
  store.addComment(t1, 'usr_alice', 'First draft is in the shared folder.');
  // A long tail of history so the activity report is bigger than a tool should return.
  for (let i = 0; i < 120; i++) store.updateTask(t1, { description: `Draft revision ${i + 1}` });

  const bobs = store.createProject('usr_bob', { name: 'Hiring', description: 'Engineering hiring pipeline.' });
  store.createTask('usr_bob', { projectId: bobs.id, title: 'Review take-home submissions', priority: 'high' });
  store.createTask('usr_bob', { projectId: bobs.id, title: 'Schedule onsite interviews' });
  return store;
}
