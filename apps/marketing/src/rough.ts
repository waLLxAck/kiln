// Hand-drawn pen strokes as SVG path data. Seeded, so every render wobbles the same way.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const j = (a: number) => (rnd() - .5) * 2 * a;
const f = (n: number) => Math.round(n * 10) / 10;
export const reseed = (value: number) => { seed = value; };

export function line(x1: number, y1: number, x2: number, y2: number, w = 1.4) {
  const mx = (x1 + x2) / 2 + j(w * 1.6), my = (y1 + y2) / 2 + j(w * 1.6);
  return `M${f(x1 + j(w))},${f(y1 + j(w))} Q${f(mx)},${f(my)} ${f(x2 + j(w))},${f(y2 + j(w))}`;
}
/** Closed or open polyline through points, each edge wobbling a little. */
function poly(points: [number, number][], close = true, w = 1.4) {
  const all = close ? [...points, points[0]] : points;
  return all.slice(1).map((point, index) => line(all[index][0], all[index][1], point[0], point[1], w)).join(' ');
}
/** A folder outline with its tab, the way everyone doodles one. */
export function folder(x: number, y: number, w: number, h: number) {
  return poly([[x, y + 9], [x, y + h], [x + w, y + h], [x + w, y + 9], [x + w * .44, y + 9], [x + w * .36, y], [x + 3, y]]);
}
export function ellipse(cx: number, cy: number, rx: number, ry: number, k = .04, turns = 1.06, start = -1.8) {
  const n = 64, phase = rnd() * 6;
  let d = '';
  for (let i = 0; i <= n * turns; i++) {
    const a = start + (i / n) * Math.PI * 2, wobble = 1 + k * Math.sin(a * 2 + phase) + (i / n) * k;
    d += `${i ? 'L' : 'M'}${f(cx + Math.cos(a) * rx * wobble)},${f(cy + Math.sin(a) * ry * wobble)} `;
  }
  return d;
}
/** Curved arrow; `bend` pushes the control point sideways. */
export function arrow(x1: number, y1: number, x2: number, y2: number, bend = 0, head = 13) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const cx = mx - (y2 - y1) / len * bend, cy = my + (x2 - x1) / len * bend;
  const tx = x2 - cx, ty = y2 - cy, tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl;
  const wing = (sign: number) => { const a = sign * .5, rx = ux * Math.cos(a) - uy * Math.sin(a), ry = ux * Math.sin(a) + uy * Math.cos(a); return `M${f(x2 - rx * head + j(1))},${f(y2 - ry * head + j(1))} L${f(x2)},${f(y2)}`; };
  return `M${f(x1)},${f(y1)} Q${f(cx + j(3))},${f(cy + j(3))} ${f(x2)},${f(y2)} ${wing(1)} ${wing(-1)}`;
}
export function cross(x: number, y: number, r = 9) { return `${line(x - r, y - r, x + r, y + r, 1)} ${line(x + r, y - r, x - r, y + r, 1)}`; }
