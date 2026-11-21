import * as THREE from 'three/webgpu';
import { Fn, Loop, attribute, cameraPosition, cameraProjectionMatrix, cameraWorldMatrix, clamp, cross, dot, exp, float, fract, int, length, max,
  mix, modelWorldMatrix, mrt, normalize, positionWorld, pow, reflect, screenSize, sin, smoothstep, texture, uniform, uv, varyingProperty, vec2,
  vec3, vec4 } from 'three/tsl';
import { BASE } from './fireworks.js';

// What New Year's show draws on the harbour round the fireworks (js/season-new-year.js), all of it drawn and none of it a light:
// - the Harbour Bridge's arch outlined along both trusses' top chords, in the show's colours, a light running along it;
// - "HAPPY NEW YEAR" and the year on the east pylons' outer faces, as projected on them on the night;
// - the Opera House's sails washed in colour, bands of it moving up them (its shells' own material, given the wash);
// - the barges the shells are fired from, low on the water, with their lights;
// - the brightest bursts' colours in the harbour's water: each a streak down towards you, broken by the waves (the sea's own material,
//   given the list). Both of those materials are copies made for the show and drawn only while it's on, so the harbour and the Opera House
//   cost nothing more the rest of the time.

const OUTLINE_WIDTH = 1.8; // m
const OUTLINE_LIFT = 3.0; // m over the chord's middle: over its steel and the climbers' handrails
const OUTLINE_PX = 2.0; // on screen, at the least
const MESSAGE = { width: 15.5, from: 21, to: 63, out: 0.35 }; // m: across the face, its foot and top over the sea, and off the granite
const BARGE = { length: 32, width: 10, height: 2.4, draft: 0.5 };

const placedAtBase = (mesh) => {
  mesh.position.set(BASE.x, 0, BASE.z);
  mesh.frustumCulled = false;
  mesh.userData.lifted = true;
  mesh.userData.ownMaterial = true;
  mesh.castShadow = false;
  return mesh;
};

