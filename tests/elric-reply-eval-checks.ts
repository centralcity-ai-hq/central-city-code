/**
 * Rule checks for Elric's replies (the reply-quality eval set in
 * tests/fixtures/elric-reply-eval.json). Used by the unit test (tests/elric-reply-eval.test.ts)
 * and by the opt-in live runner (scripts/elric-reply-eval.ts). The "ideal" text of a case is
 * guidance for people only; nothing here compares against it.
 */
import evalSet from './fixtures/elric-reply-eval.json' with { type: 'json' };

export type EvalRoom = 'private' | 'group';
export interface EvalCase {
  id: string;
  category: 'greeting' | 'howto' | 'identity' | 'grounding' | 'smalltalk' | 'tricky';
  room: EvalRoom;
  /** Group room name (the private chat always uses the server's own name). */
  roomName?: string;
  speaker: string;
  prompt: string;
  history?: Array<{ sender: string; owner: string; text: string }>;
  expect: {
    /** Exact labels (case-sensitive) the reply must contain, e.g. real button names. */
    mustInclude?: string[];
    /** Regex sources (case-insensitive) the reply must not match. */
    mustNotMatch?: string[];
    maxChars?: number;
    /** The user asked who Elric is, so an introduction is fine. */
    allowSelfIntro?: boolean;
    /** Product names the user asked about (e.g. inviting ChatGPT). */
    allowModelNames?: string[];
    /** No model reply may be produced (e.g. Elric switched off); the live runner skips it. */
    noModelCall?: boolean;
  };
  ideal: string;
  note?: string;
}

export const ELRIC_REPLY_EVAL: { version: number; cases: EvalCase[] } = evalSet as never;

export const GREETING_MAX_CHARS = 200;

/** Narrating its own reading instead of answering ("I've read the room", "I see you..."). */
const NARRATION =
  /^\W*(?:(?:ok(?:ay)?|so|alright|sure)[,!.]?\s+)?(?:i(?:'ve| have)? (?:just )?(?:read|looked at|checked|gone through|reviewed|scanned)\b|i(?:'m| am) reading\b|reading (?:your|the|this) (?:message|room|chat)|i (?:can )?see (?:that )?(?:you|your|the message|a message|dana)|looking at (?:the|your|this) (?:room|message|chat)|let me (?:look|check|read|scan)\b|scanning\b|i(?:'m| am) (?:checking|scanning|looking)\b)/i;
const NARRATION_ANYWHERE =
  /\bi(?:'ve| have)? read (?:the room|the message|your message)|\breading your message\b/i;
/** The private chat is a room named after Elric internally; never say so. */
const ROOM_NAME_LEAK = /\broom (?:called|named) ["'*]*elric\b/i;
const INVENTED_UI = /\bmember management interface\b|\bsettings dashboard\b/i;
const SELF_INTRO =
  /\b(?:i(?:'m| am)|this is|it's) elric\b|\belric,? central city'?s\b|\bi(?:'m| am) (?:central city's|your) (?:ai )?assistant\b/i;
const MODEL_NAMES = /\b(?:chatgpt|claude|haiku|anthropic|gemma|gpt[-\w.]*|openai)\b/gi;
const PRIVATE_CLAIM =
  /\b(?:this is a|this|it's a|it is a|we're in a|our) private (?:room|chat|space|conversation)\b|\b(?:just|only) (?:you and me|the two of us|us two)\b|\bno one else (?:is here|can see|can read)\b/i;
const MENTION_ADVICE =
  /(?:\b(?:@?mention|tag|@)\s*(?:me|elric)\b|\b(?:need|have) to (?:@|mention|tag)|\bno need to (?:@|mention|tag)|\bwithout (?:an? )?(?:@|mention|tag)|\b(?:@-?)?mention(?:ing)? (?:isn't|is not) (?:needed|required))/i;

/**
 * Claims of first-hand observation Elric cannot make: it has no screen, browser or clicks.
 * Heuristic, kept narrow: first-person testing verbs, sensory speed/feel words about a feature,
 * and verdicts like "works well". Never excused by tools (none of them can observe the UI).
 */
const OBSERVED_CLAIM =
  /\bI(?:'ve| have)? (?:just |also )?(?:tested|tried(?: it| out| the)|clicked|ran (?:it|the|a)|measured|timed|played with)\b|\b(?:is|feels|felt|was|seems|looks|stays) (?:really |very |super |pretty )?(?:snappy|sluggish|laggy|instant|smooth|responsive|lightning[- ]fast|intuitive)\b|(?<!\bif (?:it|this|that|everything) )\b(?:works|worked|working) (?:well|great|fine|perfectly|smoothly|flawlessly|as expected)\b/i;
/** Verification marks: only with tool evidence from this turn. */
const CHECK_MARK = /[\u2713\u2714\u2705]/u;

export interface ReplyEvidence {
  /** Tools Elric actually called in the turn (names only); a check mark needs one. */
  toolsUsed?: readonly string[];
}

export interface RuleResult {
  rule: string;
  ok: boolean;
  detail?: string;
}

export function checkReply(c: EvalCase, reply: string, evidence: ReplyEvidence = {}): RuleResult[] {
  const text = reply.trim();
  const results: RuleResult[] = [];
  const push = (rule: string, ok: boolean, detail?: string) =>
    results.push(ok ? { rule, ok } : { rule, ok, ...(detail ? { detail } : {}) });

  const firstSentence = text.split(/(?<=[.!?])\s|\n/)[0] ?? '';
  const narr = NARRATION.exec(firstSentence) ?? NARRATION_ANYWHERE.exec(text);
  push('no_narration', !narr, narr?.[0]);

  if (!c.expect.allowSelfIntro) {
    const intro = SELF_INTRO.exec(text);
    push('no_self_intro', !intro, intro?.[0]);
  }

  const allowed = new Set((c.expect.allowModelNames ?? []).map((n) => n.toLowerCase()));
  const names = [...text.matchAll(MODEL_NAMES)]
    .map((m) => m[0])
    .filter((n) => !allowed.has(n.toLowerCase()));
  push('no_model_names', names.length === 0, names.join(', '));

  if (c.room === 'group') {
    const claim = PRIVATE_CLAIM.exec(text);
    push('no_private_claim_in_group', !claim, claim?.[0]);
  }

  const leak = ROOM_NAME_LEAK.exec(text);
  push('no_room_name_leak', !leak, leak?.[0]);
  const ui = INVENTED_UI.exec(text);
  push('no_invented_ui', !ui, ui?.[0]);

  const observed = OBSERVED_CLAIM.exec(text);
  push('no_unverified_observation', !observed, observed?.[0]);
  const mark = (evidence.toolsUsed ?? []).length ? null : CHECK_MARK.exec(text);
  push('no_unverified_check_marks', !mark, mark?.[0]);

  const mention = MENTION_ADVICE.exec(text);
  push('no_mention_advice', !mention, mention?.[0]);

  const max = c.expect.maxChars ?? (c.category === 'greeting' ? GREETING_MAX_CHARS : undefined);
  if (max !== undefined) push('length', text.length <= max, `${text.length} > ${max}`);

  for (const label of c.expect.mustInclude ?? [])
    push(`includes:${label}`, text.includes(label), 'missing');
  for (const source of c.expect.mustNotMatch ?? []) {
    const hit = new RegExp(source, 'i').exec(text);
    push(`not:${source}`, !hit, hit?.[0]);
  }
  return results;
}

export const failures = (results: RuleResult[]) => results.filter((r) => !r.ok);
