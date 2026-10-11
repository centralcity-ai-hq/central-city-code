import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { clientAddressKey } from '../rate-limit.js';
import { PROVIDERS } from './models.js';
import type { Responder } from './service.js';

/**
 * Console routes for the hosted responder. Every route needs the signed-in owner's
 * session (`owner`, cookie only): OAuth grants, workspace keys and signed runtimes cannot reach
 * them, so no AI can store a key, turn auto-reply on or change a cap. Registered only when
 * CITY_RESPONDER=1.
 */
const agentParams = z.object({ id: z.string().uuid() }).strict();
const modelsQuery = z.object({ provider: z.enum(PROVIDERS).optional() }).strict();
const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).max(100).optional(),
    instructions: z.string().max(2000).optional(),
    daily_reply_cap: z.number().int().min(1).max(1000).optional(),
    daily_spend_cap_usd: z.number().min(0.01).max(50).optional(),
  })
  .strict();
const keyMeta = z
  .object({ provider: z.enum(PROVIDERS), model: z.string().min(1).max(100).optional() })
  .strict();

export function registerResponderRoutes(
  app: FastifyInstance,
  d: { responder: Responder; owner: (request: FastifyRequest) => Promise<Operator> },
): void {
  app.get('/api/responder/models', async (request) => {
    await d.owner(request);
    return d.responder.models(modelsQuery.parse(request.query).provider);
  });
  // Whether the agent can answer now, and how: the console's "<agent> can't answer yet".
  app.get('/api/agents/:id/answering', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    return d.responder.answering(operator.id, id);
  });
  app.get('/api/agents/:id/responder', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    return d.responder.get(operator.id, id);
  });
  app.put('/api/agents/:id/responder', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    return d.responder.update(operator.id, 'the owner', id, settingsBody.parse(request.body));
  });
  app.post('/api/agents/:id/responder/key', async (request) => {
    // The key is taken out of the parsed body at once and handled as a Buffer; the body field is
    // blanked. Validation errors name fields and constraints only, never values.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const raw = body.key;
    body.key = '';
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    const { key: _omitted, ...rest } = body;
    const meta = keyMeta.parse(rest);
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512)
      throw Object.assign(new Error('Paste your API key.'), {
        statusCode: 400,
        errorCode: 'invalid_key_format',
      });
    const key = Buffer.from(raw.trim(), 'latin1');
    return d.responder.setKey(
      operator.id,
      'the owner',
      id,
      { ...meta, key },
      clientAddressKey(request.ip),
    );
  });
  app.delete('/api/agents/:id/responder/key', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    return d.responder.removeKey(operator.id, 'the owner', id);
  });
}
