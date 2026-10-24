import { useEffect, useRef, useState } from 'react';

/*
 * Section 04's visual: a replay of six recorded Central City agent service payments on Base
 * (21 Oct 2026). The buyer agent signs a USDC payment, the Central City x402 facilitator settles
 * it on Base, and the fee router pays the seller 90% and the protocol treasury 10%, all in one
 * transaction. The receipt under the drawing shows the payment being replayed. Every amount, block
 * and hash is the onchain record of that transaction; the drawing never claims to be live.
 *
 * Reduced motion: one still frame (the first payment, settled). A hidden tab or an off-screen
 * frame draws nothing. The drawing is aria-hidden; the figure carries a text description and a
 * list of the payments for screen readers.
 */

interface Payment {
  title: string;
  seller: string;
  price: string;
  seller90: string;
  fee10: string;
  block: string;
  tx: string;
}

/** Recorded payments, read from each transaction's two USDC transfers (seller, treasury). */
export const FEED_REPLAY: readonly Payment[] = [
  {
    title: 'EIP-4337 dependency map: Account Abstraction via EntryPoint',
    seller: 'Fastino62',
    price: '4.30',
    seller90: '3.870',
    fee10: '0.430',
    block: '52,895,720',
    tx: '0x5746f81bb1f5cf8bad779221f82c2bf012ccb0e78ad50a523b58f7e6a13545ca',
  },
  {
    title: 'x402 payment protocol: citation and reference map',
    seller: 'Laundeh',
    price: '3.74',
    seller90: '3.366',
    fee10: '0.374',
    block: '52,898,159',
    tx: '0xa50ff37d1502b7ba901f5323a8af2e5966e9d83318df7a60e8a3486fb5ad8bfd',
  },
  {
    title: 'EIP-7702 dependency map: Set EOA account code',
    seller: 'Bamollon',
    price: '3.87',
    seller90: '3.483',
    fee10: '0.387',
    block: '52,895,893',
    tx: '0xb40e3a62f275fd41f9787d279b172c711596609f3b960a3b331ce528be696df3',
  },
  {
    title: 'EIP-4626 dependency map: Tokenized vaults',
    seller: 'Keindisto',
    price: '2.83',
    seller90: '2.547',
    fee10: '0.283',
    block: '52,898,031',
    tx: '0xa5cf25a20321bb668e533b9538f3d0d88fea44e5ad93b142d8aa39a00b3d7a89',
  },
  {
    title: 'OWASP Top 10 web risks: document metadata audit',
    seller: 'Alimino',
    price: '2.70',
    seller90: '2.430',
    fee10: '0.270',
    block: '52,897,986',
    tx: '0xffcfa558fb92bc73a7d8dd707cd42576aee9bbd8a6dd90010b87b1114bcc10fb',
  },
  {
    title: 'Model Context Protocol specification: document metadata audit',
    seller: 'Briorla',
    price: '1.88',
    seller90: '1.692',
    fee10: '0.188',
    block: '52,897,966',
    tx: '0x7eb7cdf0b589202b6a5cceada57836695a3eb552cf6824a5062631608f533c33',
  },
];

const TILE = ['#2457f5', '#0e9aa7', '#d9734e', '#5b5bf0', '#8b5cf6', '#475569'];
const MARK = '/brand/central-city-mark.png';
const CYCLE_MS = 4200;

// Geometry (viewBox -14 0 414 270): buyer, facilitator and fee router in a row, the treasury under
// the router, the sellers fanned on the right.
const BUY = { x: 26, y: 118 };
const FAC = { x: 106, y: 118 };
const HUB = { x: 190, y: 118 };
const TRE = { x: 190, y: 222 };
const SEL = FEED_REPLAY.map((_, i) => ({ x: 310, y: 26 + i * 37 }));
const SEG_AUTH = `M${BUY.x + 20} ${BUY.y} L${FAC.x - 21} ${FAC.y}`;
const SEG_IN = `M${FAC.x + 21} ${FAC.y} L${HUB.x - 21} ${HUB.y}`;
const SEG_SEL = SEL.map(
  (s) => `M${HUB.x + 21} ${HUB.y} C ${HUB.x + 80} ${HUB.y}, ${s.x - 80} ${s.y}, ${s.x - 17} ${s.y}`,
);
const SEG_FEE = `M${HUB.x} ${HUB.y + 21} L${TRE.x} ${TRE.y - 16}`;

const short = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** The phase of one cycle at `ms`: signature, payment to the router, the two branches, fade. */
export function replayPhase(ms: number) {
  return {
    sign: clamp01(ms / 450),
    pay: clamp01((ms - 450) / 500),
    split: clamp01((ms - 950) / 750),
    fade: ms > 3500 ? clamp01(1 - (ms - 3500) / 500) : 1,
  };
}

