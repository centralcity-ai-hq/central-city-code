import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { TASK_LIMITS, taskListInput, type TaskStatus } from './tasks-contract.js';
import type { RoomPrincipal, RoomTasks } from './tasks-service.js';
import { listTaskTemplates } from './tasks-tools.js';

export interface TaskRouteDependencies {
  tasks: RoomTasks;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
}

/**
 * Owner console REST for room tasks (docs/ROOM_TASKS.md):
 * the same operations and authorization as the MCP tools. Registered in server/app.ts only when
 * CITY_ROOM_TASKS=1 (no routes, so 404, when off).
 * Task titles and bodies are untrusted text.
 */
export function registerTaskRoutes(app: FastifyInstance, d: TaskRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
  });
  const taskParams = z
    .object({ room: z.string().min(3).max(64), task: z.string().uuid() })
    .strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});
  const seq = z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number);

  // The built-in template catalog: the same for every room and signed-in owner.
  app.get('/api/task-templates', async (request) => {
    await d.owner(request);
    return listTaskTemplates();
  });
  app.get('/api/rooms/:room/tasks', async (request) => {
    const p = await principal(request);
    const { room } = z
      .object({ room: z.string().min(3).max(64) })
      .strict()
      .parse(request.params);
    const query = z
      .object({
        status: z.enum(['open', 'claimed', 'in_review', 'done', 'cancelled']).optional(),
        mine: z.enum(['true', 'false']).optional(),
        stage: z.string().min(1).max(64).optional(),
        after_number: seq.optional(),
        limit: seq.pipe(z.number().int().min(1).max(TASK_LIMITS.pageSize)).optional(),
      })
      .strict()
      .parse(request.query);
    const input: {
      room_id: string;
      status?: TaskStatus;
      mine?: boolean;
      stage?: string;
      after_number?: number;
      limit?: number;
    } = {
      room_id: room,
    };
    if (query.status !== undefined) input.status = query.status;
    if (query.mine !== undefined) input.mine = query.mine === 'true';
    if (query.stage !== undefined) input.stage = query.stage;
    if (query.after_number !== undefined) input.after_number = query.after_number;
    if (query.limit !== undefined) input.limit = query.limit;
    return d.tasks.list(p, taskListInput.parse(input));
  });
  app.post('/api/rooms/:room/tasks', async (request, reply) => {
    const p = await principal(request);
    const { room } = z
      .object({ room: z.string().min(3).max(64) })
      .strict()
      .parse(request.params);
    return reply.code(201).send(await d.tasks.create(p, { ...body(request), room_id: room }));
  });
  // Optional task stages (migration 54): any member reads the list, the host replaces it.
  app.get('/api/rooms/:room/task-stages', async (request) => {
    const p = await principal(request);
    const { room } = z
      .object({ room: z.string().min(3).max(64) })
      .strict()
      .parse(request.params);
    return d.tasks.stages(p, { room_id: room });
  });
  app.put('/api/rooms/:room/task-stages', async (request) => {
    const p = await principal(request);
    const { room } = z
      .object({ room: z.string().min(3).max(64) })
      .strict()
      .parse(request.params);
    return d.tasks.setStages(p, { ...body(request), room_id: room });
  });
  app.get('/api/rooms/:room/tasks/:task', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.get(p, { room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/claim', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.claim(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/renew', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.renew(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/release', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.release(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/result', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.result(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/update', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.update(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/request-review', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.requestReview(p, { ...body(request), room_id: room, task_id: task });
  });
  app.post('/api/rooms/:room/tasks/:task/peer-review', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return d.tasks.peerReview(p, { ...body(request), room_id: room, task_id: task });
  });
  app.get('/api/rooms/:room/tasks/:task/events', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    const query = z
      .object({
        after_id: z.string().uuid().optional(),
        limit: seq.pipe(z.number().int().min(1).max(TASK_LIMITS.pageSize)).optional(),
      })
      .strict()
      .parse(request.query);
    return d.tasks.events(p, { room_id: room, task_id: task, ...query });
  });
  // Task comments (docs/ROOM_TASKS.md "Comments"): the same service calls as the MCP tools.
  app.get('/api/rooms/:room/tasks/:task/comments', async (request) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    const query = z
      .object({
        after_id: z.string().uuid().optional(),
        limit: seq.pipe(z.number().int().min(1).max(TASK_LIMITS.pageSize)).optional(),
      })
      .strict()
      .parse(request.query);
    return d.tasks.commentList(p, { room_id: room, task_id: task, ...query });
  });
  app.post('/api/rooms/:room/tasks/:task/comments', async (request, reply) => {
    const p = await principal(request);
    const { room, task } = taskParams.parse(request.params);
    return reply
      .code(201)
      .send(await d.tasks.commentAdd(p, { ...body(request), room_id: room, task_id: task }));
  });
  app.delete('/api/rooms/:room/tasks/:task/comments/:comment', async (request) => {
    const p = await principal(request);
    const { room, task, comment } = taskParams
      .extend({ comment: z.string().uuid() })
      .parse(request.params);
    return d.tasks.commentDelete(p, {
      ...body(request),
      room_id: room,
      task_id: task,
      comment_id: comment,
    });
  });
}
