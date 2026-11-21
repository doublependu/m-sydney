import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A gallery's art (js/art.js): a line a work in js/artworks.js, on the walls and plinths its insides' JSON lists (`hangs`, `plinths`).
// These hold the lines to the walls they hang on, and the meshes made from them to their rooms.
const { ARTWORKS } = await import('../js/artworks.js');
const THREE = await import('three/webgpu');
const { createArt } = await import('../js/art.js');

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../public/models/${name}.json`, import.meta.url), 'utf8'));
// Each site's inside's files: those its doors name, and theirs in turn
function files(site) {
  const out = [], todo = read(site).doors.map((d) => d.inside).filter(Boolean);
  while (todo.length) {
    const f = todo.shift();
    if (out.includes(f)) continue;
    out.push(f);
    todo.push(...read(f).doors.map((d) => d.inside).filter(Boolean));
  }
  return out;
}
const KINDS = new Set(['landscape', 'portrait', 'still-life', 'abstract', 'ink', 'desert', 'bark']);
const SCULPTURES = new Set(['bronze', 'marble', 'steel', 'vessel']);
const FRAMES = new Set(['gilt', 'timber', 'black', 'white', 'none', 'scroll']);
const FRAME_W = { gilt: 0.1, timber: 0.055, black: 0.032, white: 0.045, none: 0, scroll: 0.05 };

test('every work hangs on a wall or stands on a plinth its gallery has, once, each its own id', () => {
  for (const [site, works] of Object.entries(ARTWORKS)) {
    const insides = files(site).map(read);
    const hangs = new Map(insides.flatMap((d) => d.hangs ?? []).map((h) => [h.id, h]));
    const plinths = new Map(insides.flatMap((d) => d.plinths ?? []).map((p) => [p.id, p]));
    const ids = new Set();
    for (const w of works) {
      assert.ok(!ids.has(w.id), `${site}: ${w.id} twice`);
      ids.add(w.id);
      if (w.plinth) {
        assert.ok(plinths.has(w.plinth), `${site}: ${w.id} on no plinth (${w.plinth})`);
        assert.ok(SCULPTURES.has(w.kind) && w.h > 0.2 && w.h < 3, `${site}: ${w.id} is a ${w.kind} ${w.h} m high`);
        continue;
      }
      assert.ok(hangs.has(w.wall), `${site}: ${w.id} on no wall (${w.wall})`);
      assert.ok(w.image ? typeof w.image === 'string' : KINDS.has(w.kind) && Number.isInteger(w.seed), `${site}: ${w.id} is neither made up nor an image`);
      assert.ok(FRAMES.has(w.frame), `${site}: ${w.id}'s frame ${w.frame}`);
    }
    assert.ok(works.length > 100, `${site}: only ${works.length} works`);
    // ...and every plinth has its work
    for (const id of plinths.keys()) assert.ok(works.some((w) => w.plinth === id), `${site}: nothing on ${id}`);
  }
});

test('each painting fits its wall, in its frame, clear of the next, and below its top', () => {
  for (const [site, works] of Object.entries(ARTWORKS)) {
    const hangs = new Map(files(site).map(read).flatMap((d) => d.hangs ?? []).map((h) => [h.id, h]));
    const byWall = new Map();
    for (const w of works.filter((w) => w.wall)) {
      const h = hangs.get(w.wall), L = Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]), f = FRAME_W[w.frame];
      assert.ok(w.at - w.w / 2 - f >= -0.01 && w.at + w.w / 2 + f <= L + 0.01, `${site}: ${w.id} runs off its wall (${L.toFixed(2)} m)`);
      assert.ok(w.y - w.h / 2 - f >= h.y0 - 0.3 && w.y + w.h / 2 + f <= h.y1 + 0.5, `${site}: ${w.id} at ${w.y} m, ${w.h} high, off its wall's height`);
      if (!byWall.has(w.wall)) byWall.set(w.wall, []);
      byWall.get(w.wall).push(w);
    }
    for (const [wall, list] of byWall) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j], fa = FRAME_W[a.frame], fb = FRAME_W[b.frame];
          const apart = Math.abs(a.at - b.at) >= (a.w + b.w) / 2 + fa + fb || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + fa + fb;
          assert.ok(apart, `${site}: ${a.id} and ${b.id} overlap on ${wall}`);
        }
      }
    }
  }
});

test('the art for each level: its paintings, frames and sculptures in their rooms, the pictures packed in one atlas', () => {
  for (const file of files('art-gallery')) {
    const data = read(file);
    const scene = new THREE.Group();
    for (const r of data.rooms) {
      const node = new THREE.Group();
      node.name = r.node;
      scene.add(node);
    }
    const art = createArt({ site: 'art-gallery', data, scene, materialFor: (name) => new THREE.MeshStandardNodeMaterial({ name }), glow: { add: (v) => v },
      detail: 1 });
    const st = art.state();
    const works = ARTWORKS['art-gallery'];
    const hung = works.filter((w) => data.hangs.some((h) => h.id === w.wall)).length;
    const stood = works.filter((w) => data.plinths.some((p) => p.id === w.plinth)).length;
    assert.equal(st.paintings, hung, `${file}: ${st.paintings} paintings of ${hung}`);
    assert.equal(st.sculptures, stood, `${file}: ${st.sculptures} sculptures of ${stood}`);
    assert.ok(st.atlas[0] <= 2048 && st.atlas[1] <= 2048, `${file}: an atlas of ${st.atlas}`);
    // every mesh in a room's node, none in the scene itself, each in the model's frame inside its room (a painting on its wall)
    const meshes = [];
    scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    assert.ok(meshes.length > 0 && meshes.every((m) => m.parent !== scene && /^room_/.test(m.parent.name)), `${file}: art out of its rooms`);
    for (const m of meshes) {
      const room = data.rooms.find((r) => r.node === m.parent.name);
      const box = new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute('position'));
      const xs = room.poly.map((p) => p[0]), zs = room.poly.map((p) => p[1]);
      assert.ok(box.min.x >= Math.min(...xs) - 0.01 && box.max.x <= Math.max(...xs) + 0.01 && box.min.z >= Math.min(...zs) - 0.01
        && box.max.z <= Math.max(...zs) + 0.01 && box.min.y >= room.y0 - 0.01 && box.max.y <= room.y1, `${file}: ${m.name} out of ${room.id}`);
    }
    // the paintings' quads carry the atlas's coordinates, all inside it
    for (const m of meshes.filter((m) => m.name.startsWith('Art_paintings_'))) {
      const uv = m.geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1 && uv.getY(i) >= 0 && uv.getY(i) <= 1, `${file}: ${m.name}'s uv`);
    }
    art.dispose();
  }
});
