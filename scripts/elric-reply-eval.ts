/**
 * Elric reply-quality eval (tests/fixtures/elric-reply-eval.json).
 *
 *   pnpm eval:elric                 dry run: builds the real prompts, prints their key lines
 *   ELRIC_EVAL_LIVE=1 pnpm eval:elric
 *                                   live: calls the configured Elric model (the same CITY_ELRIC_*
 *                                   variables as the server) and prints a pass/fail table
 *
 * Options: --case <id> (repeatable), --tier 1|2 (default 1), --verbose (print each reply).
 * The live run refuses to start when CI is set. No environment value is ever printed.
 */
import { AdapterError, type ElricMessage, type ModelAdapter } from '../server/elric/adapter.js';
import { ELRIC_CONFIG } from '../server/elric/config.js';
import { elricSystemPrompt, elricUserPrompt, transcript } from '../server/elric/context.js';
import { elricModels } from '../server/elric/endpoints.js';
import { searchHelp } from '../server/elric/help.js';
import { anthropicUnits } from '../server/elric/token-cost.js';
import { toolSpecs } from '../server/elric/tools.js';
import type { PromptMessage } from '../server/responder/prompt.js';
import { PRIVATE_ROOM_NAME } from '../server/rooms/private.js';
import {
  checkReply,
  ELRIC_REPLY_EVAL,
  failures,
  type EvalCase,
} from '../tests/elric-reply-eval-checks.js';

const AGENT = 'Elric';
const ROOM_ID = '00000000-0000-4000-8000-0000000000e1';

function args(argv: string[]) {
  const cases: string[] = [];
  let tier: 1 | 2 = 1;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') cases.push(argv[++i] ?? '');
    else if (a === '--tier') tier = argv[++i] === '2' ? 2 : 1;
    else if (a === '--verbose') verbose = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { cases, tier, verbose };
}

/** The room as the server would show it: the private chat or a shared room with others. */
function roomFor(c: EvalCase) {
  const history = c.history ?? [];
  const messages: PromptMessage[] = [
    ...history,
    { sender: c.speaker, owner: c.speaker, text: c.prompt },
  ].map((m, index) => ({
    seq: index + 1,
    sender: m.sender,
    owner: m.owner,
    autoReply: false,
    parts: [{ type: 'text', text: m.text }],
  }));
  const room =
    c.room === 'private'
      ? { id: ROOM_ID, name: PRIVATE_ROOM_NAME, topic: '' }
      : { id: ROOM_ID, name: c.roomName ?? 'launch-planning', topic: '' };
  return { room, messages, triggerSeq: messages.length };
}

function build(c: EvalCase) {
  const tools = toolSpecs(false);
  const { room, messages, triggerSeq } = roomFor(c);
  const lines = transcript(messages, triggerSeq, ELRIC_CONFIG.transcriptChars);
  const system = elricSystemPrompt({ agentName: AGENT, tools, maxSteps: ELRIC_CONFIG.maxSteps });
  const user = elricUserPrompt({ room, lines, triggerSeq, triggerSender: c.speaker });
  return { system, user, tools, lines };
}

const KEY_LINES = /private chat|mention|model or company|introduce|I read the room|docs first/i;

function dryRun(cases: EvalCase[]) {
  const first = build(cases[0]!);
  console.log('Dry run (set ELRIC_EVAL_LIVE=1 to call the model). System prompt key lines:');
  for (const line of first.system.split('\n').filter((l) => KEY_LINES.test(l)))
    console.log(`  | ${line}`);
  console.log(`  (system prompt: ${first.system.length} chars)\n`);
  for (const room of ['private', 'group'] as const) {
    const sample = cases.find((c) => c.room === room);
    if (!sample) continue;
    console.log(`User prompt, ${room} room (${sample.id}):`);
    for (const line of build(sample).user.split('\n')) console.log(`  | ${line}`);
    console.log('');
  }
  console.log(`${cases.length} cases: ${cases.map((c) => c.id).join(', ')}`);
}

