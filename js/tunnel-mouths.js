import * as THREE from 'three/webgpu';
import { abs, dot, positionWorld, uniform, vec2 } from 'three/tsl';
import { PORTALS, TUNNEL_HEIGHT } from './surfaces.js';
import { onOriginMove, origin } from './world-origin.js';

// The ground over a tunnel's mouth. The ground is a lattice of points metres apart: between the cutting's floor and the
// ground over the tube it can only slope, and that slope would close the mouth. So the ground's materials leave out
// whatever of them falls inside a box at a mouth: the corridor's width, from under the road to just under the tunnel's
// ceiling, from REACH inside the portal back over the open cutting to REACH past its end (where the ground plan, which
// knows nothing of the tunnel, closes the road off with a kerb). Above that the slope is behind the portal's face and
// over the tunnel's ceiling, out of sight. Only the mouths nearest the camera are checked.
const COUNT = 4;
const REACH = 10; // m
const FAR = 1e6;

// Each mouth as two vec4s: (x, z, along x, along z) and (road height, half width, length outside, road's rise inward)
const mouths = Array.from({ length: COUNT }, () => ({
  a: uniform(new THREE.Vector4(FAR, FAR, 1, 0)),
  b: uniform(new THREE.Vector4(-FAR, 0, 0, 0))
}));

/** True where a ground fragment is clear of every tunnel mouth: for a material's maskNode */
function outsideTunnelMouths() {
  let inside = null;
  for (const { a, b } of mouths) {
    const d = positionWorld.xz.sub(a.xy);
    const along = dot(d, a.zw);
    const across = dot(d, vec2(a.w.negate(), a.z));
    const up = positionWorld.y.sub(b.x.add(along.min(0).mul(b.w)));
    const here = along.lessThan(REACH).and(along.greaterThan(b.z.negate())).and(abs(across).lessThan(b.y)).and(up.greaterThan(-2)).and(up.lessThan(TUNNEL_HEIGHT - 0.1));
    inside = inside ? inside.or(here) : here;
  }
  return inside.not();
}

/** Points the boxes at the mouths nearest (x, z), once it has moved a few metres */
let lastX = Infinity, lastZ = Infinity;
onOriginMove(() => { lastX = Infinity; });
function updateTunnelMouths(x, z) {
  if ((x - lastX) ** 2 + (z - lastZ) ** 2 < 16) return;
  lastX = x;
  lastZ = z;
  const near = PORTALS.map((p) => ({ p, d: (p.x - x) ** 2 + (p.z - z) ** 2 })).sort((m, n) => m.d - n.d);
  for (let i = 0; i < COUNT; i++) {
    const m = near[i];
    if (m && m.d < 400 * 400) {
      mouths[i].a.value.set(m.p.x - origin.x, m.p.z - origin.z, m.p.ux, m.p.uz);
      mouths[i].b.value.set(m.p.y, m.p.half, m.p.open + REACH, m.p.rise);
    } else {
      mouths[i].a.value.set(FAR, FAR, 1, 0);
      mouths[i].b.value.set(-FAR, 0, 0, 0);
    }
  }
}

export { outsideTunnelMouths, updateTunnelMouths };
