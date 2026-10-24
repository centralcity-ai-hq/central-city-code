import { useEffect, useRef } from 'react';

/*
 * The homepage's quiet visual: a field of blue dots in soft perspective, a slow wave receding into
 * the distance. About every 12 s the dots near the centre gather into the room (the CC mark's
 * rounded square, with a door on each side), hold it and flow back. Scroll shifts the wave a
 * little; the pointer leaves a gentle ripple. Decoration only: it shows no data.
 *
 * Reduced motion: one still frame. A hidden tab draws nothing. aria-hidden (decorative).
 */
interface Dot {
  u: number;
  v: number;
  ring: [number, number] | null;
  door: [number, number] | null;
}

export function DotField() {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = host.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0;
    let H = 0;
    let dots: Dot[] = [];
    let ringBox = { cx: 0, cy: 0, rw: 0 };
    const pointer = { x: -1e4, y: -1e4, a: 0 };
    let shift = 0;
    let frame = 0;

    const build = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = el.clientWidth;
      H = el.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = W < 720 ? 40 : 84;
      const rows = W < 720 ? 14 : 18;
      const rw = Math.min(W * 0.22, 230);
      const rh = rw * 0.5;
      const rr = rh * 0.44;
      const cx = W / 2;
      const cy = H * 0.5;
      ringBox = { cx, cy, rw };
      // The room outline, sampled into evenly spaced points.
      const poly: [number, number][] = [];
      const seg = (x0: number, y0: number, x1: number, y1: number) => {
        for (let k = 0; k < 40; k++)
          poly.push([x0 + ((x1 - x0) * k) / 40, y0 + ((y1 - y0) * k) / 40]);
      };
      const arc = (x: number, y: number, a0: number) => {
        for (let k = 0; k < 24; k++) {
          const t = a0 + (k / 24) * (Math.PI / 2);
          poly.push([x + Math.cos(t) * rr, y + Math.sin(t) * rr]);
        }
      };
      const L = cx - rw / 2;
      const R = cx + rw / 2;
      const T = cy - rh / 2;
      const B = cy + rh / 2;
      seg(L + rr, T, R - rr, T);
      arc(R - rr, T + rr, -Math.PI / 2);
      seg(R, T + rr, R, B - rr);
      arc(R - rr, B - rr, 0);
      seg(R - rr, B, L + rr, B);
      arc(L + rr, B - rr, Math.PI / 2);
      seg(L, B - rr, L, T + rr);
      arc(L + rr, T + rr, Math.PI);
      const lens = [0];
      for (let k = 1; k < poly.length; k++)
        lens.push(
          lens[k - 1]! + Math.hypot(poly[k]![0] - poly[k - 1]![0], poly[k]![1] - poly[k - 1]![1]),
        );
      const total = lens[lens.length - 1]!;
      const at = (u: number): [number, number] => {
        const d = u * total;
        let k = 1;
        while (k < lens.length && lens[k]! < d) k++;
        const i = Math.min(k, poly.length - 1);
        const j = i - 1;
        const span = lens[i]! - lens[j]!;
        const t = span ? (d - lens[j]!) / span : 0;
        return [
          poly[j]![0] + (poly[i]![0] - poly[j]![0]) * t,
          poly[j]![1] + (poly[i]![1] - poly[j]![1]) * t,
        ];
      };
      dots = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const u = c / (cols - 1);
          const v = r / (rows - 1);
          const near = Math.abs(u - 0.5) < 0.22 && v > 0.25 && v < 0.85 && (c + r) % 2 === 0;
          dots.push({ u, v, ring: near ? [0, 0] : null, door: null });
        }
      const ringDots = dots.filter((d) => d.ring).slice(0, 160);
      dots.forEach((d) => {
        if (d.ring && !ringDots.includes(d)) d.ring = null;
      });
      ringDots.forEach((d, i) => (d.ring = at(i / ringDots.length)));
      const left = dots.find(
        (d) => !d.ring && Math.abs(d.u - 0.36) < 0.02 && Math.abs(d.v - 0.55) < 0.06,
      );
      const right = dots.find(
        (d) => !d.ring && Math.abs(d.u - 0.64) < 0.02 && Math.abs(d.v - 0.55) < 0.06,
      );
      if (left) left.door = [L, cy];
      if (right) right.door = [R, cy];
    };

    // How far the room has formed: wave 6.5 s, gather 1.6 s, hold 2.2 s, release 1.8 s.
    const gather = (t: number) => {
      const c = t % 12.1;
      const s = (k: number) => k * k * (3 - 2 * k);
      if (c < 6.5) return 0;
      if (c < 8.1) return s((c - 6.5) / 1.6);
      if (c < 10.3) return 1;
      return 1 - s((c - 10.3) / 1.8);
    };

    const draw = (now: number) => {
      const t = reduce ? 2 : now / 1000;
      ctx.clearRect(0, 0, W, H);
      pointer.a += ((pointer.x > -1e3 ? 1 : 0) - pointer.a) * 0.06;
      const g = reduce ? 0 : gather(t);
      const horizon = H * 0.08;
      const base = H * 0.98;
      for (const d of dots) {
        const z = 1 - d.v;
        const persp = 1 / (1 + z * 2.2);
        const wave =
          Math.sin(d.u * 7 + t * 0.55 + shift) * 0.55 +
          Math.sin(d.u * 3.1 - d.v * 5 + t * 0.35) * 0.7 +
          Math.sin((d.u + d.v) * 11 + t * 0.8) * 0.18;
        let x = (d.u - 0.5) * W * 1.25 * persp + W / 2;
        let y = horizon + (base - horizon) * Math.pow(d.v, 1.15) - wave * 16 * persp;
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (pointer.a > 0.01 && dist < 160) {
          const k = (1 - dist / 160) * pointer.a;
          y += Math.sin(dist * 0.09 - t * 4) * 7 * k;
          x += (dx / dist) * 6 * k;
        }
        let size = (0.6 + persp * 1.9) * (1 + (wave + 1.4) * 0.08);
        let alpha = 0.1 + persp * 0.55;
        if (d.ring && g > 0) {
          x += (d.ring[0] - x) * g;
          y += (d.ring[1] - y) * g;
          size += g * 0.9;
          alpha += g * 0.45;
        }
        ctx.fillStyle = `rgba(36,87,245,${Math.min(0.95, alpha)})`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, 6.283);
        ctx.fill();
        if (d.door && g > 0.6) {
          const k = (g - 0.6) / 0.4;
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = `rgba(36,87,245,${k})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(d.door[0], d.door[1], 4.5 * k, 0, 6.283);
          ctx.fill();
          ctx.stroke();
        }
      }
      if (g > 0) {
        const { cx, cy, rw } = ringBox;
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, rw * 0.7);
        glow.addColorStop(0, `rgba(36,87,245,${0.07 * g})`);
        glow.addColorStop(1, 'rgba(36,87,245,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - rw, cy - rw, rw * 2, rw * 2);
      }
    };

    const loop = (now: number) => {
      if (!document.hidden) draw(now);
      frame = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
    };
    const leave = () => {
      pointer.x = pointer.y = -1e4;
    };
    const scroll = () => {
      shift = -el.getBoundingClientRect().top / 260;
    };
    const resize = () => {
      build();
      if (reduce) draw(0);
    };
    build();
    if (reduce) draw(0);
    else {
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerleave', leave);
      window.addEventListener('scroll', scroll, { passive: true });
      frame = requestAnimationFrame(loop);
    }
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="cc-field" ref={host} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
