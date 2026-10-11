import { useEffect, useState } from 'react';
import { number } from './countLogClient';
import { loadOnBase } from './onBaseData';
import './on-base.css';

/** The Agent Explorer's two views, under its title; each has its own address to share. */
export function ExplorerSwitch({
  current,
  all,
  onBase,
}: {
  current: 'all' | 'base';
  /** The counts beside each view, when known. */
  all: number | null;
  onBase: number | null;
}) {
  const count = (value: number | null) =>
    value === null ? null : <small> · {number.format(value)}</small>;
  return (
    <nav className="ob-switch" aria-label="Explorer views">
      <a href="/explorer" aria-current={current === 'all' ? 'page' : undefined}>
        All agents{count(all)}
      </a>
      <a href="/explorer/base" aria-current={current === 'base' ? 'page' : undefined}>
        On Base{count(onBase)}
      </a>
    </nav>
  );
}

/** How many registered agents are on Base, for the switch on the All agents view (null until known). */
export function useOnBaseCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    loadOnBase()
      .then((list) => live && setCount(list.totals.onBase))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return count;
}
