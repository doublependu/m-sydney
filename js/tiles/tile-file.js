// One tile's file (tools/build-tiles.mjs): a 16 byte head giving the length of each part, then JSON for what's sparse,
// and binary for buildings, trees and heights.

function reader(data, start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, scale = 1, byte;
      do {
        if (cursor >= end) throw new Error('Tile data ended early.');
        byte = data[cursor++];
        value += (byte & 127) * scale;
        scale *= 128;
      } while (byte & 128);
      return value;
    },
    sint() {
      const v = this.uint();
      return v % 2 ? -(v + 1) / 2 : v / 2;
    },
    byte() { return data[cursor++]; },
    done: () => cursor === end
  };
}

// kind: 0 other, 1 house, 2 flats, 3 shops and offices, 4 shed, 5 civic
function unpackBuildings(data, start, end) {
  const head = reader(data, start, end);
  const metaLength = head.uint(), xLength = head.uint(), zLength = head.uint();
  // The head's own length: what's left once the three streams are taken off the end
  const zStart = end - zLength, xStart = zStart - xLength, metaStart = xStart - metaLength;
  const meta = reader(data, metaStart, xStart), xs = reader(data, xStart, zStart), zs = reader(data, zStart, end);
  let x = 0, z = 0;
  const out = [];
  for (let count = meta.uint(); count > 0; count--) {
    const height = meta.uint(), style = meta.uint();
    const group = style & 16 ? meta.uint() : 0, bottom = style & 16 ? meta.uint() : 0;
    const floor = meta.sint() / 10, low = meta.sint() / 10;
    const polygons = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let n = meta.uint(); n > 0; n--) {
      const rings = [];
      for (let r = meta.uint(); r > 0; r--) {
        const ring = [];
        for (let p = meta.uint(); p > 0; p--) {
          x += xs.sint();
          z += zs.sint();
          const point = { x: x * 0.5, z: z * 0.5 };
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
          if (point.z < minZ) minZ = point.z;
          if (point.z > maxZ) maxZ = point.z;
          ring.push(point);
        }
        rings.push(ring);
      }
      polygons.push({ outer: rings[0], holes: rings.slice(1) });
    }
    out.push({ height, kind: style & 7, pitched: !!(style & 8), group, bottom, realAwning: !!(style & 32), polygons, floor, low,
      minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 });
  }
  return out;
}

// x and z in 0.5 m as differences, then a species class and a height for each
function unpackTrees(data, start, end) {
  const r = reader(data, start, end);
  const count = r.uint();
  const points = new Float32Array(count * 2), kinds = new Uint8Array(count), heights = new Uint8Array(count);
  let x = 0, z = 0;
  for (let i = 0; i < count; i++) {
    x += r.sint();
    z += r.sint();
    points[i * 2] = x * 0.5;
    points[i * 2 + 1] = z * 0.5;
    kinds[i] = r.byte();
    heights[i] = r.byte();
  }
  return { points, kinds, heights };
}

// 0.25 m steps as differences along each row
function unpackHeights(data, start, end, size) {
  const r = reader(data, start, end);
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    let v = 0;
    for (let i = 0; i < size; i++) {
      v += r.sint();
      out[j * size + i] = v * 0.25;
    }
  }
  return out;
}

/** What a tile's (unzipped) file holds */
function unpackTile(data, heightSize) {
  const head = new DataView(data.buffer, data.byteOffset, 16);
  const json = 16 + head.getUint32(0, true), buildings = json + head.getUint32(4, true);
  const trees = buildings + head.getUint32(8, true), heights = trees + head.getUint32(12, true);
  if (heights !== data.length) throw new Error('Tile data is the wrong length.');
  const tile = JSON.parse(new TextDecoder().decode(data.subarray(16, json)));
  tile.buildings = unpackBuildings(data, json, buildings);
  tile.trees = unpackTrees(data, buildings, trees);
  tile.heights = unpackHeights(data, trees, heights, heightSize);
  return tile;
}

/** One of the far files (tools/build-tiles.mjs): every building in a 4 km square as a few points, and its ground */
function unpackFarFile(data) {
  const lead = new DataView(data.buffer, data.byteOffset, 8);
  const jsonEnd = 8 + lead.getUint32(0, true), headEnd = jsonEnd + lead.getUint32(4, true);
  const file = JSON.parse(new TextDecoder().decode(data.subarray(8, jsonEnd)));
  const head = reader(data, jsonEnd, headEnd);
  const count = head.uint(), metaLength = head.uint(), xLength = head.uint(), zLength = head.uint();
  const metaEnd = headEnd + metaLength, xEnd = metaEnd + xLength, zEnd = xEnd + zLength;
  if (zEnd !== data.length) throw new Error('Far data is the wrong length.');
  const meta = reader(data, headEnd, metaEnd), xs = reader(data, metaEnd, xEnd), zs = reader(data, xEnd, zEnd);
  let x = 0, z = 0;
  file.buildings = [];
  for (let n = 0; n < count; n++) {
    const b = { height: meta.uint(), bottom: meta.uint(), floor: meta.sint() / 10, low: meta.sint() / 10, mat: meta.uint(), roof: meta.uint(), ix: meta.sint(), iz: meta.sint(), rings: [] };
    for (let r = meta.uint(); r > 0; r--) {
      const ring = [];
      for (let p = meta.uint(); p > 0; p--) {
        x += xs.sint();
        z += zs.sint();
        ring.push({ x: x * 0.5, z: z * 0.5 });
      }
      b.rings.push(ring);
    }
    file.buildings.push(b);
  }
  return file;
}

export { unpackFarFile, unpackTile };