/** The arch's outline: a ribbon facing you along each chord, [x, y, z] points in the game's frame */
function outlineMesh(chords, u) {
  const position = [], tangent = [], rib = [], index = [];
  for (const chord of chords) {
    let along = 0;
    const first = position.length / 3;
    chord.forEach((p, i) => {
      const a = chord[Math.max(0, i - 1)], b = chord[Math.min(chord.length - 1, i + 1)];
      if (i) along += Math.hypot(p[0] - chord[i - 1][0], p[1] - chord[i - 1][1], p[2] - chord[i - 1][2]);
      for (const side of [-1, 1]) {
        position.push(p[0] - BASE.x, p[1] + OUTLINE_LIFT, p[2] - BASE.z);
        tangent.push(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        rib.push(side, along);
      }
      if (i) {
        const v = first + (i - 1) * 2;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangent, 3));
  geometry.setAttribute('aRib', new THREE.Float32BufferAttribute(rib, 2));
  geometry.setIndex(index);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.fog = false;
  mat.mrtNode = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
  const vSide = varyingProperty('float', 'vOutlineSide');
  const vLight = varyingProperty('vec3', 'vOutlineLight');
  mat.positionNode = Fn(() => {
    const at = attribute('position', 'vec3'), rib = attribute('aRib', 'vec2');
    const world = modelWorldMatrix.mul(vec4(at, 1.0)).xyz;
    const toCamera = cameraPosition.sub(world);
    const distance = max(length(toCamera), 0.1);
    const pixel = distance.mul(2.0).div(cameraProjectionMatrix[1].y.mul(screenSize.y));
    const wide = max(float(OUTLINE_WIDTH), pixel.mul(OUTLINE_PX));
    const across = normalize(cross(normalize(attribute('aTangent', 'vec3')), toCamera.div(distance)).add(vec3(0.0, 1e-5, 0.0)));
    // A light running up one side and down the other, over the show's colour
    const run = smoothstep(0.75, 1.0, fract(rib.y.div(90.0).sub(u.now.mul(0.45))));
    vLight.assign(mix(u.outline, u.outline2, run).mul(run.mul(0.8).add(0.55)).mul(u.lit).mul(float(OUTLINE_WIDTH).div(wide).clamp(0.3, 1.0))
      .mul(exp(distance.mul(-0.00011))));
    vSide.assign(rib.x);
    return at.add(across.mul(rib.x.mul(wide).mul(0.5)));
  })();
  mat.colorNode = vec4(vLight.mul(exp(vSide.mul(vSide).mul(-2.5))), 1.0);
  const mesh = placedAtBase(new THREE.Mesh(geometry, mat));
  mesh.name = 'BridgeOutline';
  mesh.renderOrder = 2;
  return mesh;
}

/** The message's picture: "HAPPY NEW YEAR" and the year, on green, as it was projected on the pylon */
function messageTexture(year) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = Math.round((384 * (MESSAGE.to - MESSAGE.from)) / MESSAGE.width);
  const c = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const ground = c.createLinearGradient(0, 0, 0, H);
  ground.addColorStop(0, '#0c5a33');
  ground.addColorStop(0.5, '#16a35a');
  ground.addColorStop(1, '#0c5a33');
  c.fillStyle = ground;
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#7dffb8';
  c.lineWidth = 10;
  c.strokeRect(14, 14, W - 28, H - 28);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const line = (text, y, size, ink) => {
    c.font = `800 ${size}px Inter, Overpass, Arial, sans-serif`;
    c.fillStyle = ink;
    c.fillText(text, W / 2, H * y, W - 50);
  };
  line('HAPPY', 0.17, 118, '#ffffff');
  line('NEW', 0.39, 140, '#8af2ff');
  line('YEAR', 0.59, 140, '#8af2ff');
  line(String(year), 0.81, 150, '#ffd54a');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

/** The message on each east pylon's outer face, a little off the granite */
function messageMesh(faces, year, u) {
  const parts = faces.map((f) => {
    const plane = new THREE.PlaneGeometry(MESSAGE.width, MESSAGE.to - MESSAGE.from);
    plane.rotateY(Math.atan2(f.normal[0], f.normal[1]));
    plane.translate(f.x + f.normal[0] * MESSAGE.out - BASE.x, (MESSAGE.from + MESSAGE.to) / 2, f.z + f.normal[1] * MESSAGE.out - BASE.z);
    return plane;
  });
  const geometry = new THREE.BufferGeometry();
  const merged = parts.reduce((all, g) => {
    all.position.push(...g.attributes.position.array);
    all.uv.push(...g.attributes.uv.array);
    all.index.push(...g.index.array.map((i) => i + all.position.length / 3 - g.attributes.position.count));
    return all;
  }, { position: [], uv: [], index: [] });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(merged.position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(merged.uv, 2));
  geometry.setIndex(merged.index);
  const map = messageTexture(year);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.fog = false;
  mat.mrtNode = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
  // Projected light: it adds to the granite's own, brightening a little with the show
  mat.colorNode = vec4(texture(map, uv()).rgb.mul(u.message), 1.0);
  const mesh = placedAtBase(new THREE.Mesh(geometry, mat));
  mesh.name = 'PylonMessage';
  mesh.userData.map = map;
  return mesh;
}

/** The barges, each a low steel hull with its mortars' racks on deck and its lights */
function bargeMesh(barges) {
  const position = [], normal = [], colour = [], glow = [];
  const box = (cx, cy, cz, yaw, sx, sy, sz, rgb, lit = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).rotateY(yaw).translate(cx, cy, cz);
    position.push(...g.attributes.position.array);
    normal.push(...g.attributes.normal.array);
    for (let k = 0; k < g.attributes.position.count; k++) {
      colour.push(...rgb);
      glow.push(lit);
    }
    return g;
  };
  const index = [];
  let base = 0;
  const add = (g) => {
    index.push(...g.index.array.map((i) => i + base));
    base += g.attributes.position.count;
  };
  const sea = -2.2;
  for (const b of barges) {
    const yaw = 0.25, x = b.x - BASE.x, z = b.z - BASE.z;
    const along = [Math.cos(yaw), -Math.sin(yaw)], across = [Math.sin(yaw), Math.cos(yaw)];
    const at = (u, v) => [x + along[0] * u + across[0] * v, z + along[1] * u + across[1] * v];
    add(box(x, sea + BARGE.height / 2 - BARGE.draft, z, yaw, BARGE.length, BARGE.height, BARGE.width, [0.08, 0.085, 0.09]));
    for (const u of [-10, 0, 10]) {
      const [px, pz] = at(u, 0);
      add(box(px, sea + BARGE.height - BARGE.draft + 0.6, pz, yaw, 6, 1.2, 4, [0.12, 0.1, 0.07]));
    }
    // Red to port, green to starboard, white at each end
    for (const [u, v, rgb] of [[15.5, 4.6, [1, 0.08, 0.05]], [15.5, -4.6, [0.1, 1, 0.2]], [-15.5, 0, [1, 0.95, 0.85]], [15.5, 0, [1, 0.95, 0.85]]]) {
      const [px, pz] = at(u, v);
      add(box(px, sea + BARGE.height - BARGE.draft + 1.2, pz, yaw, 0.35, 0.35, 0.35, rgb, 1));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
  geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  geometry.setIndex(index);
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 });
  mat.emissiveNode = attribute('color', 'vec3').mul(attribute('aGlow', 'float')).mul(4.0);
  const mesh = placedAtBase(new THREE.Mesh(geometry, mat));
  mesh.receiveShadow = true;
  mesh.name = 'Barges';
  return mesh;
}

/**
 * The sea's material, given the bursts' colours: each of the brightest bursts (`bright`, `count` of them: [place, radius], [colour]) a
 * streak on the water down towards you, where the waves turn its reflection to you, and a faint sheen round it. A copy, drawn while the
 * show is on.
 */
function seaWithFireworks(material, bright, count, gain = 1) {
  const sea = material.clone();
  const own = material.emissiveNode ?? vec3(0.0);
  const waveNormal = material.normalNode;
  sea.emissiveNode = Fn(() => {
    const n = (waveNormal ? cameraWorldMatrix.transformDirection(waveNormal) : vec3(0.0, 1.0, 0.0)).toVar();
    const view = normalize(positionWorld.sub(cameraPosition)).toVar();
    const r = reflect(view, n).toVar();
    const fresnel = pow(float(1.0).sub(clamp(dot(n, view.negate()), 0.0, 1.0)), 5.0).mul(0.98).add(0.02).toVar();
    const flat = normalize(vec2(r.x, r.z).add(vec2(1e-5, 0.0))).toVar();
    const here = positionWorld.toVar();
    const glow = vec3(0.0).toVar();
    Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
      const at = bright.element(i.mul(2)), colour = bright.element(i.mul(2).add(1));
      const to = at.xyz.sub(here);
      const d = max(length(to), 1.0);
      const l = to.div(d);
      // How far the reflected ray is from the burst: across (as an angle, squared) and up and down
      const across2 = float(1.0).sub(dot(flat, normalize(vec2(l.x, l.z).add(vec2(1e-5, 0.0))))).mul(2.0);
      const updown = r.y.sub(l.y);
      const size = at.w.div(d).add(0.006);
      // A burst's light is spread over its streak: the wider it looks, the fainter each part of it
      const spread = clamp(float(0.0016).div(size.mul(size)), 0.0, 1.5);
      const streak = exp(across2.div(size.mul(size)).add(updown.mul(updown).div(size.mul(size).mul(9.0).add(0.004))).negate()).mul(spread);
      const sheen = exp(across2.div(size.mul(size).mul(16.0)).add(updown.mul(updown).mul(8.0)).negate()).mul(spread.mul(0.004));
      glow.addAssign(colour.xyz.mul(streak.add(sheen)));
    });
    return own.add(glow.mul(fresnel).mul(gain));
  })();
  return sea;
}

