import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import { avatarStyle, useAvatarColor } from '../shell/avatarColor';
import { initialOf } from '../rooms/Avatar';

/*
 * Small pieces the Agent permissions page and its New connection sheet share: avatars, the drawn
 * route between two agents and the ⋯ menu. Styles: src/permissions/agent-permissions.css.
 */

/**
 * An agent's avatar: white initials on its list colour (src/shell/avatarColor.ts). An agent of
 * another person has no colour of ours: a dashed outline marks it as external. Decorative; the
 * name always sits next to it.
 */
export function AgentAvatar({
  id,
  name,
  external = false,
}: {
  id: string;
  name: string;
  external?: boolean;
}) {
  const colour = useAvatarColor(id);
  return (
    <span
      className="perm3-av"
      data-external={external ? 'true' : undefined}
      style={external ? undefined : avatarStyle(id, colour)}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

/** An avatar and a name, with an optional muted line (capability) under it. */
export function AgentLabel({
  id,
  name,
  sub,
  external = false,
}: {
  id: string;
  name: string;
  sub?: string;
  external?: boolean;
}) {
  return (
    <span className="perm3-agent">
      <AgentAvatar id={id} name={name} external={external} />
      <span className="perm3-agent-text">
        <b>{name}</b>
        {sub ? <small>{sub}</small> : null}
      </span>
    </span>
  );
}

/**
 * The route between two agents: a dashed line that ends in a dot on the side that does the work,
 * with a small dot travelling along it (still under reduced motion). Decorative: the words next
 * to it say the direction.
 */
export function Wire() {
  return (
    <span className="perm3-wire" aria-hidden="true">
      <i />
    </span>
  );
}

export type MenuItem = { label: string; danger?: boolean; onSelect: () => void };

/**
 * A ⋯ button with a menu (Messages' ThreadMenu pattern): arrows, Home and End move between the
 * items, Escape closes it and gives focus back to the button, Tab leaves and closes it, a click
 * outside closes it. Choosing an item puts focus back on the button first, so a sheet the item
 * opens returns focus there when it closes.
 */
export function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div
      className="perm3-more"
      ref={ref}
      onKeyDown={(event) => {
        if (!open) return;
        const options = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ];
        const at = options.indexOf(document.activeElement as HTMLButtonElement);
        const move = (index: number) => {
          event.preventDefault();
          options[(index + options.length) % options.length]?.focus();
        };
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        } else if (event.key === 'ArrowDown') move(at + 1);
        else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(-1);
        else if (event.key === 'Tab') setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="perm3-round"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="perm3-menu" role="menu" aria-label={label}>
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              autoFocus={index === 0}
              className={item.danger ? 'perm3-danger' : undefined}
              onClick={() => {
                button.current?.focus();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A card's heading row: the title with its count, a muted line, and optional tools. */
export function CardHead({
  id,
  title,
  count,
  sub,
  tools,
}: {
  id: string;
  title: string;
  count?: number;
  sub?: string;
  tools?: ReactNode;
}) {
  return (
    <div className="perm3-cardhead">
      <div className="perm3-grow">
        <div className="perm3-titlerow">
          {/* The heading names its card (aria-labelledby), so the count sits beside it. */}
          <h2 id={id} tabIndex={-1}>
            {title}
          </h2>
          {count !== undefined ? <span className="perm3-num">{count}</span> : null}
        </div>
        {sub ? <p>{sub}</p> : null}
      </div>
      {tools}
    </div>
  );
}
