// How much of a control can actually be clicked.
//
// A visibility assertion passes for a button that sits under an overlay. Two exact quantities
// say whether a pointer can reach it: the fraction of its box not covered by boxes painted
// above it, and whether the point a click lands on (the centre, by default) is exposed. A
// button that is 60% visible with its centre covered still swallows the click.
//
// Boxes are { x, y, w, h } in the same coordinate space. `covers` are the boxes painted above
// the target; which boxes those are (stacking order, pointer-events) is the caller's knowledge,
// read from the browser. The area is exact: the union is measured on the grid cut by every box
// edge, so overlapping covers are not counted twice.

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * @param {{x:number,y:number,w:number,h:number}} target
 * @param {{x:number,y:number,w:number,h:number}[]} covers
 * @returns {number} uncovered share of the target's area, in [0, 1]
 */
export function visibleFraction(target, covers) {
  const area = target.w * target.h;
  if (!(area > 0)) return 0;
  const x0 = target.x;
  const x1 = target.x + target.w;
  const y0 = target.y;
  const y1 = target.y + target.h;
  // Clip each cover to the target; drop the ones that miss it.
  const clipped = [];
  for (const c of covers) {
    const cx0 = Math.max(x0, c.x);
    const cx1 = Math.min(x1, c.x + c.w);
    const cy0 = Math.max(y0, c.y);
    const cy1 = Math.min(y1, c.y + c.h);
    if (cx1 > cx0 && cy1 > cy0) clipped.push([cx0, cx1, cy0, cy1]);
  }
  if (clipped.length === 0) return 1;
  const xs = [...new Set([x0, x1, ...clipped.flatMap((c) => [c[0], c[1]])])].sort((a, b) => a - b);
  const ys = [...new Set([y0, y1, ...clipped.flatMap((c) => [c[2], c[3]])])].sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const mx = (xs[i] + xs[i + 1]) / 2;
      const my = (ys[j] + ys[j + 1]) / 2;
      if (clipped.some((c) => mx > c[0] && mx < c[1] && my > c[2] && my < c[3]))
        covered += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return Math.min(1, Math.max(0, 1 - covered / area));
}

/**
 * Is the point a click would land on free of every cover? Defaults to the centre.
 * @param {{x:number,y:number,w:number,h:number}} target
 * @param {{x:number,y:number,w:number,h:number}[]} covers
 * @param {{x:number,y:number}} [point]
 */
export function clickPointExposed(target, covers, point) {
  const p = point ?? { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const inside = (b) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
  return inside(target) && !covers.some(inside);
}

/** Area two boxes share. Exported for callers that build `covers` from a layout snapshot. */
export function intersectionArea(a, b) {
  return overlap(a.x, a.x + a.w, b.x, b.x + b.w) * overlap(a.y, a.y + a.h, b.y, b.y + b.h);
}
