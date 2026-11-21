import * as THREE from 'three/webgpu';
import { abs, attribute, cameraProjectionMatrix, clamp, dot, exp2, float, floor, fract, length, max, min, mix, modelViewMatrix, mrt, screenSize, sin,
  smoothstep, step, uniform, uv, varying, vec3, vec4 } from 'three/tsl';

// December's two materials, shared by the houses' decorations (js/christmas-houses.js) and the city's big trees (js/christmas-trees.js):
// one of each, so each is compiled once, whichever is drawn first (a compile is 50-70 ms on a phone, in one piece).
// - The bulbs: sprites added to what's behind them, from aBulb (x, y, z from the origin; s, m along its string) and aLook (r, g, b; the
//   look, lookW()). A bulb in the middle, as big as one near and MIN_PX on screen far, and at night a halo round it, so strings far off
//   run together into lines of light.
// - The shapes: lit as anything else, their vertices' colour, and lit from inside at night by their aGlow.

const BULB = 0.055; // m across
const MIN_PX = 1.5; // on screen, at the least
const HALO = 0.22; // m across: a bulb's glow at night
const HALO_PX = 4.5; // on screen, at the least: so a street far off still reads as strings of light
const SPACING = 0.28; // m between bulbs along a string
// What a bulb does at night. `glow` and `beacon` aren't bulbs: they're a glow at night only, nothing by day. A big tree's star has a glow;
// a big tree far off is its beacon, a glow as big as its crown, coming in from BEACON_NEAR to BEACON_FAR m away
const EFFECT = { steady: 0, twinkle: 1, chase: 2, fade: 3, alternate: 4, beacon: 5, glow: 6 };
const BEACON_NEAR = 250, BEACON_FAR = 700; // m
const BEACON_PX = 14; // on screen, at the least

/**
 * A bulb's aLook.w: its effect (EFFECT), its seed (0-1, its own time in the effect), and its size: BULB and HALO times 2^size. The houses'
 * bulbs are size 0.
 */
const lookW = (effect, seed, size = 0) => effect + size * 8 + Math.min(0.999, Math.max(0, seed));

function bulbMaterial(now, glow) {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  // What's under it stays in the G-buffer: reflections see the wall, not the bulb's quad
  mat.mrtNode = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
  const bulb = attribute('aBulb', 'vec4'), look = attribute('aLook', 'vec4');
  mat.positionNode = bulb.xyz;
  // A pixel's size at its depth
  const depth = modelViewMatrix.mul(vec4(bulb.xyz, 1.0)).z.negate().max(0.05);
  const pixel = depth.mul(2.0).div(cameraProjectionMatrix[1].y.mul(screenSize.y));
  const night = smoothstep(0.4, 1.1, glow);
  const kind = floor(look.w), size = floor(kind.div(8.0)), effect = kind.sub(size.mul(8.0)), seed = fract(look.w);
  const scale = exp2(size);
  const pick = (k) => float(1.0).sub(min(abs(effect.sub(k)), 1.0));
  const beacon = pick(EFFECT.beacon);
  const glowOnly = step(4.5, effect);
  const bulbM = scale.mul(BULB), haloM = scale.mul(HALO);
  const core = max(bulbM, pixel.mul(MIN_PX));
  const halo = max(core, max(haloM, pixel.mul(mix(float(HALO_PX), float(BEACON_PX), beacon))));
  // By day the sprite is the bulb alone: no halo to spend the pixels on. A glow alone is nothing by day
  const spread = mix(mix(core, halo, night), halo.mul(step(0.01, night)), glowOnly);
  mat.scaleNode = spread;
  const t = now;
  const r = fract(sin(dot(bulb.xyz, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const twinkle = smoothstep(-0.2, 0.8, sin(t.mul(r.mul(2.5).add(1.5)).add(r.mul(40.0)))).mul(0.8).add(0.2);
  const chase = float(1.0).sub(smoothstep(0.3, 0.55, abs(fract(bulb.w.div(0.84).sub(t.mul(1.1))).sub(0.5)).mul(2.0))).mul(0.8).add(0.2);
  const fade = sin(t.mul(0.9).add(seed.mul(20.0))).mul(0.32).add(0.68);
  const alternate = step(0.5, fract(bulb.w.div(SPACING * 2).add(0.25).add(floor(t.mul(0.7).add(seed)).mul(0.5)))).mul(0.8).add(0.2);
  const pattern = pick(EFFECT.steady).add(pick(EFFECT.twinkle).mul(twinkle)).add(pick(EFFECT.chase).mul(chase)).add(pick(EFFECT.fade).mul(fade))
    .add(pick(EFFECT.alternate).mul(alternate)).add(beacon.mul(smoothstep(BEACON_NEAR, BEACON_FAR, depth))).add(pick(EFFECT.glow));
  const on = mix(float(1.0), pattern, night);
  // The bulb: dimmer as it's spread over more than its own size, so a string far off, its sprites run together, is a line no brighter
  // than it is near; its halo only at night. A glow is all halo, and keeps more of its light far off
  // A big tree's bulbs are many and close together: by day, far off, a bulb smaller than its sprite gives it as little of its colour as
  // it covers, or the tree would be lost under them
  const covers = clamp(bulbM.div(core), 0.0, 1.0);
  const dayFar = mix(float(1.0), covers, step(0.5, size).mul(float(1.0).sub(night)));
  const coreLit = varying(look.xyz.mul(mix(float(0.85), float(5.5), night)).mul(on).mul(clamp(covers, 0.12, 1.0)).mul(dayFar)
    .mul(float(1.0).sub(glowOnly)));
  const haloLit = varying(look.xyz.mul(night.mul(on).mul(mix(float(0.55), float(1.0), glowOnly)))
    .mul(clamp(haloM.div(spread), mix(float(0.15), float(0.35), glowOnly), 1.0)));
  const coreR = varying(core.div(spread));
  const d = length(uv().sub(0.5)).mul(2.0);
  const inCore = float(1.0).sub(smoothstep(coreR.mul(0.55), coreR, d));
  // A glow's light falls off more slowly than a bulb's halo: it's what's left of a whole tree's lights far off
  const haloShape = max(float(1.0).sub(d), 0.0).pow(mix(float(2.5), float(1.6), glowOnly));
  mat.colorNode = vec4(coreLit.mul(inCore).add(haloLit.mul(haloShape)), 1.0);
  mat.opacityNode = float(1.0);
  return mat;
}

function shapeMaterial(glow) {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.65, metalness: 0 });
  const g = attribute('aGlow', 'float');
  mat.emissiveNode = attribute('color', 'vec3').mul(g).mul(smoothstep(0.4, 1.1, glow)).mul(2.0);
  return mat;
}

let made = null;
/**
 * December's materials, made once: { now (the game's clock, set each frame), bulbs, shapes }. `glow`: the night's glow uniform. A mesh
 * drawn with them doesn't own them: they're let go of with dispose(), once nothing of December is drawn.
 */
function christmasMaterials(glow) {
  if (made) return made;
  const now = uniform(0);
  made = { now, bulbs: bulbMaterial(now, glow), shapes: shapeMaterial(glow) };
  return made;
}
function disposeChristmasMaterials() {
  made?.bulbs.dispose();
  made?.shapes.dispose();
  made = null;
}

/** A colour written 0xrrggbb, in linear light */
const lin = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => (v / 255) ** 2.2);

export { BULB, EFFECT, SPACING, christmasMaterials, disposeChristmasMaterials, lin, lookW };
