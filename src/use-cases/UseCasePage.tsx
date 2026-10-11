import type { ReactNode } from 'react';
import {
  ChevronDown,
  ListChecks,
  MessagesSquare,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { USE_CASES, USE_CASES_INDEX, useCasePath } from '../../shared/use-cases';
import {
  SETUP_BLOCKS,
  USE_CASE_CONTENT,
  type Block,
  type BlockId,
  type Section,
  type UseCaseContent,
} from './content';
import { ROOM_PREVIEWS, type PreviewMember, type RoomPreview } from './previews';
import './use-cases.css';

/*
 * Use cases (/use-cases and /use-cases/<slug>): public pages that show one way to put AIs to work
 * together in a room. The copy lives in ./content.ts, the titles and descriptions in
 * shared/use-cases.ts. Render touches no browser globals (the pages are prerendered,
 * src/prerender.tsx).
 *
 * The presentation follows the signed-in workspace (rooms v3): room pills, rounded-square AI
 * avatars, message bubbles and task chips, drawn from the shared tokens. The room previews
 * (./previews.ts) are decorative and hidden from screen readers.
 */

export const CONNECT_URL = 'https://centralcity.ai/connect';

/** Inline markup: **bold**, `code`, site links and "block X" references. */
const INLINE =
  /\*\*([^*]+)\*\*|`([^`]+)`|block ([A-F])\b|(https:\/\/centralcity\.ai(?:\/[^\s,)]*[^\s,).])?)|(?<![\w/.])(\/connect|\/docs(?:\/[a-z-]+\.md)?)(?![\w/])/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const [, bold, code, block, url, path] = match;
    if (bold !== undefined) out.push(<strong key={key++}>{inline(bold)}</strong>);
    else if (code !== undefined) out.push(<code key={key++}>{code}</code>);
    else if (block !== undefined)
      out.push(
        <a key={key++} href={`#${SETUP_BLOCKS[block as BlockId].id}`}>
          block {block}
        </a>,
      );
    else
      out.push(
        <a key={key++} href={url ?? path}>
          {url ?? path}
        </a>,
      );
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The shared setup blocks a page refers to ("block B"), in A–F order. */
export function referencedBlocks(page: UseCaseContent): BlockId[] {
  const text = JSON.stringify(page.sections);
  return (Object.keys(SETUP_BLOCKS) as BlockId[]).filter((id) =>
    new RegExp(`block ${id}\\b`).test(text),
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'p':
            return <p key={index}>{inline(block.text)}</p>;
          case 'h3':
            return <h3 key={index}>{block.text}</h3>;
          case 'code':
            return (
              <pre key={index} className="uc-code" tabIndex={0}>
                <code>{block.text}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={index}>{inline(block.text)}</blockquote>;
          case 'ul':
            return (
              <ul key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={index} className="uc-steps">
                {block.items.map((step, i) => (
                  <li key={i}>
                    <p>{inline(step.text)}</p>
                    {step.code ? (
                      <pre className="uc-code" tabIndex={0}>
                        <code>{step.code}</code>
                      </pre>
                    ) : null}
                    {step.items ? (
                      step.code ? (
                        step.items.map((item, j) => <p key={j}>{inline(item)}</p>)
                      ) : (
                        <ul>
                          {step.items.map((item, j) => (
                            <li key={j}>{inline(item)}</li>
                          ))}
                        </ul>
                      )
                    ) : null}
                  </li>
                ))}
              </ol>
            );
        }
      })}
    </>
  );
}

function Avatar({ member, size = 'md' }: { member: PreviewMember; size?: 'sm' | 'md' }) {
  return (
    <span className={`uc-av uc-av-${size}`} data-tone={member.tone}>
      {member.letters}
    </span>
  );
}

function RoomPill({ preview }: { preview: RoomPreview }) {
  return (
    <div className="uc-pill">
      <span className="uc-pill-name"># {preview.room}</span>
      <span className="uc-pill-avs">
        {preview.members.map((member) => (
          <Avatar key={member.name} member={member} size="sm" />
        ))}
      </span>
      <span className="uc-pill-active">
        <span className="uc-dot" />
        {preview.active} active
      </span>
    </div>
  );
}

function Chip({ chip }: { chip: RoomPreview['chip'] }) {
  return (
    <span className="uc-chip" data-tone={chip.tone}>
      <span className="uc-dot" />
      {chip.label}
    </span>
  );
}

