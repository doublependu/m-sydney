// Which facade and roof a building gets: the same in the tile and on the far model of it, whichever is drawn.

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

const ROOF_TONES = 4;

/** { mat, roof, tone, seed } for a building (`whole`: the whole of it, if this is one of its pieces) */
function buildingLook(b, whole) {
  const seed = Math.round(whole.cx * 31 + whole.cz * 17);
  const tone = mulberry32(seed)();
  // Low-rise is sandstone and brick; the taller it gets, the likelier concrete, granite, then glass
  const mat = b.kind === 1 ? (tone < 0.3 ? 0 : 1)
    : whole.height < 22 ? (tone < 0.6 ? 0 : 1)
      : whole.height < 60 ? (tone < 0.34 ? 0 : tone < 0.56 ? 5 : tone < 0.66 ? 6 : tone < 0.84 ? 3 : 2)
        : whole.height < 130 ? (tone < 0.22 ? 5 : tone < 0.34 ? 6 : tone < 0.7 ? 2 : 4)
          : tone < 0.6 ? 2 : 4;
  return { mat, tone, seed, roof: Math.floor(tone * ROOF_TONES) };
}

export { ROOF_TONES, buildingLook, mulberry32 };