/** The Opera House's shells' material, washed in the show's colours: bands of them moving up the sails, over the tiles' own glow at night */
function sailsWashed(material, u) {
  const sails = material.clone();
  const own = material.emissiveNode ?? vec3(0.0);
  sails.emissiveNode = Fn(() => {
    const y = positionWorld.y;
    const band = sin(y.mul(0.16).sub(u.now.mul(1.1)).add(positionWorld.x.mul(0.035))).mul(0.5).add(0.5);
    const wash = mix(u.washA, u.washB, smoothstep(0.2, 0.8, band)).mul(sin(u.now.mul(0.7)).mul(0.12).add(0.62));
    return mix(own, wash, u.wash);
  })();
  return sails;
}

/**
 * The show's dressing on the harbour: { group, u, update(look), sea(material), sails(material), dispose() }. `outline`: the bridge's lines
 * (js/harbour-bridge.js bridgeOutline()); `places`: the firing places (js/firework-show.js); `year`: the message's; `now`: the show's
 * clock uniform, shared with the fireworks.
 */
function createHarbourDressing({ outline, places, year, now }) {
  const u = {
    now,
    outline: uniform(new THREE.Color(1, 0.6, 0.15)),
    outline2: uniform(new THREE.Color(1, 1, 1)),
    lit: uniform(1.6),
    message: uniform(1.4),
    washA: uniform(new THREE.Color(1, 0.2, 0.4)),
    washB: uniform(new THREE.Color(0.3, 0.2, 1)),
    wash: uniform(0.85)
  };
  const group = new THREE.Group();
  group.name = 'NewYearHarbour';
  const meshes = [outlineMesh(outline.chords, u), messageMesh(outline.faces, year, u), bargeMesh([...places.barges, places.darling])];
  for (const m of meshes) group.add(m);
  return {
    group,
    u,
    year,
    /** The show's colours now: [a, b] each [r, g, b] in linear light */
    update([a, b]) {
      u.outline.value.setRGB(...a);
      u.outline2.value.setRGB(...b);
      u.washA.value.setRGB(...a);
      u.washB.value.setRGB(...b);
    },
    sea: (material, bright, count, gain) => seaWithFireworks(material, bright, count, gain),
    sails: (material) => sailsWashed(material, u),
    dispose() {
      for (const m of meshes) m.userData.map?.dispose();
    }
  };
}

export { MESSAGE, createHarbourDressing, messageTexture, sailsWashed, seaWithFireworks };