function Message({ preview, index }: { preview: RoomPreview; index: number }) {
  const message = preview.messages[index]!;
  if (message.from === 'host')
    return (
      <div className="uc-msg uc-msg-host">
        <p className="uc-bubble">{message.text}</p>
      </div>
    );
  const member = preview.members[message.from]!;
  return (
    <div className="uc-msg">
      <Avatar member={member} />
      <div className="uc-msg-body">
        <p className="uc-msg-meta">
          <span className="uc-msg-name">{member.name}</span>
          <span className="uc-badge">AI</span>
        </p>
        <p className="uc-bubble">{message.text}</p>
      </div>
    </div>
  );
}

/** The framed room on the right of the hero: decorative, summarised for screen readers. */
function RoomPreviewFrame({ preview }: { preview: RoomPreview }) {
  return (
    <div className="uc-preview-wrap">
      <p className="uc-sr-only">{preview.summary}</p>
      <div className="uc-preview" aria-hidden="true">
        <div className="uc-preview-top">
          <RoomPill preview={preview} />
        </div>
        <div className="uc-preview-log">
          {preview.messages.map((_, index) => (
            <Message key={index} preview={preview} index={index} />
          ))}
          <div className="uc-preview-chip">
            <Chip chip={preview.chip} />
          </div>
        </div>
        <div className="uc-composer">
          <span>Message {preview.room}</span>
          <span className="uc-send" />
        </div>
      </div>
    </div>
  );
}

const BENEFIT_ICONS: LucideIcon[] = [MessagesSquare, ListChecks, ShieldCheck];

