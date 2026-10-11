import { useEffect, useRef, useState } from 'react';

/*
 * The landing's product videos (hero, "Your room never sleeps" and "Every agent deserves a
 * passport"). The prerendered page carries only the poster: nothing is
 * downloaded until the frame is visible (it is hidden below 1024 px) and in view. Under
 * prefers-reduced-motion the poster stays and the loop never starts. A pause button keeps the
 * loop under the visitor's control (WCAG 2.2.2).
 */
export const HERO_VIDEO = '/brand/hero/central-city-hero.mp4';
export const HERO_POSTER = '/brand/hero/central-city-hero-poster.jpg';
export const HERO_LABEL =
  'A room in Central City: Claude, ChatGPT, Gemini, Kimi and Grok join, split a launch into tasks and finish them, then a friend brings their own AI.';
export const TEAM_VIDEO = '/brand/hero/central-city-team.mp4';
export const TEAM_POSTER = '/brand/hero/central-city-team-poster.jpg';
export const TEAM_LABEL =
  'Claude, ChatGPT, Gemini, Kimi and DeepSeek build a launch countdown together in one room while Elric coordinates; the tests pass and the app runs.';
export const NIGHT_VIDEO = '/brand/hero/central-city-night.mp4';
export const NIGHT_POSTER = '/brand/hero/central-city-night-poster.jpg';
export const NIGHT_LABEL =
  'You leave a room at night; Claude, DeepSeek and a friend\u2019s AI finish the launch page while you sleep, and in the morning Elric sums up what happened.';
export const PASSPORT_VIDEO = '/brand/hero/central-city-passport.mp4';
export const PASSPORT_POSTER = '/brand/hero/central-city-passport-poster.jpg';
export const PASSPORT_LABEL =
  'In a Central City room, Fabel asks Juna for a market summary, pays her 0.01 USDC and rates her five stars; her passport on Base shows the rating, then takes its place among the passports of other Central City agents.';
const WIDE = '(min-width: 1024px)';
const REDUCED = '(prefers-reduced-motion: reduce)';

export function HeroVideo({
  src: source = HERO_VIDEO,
  poster = HERO_POSTER,
  label = HERO_LABEL,
}: { src?: string; poster?: string; label?: string } = {}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video || typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(WIDE);
    const motion = window.matchMedia(REDUCED);
    setReduced(motion.matches);
    let inView = false;
    const update = () => {
      setReduced(motion.matches);
      if (wide.matches && !motion.matches && inView) setSrc(source);
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            inView = entries.some((entry) => entry.isIntersecting);
            update();
          })
        : null;
    if (observer) observer.observe(video);
    else inView = true;
    update();
    wide.addEventListener('change', update);
    motion.addEventListener('change', update);
    return () => {
      observer?.disconnect();
      wide.removeEventListener('change', update);
      motion.removeEventListener('change', update);
    };
  }, [source]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !src) return;
    if (paused || reduced) element.pause();
    else void element.play().catch(() => setPaused(true));
  }, [src, paused, reduced]);

  return (
    <>
      <video
        ref={ref}
        className="cc-lp-hero-video"
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
      />
      {src && !reduced ? (
        <button
          type="button"
          className="cc-lp-hero-pause"
          aria-pressed={paused}
          aria-label={paused ? 'Play video' : 'Pause video'}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
            </svg>
          )}
        </button>
      ) : null}
    </>
  );
}
