import fs from 'node:fs';
import zlib from 'node:zlib';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// A model's triangles as the game draws them (public/models/<name>.glb.gz): gzipped, its buffers packed by meshopt, as the model scripts
// export them. Each node's mesh is in the model's own frame: the scripts give nodes no transforms.

const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** { json, primitives: [{ node, material, position: Float32Array, color: Float32Array | null, index: Uint16Array | Uint32Array }] } */
async function readModel(name) {
  await MeshoptDecoder.ready;
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL(`../../public/models/${name}.glb.gz`, import.meta.url)));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binAt = 20 + jsonLength + 8;
  const bin = bytes.subarray(binAt, binAt + bytes.readUInt32LE(20 + jsonLength));
  const views = new Map();
  const view = (i) => {
    if (views.has(i)) return views.get(i);
    const v = json.bufferViews[i];
    const ext = v.extensions?.EXT_meshopt_compression;
    let out;
    if (ext) {
      out = new Uint8Array(ext.count * ext.byteStride);
      const source = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, source, ext.mode, ext.filter ?? 'NONE');
    } else {
      out = new Uint8Array(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), v.byteLength).slice();
    }
    views.set(i, out);
    return out;
  };
  const accessor = (i) => {
    const a = json.accessors[i];
    const raw = view(a.bufferView);
    const Kind = ARRAYS[a.componentType];
    const n = a.count * SIZES[a.type];
    const stride = json.bufferViews[a.bufferView].byteStride;
    const step = stride ? stride / Kind.BYTES_PER_ELEMENT : SIZES[a.type];
    const all = new Kind(raw.buffer, raw.byteOffset + (a.byteOffset ?? 0), Math.floor((raw.byteLength - (a.byteOffset ?? 0)) / Kind.BYTES_PER_ELEMENT));
    if (step === SIZES[a.type]) return all.slice(0, n);
    const out = new Kind(n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < SIZES[a.type]; c++) out[k * SIZES[a.type] + c] = all[k * step + c];
    return out;
  };
  const primitives = [];
  for (const node of json.nodes) {
    if (node.mesh === undefined) continue;
    if (node.translation || node.rotation || node.scale || node.matrix) throw new Error(`${name}: node ${node.name} is moved`);
    for (const p of json.meshes[node.mesh].primitives) {
      primitives.push({
        node: node.name, material: json.materials?.[p.material]?.name ?? null, position: accessor(p.attributes.POSITION),
        color: p.attributes.COLOR_0 !== undefined ? accessor(p.attributes.COLOR_0) : null, index: accessor(p.indices)
      });
    }
  }
  return { json, primitives };
}

/** Each triangle of a model: [[x, y, z] x 3, colour of its first corner or null] */
function* triangles(model) {
  for (const p of model.primitives) {
    const P = (i) => [p.position[3 * i], p.position[3 * i + 1], p.position[3 * i + 2]];
    for (let k = 0; k < p.index.length; k += 3) {
      const i = p.index[k];
      yield { a: P(i), b: P(p.index[k + 1]), c: P(p.index[k + 2]), color: p.color ? [p.color[3 * i], p.color[3 * i + 1], p.color[3 * i + 2]] : null, material: p.material };
    }
  }
}

export { readModel, triangles };