/** "**Title.** Rest" list items as a grid of cards; null when the section has another shape. */
function BenefitCards({ section }: { section: Section }) {
  const [only] = section.blocks;
  if (section.blocks.length !== 1 || only?.kind !== 'ul') return null;
  return (
    <ul className="uc-benefits">
      {only.items.map((item, index) => {
        const match = /^\*\*([^*]+)\*\*\s*([\s\S]*)$/.exec(item);
        const Icon = BENEFIT_ICONS[index % BENEFIT_ICONS.length]!;
        return (
          <li key={index} className="uc-card uc-benefit">
            <span className="uc-benefit-icon" aria-hidden="true">
              <Icon size={20} strokeWidth={1.75} />
            </span>
            {match ? (
              <>
                <h3>{match[1]}</h3>
                <p>{inline(match[2]!)}</p>
              </>
            ) : (
              <p>{inline(item)}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The example prompts as the host's messages in a room frame (the copy stays as written). */
function PromptRoom({ section, preview }: { section: Section; preview?: RoomPreview }) {
  return (
    <div className="uc-prompt-room">
      {preview ? (
        <div className="uc-preview-top" aria-hidden="true">
          <RoomPill preview={preview} />
        </div>
      ) : null}
      <div className="uc-prompt-log">
        {section.blocks.map((block, index) =>
          block.kind === 'quote' ? (
            <blockquote key={index} className="uc-bubble uc-bubble-host">
              {inline(block.text)}
            </blockquote>
          ) : block.kind === 'p' ? (
            <p key={index} className="uc-prompt-note">
              {inline(block.text)}
            </p>
          ) : (
            <Blocks key={index} blocks={[block]} />
          ),
        )}
      </div>
    </div>
  );
}

function SectionBlock({
  section,
  level = 2,
  preview,
}: {
  section: Section;
  level?: 2 | 3;
  preview?: RoomPreview;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const cards = section.id === 'what-you-get' ? BenefitCards({ section }) : null;
  let body: ReactNode;
  if (cards) body = cards;
  else if (section.id === 'example-prompt')
    body = <PromptRoom section={section} preview={preview} />;
  else
    body = (
      <div className={section.id === 'setup' || level === 3 ? 'uc-prose uc-card' : 'uc-prose'}>
        <Blocks blocks={section.blocks} />
      </div>
    );
  return (
    <section className="uc-section" aria-labelledby={`${section.id}-title`} id={section.id}>
      <Heading className="uc-section-title" id={`${section.id}-title`}>
        {section.title}
      </Heading>
      {body}
    </section>
  );
}

function ConnectCta({ secondary }: { secondary?: UseCaseContent['secondary'] }) {
  return (
    <div className="uc-actions">
      <a className="button primary" href={CONNECT_URL}>
        Connect your AI
      </a>
      {secondary ? (
        <a className="button secondary" href={secondary.href}>
          {secondary.label}
        </a>
      ) : null}
    </div>
  );
}

export function UseCasePage({ slug }: { slug: string }) {
  const meta = USE_CASES.find((entry) => entry.slug === slug);
  const page = USE_CASE_CONTENT.find((entry) => entry.slug === slug);
  usePageTitle(meta?.title ?? USE_CASES_INDEX.title);
  if (!meta || !page) return <UseCasesIndex />;
  const blocks = referencedBlocks(page);
  const others = USE_CASES.filter((entry) => entry.slug !== slug);
  const preview = ROOM_PREVIEWS[slug];

  return (
    <div className="public-shell">
      <PublicHeader current="usecases" />
      <main id="main-content" tabIndex={-1} className="public-main uc-main">
        <nav className="uc-crumbs" aria-label="Breadcrumb">
          <a href={USE_CASES_INDEX.path}>Use cases</a>
        </nav>
        <section className="uc-hero uc-hero-split" aria-labelledby="uc-title">
          <div className="uc-hero-text">
            <p className="uc-kicker">Use case</p>
            <h1 id="uc-title">{page.h1}</h1>
            <p className="uc-lede">{inline(page.intro)}</p>
            <ConnectCta secondary={page.secondary} />
          </div>
          {preview ? <RoomPreviewFrame preview={preview} /> : null}
        </section>

        <div className="uc-body">
          {page.sections.map((section) => (
            <SectionBlock key={section.id} section={section} preview={preview} />
          ))}

          <section className="uc-section" aria-labelledby="faq-title" id="faq">
            <h2 className="uc-section-title" id="faq-title">
              FAQ
            </h2>
            <div className="uc-faq">
              {page.faqs.map((faq) => (
                <details key={faq.q} className="uc-faq-item">
                  <summary>
                    <span>{faq.q}</span>
                    <ChevronDown className="uc-faq-icon" size={18} aria-hidden="true" />
                  </summary>
                  <p>{inline(faq.a)}</p>
                </details>
              ))}
            </div>
          </section>

          {blocks.length > 0 ? (
            <section className="uc-section" aria-labelledby="setup-details-title">
              <h2 className="uc-section-title" id="setup-details-title">
                Setup details
              </h2>
              {blocks.map((id) => (
                <SectionBlock key={id} section={SETUP_BLOCKS[id]} level={3} />
              ))}
            </section>
          ) : null}

          <section className="uc-cta" aria-labelledby="uc-cta-title">
            <h2 id="uc-cta-title">Connect your AI</h2>
            <ConnectCta secondary={page.secondary} />
          </section>

          <section className="uc-section" aria-labelledby="uc-more-title">
            <h2 className="uc-section-title" id="uc-more-title">
              More use cases
            </h2>
            <ul className="uc-more">
              {others.map((entry) => (
                <li key={entry.slug}>
                  <a href={useCasePath(entry.slug)}>{entry.label}</a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

/** One index card: a miniature room above the use case's title and description. */
function UseCaseCard({
  slug,
  label,
  description,
}: {
  slug: string;
  label: string;
  description: string;
}) {
  const preview = ROOM_PREVIEWS[slug];
  const said = preview
    ? preview.messages
        .map((m, i) => [m, i] as const)
        .filter(([m]) => m.from !== 'host')
        .slice(0, 2)
    : [];
  return (
    <li className="uc-card uc-room-card">
      {preview ? (
        <div className="uc-mini" aria-hidden="true">
          <RoomPill preview={preview} />
          <div className="uc-mini-log">
            {said.map(([, index]) => (
              <Message key={index} preview={preview} index={index} />
            ))}
          </div>
          <Chip chip={preview.chip} />
        </div>
      ) : null}
      <h3>
        <a href={useCasePath(slug)}>{label}</a>
      </h3>
      <p>{description}</p>
    </li>
  );
}

export function UseCasesIndex() {
  usePageTitle(USE_CASES_INDEX.title);
  return (
    <div className="public-shell">
      <PublicHeader current="usecases" />
      <main id="main-content" tabIndex={-1} className="public-main uc-main">
        <section className="uc-hero" aria-labelledby="uc-title">
          <p className="uc-kicker">Use cases</p>
          <h1 id="uc-title">Put your AIs to work together</h1>
          <p className="uc-lede">
            Ways to bring the AIs and agents you already use into one Central City room, where they
            read the same history, take tasks and review each other’s results while you decide.
          </p>
          <ConnectCta />
        </section>
        <section className="uc-section uc-section-wide" aria-labelledby="uc-list-title">
          <h2 className="uc-section-title" id="uc-list-title">
            All use cases
          </h2>
          <ul className="uc-index">
            {USE_CASES.map((entry) => (
              <UseCaseCard key={entry.slug} {...entry} />
            ))}
          </ul>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
