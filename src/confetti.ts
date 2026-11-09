// A short burst of the accent and the rainbow's colours over the page when a link is ready. It never runs while
// motion is off or the system asks for less of it.
import { RAINBOW } from '@glimstone/core';

export function confetti() {
  const level = document.documentElement.dataset.motion;
  if (level === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = Object.assign(document.createElement('canvas'), { width: innerWidth, height: innerHeight, className: 'cp-confetti' });
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d')!;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const colours = [accent, ...RAINBOW];
  const count = level === 'subtle' ? 60 : 140;
  const bits = Array.from({ length: count }, () => ({
    x: innerWidth / 2, y: innerHeight * .3,
    vx: (Math.random() - .5) * 14, vy: -Math.random() * 12 - 4,
    r: Math.random() * Math.PI, spin: (Math.random() - .5) * .4,
    c: colours[Math.floor(Math.random() * colours.length)]!,
  }));
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = Math.max(0, 1 - t / 1800);
    for (const b of bits) {
      b.vy += .35; b.vx *= .99; b.x += b.vx; b.y += b.vy; b.r += b.spin;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.r);
      g.fillStyle = b.c;
      g.fillRect(-4, -2, 8, 4);
      g.restore();
    }
    if (t < 1800) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
