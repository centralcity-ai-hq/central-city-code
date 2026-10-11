import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { elricAnthropicModels } from '../server/elric/anthropic.js';
import { ELRIC_CONFIG, ELRIC_STEP_CONTEXT_TOKENS } from '../server/elric/config.js';
import { elricSystemPrompt, elricUserPrompt } from '../server/elric/context.js';
import { toolSpecs } from '../server/elric/tools.js';
import { PROMPT_LIMITS } from '../server/responder/prompt.js';
import { anthropicWorstUnits, estimateTokens } from '../server/elric/token-cost.js';
import { elricFixture } from './elric-fixture.js';

/**
 * The reservation covers the real worst case: the largest context a step can carry stays under
 * ELRIC_STEP_CONTEXT_TOKENS, and with a GPU-priced fallback configured a run reserves the larger
 * of the two providers' worst cases.
 */
test('everything but the model turns fits ELRIC_STEP_CONTEXT_TOKENS at the estimate rate', () => {
  // System prompt, tools, room header, the full transcript (plus the always-kept trigger) and every
  // tool result a run may gather, counted like the per-step estimate (estimateTokens). Text the
  // model writes in earlier steps is covered by that per-step estimate, which stops the run
  // honestly (turn_budget) before the reservation is exceeded.
  const tools = toolSpecs(true);
  const system = elricSystemPrompt({ agentName: 'Elric', tools, maxSteps: ELRIC_CONFIG.maxSteps });
  const header = elricUserPrompt({
    room: {
      id: 'r'.repeat(40),
      name: 'n'.repeat(200),
      topic: 't'.repeat(PROMPT_LIMITS.topicChars),
      elric_private: false,
    },
    lines: [],
    triggerSeq: 1,
    triggerSender: 's'.repeat(100),
  });
  const chars =
    system.length +
    JSON.stringify(tools).length +
    header.length +
    ELRIC_CONFIG.transcriptChars +
    PROMPT_LIMITS.messageChars * 1.5 +
    ELRIC_CONFIG.toolResultChars;
  const tokens = estimateTokens(chars);
  assert.ok(tokens <= ELRIC_STEP_CONTEXT_TOKENS, `${tokens} tokens > ${ELRIC_STEP_CONTEXT_TOKENS}`);
});

test('with the GPU fallback configured, the run reserves the larger worst case', async (t) => {
  const key = randomBytes(24).toString('hex');
  const base = {
    CITY_ELRIC_PROVIDER: 'anthropic',
    CITY_ELRIC_T1_MODEL: 'hosted-model-1',
    CITY_ELRIC_ANTHROPIC_KEY: key,
  };
  const reserved = async (env: Record<string, string>) => {
    const models = elricAnthropicModels(env, {
      fetch: async () => {
        const json = JSON.stringify({
          type: 'message',
          content: [{ type: 'text', text: 'Hi.' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
        return { status: 200, text: async () => json };
      },
    });
    const f = await elricFixture(t, { models });
    const s = await f.scene();
    const trigger = await f.say(s.owner, s.room, '@Elric hi', s.person);
    await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
    return Number((await f.turns(s.owner.operatorId))[0]!.reserved_units);
  };
  const perToken = anthropicWorstUnits(ELRIC_STEP_CONTEXT_TOKENS, ELRIC_CONFIG.maxOutputTokens);
  assert.equal(await reserved(base), perToken * ELRIC_CONFIG.maxSteps);
  const withFallback = await reserved({
    ...base,
    CITY_ELRIC_FALLBACK_URL: 'https://fallback.example',
    CITY_ELRIC_FALLBACK_MODEL: 'fallback-model',
  });
  assert.equal(
    withFallback,
    Math.max(perToken, ELRIC_CONFIG.unitsPerStep[1]) * ELRIC_CONFIG.maxSteps,
  );
  assert.ok(withFallback >= perToken * ELRIC_CONFIG.maxSteps);
});
