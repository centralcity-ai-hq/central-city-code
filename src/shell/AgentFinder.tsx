import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, LoaderCircle, Search, Star } from 'lucide-react';
import type { DirectoryCard, DirectoryChain } from '../../shared/directory';
import { ON_BASE_QUERY_MAX } from '../../shared/base/on-base';
import { arcEnabled, explorerChainOf } from '../explorer/chain';
import { findAgents, standing } from '../verify/directoryData';
import { initial, passportPath } from '../verify/onBaseData';
import { finderEnterHref } from './agentFinderEnter';
import { avatarColor } from './avatarColor';
import './agent-finder.css';

/*
 * The header's finder (Operation Directory D1, docs/design/directory.html): the search icon or
 * Cmd/Ctrl+K opens it on any public page. It searches the Base Agents directory by name, skill or
 * Base ID; Enter (or a press) opens the agent's passport. While the directory has no match (it is
 * opt-in and starts empty) it searches every Central City agent on Base instead. While the server
 * has Arc on (arcEnabled, the Arc pages' probe), a Base / Arc switch does the same on Arc.
 */

/** Rows shown at most; the page has the rest. */
const SHOWN = 6;
const DELAY_MS = 180;

type State =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      agents: DirectoryCard[];
      source: 'directory' | 'registry';
      query: string;
      /** Why the registry answer may be incomplete or was not searched (shown, never hidden). */
      note?: string;
    }
  | { phase: 'error' };

export default function AgentFinder({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [active, setActive] = useState(0);
  const [chain, setChain] = useState<DirectoryChain>('base');
  const [arcLive, setArcLive] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const titleId = useId();

  useEffect(() => {
    input.current?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', keydown);
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', keydown);
      document.documentElement.style.overflow = overflow;
    };
  }, [onClose]);

  useEffect(() => {
    let live = true;
    arcEnabled().then((on) => {
      if (live) setArcLive(on);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        findAgents(text, controller.signal, chain).then(
          (found) => {
            setActive(0);
            setState({
              phase: 'ready',
              query: text,
              source: found.source,
              agents: found.agents.slice(0, SHOWN),
              ...(found.note ? { note: found.note } : {}),
            });
          },
          () => !controller.signal.aborted && setState({ phase: 'error' }),
        );
      },
      text ? DELAY_MS : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [text, chain]);

  const agents = state.phase === 'ready' ? state.agents : [];
  const { name: chainName, home: pageHref } = explorerChainOf(chain);

  /** Another chain's list: the old one leaves at once, and typing goes on where it was. */
  function choose(next: DirectoryChain) {
    if (next !== chain) {
      setChain(next);
      setState({ phase: 'loading' });
    }
    input.current?.focus();
  }

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (agents.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (active + step + agents.length) % agents.length;
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const shown = state.phase === 'ready' ? state : null;
      window.location.assign(finderEnterHref(shown, text, active, pageHref));
    }
  }

  return (
    <div className="af-layer">
      <div className="af-scrim" aria-hidden="true" onClick={onClose} />
      <div className="af-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="visually-hidden">
          Find an agent
        </h2>
        <div className="af-input">
          <Search size={19} aria-hidden="true" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded={agents.length > 0}
            aria-controls={listId}
            aria-activedescendant={agents[active] ? `${listId}-${active}` : undefined}
            aria-label={`Find an agent by name, skill or ${chainName} ID`}
            placeholder={`Name, skill or ${chainName} ID`}
            maxLength={ON_BASE_QUERY_MAX}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (state.phase !== 'ready') setState({ phase: 'loading' });
            }}
            onKeyDown={keys}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          {state.phase === 'loading' ? (
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
          ) : null}
          <button type="button" className="af-esc" onClick={onClose}>
            <span className="af-esc-key">esc</span>
            <span className="af-esc-word">Cancel</span>
          </button>
        </div>

        {arcLive ? (
          <div className="af-chains" role="group" aria-label="Chain">
            {(['base', 'arc'] as const).map((slug) => (
              <button
                key={slug}
                type="button"
                className="af-chain"
                aria-pressed={chain === slug}
                onClick={() => choose(slug)}
              >
                <span className={`ob-chain ob-chain-${slug}`} aria-hidden="true" />
                {explorerChainOf(slug).name}
              </button>
            ))}
          </div>
        ) : null}

        {agents.length > 0 && state.phase === 'ready' && state.source === 'registry' ? (
          <p className="af-caption">
            All agents on {chainName}
            {state.note ? ` · ${state.note}` : ''}
          </p>
        ) : null}
        {agents.length > 0 ? (
          <ul ref={list} id={listId} className="af-list" role="listbox" aria-label="Agents">
            {agents.map((card, index) => {
              const { stars, paid } = standing(card);
              return (
                <li
                  key={card.baseId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                >
                  <a
                    href={passportPath(card.short)}
                    className="af-row"
                    tabIndex={-1}
                    onMouseMove={() => setActive(index)}
                  >
                    <i
                      className="af-av"
                      style={{ background: avatarColor(card.baseId) }}
                      aria-hidden="true"
                    >
                      {initial(card.name)}
                    </i>
                    <span className="af-text">
                      <b>{card.name}</b>
                      <span>
                        {card.description ||
                          card.skills.join(', ') ||
                          `${chainName} ID ${card.baseId}`}
                      </span>
                    </span>
                    <span className="af-standing">
                      {stars ? (
                        <span className="af-stars">
                          <Star size={11} aria-hidden="true" />
                          <b>{stars}</b>
                        </span>
                      ) : null}
                      {paid ? <span>{paid}</span> : null}
                      {!stars && !paid ? <span>New</span> : null}
                    </span>
                  </a>
                  {card.chain && card.explorerUrl ? (
                    <a
                      href={card.explorerUrl}
                      className="af-chain-id"
                      target="_blank"
                      rel="noreferrer"
                      tabIndex={-1}
                    >
                      {chainName} ID {card.baseId}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : state.phase === 'loading' ? null : (
          <p className="af-note" role="status">
            {state.phase === 'error'
              ? "The directory couldn't be loaded. Try again in a moment."
              : state.note
                ? state.note
                : text.trim()
                  ? `No agent on ${chainName} matches “${text.trim()}”.`
                  : `No agents on ${chainName} yet.`}
          </p>
        )}

        <div className="af-foot">
          <span className="af-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> choose <kbd>↵</kbd> open passport
          </span>
          <a href={pageHref} className="af-all">
            All {chainName} Agents <ArrowRight size={13} aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
