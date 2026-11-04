// Which facade and roof a building gets: the same in the tile and on the far model of it, whichever is drawn.
import { HOUSE_STYLES, pick } from './house-styles.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRICK = 7, PAINTED = 8; // js/buildings.js FACADES
const ROOF_TONES = 4; // the flat roofs' greys, the first of js/buildings.js ROOF_COLOURS
const TERRACOTTA = 4, SLATE = 5;
const PITCH = 28; // degrees, a pitched roof of no style's

/**
 * { mat, farMat, roof, tone, seed, pitch, gabled, eaves } for a building (`whole`: the whole of it, if this is one of its pieces).
 * mat: js/buildings.js FACADES, farMat its FACADE_TONES far away; roof: ROOF_COLOURS, its pitched roof's colour if it has one; pitch in degrees; gabled: gable ends
 * rather than a hip; eaves: metres the roof stands past the walls.
 */
function buildingLook(b, whole) {
  const seed = Math.round(whole.cx * 31 + whole.cz * 17);
  const random = mulberry32(seed);
  const tone = random();
  const style = HOUSE_STYLES[b.houseStyle || 0];
  if (style) {
    // A house's walls and roof by its style, and its tone within the range of its walls' colours the style has
    const [mat, , from = 0, to = 1] = pick(style.walls, random(), true);
    const flat = Math.floor(tone * ROOF_TONES);
    const roof = b.pitched && style.roofs ? pick(style.roofs, random()) : flat;
    const t = from + (to - from) * tone;
    // Far away, the nearest of a few tones of its walls (js/buildings.js FACADE_TONES)
    const farMat = mat === BRICK ? 9 + Math.min(2, Math.floor(t * 3)) : mat === PAINTED ? 12 + (t > 0.45 ? 1 : 0) : mat;
    return { mat, farMat, tone: t, seed, roof, pitch: style.pitch || PITCH, gabled: random() < (style.gabled || 0), eaves: style.eaves ?? 0.3 };
  }
  // Low-rise is sandstone and brick; the taller it gets, the likelier concrete, granite, then glass
  const mat = b.kind === 1 ? (tone < 0.3 ? 0 : 1)
    : whole.height < 22 ? (tone < 0.6 ? 0 : 1)
      : whole.height < 60 ? (tone < 0.34 ? 0 : tone < 0.56 ? 5 : tone < 0.66 ? 6 : tone < 0.84 ? 3 : 2)
        : whole.height < 130 ? (tone < 0.22 ? 5 : tone < 0.34 ? 6 : tone < 0.7 ? 2 : 4)
          : tone < 0.6 ? 2 : 4;
  // A pitched roof of no house style: terracotta, or slate on one in three
  const roof = b.pitched ? (random() < 2 / 3 ? TERRACOTTA : SLATE) : Math.floor(tone * ROOF_TONES);
  return { mat, farMat: mat, tone, seed, roof, pitch: PITCH, gabled: false, eaves: 0.3 };
}

export { ROOF_TONES, buildingLook, mulberry32 };