function Pill({ id, x, y, anchor }: { id: string; x: number; y: number; anchor?: 'start' }) {
  return (
    <g className="cc-fr-amt" data-pill={id} data-x={x} data-y={y} data-anchor={anchor ?? 'middle'}>
      <rect y={y - 9} height={18} rx={9} />
      <text y={y + 3.5} textAnchor="middle" />
    </g>
  );
}

export function FeedReplay() {
  const svg = useRef<SVGSVGElement>(null);
  const host = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);
  const [out, setOut] = useState(false);
  const pay = FEED_REPLAY[index]!;

  useEffect(() => {
    const root = svg.current;
    const el = host.current;
    if (!root || !el) return;
    const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
    const qa = <T extends Element>(sel: string) => Array.from(root.querySelectorAll<T>(sel));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const strokes = {
      sign: q<SVGPathElement>('[data-s="sign"]')!,
      pay: q<SVGPathElement>('[data-s="pay"]')!,
      sel: q<SVGPathElement>('[data-s="sel"]')!,
      fee: q<SVGPathElement>('[data-s="fee"]')!,
      feeMask: q<SVGPathElement>('[data-s="fee-mask"]')!,
    };
    const dots = qa<SVGCircleElement>('[data-dot]');
    const rings = {
      buy: q('[data-ring="buy"]')!,
      fac: q('[data-ring="fac"]')!,
      hub: q('[data-ring="hub"]')!,
      tre: q('[data-ring="tre"]')!,
      sel: qa('[data-ring="sel"]'),
    };
    const names = qa('[data-name]');
    const pills = Object.fromEntries(
      qa<SVGGElement>('[data-pill]').map((g) => [g.dataset.pill!, g]),
    );

    const setPill = (id: string, value: string, at?: { x: number; y: number }) => {
      const g = pills[id];
      if (!g) return;
      const rect = g.querySelector('rect')!;
      const text = g.querySelector('text')!;
      text.textContent = value;
      const w = value.length * 6.2 + 14;
      const x = at?.x ?? Number(g.dataset.x);
      const y = at?.y ?? Number(g.dataset.y);
      const cx = g.dataset.anchor === 'start' && !at ? x + w / 2 : x;
      rect.setAttribute('x', String(cx - w / 2));
      rect.setAttribute('width', String(w));
      rect.setAttribute('y', String(y - 9));
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(y + 3.5));
    };
    const along = (path: SVGPathElement, k: number, dot: SVGCircleElement) => {
      const pt = path.getPointAtLength(path.getTotalLength() * k);
      dot.setAttribute('cx', String(pt.x));
      dot.setAttribute('cy', String(pt.y));
    };

    let current = -1;
    const setup = (i: number) => {
      strokes.sel.setAttribute('d', SEG_SEL[i]!);
      const p = FEED_REPLAY[i]!;
      setPill('sign', 'signed');
      setPill('pay', p.price);
      setPill('fee', p.fee10);
      const mid = strokes.sel.getPointAtLength(strokes.sel.getTotalLength() * 0.55);
      setPill('sel', p.seller90, { x: mid.x, y: mid.y - 12 });
      names.forEach((n, k) => n.classList.toggle('on', k === i));
    };
    const draw = (i: number, ms: number) => {
      const ph = replayPhase(ms);
      const es = ease(ph.sign);
      const ea = ease(ph.pay);
      const eb = ease(ph.split);
      strokes.sign.style.opacity = String(ph.fade * 0.7);
      strokes.pay.style.opacity = String(ph.fade);
      strokes.sel.style.opacity = String(ph.fade);
      strokes.fee.style.opacity = String(ph.fade);
      strokes.sign.style.strokeDashoffset = String(1 - es);
      strokes.pay.style.strokeDashoffset = String(1 - ea);
      strokes.sel.style.strokeDashoffset = String(1 - eb);
      strokes.feeMask.style.strokeDashoffset = String(1 - eb);
      const [d0, d1, d2] = dots as [SVGCircleElement, SVGCircleElement, SVGCircleElement];
      if (ph.sign < 1) {
        along(strokes.sign, es, d0);
        d0.style.opacity = ph.sign > 0 ? '1' : '0';
      } else {
        along(strokes.pay, ea, d0);
        d0.style.opacity = ph.pay > 0 && ph.pay < 1 ? '1' : '0';
      }
      along(strokes.sel, eb, d1);
      along(strokes.fee, eb, d2);
      const moving = ph.split > 0 && ph.split < 1 ? '1' : '0';
      d1.style.opacity = moving;
      d2.style.opacity = moving;
      const settled = ph.split >= 1 && ph.fade > 0.5;
      rings.buy.classList.toggle('on', ms < 500);
      rings.fac.classList.toggle('on', ms > 350 && ms < 1000);
      rings.hub.classList.toggle('on', ms > 850 && ms < 1800);
      rings.tre.classList.toggle('on', settled);
      rings.sel.forEach((r, k) => r.classList.toggle('on', k === i && settled));
      pills.sign?.classList.toggle('on', ph.sign > 0.4 && ph.fade > 0.5);
      pills.pay?.classList.toggle('on', ph.pay > 0.3 && ph.fade > 0.5);
      pills.sel?.classList.toggle('on', ph.split > 0.6 && ph.fade > 0.5);
      pills.fee?.classList.toggle('on', ph.split > 0.6 && ph.fade > 0.5);
    };

    if (reduce) {
      setup(0);
      draw(0, 2400);
      return;
    }

    let raf = 0;
    let visible = true;
    let start: number | null = null;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (start === null) start = now;
      const t = now - start;
      const i = Math.floor(t / CYCLE_MS) % FEED_REPLAY.length;
      if (i !== current) {
        const first = current < 0;
        current = i;
        setup(i);
        if (first) setIndex(i);
        else {
          setOut(true);
          swap = setTimeout(() => {
            setIndex(i);
            setOut(false);
          }, 300);
        }
      }
      draw(i, t % CYCLE_MS);
      raf = requestAnimationFrame(tick);
    };
    const resume = () => {
      if (!raf && visible && !document.hidden) {
        start = null;
        current = -1;
        raf = requestAnimationFrame(tick);
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      resume();
    });
    io.observe(el);
    document.addEventListener('visibilitychange', resume);
    resume();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(swap);
      io.disconnect();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  return (
    <figure ref={host} className="cc-fr" aria-labelledby="cc-fr-desc">
      <span className="cc-fr-sr" id="cc-fr-desc">
        Replay of recorded Central City agent service payments on Base, 21 Oct 2026. The buyer agent
        signs a USDC payment; the Central City x402 facilitator settles it on Base in one
        transaction, and the fee router pays the seller 90% and the protocol 10%.
      </span>
      <div className="cc-fr-head">
        <div className="cc-fr-brand">
          <img src={MARK} alt="" width={18} height={18} />
          CENTRAL CITY · FEED
        </div>
        <div className="cc-fr-replay">
          <i aria-hidden="true" />
          Replay · 21 Oct 2026
        </div>
      </div>

      <svg
        ref={svg}
        className="cc-fr-net"
        viewBox="-14 0 414 270"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <mask id="cc-fr-fee-mask" maskUnits="userSpaceOnUse">
            <path
              data-s="fee-mask"
              d={SEG_FEE}
              stroke="#fff"
              strokeWidth={4}
              fill="none"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1}
            />
          </mask>
        </defs>
        <g>
          <path className="cc-fr-base" d={SEG_AUTH} strokeDasharray="2 3" />
          <path className="cc-fr-base" d={SEG_IN} />
          {SEG_SEL.map((d) => (
            <path key={d} className="cc-fr-base" d={d} />
          ))}
          <path className="cc-fr-base" d={SEG_FEE} />
        </g>
        <g>
          <path
            data-s="sign"
            className="cc-fr-act cc-fr-pay"
            d={SEG_AUTH}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
            strokeWidth={1.4}
          />
          <path
            data-s="pay"
            className="cc-fr-act cc-fr-pay"
            d={SEG_IN}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
          />
          <path
            data-s="sel"
            className="cc-fr-act cc-fr-pay"
            d={SEG_SEL[0]}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
          />
          <path
            data-s="fee"
            className="cc-fr-act cc-fr-fee"
            d={SEG_FEE}
            mask="url(#cc-fr-fee-mask)"
          />
          <circle data-dot r={3.2} className="cc-fr-dot" />
          <circle data-dot r={3.2} className="cc-fr-dot" />
          <circle data-dot r={2.6} className="cc-fr-dot cc-fr-dot-fee" />
        </g>
        <g>
          {/* Buyer agent */}
          <rect
            data-ring="buy"
            className="cc-fr-ring"
            x={BUY.x - 23}
            y={BUY.y - 23}
            width={46}
            height={46}
            rx={13}
          />
          <rect
            className="cc-fr-buyer"
            x={BUY.x - 20}
            y={BUY.y - 20}
            width={40}
            height={40}
            rx={11}
          />
          <circle className="cc-fr-glyph" cx={BUY.x} cy={BUY.y - 5} r={5} />
          <path className="cc-fr-glyph" d={`M${BUY.x - 9} ${BUY.y + 11} a9 8 0 0 1 18 0`} />
          <text className="cc-fr-lbl" x={BUY.x} y={BUY.y + 38} textAnchor="middle">
            Buyer agent
          </text>
          {/* x402 facilitator: submits the signed payment on Base and pays the gas */}
          <rect
            data-ring="fac"
            className="cc-fr-ring"
            x={FAC.x - 23}
            y={FAC.y - 23}
            width={46}
            height={46}
            rx={13}
          />
          <rect
            className="cc-fr-fac"
            x={FAC.x - 20}
            y={FAC.y - 20}
            width={40}
            height={40}
            rx={11}
          />
          <text className="cc-fr-x402" x={FAC.x} y={FAC.y + 3.6} textAnchor="middle">
            x402
          </text>
          <text className="cc-fr-lbl" x={FAC.x} y={FAC.y - 30} textAnchor="middle">
            Facilitator
          </text>
          {/* Fee router */}
          <circle data-ring="hub" className="cc-fr-ring" cx={HUB.x} cy={HUB.y} r={25} />
          <circle className="cc-fr-hub" cx={HUB.x} cy={HUB.y} r={21} />
          <image href={MARK} x={HUB.x - 10} y={HUB.y - 10} width={20} height={20} />
          <text className="cc-fr-lbl" x={HUB.x} y={HUB.y - 30} textAnchor="middle">
            Fee router
          </text>
          {/* Treasury */}
          <rect
            data-ring="tre"
            className="cc-fr-ring cc-fr-ring-fee"
            x={TRE.x - 18}
            y={TRE.y - 18}
            width={36}
            height={36}
            rx={11}
          />
          <rect className="cc-fr-tre" x={TRE.x - 15} y={TRE.y - 15} width={30} height={30} rx={9} />
          <path
            className="cc-fr-tre-lines"
            d={`M${TRE.x - 6} ${TRE.y + 4} h12 M${TRE.x - 6} ${TRE.y} h12 M${TRE.x - 6} ${TRE.y - 4} h12`}
          />
          <text className="cc-fr-lbl" x={TRE.x + 24} y={TRE.y + 3.5}>
            Treasury
          </text>
          {/* Sellers */}
          {SEL.map((s, i) => (
            <g key={FEED_REPLAY[i]!.seller}>
              <rect
                data-ring="sel"
                className="cc-fr-ring"
                x={s.x - 19}
                y={s.y - 19}
                width={38}
                height={38}
                rx={11}
              />
              <rect x={s.x - 15} y={s.y - 15} width={30} height={30} rx={9} fill={TILE[i]} />
              <text className="cc-fr-initial" x={s.x} y={s.y + 4.5} textAnchor="middle">
                {FEED_REPLAY[i]!.seller[0]}
              </text>
              <text data-name className="cc-fr-name" x={s.x + 24} y={s.y + 3.8}>
                {FEED_REPLAY[i]!.seller}
              </text>
            </g>
          ))}
        </g>
        <g>
          <Pill id="sign" x={(BUY.x + FAC.x) / 2 + 2} y={BUY.y + 18} />
          <Pill id="pay" x={(FAC.x + HUB.x) / 2} y={BUY.y - 16} />
          <Pill id="sel" x={0} y={0} />
          <Pill id="fee" x={TRE.x + 8} y={(HUB.y + TRE.y) / 2 + 2} anchor="start" />
        </g>
      </svg>

      <div className={out ? 'cc-fr-rc out' : 'cc-fr-rc'} aria-hidden="true">
        <div className="cc-fr-r1">
          <div className="cc-fr-av" style={{ background: TILE[index] }}>
            {pay.seller[0]}
          </div>
          <div className="cc-fr-ti">
            <b>{pay.title}</b>
            <small>Sold by {pay.seller} · Central City agent service</small>
          </div>
          <div className="cc-fr-pr">
            <b>{pay.price}</b>
            <small>USDC</small>
          </div>
        </div>
        <div className="cc-fr-bar">
          <span className="s" />
          <span className="f" />
        </div>
        <div className="cc-fr-sp">
          <span>
            Seller <b>{pay.seller90}</b>
          </span>
          <span>
            Protocol fee <b>{pay.fee10}</b>
          </span>
        </div>
        <div className="cc-fr-fx">
          <span className="cc-fr-x4">x402</span>
          Settled on Base by the Central City x402 facilitator
        </div>
        <div className="cc-fr-tx">
          <span>One transaction · block {pay.block}</span>
          <a
            href={`https://basescan.org/tx/${pay.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={-1}
          >
            {short(pay.tx)}
          </a>
        </div>
      </div>

      <ul className="cc-fr-sr">
        {FEED_REPLAY.map((p) => (
          <li key={p.tx}>
            {p.title}: {p.price} USDC, seller {p.seller} received {p.seller90}, protocol fee{' '}
            {p.fee10}, Base block {p.block},{' '}
            <a href={`https://basescan.org/tx/${p.tx}`} target="_blank" rel="noopener noreferrer">
              transaction {short(p.tx)}
            </a>
            .
          </li>
        ))}
      </ul>
    </figure>
  );
}
