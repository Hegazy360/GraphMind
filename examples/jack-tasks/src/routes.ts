/**
 * Acme Tasks — every endpoint, its schemas and its handler. The OpenAPI
 * document is generated from this file (see openapi.ts).
 *
 * The descriptions are written for HUMANS reading API docs, as in most real
 * codebases. The example's jack.yaml then rewrites a few of them for models,
 * which shows the curation step rather than hiding it.
 */
import { z } from 'zod';
import { HttpError, route, type RouteDef } from './route.js';
import type { Comment, Project, Task, TasksStore, User } from './store.js';

// ---------------------------------------------------------------- schemas --

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const status = z.enum(['todo', 'in_progress', 'done']).describe('Workflow state');
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const label = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes');

const UserOut = z.object({ id: z.string(), name: z.string(), email: z.string() });
const ProjectOut = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  openTasks: z.number().int(),
  createdAt: z.string(),
});
const TaskOut = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status,
  priority,
  labels: z.array(z.string()),
  dueDate: z.string().nullable(),
  commentCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const CommentOut = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.object({ id: z.string(), name: z.string() }),
  body: z.string(),
  createdAt: z.string(),
});
const TaskPage = z.object({
  items: z.array(TaskOut),
  nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page; null on the last page'),
});
const ActivityReport = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({ created: z.number().int(), completed: z.number().int(), comments: z.number().int() }),
  events: z.array(
    z.object({ at: z.string(), type: z.string(), taskId: z.string().nullable(), summary: z.string() }),
  ),
});

const TaskIdParams = z.object({ taskId: z.string().describe('Task id, e.g. tsk_0003') });

// ---------------------------------------------------------------- helpers --

function ownTask(store: TasksStore, user: User, id: string): Task {
  const t = store.tasks.get(id);
  // 404, not 403, for other users' tasks: ids are not an oracle.
  if (!t || t.ownerId !== user.id) throw new HttpError(404, 'Task not found', `no task ${id}`);
  return t;
}

function ownProject(store: TasksStore, user: User, id: string): Project {
  const p = store.projects.get(id);
  if (!p || p.ownerId !== user.id) throw new HttpError(404, 'Project not found', `no project ${id}`);
  return p;
}

