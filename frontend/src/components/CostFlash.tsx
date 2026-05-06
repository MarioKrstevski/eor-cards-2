import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const PAUSE = 2000;          // ms to show cost before anything moves
const ANIMATE = 2000;        // ms for missiles + countdown
const MISSILE_TRAVEL = 1100; // ms each missile flies
const MAX_MISSILES = 20;
const MIN_MISSILES = 3;
// Cost thresholds: $0.005 → ~3 missiles, $0.30 → 20 missiles (linear)
const COST_MAX = 0.30;

function missileCount(cost: number): number {
  const t = Math.min(cost / COST_MAX, 1);
  return Math.max(MIN_MISSILES, Math.round(MIN_MISSILES + t * (MAX_MISSILES - MIN_MISSILES)));
}

export default function CostFlash() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    function handler(e: Event) {
      const { cost, prevTotal, newTotal, originX, originY } =
        (e as CustomEvent<{ cost: number; prevTotal: number; newTotal: number; originX?: number; originY?: number }>).detail;
      if (cost < 0.000001) return;
      if (busyRef.current) {
        window.dispatchEvent(new CustomEvent('costComplete', { detail: { newTotal } }));
        return;
      }
      start(cost, prevTotal, newTotal, originX, originY);
    }
    window.addEventListener('costIncurred', handler);
    return () => window.removeEventListener('costIncurred', handler);
  }, []);

  function addTrail(x: number, y: number) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;left:${x}px;top:${y}px;
      transform:translate(-50%,-50%);
      width:5px;height:5px;border-radius:50%;
      background:rgba(34,197,94,0.5);
      pointer-events:none;z-index:9999;
      transition:opacity 0.35s linear,transform 0.35s linear;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-50%) scale(0.3)';
    });
    setTimeout(() => el.remove(), 380);
  }

  function launchMissile(sx: number, sy: number, ex: number, ey: number, delay: number) {
    const tid = window.setTimeout(() => {
      const el = document.createElement('div');
      el.style.cssText = `
        position:fixed;left:${sx}px;top:${sy}px;
        transform:translate(-50%,-50%);
        width:9px;height:9px;border-radius:50%;
        background:#22c55e;
        box-shadow:0 0 6px rgba(34,197,94,0.9),0 0 14px rgba(34,197,94,0.45);
        pointer-events:none;z-index:9999;
      `;
      document.body.appendChild(el);

      const dx = ex - sx;
      const dy = ey - sy;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const curve = (Math.random() - 0.5) * 300;
      const cpx = sx + dx * 0.5 + nx * curve;
      const cpy = sy + dy * 0.5 + ny * curve;

      const t0 = performance.now();
      let tick = 0;

      function animate(now: number) {
        const t = Math.min((now - t0) / MISSILE_TRAVEL, 1);
        const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cpx + t ** 2 * ex;
        const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cpy + t ** 2 * ey;

        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.opacity = t > 0.75 ? String(1 - (t - 0.75) / 0.25) : '1';

        tick++;
        if (tick % 2 === 0) addTrail(x, y);

        if (t < 1) requestAnimationFrame(animate);
        else el.remove();
      }
      requestAnimationFrame(animate);
    }, delay);
    timeoutsRef.current.push(tid);
  }

  function start(cost: number, prevTotal: number, newTotal: number, originX?: number, originY?: number) {
    const container = containerRef.current;
    if (!container) return;
    const safeContainer: HTMLDivElement = container;

    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];

    busyRef.current = true;
    // Only show the centered overlay card for the default (non-chat) case
    if (!originX && !originY) safeContainer.style.display = 'block';

    const sx = originX ?? window.innerWidth / 2;
    const sy = originY ?? window.innerHeight / 2;
    const ex = window.innerWidth - 90;
    const ey = 22;

    const count = missileCount(cost);
    const spread = ANIMATE * 0.65;
    for (let i = 0; i < count; i++) {
      const delay = PAUSE + (i === 0 ? 0 : (i / (count - 1)) * spread);
      launchMissile(sx, sy, ex, ey, delay);
    }

    let t0: number | null = null;
    function frame(ts: number) {
      if (!t0) t0 = ts;
      const elapsed = ts - t0;

      // During the pause phase keep label at full cost, header unchanged
      if (elapsed < PAUSE) {
        if (labelRef.current) {
          labelRef.current.textContent = `$${cost.toFixed(4)}`;
        }
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      const animT = Math.min((elapsed - PAUSE) / ANIMATE, 1);

      if (labelRef.current) {
        labelRef.current.textContent = `$${(cost * (1 - animT)).toFixed(4)}`;
      }
      window.dispatchEvent(new CustomEvent('costProgress', {
        detail: { value: prevTotal + cost * animT },
      }));

      if (animT < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        safeContainer.style.display = 'none';
        busyRef.current = false;
        rafRef.current = null;
        window.dispatchEvent(new CustomEvent('costComplete', { detail: { newTotal } }));
      }
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  }

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 pointer-events-none"
      style={{ display: 'none' }}
    >
      {/* Centered overlay card */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/55 rounded-2xl px-10 py-6 flex flex-col items-center gap-2 backdrop-blur-[2px]">
        <p className="text-white/70 text-[10px] font-semibold tracking-[0.2em] uppercase">Task complete</p>
        <span ref={labelRef} className="text-green-500 text-2xl font-bold tabular-nums">$0.0000</span>
      </div>
    </div>,
    document.body
  );
}
