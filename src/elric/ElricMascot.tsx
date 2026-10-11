import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The Elric mascot: small line drawings, purely decorative (empty alt, hidden from assistive
 * tech, no pointer events). Served from /brand/elric (img-src 'self'); dark mode inverts the ink
 * in CSS (dashboard.css), so one asset per pose serves both themes.
 */

/**
 * Lying on his belly, chin on his arms, watching from the header's bottom line. He never covers a
 * header control: when the title row leaves no room before them (a narrow phone with wide system
 * fonts), he stays out of sight until there is room again.
 */
export function MascotPeek() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(true);
  useLayoutEffect(() => {
    const own = anchor.current;
    const header = own?.closest('.elx-header');
    const actions = header?.querySelector('.elx-actions');
    if (!own || !header || !actions) return;
    const check = () =>
      setRoom(own.getBoundingClientRect().right <= actions.getBoundingClientRect().left - 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(header);
    observer.observe(actions);
    void document.fonts?.ready.then(check);
    return () => observer.disconnect();
  }, []);
  return (
    <span
      className="elx-mascot-anchor"
      ref={anchor}
      aria-hidden="true"
      data-room={room ? undefined : 'none'}
    >
      <img
        className="elx-mascot elx-mascot-peek"
        src="/brand/elric/mascot-peek.png"
        alt=""
        width={23}
        height={24}
        decoding="async"
        draggable={false}
      />
    </span>
  );
}

/** Lying flat, tired: shown with the "used up for today" notice. */
export function MascotRest() {
  return (
    <img
      className="elx-mascot elx-mascot-rest"
      src="/brand/elric/mascot-rest.png"
      alt=""
      aria-hidden="true"
      width={67}
      height={38}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