const taskOut = (store: TasksStore, t: Task) => ({
  id: t.id,
  projectId: t.projectId,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  labels: t.labels,
  dueDate: t.dueDate,
  commentCount: store.commentCount(t.id),
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const commentOut = (store: TasksStore, c: Comment) => {
  const author = store.users.get(c.authorId);
  return { id: c.id, taskId: c.taskId, author: { id: c.authorId, name: author?.name ?? 'unknown' }, body: c.body, createdAt: c.createdAt };
};

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

function filterTasks(store: TasksStore, user: User, q: { status?: string | undefined; projectId?: string | undefined; label?: string | undefined; q?: string | undefined }) {
  const needle = q.q?.toLowerCase();
  return [...store.tasks.values()]
    .filter((t) => t.ownerId === user.id)
    .filter((t) => q.status === undefined || t.status === q.status)
    .filter((t) => q.projectId === undefined || t.projectId === q.projectId)
    .filter((t) => q.label === undefined || t.labels.includes(q.label))
    .filter((t) => needle === undefined || t.title.toLowerCase().includes(needle) || (t.description ?? '').toLowerCase().includes(needle))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.id.localeCompare(b.id));
}

// ----------------------------------------------------------------- routes --

export const routes: RouteDef[] = [
  route({
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Get the current user',
    description: 'Returns the account the API key belongs to.',
    tags: ['account'],
    response: { status: 200, description: 'The current user', schema: UserOut },
    handler: ({ user }) => ({ status: 200, body: user }),
  }),

  route({
    method: 'get',
    path: '/projects',
    operationId: 'listProjects',
    summary: 'List projects',
    description: 'All projects owned by the current user, with the number of tasks not yet done.',
    tags: ['projects'],
    response: { status: 200, description: 'Projects', schema: z.object({ items: z.array(ProjectOut) }) },
    handler: ({ user, store }) => {
      const items = [...store.projects.values()]
        .filter((p) => p.ownerId === user.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          openTasks: [...store.tasks.values()].filter((t) => t.projectId === p.id && t.status !== 'done').length,
          createdAt: p.createdAt,
        }));
      return { status: 200, body: { items } };
    },
  }),

  route({
    method: 'post',
    path: '/projects',
    operationId: 'createProject',
    summary: 'Create a project',
    tags: ['projects'],
    body: z.object({ name: z.string().min(1).max(100), description: z.string().max(1000).optional() }),
    response: { status: 201, description: 'The new project', schema: ProjectOut },
    errors: [400, 409],
    handler: ({ user, store, body }) => {
      const clash = [...store.projects.values()].some((p) => p.ownerId === user.id && p.name.toLowerCase() === body.name.toLowerCase());
      if (clash) throw new HttpError(409, 'Project exists', `you already have a project named "${body.name}"`);
      const p = store.createProject(user.id, body);
      return { status: 201, body: { ...p, openTasks: 0, ownerId: undefined } };
    },
  }),

  route({
    method: 'get',
    path: '/tasks',
    operationId: 'listTasks',
    summary: 'List tasks',
    description: 'Tasks owned by the current user, most urgent first. Results are paginated.',
    tags: ['tasks'],
    query: z.object({
      status: status.optional(),
      projectId: z.string().optional().describe('Only tasks in this project'),
      label: label.optional().describe('Only tasks with this label'),
      q: z.string().min(1).max(100).optional().describe('Case-insensitive text search in title and description'),
      limit: z.coerce.number().int().min(1).max(100).default(20).describe('Page size'),
      cursor: z.string().optional().describe('`nextCursor` from the previous page'),
    }),
    response: { status: 200, description: 'A page of tasks', schema: TaskPage },
    errors: [400],
    handler: ({ user, store, query }) => {
      const all = filterTasks(store, user, query);
      const start = query.cursor === undefined ? 0 : Number(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!Number.isInteger(start) || start < 0) throw new HttpError(400, 'Invalid cursor');
      const page = all.slice(start, start + query.limit);
      const next = start + query.limit < all.length ? Buffer.from(String(start + query.limit)).toString('base64url') : null;
      return { status: 200, body: { items: page.map((t) => taskOut(store, t)), nextCursor: next } };
    },
  }),

  route({
    method: 'get',
    path: '/tasks/search',
    operationId: 'searchTasks',
    summary: 'Search tasks',
    description: 'Deprecated: use `GET /tasks?q=` instead.',
    tags: ['tasks'],
    deprecated: true,
    query: z.object({ q: z.string().min(1) }),
    response: { status: 200, description: 'Matching tasks', schema: z.object({ items: z.array(TaskOut) }) },
    handler: ({ user, store, query }) => ({ status: 200, body: { items: filterTasks(store, user, { q: query.q }).map((t) => taskOut(store, t)) } }),
  }),

  route({
    method: 'post',
    path: '/tasks',
    operationId: 'createTask',
    summary: 'Create a task',
    tags: ['tasks'],
    body: z.object({
      projectId: z.string(),
      title: z.string().min(1).max(200),
      description: z.string().max(5000).optional(),
      priority: priority.optional(),
      labels: z.array(label).max(10).optional(),
      dueDate: isoDate.optional(),
    }),
    response: { status: 201, description: 'The new task', schema: TaskOut },
    errors: [400, 404],
    handler: ({ user, store, body }) => {
      ownProject(store, user, body.projectId);
      return { status: 201, body: taskOut(store, store.createTask(user.id, body)) };
    },
  }),

  route({
    method: 'get',
    path: '/tasks/{taskId}',
    operationId: 'getTask',
    summary: 'Get a task',
    tags: ['tasks'],
    params: TaskIdParams,
    response: { status: 200, description: 'The task', schema: TaskOut },
    errors: [404],
    handler: ({ user, store, params }) => ({ status: 200, body: taskOut(store, ownTask(store, user, params.taskId)) }),
  }),

  route({
    method: 'patch',
    path: '/tasks/{taskId}',
    operationId: 'updateTask',
    summary: 'Update a task',
    description: 'Change any subset of fields. Setting `status` to `done` completes the task.',
    tags: ['tasks'],
    params: TaskIdParams,
    body: z
      .object({
        title: z.string().min(1).max(200),
        description: z.string().max(5000).nullable(),
        status,
        priority,
        dueDate: isoDate.nullable(),
        projectId: z.string(),
      })
      .partial()
      .refine((b) => Object.keys(b).length > 0, 'send at least one field to change'),
    response: { status: 200, description: 'The updated task', schema: TaskOut },
    errors: [400, 404],
    handler: ({ user, store, params, body }) => {
      const t = ownTask(store, user, params.taskId);
      if (body.projectId !== undefined) ownProject(store, user, body.projectId);
      const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      return { status: 200, body: taskOut(store, store.updateTask(t, patch)) };
    },
  }),

  route({
    method: 'delete',
    path: '/tasks/{taskId}',
    operationId: 'deleteTask',
    summary: 'Delete a task',
    description: 'Deletes the task and its comments. This cannot be undone.',
    tags: ['tasks'],
    params: TaskIdParams,
    response: { status: 204, description: 'Deleted' },
    errors: [404],
    handler: ({ user, store, params }) => {
      store.deleteTask(ownTask(store, user, params.taskId));
      return { status: 204 };
    },
  }),

  route({
    method: 'put',
    path: '/tasks/{taskId}/labels',
    operationId: 'replaceTaskLabels',
    summary: 'Replace a task\'s labels',
    description: 'The request body is the complete new list of labels; send [] to clear them.',
    tags: ['tasks'],
    params: TaskIdParams,
    body: z.array(label).max(10),
    response: { status: 200, description: 'The updated task', schema: TaskOut },
    errors: [400, 404],
    handler: ({ user, store, params, body }) => {
      const t = ownTask(store, user, params.taskId);
      return { status: 200, body: taskOut(store, store.updateTask(t, { labels: [...new Set(body)] })) };
    },
  }),

  route({
    method: 'get',
    path: '/tasks/{taskId}/comments',
    operationId: 'listComments',
    summary: 'List comments on a task',
    tags: ['comments'],
    params: TaskIdParams,
    response: { status: 200, description: 'Comments, oldest first', schema: z.object({ items: z.array(CommentOut) }) },
    errors: [404],
    handler: ({ user, store, params }) => {
      const t = ownTask(store, user, params.taskId);
      const items = [...store.comments.values()].filter((c) => c.taskId === t.id).map((c) => commentOut(store, c));
      return { status: 200, body: { items } };
    },
  }),

  route({
    method: 'post',
    path: '/tasks/{taskId}/comments',
    operationId: 'addComment',
    summary: 'Comment on a task',
    tags: ['comments'],
    params: TaskIdParams,
    body: z.object({ body: z.string().min(1).max(5000) }),
    response: { status: 201, description: 'The new comment', schema: CommentOut },
    errors: [400, 404],
    handler: ({ user, store, params, body }) => {
      const t = ownTask(store, user, params.taskId);
      return { status: 201, body: commentOut(store, store.addComment(t, user.id, body.body)) };
    },
  }),

  route({
    method: 'get',
    path: '/reports/activity',
    operationId: 'getActivityReport',
    summary: 'Activity report',
    description: 'Totals and the full event history for the current user over a period.',
    tags: ['reports'],
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30).describe('Look-back window in days') }),
    response: { status: 200, description: 'The report', schema: ActivityReport },
    handler: ({ user, store, query }) => {
      const to = new Date();
      const from = new Date(to.getTime() - query.days * 86_400_000);
      const events = store.events
        .filter((e) => e.userId === user.id && e.at >= from.toISOString())
        .map((e) => ({ at: e.at, type: e.type, taskId: e.taskId, summary: e.summary }));
      return {
        status: 200,
        body: {
          from: from.toISOString(),
          to: to.toISOString(),
          totals: {
            created: events.filter((e) => e.type === 'task.created').length,
            completed: events.filter((e) => e.type === 'task.completed').length,
            comments: events.filter((e) => e.type === 'comment.added').length,
          },
          events,
        },
      };
    },
  }),
];