/** One Elric turn without a database: docs lookups run for real, room reads return the transcript. */
async function answer(adapter: ModelAdapter, c: EvalCase) {
  const { system, user, tools, lines } = build(c);
  const conversation: ElricMessage[] = [{ role: 'user', content: user }];
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (let step = 0; step < ELRIC_CONFIG.maxSteps; step++) {
    const response = await adapter.complete({
      system,
      messages: conversation,
      tools,
      maxOutputTokens: ELRIC_CONFIG.maxOutputTokens,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadInputTokens += response.usage.cacheReadInputTokens ?? 0;
    usage.cacheCreationInputTokens += response.usage.cacheCreationInputTokens ?? 0;
    if (!response.toolCalls.length) return { text: response.text ?? '', usage, steps: step + 1 };
    conversation.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
      ...(response.thinking ? { thinking: response.thinking } : {}),
    });
    for (const call of response.toolCalls) {
      const query = typeof call.args?.query === 'string' ? call.args.query : '';
      const content =
        call.name === 'city_help'
          ? JSON.stringify(searchHelp(query, undefined, { self: true }))
          : call.name === 'room_read'
            ? lines.join('\n')
            : JSON.stringify({ error: 'not_available_in_eval' });
      conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    }
  }
  return { text: '', usage, steps: ELRIC_CONFIG.maxSteps };
}

async function live(cases: EvalCase[], tier: 1 | 2, verbose: boolean) {
  if (process.env.CI) throw new Error('The live Elric eval does not run in CI.');
  const wiring = elricModels(process.env, { log: () => {} });
  if (!wiring) throw new Error('No Elric model is configured (see server/elric/endpoints.ts).');
  const adapter = wiring.adapterFor(tier);
  const rows: string[][] = [];
  let passed = 0;
  let micro = 0;
  let input = 0;
  let output = 0;
  for (const c of cases) {
    if (c.expect.noModelCall) {
      rows.push(['SKIP', c.id, c.room, 'no model call expected (covered by server tests)']);
      continue;
    }
    let text = '';
    let note = '';
    try {
      const result = await answer(adapter, c);
      text = result.text;
      input +=
        result.usage.inputTokens +
        result.usage.cacheReadInputTokens +
        result.usage.cacheCreationInputTokens;
      output += result.usage.outputTokens;
      micro += anthropicUnits(result.usage);
    } catch (error) {
      note = error instanceof AdapterError ? error.message : 'model_error';
    }
    const failed = note ? [] : failures(checkReply(c, text));
    const ok = !note && text.length > 0 && failed.length === 0;
    if (ok) passed++;
    rows.push([
      ok ? 'PASS' : 'FAIL',
      c.id,
      c.room,
      note ||
        (text
          ? failed.map((f) => (f.detail ? `${f.rule} (${f.detail})` : f.rule)).join('; ')
          : 'empty reply'),
    ]);
    if (verbose) console.log(`--- ${c.id}\n${text}\n`);
  }
  const width = [4, Math.max(...rows.map((r) => r[1]!.length)), 7];
  for (const r of rows)
    console.log(
      `${r[0]!.padEnd(width[0]!)}  ${r[1]!.padEnd(width[1]!)}  ${r[2]!.padEnd(width[2]!)}  ${r[3]}`,
    );
  const run = cases.filter((c) => !c.expect.noModelCall).length;
  console.log(`\n${passed}/${run} passed`);
  console.log(
    `Tokens: ${input} in, ${output} out. Cost estimate at hosted per-token prices: USD ${(micro / 1e6).toFixed(4)}`,
  );
  if (passed < run) process.exitCode = 1;
}

async function main() {
  const { cases: ids, tier, verbose } = args(process.argv.slice(2));
  const cases = ids.length
    ? ELRIC_REPLY_EVAL.cases.filter((c) => ids.includes(c.id))
    : ELRIC_REPLY_EVAL.cases;
  if (!cases.length) throw new Error('No matching cases.');
  if (process.env.ELRIC_EVAL_LIVE === '1') await live(cases, tier, verbose);
  else dryRun(cases);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.slice(0, 200) : 'eval failed');
  process.exitCode = 1;
});
