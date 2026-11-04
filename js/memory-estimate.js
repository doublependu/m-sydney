// How much memory the game holds, by its own count. iOS gives a page no figure for its memory, and kills the tab when there's too
// much, so the game counts what it made: every geometry's and texture's bytes, which go to the GPU, and the map data it holds.
// It's an estimate, not what the browser holds, which has copies and overheads of its own; Phase F of ai/plan_4.md compares the
// two. Walks the scene, a few thousand objects, in about a millisecond: often enough for the readout and the budget.

const textureBytes = (texture) => {
  const image = texture?.image;
  const w = image?.width || 0, h = image?.height || 0, d = image?.depth || 1;
  if (!w || !h) return 0;
  // Four bytes a texel, and a third again for the mipmaps where there are any
  return w * h * d * 4 * (texture.generateMipmaps === false ? 1 : 4 / 3);
};

const attributeBytes = (attribute) => attribute?.array?.byteLength || attribute?.data?.array?.byteLength || 0;

/**
 * { total, parts } in bytes: `parts` by the name of the scene's top-level groups, each counted once whatever shares them.
 * `extra` adds what isn't in the scene: { name: bytes }, like the tiles' data.
 */
function estimateMemory(scene, extra = {}, { split = [] } = {}) {
  const seen = new Set();
  const parts = {};
  const add = (part, bytes) => { parts[part] = (parts[part] || 0) + bytes; };
  const visit = (object, part) => {
    const geometry = object.geometry;
    if (geometry && !seen.has(geometry)) {
      seen.add(geometry);
      let bytes = attributeBytes(geometry.index);
      for (const name in geometry.attributes) {
        const a = geometry.attributes[name];
        if (!seen.has(a.data || a)) { seen.add(a.data || a); bytes += attributeBytes(a); }
      }
      add(part, bytes);
    }
    if (object.isInstancedMesh) {
      for (const a of [object.instanceMatrix, object.instanceColor]) if (a && !seen.has(a)) { seen.add(a); add(part, attributeBytes(a)); }
    }
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const m of materials) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'alphaMap', 'aoMap']) {
        const t = m[key];
        if (t && !seen.has(t)) { seen.add(t); add(part, textureBytes(t)); }
      }
    }
  };
  for (const child of scene.children) {
    const part = child.name || child.type;
    // A group named in `split` is counted by its own children's names, to see inside it
    if (split.includes(part)) for (const c of child.children) c.traverse((o) => visit(o, `${part}/${c.name || c.type}`));
    else child.traverse((o) => visit(o, part));
  }
  for (const [name, bytes] of Object.entries(extra)) add(name, bytes);
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts };
}

export { estimateMemory, textureBytes };
