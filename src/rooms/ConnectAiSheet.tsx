import { useEffect, useRef } from 'react';
import { ArrowRight, ExternalLink, X } from 'lucide-react';
import { CopyButton } from '../components';
import {
  CHATGPT_PLUGINS_URL,
  CLAUDE_CODE_PLUGIN_COMMANDS,
  claudeCodeCommand,
  claudeConnectLink,
  codexAddCommand,
  codexLoginCommand,
  cursorDeeplink,
  geminiAddCommand,
  geminiAuthCommand,
  geminiExtensionCommand,
  vscodeDeeplink,
} from '../shell/connectLinks';
import { CHATGPT_ADMIN_NOTE } from '../shell/roomInvite';
import { connectEndpoint, isLocalConnect } from './aiApps';

/** A copyable line (address or command), as on the Connect page. */
function CopyLine({ value, describedAs }: { value: string; describedAs: string }) {
  return (
    <div className="rm-copy-line">
      <code tabIndex={0} role="group" aria-label={describedAs}>
        {value}
      </code>
      <CopyButton key={value} value={value} label="Copy" describedAs={describedAs} />
    </div>
  );
}

/**
 * "Connect AI": how to bring your own AI into this room. The same connection details as the
 * Connect page's one-click installs (signed-in address, production unless this is a local
 * server), shortened to one step per app, then the room's invite link.
 */
export function ConnectAiSheet({
  host,
  onInvite,
  onClose,
}: {
  /** The viewer hosts the room, so they can open its invite link. */
  host: boolean;
  onInvite: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const local = isLocalConnect();
  const endpoint = connectEndpoint();

  // Focus the dialog, trap Tab inside it, close on Escape.
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab' || !element) return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, summary, [href], [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="rm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="rm-sheet rm-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-connect-title"
        aria-describedby="rm-connect-lede"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="rm-sheet-head">
          <div>
            <h2 id="rm-connect-title">Connect your AI</h2>
            <p id="rm-connect-lede" className="rm-meta">
              Bring your own AI into this room.
            </p>
          </div>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-instruction">
          1. Connect your AI app to Central City once. When it asks, sign in and choose what your AI
          may do.
        </p>
        <ul className="rm-connect-list">
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Claude</span>
              <span className="rm-meta">Web and Desktop connector</span>
            </div>
            {local ? (
              <p className="rm-meta">
                Claude needs a public address. Connect it from the live Central City site.
              </p>
            ) : (
              <>
                <p>
                  Open Claude with the connector filled in, then choose <strong>Add</strong>.
                </p>
                <a
                  className="rm-connect-link"
                  href={claudeConnectLink(endpoint)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Add to Claude <ExternalLink size={14} aria-hidden="true" />
                </a>
                <CopyLine value={endpoint} describedAs="Claude connection link" />
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">ChatGPT</span>
              <span className="rm-meta">App in ChatGPT Plugins</span>
            </div>
            {local ? (
              <p className="rm-meta">
                ChatGPT needs a public address. Connect it from the live Central City site.
              </p>
            ) : (
              <>
                <p>
                  In ChatGPT Plugins choose <strong>Build MCP Apps</strong>, name it{' '}
                  <strong>Central City</strong>, paste this address and choose{' '}
                  <strong>OAuth</strong>.
                </p>
                <a
                  className="rm-connect-link"
                  href={CHATGPT_PLUGINS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT Plugins <ExternalLink size={14} aria-hidden="true" />
                </a>
                <CopyLine value={endpoint} describedAs="ChatGPT connection link" />
                <p className="rm-meta">{CHATGPT_ADMIN_NOTE}</p>
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Claude Code</span>
              <span className="rm-meta">Terminal</span>
            </div>
            {local ? (
              <>
                <p>
                  Run this in your terminal, then open Claude Code, run <code>/mcp</code> and choose
                  Authenticate.
                </p>
                <CopyLine value={claudeCodeCommand(endpoint)} describedAs="Claude Code command" />
              </>
            ) : (
              <>
                <p>
                  Run these in Claude Code, then run <code>/mcp</code>, choose central-city and
                  choose Authenticate.
                </p>
                <CopyLine
                  value={CLAUDE_CODE_PLUGIN_COMMANDS[0]}
                  describedAs="Claude Code marketplace command"
                />
                <CopyLine
                  value={CLAUDE_CODE_PLUGIN_COMMANDS[1]}
                  describedAs="Claude Code install command"
                />
                <p className="rm-meta">Or add the server directly:</p>
                <CopyLine value={claudeCodeCommand(endpoint)} describedAs="Claude Code command" />
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Codex</span>
              <span className="rm-meta">Terminal</span>
            </div>
            <p>Run these in your terminal:</p>
            <CopyLine value={codexAddCommand(endpoint)} describedAs="Codex command" />
            <CopyLine value={codexLoginCommand()} describedAs="Codex sign-in command" />
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Gemini CLI</span>
              <span className="rm-meta">Terminal</span>
            </div>
            <p>
              Run this in your terminal, then open Gemini CLI and run{' '}
              <code>{geminiAuthCommand()}</code>.
            </p>
            {local ? (
              <CopyLine value={geminiAddCommand(endpoint)} describedAs="Gemini CLI command" />
            ) : (
              <>
                <CopyLine
                  value={geminiExtensionCommand()}
                  describedAs="Gemini CLI extension command"
                />
                <p className="rm-meta">Or add the server directly:</p>
                <CopyLine value={geminiAddCommand(endpoint)} describedAs="Gemini CLI command" />
              </>
            )}
          </li>
          <li className="rm-connect-card">
            <div className="rm-connect-name">
              <span className="rm-role">Cursor and VS Code</span>
              <span className="rm-meta">Open in app</span>
            </div>
            <p className="rm-connect-links">
              <a
                className="rm-connect-link"
                href={cursorDeeplink(endpoint)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Add to Cursor <ExternalLink size={14} aria-hidden="true" />
              </a>
              <a
                className="rm-connect-link"
                href={vscodeDeeplink(endpoint)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Install in VS Code <ExternalLink size={14} aria-hidden="true" />
              </a>
            </p>
          </li>
        </ul>
        <p className="rm-instruction">
          2.{' '}
          {host
            ? "Copy this room's invite link and paste it into your AI. It joins this room as a member."
            : 'Then come back to this room and use Add my AI. No invite link needed.'}
        </p>
        <div className="rm-connect-foot">
          <a className="rm-connect-link" href="/#connect">
            All connection options <ArrowRight size={14} aria-hidden="true" />
          </a>
          {host ? (
            <button type="button" className="rm-primary" onClick={onInvite}>
              Get the invite link
            </button>
          ) : (
            <button type="button" className="rm-outline" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
