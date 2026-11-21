// The concert's stage in the Opera House's Concert Hall (js/concert.js): the performers' own small model, fetched when you first sit in
// the hall, on its stage, and the show played by them as the score sounds.
//   - the piano (black, its lid up, its 88 keys pressed as they sound), its bench and the trumpeter's music stand: tools/models/
//     opera_concert.py in the models' repo, `opera-house-concert`;
//   - the robot at the piano: rigid parts on joints, turned here, drawn as one skinned mesh a material. Each hand reaches (two bones,
//     shoulder to wrist) for the keys of its next notes, and dips as they're struck; its head turns to the trumpeter when the trumpet
//     answers or leads, and nods to the beat; its body leans with the loudness and turns towards its hands;
//   - the trumpeter: the walker's rig (js/pedestrians.js) in a dark suit, the trumpet in their hands. They raise it for each phrase and
//     breathe before it, the valves going down for each note's fingering; in the gaps they lower it a little, turn to the piano and nod.
//   - the show: when a performance is asked for they're in their places (the first time you sit, they're there as the stage is placed),
//     or walk on from the stage's side, bow and take their places, and the music waits for them; at its end they stand, come forward,
//     bow, and go off. The house lights dim while they play and come up at the bows; the stage is lit while they're on it.
// Everything is in the model's frame: the stage's floor at (s, v) in the hall's (js/opera-house.js hallFrame()), x east, z south, y up.
// What it needs of the game's own (the walker's rig, the world's origin) is handed to it, so its chunk brings nothing of the first
// download's along and splits none of it off.
import * as THREE from 'three/webgpu';

const FILE = 'models/opera-house-concert';
const DARK_SUIT = { coat: 0x1c1e25, shirt: 0xe8e5dd, legs: 0x1a1c22 };
const TRUMPETER_LOOK = { seed: 11.3, scale: 1.0, girth: 1.0, hair: 0.12, armSwing: 0.8 };
const WALK = 1.3; // m/s, the trumpeter's
const ROBOT_WALK = 1.05; // m/s
const STEP = 0.5; // m, the robot's
const BOW = 1.9; // s
const SIT = 1.1; // s to slide onto the bench, or off it
const HOUSE_DIM = 0.3; // of the house's light while they play
const RAISE = 0.5; // s before a phrase the trumpet goes up to the lips
const HAND = 0.16; // m from the robot's wrist to its fingertips
const LOAD_HOLD = 1.0; // s the music waits for the stage's model the first time, before starting without it
const WALK_ON_HOLD = 25; // s it waits for them to walk on and take their places

// --- The keyboard ------------------------------------------------------------------------------------------------------------
const isBlack = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
/** White keys below p from the low A (21) */
function whitesBelow(p, low = 21) {
  let n = 0;
  for (let q = low; q < p; q++) if (!isBlack(q)) n++;
  return n;
}
/** A key's middle along the keyboard from its low end, m: a black key's between the whites either side */
function keyAlong(p, white = 0.0235) {
  return isBlack(p) ? whitesBelow(p) * white : (whitesBelow(p) + 0.5) * white;
}

// The B-flat trumpet's valves for a concert pitch (MIDI), the standard fingering of its written note, a tone up: '' open, '12' the
// first and second down
const FINGERING = { 54: '123', 55: '13', 56: '23', 57: '12', 58: '1', 59: '2', 60: '', 61: '123', 62: '13', 63: '23', 64: '12', 65: '1', 66: '2',
  67: '', 68: '23', 69: '12', 70: '1', 71: '2', 72: '', 73: '12', 74: '1', 75: '2', 76: '', 77: '1', 78: '2', 79: '', 80: '23', 81: '12', 82: '1',
  83: '2', 84: '', 85: '12', 86: '1', 87: '2', 88: '', 89: '1', 90: '2', 91: '' };
/** Which of the three valves are down for a concert pitch: [first, second, third] */
function valvesFor(p) {
  const f = FINGERING[Math.max(54, Math.min(91, p + 2))] ?? '';
  return [f.includes('1'), f.includes('2'), f.includes('3')];
}

/**
 * Each of the pianist's hands' strikes, from the score: its notes starting together (within 25 ms), where its hand goes for them along
 * the keyboard (their keys' middle) and how far in (further for black keys), when they end and how hard they're struck.
 * { l: [{ t, end, along, depth, v, pitches }], r: [...] }, by t
 */
function handPlan(score, keyboard = { white: 0.0235 }) {
  const out = { l: [], r: [] };
  for (const n of score.notes) {
    if (n.i !== 'piano') continue;
    const list = out[n.hand === 'l' ? 'l' : 'r'];
    const last = list[list.length - 1];
    if (last && n.t - last.t < 0.025) {
      last.pitches.push(n.p);
      last.end = Math.max(last.end, n.t + n.d);
      last.v = Math.max(last.v, n.v);
    } else list.push({ t: n.t, end: n.t + n.d, v: n.v, pitches: [n.p] });
  }
  for (const list of Object.values(out)) {
    for (const s of list) {
      s.along = s.pitches.reduce((a, p) => a + keyAlong(p, keyboard.white), 0) / s.pitches.length;
      s.depth = s.pitches.some(isBlack) ? 0.105 : 0.06;
    }
  }
  return out;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

/** The last index in `list` (by `key`) at or before t, starting from a guess: the lists are walked forwards as the music plays */
function seek(list, t, guess = -1, key = 't') {
  let i = Math.min(guess, list.length - 1);
  if (i >= 0 && list[i][key] > t) i = -1;
  while (i + 1 < list.length && list[i + 1][key] <= t) i++;
  return i;
}

/**
 * Where a hand is along the keyboard at t (s, the score's), from its strikes: at a strike's keys from when it's struck, moving to the
 * next's in time to strike it (no sooner than it can, its notes held as long as there's time to get there), lifted on the way as far
 * as it goes; and how far down it is, dipping as it strikes. { along, depth, lift, dip, playing }, `cursor` the index it starts from.
 */
function handAt(strikes, t, cursor = -1) {
  const k = seek(strikes, t, cursor);
  const cur = strikes[k] ?? null, next = strikes[k + 1] ?? null;
  if (!cur && !next) return { k, along: null, depth: 0.06, lift: 0.06, dip: 0, playing: false };
  if (!cur) {
    // before its first notes: there, or on its way
    return { k, along: next.along, depth: next.depth, lift: 0.06 * smoothstep(next.t - 0.2, next.t - 1.2, t), dip: 0, playing: false };
  }
  const dip = cur.v * 0.013 * Math.exp(-Math.max(0, t - cur.t) / 0.07);
  if (!next) return { k, along: cur.along, depth: cur.depth, lift: 0.05 * smoothstep(cur.end, cur.end + 0.6, t), dip, playing: t < cur.end };
  const gap = next.t - cur.t;
  const far = Math.abs(next.along - cur.along);
  const travel = Math.min(gap * 0.85, 0.07 + far * 0.55, 0.35);
  const leave = Math.max(cur.t + Math.min(0.06, gap * 0.3), Math.min(cur.end, next.t - travel), next.t - travel);
  const u = smoothstep(leave, next.t - 0.012, t);
  const lift = Math.sin(Math.PI * u) * Math.min(0.06, 0.006 + far * 0.25) + 0.03 * smoothstep(cur.end, cur.end + 0.5, t) * (1 - u);
  return { k, along: lerp(cur.along, next.along, u), depth: lerp(cur.depth, next.depth, u), lift, dip, playing: t < cur.end };
}

// --- Bones, by hand ------------------------------------------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
/** A rotation whose +y points along `up` and whose +z is as near `front` as it can be */
function basis(up, front, out) {
  _y.copy(up).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}
/** ...whose +y points along `up` and +x along `hinge` (made square to it) */
function hinged(up, hinge, out) {
  _y.copy(up).normalize();
  _z.crossVectors(hinge, _y).normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}
const _d = new THREE.Vector3(), _b = new THREE.Vector3();
/** Two bones from `root` towards `target`, l1 then l2, the middle joint bending towards `pole`: the middle and end joints, into mid, end */
function twoBone(root, target, l1, l2, pole, mid, end) {
  _d.subVectors(target, root);
  const want = _d.length();
  const dist = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min((l1 + l2) * 0.999, want));
  _d.divideScalar(want || 1);
  _b.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_b.lengthSq() < 1e-8) _b.set(0, -1, 0);
  _b.normalize();
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  mid.copy(root).addScaledVector(_d, l1 * cosA).addScaledVector(_b, l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  end.copy(root).addScaledVector(_d, dist);
  return want - dist; // how far short it falls
}

const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const qx = (a, out = new THREE.Quaternion()) => out.setFromAxisAngle(AX, a);
const qy = (a, out = new THREE.Quaternion()) => out.setFromAxisAngle(AY, a);
const qz = (a, out = new THREE.Quaternion()) => out.setFromAxisAngle(AZ, a);

// --- The model's meshes ----------------------------------------------------------------------------------------------------------
/**
 * The nodes `names` of a loaded model as one skinned mesh a material, each node a bone of `bones` (by name): every vertex rigidly on its
 * node's bone, in the model's frame at rest. Returns the meshes.
 */
function skinned(scene, names, boneIndex, skeleton, material) {
  const parts = new Map(); // material name -> [{ geometry, matrix, bone }]
  for (const name of names) {
    const node = scene.getObjectByName(name);
    if (!node) {
      console.warn('[concert] no node', name);
      continue;
    }
    node.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.material.name;
      if (!parts.has(key)) parts.set(key, []);
      parts.get(key).push({ geometry: o.geometry, matrix: o.matrixWorld.clone(), bone: boneIndex.get(name) });
    });
  }
  const meshes = [];
  const v = new THREE.Vector3();
  for (const [key, list] of parts) {
    let count = 0, indices = 0;
    for (const { geometry } of list) {
      count += geometry.attributes.position.count;
      indices += geometry.index ? geometry.index.count : geometry.attributes.position.count;
    }
    const position = new Float32Array(count * 3), colour = new Float32Array(count * 3);
    const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
    const index = new Uint32Array(indices);
    let at = 0, ai = 0;
    for (const { geometry, matrix, bone } of list) {
      const p = geometry.attributes.position, c = geometry.attributes.color;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(matrix);
        position.set([v.x, v.y, v.z], (at + i) * 3);
        if (c) colour.set([c.getX(i), c.getY(i), c.getZ(i)], (at + i) * 3);
        else colour.fill(1, (at + i) * 3, (at + i) * 3 + 3);
        skinIndex[(at + i) * 4] = bone;
        skinWeight[(at + i) * 4] = 1;
      }
      if (geometry.index) for (let i = 0; i < geometry.index.count; i++) index[ai++] = geometry.index.getX(i) + at;
      else for (let i = 0; i < p.count; i++) index[ai++] = i + at;
      at += p.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.SkinnedMesh(g, material(key));
    mesh.name = `concert_${key}`;
    mesh.frustumCulled = false;
    mesh.bind(skeleton, new THREE.Matrix4());
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * The stage. `hall`: the Concert Hall (js/opera-house.js OPERA_HOUSE.halls), `frame` its hallFrame(); `load(file)` fetches a model
 * ({ scene, data }: js/interiors.js loadModel()); `material(name)` the models' material for an inside; `reveal(group)` puts a group in
 * the scene with its shaders ready, `dispose(group)` lets it go. `people`: js/pedestrians.js's { PersonRig, PersonCrowd, PERSON_BIND,
 * PERSON_BONES }; `anchor`: js/world-origin.js anchorToOrigin(). update(dt, concert) each frame; `holdFor()` how long the music should
 * wait for them, s; `show()` the hall's lights for js/interiors.js; debug(camera) for the scripts.
 */
function createConcertStage({ hall, frame, load, material, reveal, dispose, people, anchor }) {
  const { PersonRig, PersonCrowd, PERSON_BIND, PERSON_BONES } = people;
  const root = new THREE.Group(); // in the scene's frame: what's placed on the stage, and the trumpeter's crowd of one
  root.name = 'ConcertStage';
  const group = new THREE.Group(); // the model's frame
  root.add(group);
  let data = null, loaded = false, failed = false, disposed = false;
  let frames = 0;
  const yaw = -hall.yaw; // the model's frame turned in the world's: rotation.y
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  let gx = 0, gz = 0, floor = 0;
  /** The model's (x, z) in the world's frame, and back */
  const toWorld = (x, z, out = {}) => ((out.x = gx + cy * x + sy * z), (out.z = gz - sy * x + cy * z), out);
  const toModel = (x, z, out = {}) => {
    const dx = x - gx, dz = z - gz;
    out.x = cy * dx - sy * dz;
    out.z = sy * dx + cy * dz;
    return out;
  };
  const turnBack = new THREE.Quaternion().setFromAxisAngle(AY, -yaw);

  // What the music says, looked up as it plays
  let score = null, hands = null, cursors = { l: -1, r: -1, beat: -1, phrase: -1, ahead: -1 };
  let trumpetPhrases = [], pianoNotes = [], trumpetNotes = [];

  // The performers
  let bones = null, boneIndex = null, rest = null, robotMeshes = [], keyMeshes = [], keyState = null;
  let rig = null, crowd = null;
  const robot = {
    x: 0, z: 0, yaw: 0, shown: false, sit: 1, gait: 0, phase: 0, path: [], face: null, bow: 0, bowing: false,
    lean: 0, turn: 0, roll: 0, head: { yaw: 0, pitch: 0.45 }, handsOn: 0, loud: 0, lift: 0, look: 0,
    wrists: [new THREE.Vector3(), new THREE.Vector3()], travelled: 0, slide: null
  };
  const trumpeter = {
    x: 0, z: 0, heading: 0, shown: false, path: [], face: null, bow: 0, bowing: false, play: 1, raise: 0, breath: 0, look: 0,
    valves: [0, 0, 0], valvePresses: 0, raised: 0, raisedWas: false, lastValves: '', nod: 0
  };
  const director = { phase: 'loading', since: 0, encore: false, house: 1, stage: 0 };
  const counts = { keyPresses: 0, handTravel: 0, short: 0 }; // short: the furthest a hand at its keys fell short of them, m

  // --- Loading ---------------------------------------------------------------------------------------------------------------
  load(FILE).then(async ({ scene, data: d }) => {
    if (disposed) return;
    data = d;
    const [x, y, z] = frame(d.stage.s, d.stage.v, d.stage.floor);
    gx = x;
    gz = z;
    floor = y;
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    scene.updateMatrixWorld(true);
    // the piano, its bench and the stand, as they're built
    const body = scene.getObjectByName('body');
    if (body) {
      body.traverse((o) => {
        if (!o.isMesh) return;
        const old = o.material;
        o.material = material(old.name);
        old.dispose();
      });
      group.add(body);
    }
    // the robot's parts and the trumpet, a bone each, flat under the model's frame: each frame sets every bone's place in it
    const names = [...d.robot.bones.map((b) => b.node), 'trumpet', 'valve_1', 'valve_2', 'valve_3'];
    boneIndex = new Map(names.map((n, i) => [n, i]));
    rest = names.map((n) => scene.getObjectByName(n)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3());
    bones = names.map((n) => {
      const b = new THREE.Bone();
      b.name = n;
      b.matrixAutoUpdate = false;
      group.add(b);
      return b;
    });
    const skeleton = new THREE.Skeleton(bones, rest.map((p) => new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)));
    robotMeshes = skinned(scene, names, boneIndex, skeleton, material);
    for (const m of robotMeshes) {
      m.onBeforeRender = () => { m.userData.drawnAt = frames; };
      group.add(m);
    }
    // the keys: a white and a black, each drawn as many times as there are of it
    const kb = d.keyboard;
    keyState = [];
    for (let p = kb.low; p <= kb.high; p++) keyState.push({ p, black: isBlack(p), down: 0, want: 0, changed: true });
    for (const [name, black] of [['key_white', false], ['key_black', true]]) {
      const node = scene.getObjectByName(name);
      const proto = [];
      node?.traverse((o) => { if (o.isMesh) proto.push(o); });
      for (const part of proto) {
        const list = keyState.filter((k) => k.black === black);
        const mesh = new THREE.InstancedMesh(part.geometry, material(part.material.name), list.length);
        mesh.name = `concert_${name}`;
        mesh.userData.keys = list;
        mesh.userData.proto = part.matrixWorld.clone();
        list.forEach((k, i) => { k.mesh = mesh; k.slot = i; });
        keyMeshes.push(mesh);
        group.add(mesh);
      }
    }
    for (const k of keyState) placeKey(k);
    // the trumpeter, in a dark suit
    crowd = new PersonCrowd(1, { farDistance: Infinity, castShadow: false, dress: DARK_SUIT });
    rig = new PersonRig(TRUMPETER_LOOK);
    for (const m of crowd.meshes) {
      m.geometry.userData.shared = true; // the walkers' geometry, everyone's
      m.userData.ownMaterial = true;
      m.onBeforeRender = () => { m.userData.drawnAt = frames; };
      root.add(anchor(m));
    }
    root.traverse((o) => { o.userData.lifted = true; });
    // in their places to begin with
    placeAll();
    poseAll(0);
    root.updateMatrixWorld(true);
    await reveal(root);
    if (disposed) return;
    loaded = true;
    director.phase = 'placed';
  }).catch((error) => {
    console.warn('[concert] the stage', error);
    failed = true;
  });

  function placeAll() {
    const { bench } = data.robot;
    robot.x = bench.at[0];
    robot.z = bench.at[1];
    robot.yaw = bench.facing;
    robot.sit = 1;
    robot.shown = true;
    robot.path = [];
    const m = data.marks.trumpeter;
    trumpeter.x = m.at[0];
    trumpeter.z = m.at[1];
    trumpeter.heading = m.facing;
    trumpeter.shown = true;
    trumpeter.play = 1;
    trumpeter.path = [];
    const w = toWorld(trumpeter.x, trumpeter.z);
    rig.reset(w.x, w.z, trumpeter.heading + yaw, () => 0);
  }

  // --- The keys ----------------------------------------------------------------------------------------------------------------
  const _kp = new THREE.Vector3(), _km = new THREE.Matrix4(), _kr = new THREE.Matrix4(), _kb = new THREE.Matrix4(), _kt = new THREE.Matrix4();
  function placeKey(k) {
    const kb = data.keyboard;
    const along = new THREE.Vector3(...kb.along), out = new THREE.Vector3(...kb.out);
    const a = keyAlong(k.p, kb.white);
    _kp.fromArray(kb.start).addScaledVector(along, a);
    if (k.black) _kp.addScaledVector(out, -kb.blackBack).y += kb.blackUp;
    // its own x along the keyboard, y up, z out of the piano
    _kb.makeBasis(along, AY, out).setPosition(_kp);
    // pressed: turned about its pivot behind the fallboard, its front going down `drop`
    const angle = Math.asin(Math.min(1, kb.drop / kb.pivot)) * k.down;
    _kr.makeTranslation(0, 0, -kb.pivot).multiply(_km.makeRotationX(angle)).multiply(_kt.makeTranslation(0, 0, kb.pivot));
    _kb.multiply(_kr).multiply(k.mesh.userData.proto);
    k.mesh.setMatrixAt(k.slot, _kb);
    k.mesh.instanceMatrix.needsUpdate = true;
    k.changed = false;
  }
  function updateKeys(dt, t) {
    for (const k of keyState) k.want = 0;
    if (t !== null) {
      for (const n of sounding(pianoNotes, t, 'piano')) {
        const k = keyState[n.p - data.keyboard.low];
        if (k) k.want = 1;
      }
    }
    for (const k of keyState) {
      if (k.want === k.down) continue;
      const was = k.down;
      // down in 25 ms, up in 60
      k.down = k.want > k.down ? Math.min(1, k.down + dt / 0.025) : Math.max(0, k.down - dt / 0.06);
      if (was === 0 && k.down > 0) counts.keyPresses++;
      placeKey(k);
    }
  }

  // The notes of an instrument sounding at t: those started, back as far as a note can last
  const soundCursor = { piano: -1, trumpet: -1 };
  function sounding(notes, t, i) {
    const k = seek(notes, t, soundCursor[i]);
    soundCursor[i] = k;
    const out = [];
    for (let j = k; j >= 0 && notes[j].t > t - 7; j--) if (t < notes[j].t + notes[j].d) out.push(notes[j]);
    return out;
  }

  // --- Walking ---------------------------------------------------------------------------------------------------------------
  // A path: [{ x, z }, ...] in the model's frame, then a heading to face
  function walkTo(who, points, face = null) {
    who.path = points.map(([x, z]) => ({ x, z }));
    who.face = face;
  }
  const arrived = (who) => !who.path.length && (who.face === null || Math.abs(wrap(who.face - (who === robot ? who.yaw : who.heading))) < 0.08);
  /** Along its path at `speed`, turning to it first if it's far off; true when there and facing its way */
  function follow(who, dt, speed, turnRate) {
    const heading = who === robot ? 'yaw' : 'heading';
    let moved = 0;
    if (who.path.length) {
      const p = who.path[0];
      const dx = p.x - who.x, dz = p.z - who.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.02) who.path.shift();
      else {
        const want = Math.atan2(dx, dz);
        const err = wrap(want - who[heading]);
        who[heading] = wrap(who[heading] + Math.sign(err) * Math.min(Math.abs(err), turnRate * dt));
        // turns on the spot first, then walks, easing into its mark
        const go = Math.abs(err) < 0.5 ? Math.min(d, speed * dt * Math.min(1, 0.4 + d)) : 0;
        who.x += Math.sin(who[heading]) * go;
        who.z += Math.cos(who[heading]) * go;
        moved = go;
      }
    } else if (who.face !== null) {
      const err = wrap(who.face - who[heading]);
      who[heading] = wrap(who[heading] + Math.sign(err) * Math.min(Math.abs(err), turnRate * dt));
      if (Math.abs(err) < 0.05) who.face = null;
    }
    return moved;
  }

  // --- The director: who does what, when -------------------------------------------------------------------------------------
  const marks = () => data.marks;
  function setPhase(phase) {
    director.phase = phase;
    director.since = 0;
  }
  function benchSide() {
    // beside the bench's end towards the audience, facing the keys
    const { bench } = data.robot;
    const f = bench.facing;
    // the robot's right, seated, is the audience's side: its right is -x of its own frame, turned
    return [bench.at[0] - Math.cos(f) * 0.85, bench.at[1] + Math.sin(f) * 0.85];
  }
  function direct(dt, concert, t) {
    director.since += dt;
    const state = concert?.state ?? 'idle';
    const wanted = state === 'loading';
    const playing = state === 'playing' && t !== null;
    const m = marks();
    const audience = m.audience;
    const end = score ? score.duration + 0.6 : Infinity;
    switch (director.phase) {
      case 'placed':
        if (playing && t < end) setPhase('playing');
        break;
      case 'playing':
        if (!playing) setPhase('placed');
        else if (t >= end) setPhase('closing');
        break;
      case 'closing':
        // the last chord held a moment, the hands up off the keys
        if (director.since > 1.2) {
          setPhase('rising');
          robot.slide = { from: { x: robot.x, z: robot.z }, to: benchSide(), t: 0, up: true };
          trumpeter.face = audience;
        }
        break;
      case 'rising':
        if (!robot.slide) {
          setPhase('forward');
          walkTo(robot, [m.robot.bow], audience);
          walkTo(trumpeter, [m.trumpeter.bow], audience);
        }
        break;
      case 'forward':
        if (arrived(robot) && arrived(trumpeter)) {
          setPhase('bowing-out');
          robot.bowing = trumpeter.bowing = true;
          robot.bow = trumpeter.bow = 0;
        }
        break;
      case 'bowing-out':
        if (!robot.bowing && !trumpeter.bowing) {
          if (wanted) takePlaces();
          else {
            setPhase('leaving');
            walkTo(robot, [m.wings]);
            walkTo(trumpeter, [m.wings]);
          }
        }
        break;
      case 'leaving':
        if (wanted) {
          setPhase('entering');
          walkTo(robot, [m.robot.bow], audience);
          walkTo(trumpeter, [m.trumpeter.bow], audience);
        } else if (arrived(robot) && arrived(trumpeter)) {
          robot.shown = trumpeter.shown = false;
          setPhase('offstage');
        }
        break;
      case 'offstage':
        if (wanted) {
          // on from the stage's side, the trumpeter a step ahead
          const w = m.wings, tb = m.trumpeter.bow;
          const d = Math.hypot(tb[0] - w[0], tb[1] - w[1]);
          robot.x = w[0];
          robot.z = w[1];
          trumpeter.x = w[0] + (tb[0] - w[0]) * 0.8 / d;
          trumpeter.z = w[1] + (tb[1] - w[1]) * 0.8 / d;
          robot.sit = 0;
          robot.yaw = Math.atan2(m.robot.bow[0] - w[0], m.robot.bow[1] - w[1]);
          trumpeter.heading = Math.atan2(tb[0] - w[0], tb[1] - w[1]);
          robot.shown = trumpeter.shown = true;
          trumpeter.play = 0;
          const at = toWorld(trumpeter.x, trumpeter.z);
          rig.reset(at.x, at.z, trumpeter.heading + yaw, () => 0);
          setPhase('entering');
          walkTo(trumpeter, [m.trumpeter.bow], audience);
          walkTo(robot, [m.robot.bow], audience);
        }
        break;
      case 'entering':
        if (arrived(robot) && arrived(trumpeter)) {
          setPhase('bowing-in');
          robot.bowing = trumpeter.bowing = true;
          robot.bow = trumpeter.bow = 0;
        }
        break;
      case 'bowing-in':
        if (!robot.bowing && !trumpeter.bowing) takePlaces();
        break;
      case 'seating':
        if (arrived(robot) && robot.sit === 0 && !robot.slide) {
          robot.slide = { from: { x: robot.x, z: robot.z }, to: data.robot.bench.at, t: 0, up: false };
        }
        if (robot.sit === 1 && arrived(trumpeter)) setPhase('placed');
        break;
      default:
        break;
    }
  }
  function takePlaces() {
    const m = marks();
    setPhase('seating');
    const side = benchSide();
    walkTo(robot, [side], data.robot.bench.facing);
    walkTo(trumpeter, [m.trumpeter.at], m.trumpeter.facing);
  }

  // --- The robot ---------------------------------------------------------------------------------------------------------------
  const P = {}, Q = {}; // each bone's joint and turn this frame, by name
  const restOf = (n) => rest[boneIndex.get(`robot_${n}`)];
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _mid = new THREE.Vector3(), _end = new THREE.Vector3(), _pole = new THREE.Vector3(), _front = new THREE.Vector3(), _left = new THREE.Vector3();
  const _target = new THREE.Vector3(), _knee = new THREE.Vector3(), _fingers = new THREE.Vector3(), _tip = new THREE.Vector3();
  const _along = new THREE.Vector3(), _out = new THREE.Vector3(), _yawQ = new THREE.Quaternion(), _tl = new THREE.Vector3();
  const before = [new THREE.Vector3(), new THREE.Vector3()];
  function joint(name, parent, out = new THREE.Vector3()) {
    // a joint where its rest offset from its parent's joint is now
    return out.subVectors(restOf(name), restOf(parent)).applyQuaternion(Q[parent]).add(P[parent]);
  }
  function setBone(name, at, q) {
    (P[name] ??= new THREE.Vector3()).copy(at);
    (Q[name] ??= new THREE.Quaternion()).copy(q);
  }

  function robotUpdate(dt, t) {
    const r = robot;
    // its feet: walking when it moves, standing when it stops
    const moved = r.sit === 0 && !r.slide ? follow(r, dt, ROBOT_WALK, 2.2) : 0;
    const turning = r.path.length || (r.face !== null && Math.abs(wrap(r.face - r.yaw)) > 0.05);
    r.gait += ((moved > 0 || turning ? 1 : 0) - r.gait) * ease(dt, 0.18);
    r.phase = (r.phase + (moved > 0 ? moved / (2 * STEP) : turning ? dt * 0.8 : 0)) % 1;
    r.travelled += moved;
    // onto the bench, or off it: sideways along it, down onto it or up off it
    if (r.slide) {
      r.slide.t = Math.min(1, r.slide.t + dt / SIT);
      const u = smoothstep(0, 1, r.slide.t);
      const [tx, tz] = Array.isArray(r.slide.to) ? r.slide.to : [r.slide.to.x, r.slide.to.z];
      r.x = lerp(r.slide.from.x, tx, u);
      r.z = lerp(r.slide.from.z, tz, u);
      r.sit = r.slide.up ? 1 - smoothstep(0.1, 0.8, r.slide.t) : smoothstep(0.2, 0.9, r.slide.t);
      if (r.slide.t >= 1) {
        r.sit = r.slide.up ? 0 : 1;
        r.slide = null;
        if (r.sit === 0) r.face = null;
      }
    }
    if (r.bowing) {
      r.bow += dt / BOW;
      if (r.bow >= 1) {
        r.bow = 0;
        r.bowing = false;
      }
    }
    const bowAmount = r.bowing ? Math.sin(Math.PI * Math.min(1, r.bow * 1.15)) ** 0.7 : 0;

    // What the music asks of it
    const playing = t !== null && director.phase === 'playing';
    const closing = director.phase === 'closing';
    let lean = 0.18, turn = 0, roll = 0, headYaw = 0, headPitch = 0.42;
    const hand = [null, null];
    if (r.sit > 0.99 && (playing || closing || director.phase === 'placed') && hands) {
      const tt = t ?? -1;
      const kb = data.keyboard;
      const centre = 26 * kb.white;
      const places = ['l', 'r'].map((h) => {
        const at = handAt(hands[h], tt, cursors[h]);
        cursors[h] = at.k;
        return at;
      });
      // poised over the keys from a second before the first notes; resting on its knees before that
      const ready = playing ? 1 : closing ? 1 : smoothstep(-2.5, -1.0, tt);
      r.handsOn += (ready - r.handsOn) * ease(dt, 0.25);
      const mean = places.filter((p) => p.along !== null).reduce((a, p, _, all) => a + p.along / all.length, 0) || centre;
      turn = Math.max(-0.3, Math.min(0.3, (centre - mean) * 0.55)) * r.handsOn;
      roll = Math.max(-0.12, Math.min(0.12, (centre - mean) * 0.25)) * r.handsOn;
      // louder, further in
      const loud = playing ? sounding(pianoNotes, tt, 'piano').reduce((a, n) => Math.max(a, n.v), 0) : 0;
      r.loud += (loud - r.loud) * ease(dt, loud > r.loud ? 0.12 : 0.6);
      lean = 0.2 + 0.16 * r.loud * r.handsOn;
      // at the end, up off the keys
      r.lift += ((closing ? 1 : 0) - r.lift) * ease(dt, 0.25);
      places.forEach((p, i) => {
        const along = p.along ?? (i === 0 ? centre - 0.2 : centre + 0.2);
        hand[i] = { along, depth: p.depth, height: 0.07 + p.lift - p.dip + 0.12 * r.lift };
      });
      // looks to the trumpeter when the trumpet leads or answers, at the keys otherwise; nods to the beat
      const toTrumpet = playing && trumpetLeads(tt) ? 1 : 0;
      r.look += (toTrumpet - (r.look ?? 0)) * ease(dt, 0.35);
      const nod = playing ? beatPulse(tt) : 0;
      const dir = lookAt();
      headYaw = lerp(turn * -0.4, dir.yaw, r.look);
      headPitch = lerp(0.42, dir.pitch, r.look) + 0.07 * nod - 0.06 * r.lift;
    } else {
      r.handsOn += (0 - r.handsOn) * ease(dt, 0.25);
      r.look = 0;
      headPitch = r.sit > 0.5 ? 0.3 : 0.05;
      if (director.phase === 'bowing-out' || director.phase === 'bowing-in' || director.phase === 'forward' || director.phase === 'entering') {
        headPitch = 0.0;
      }
    }
    r.lean += (lean - r.lean) * ease(dt, 0.2);
    r.turn += (turn - r.turn) * ease(dt, 0.25);
    r.roll += (roll - r.roll) * ease(dt, 0.25);
    r.head.yaw += (headYaw - r.head.yaw) * ease(dt, 0.18);
    r.head.pitch += (headPitch - r.head.pitch) * ease(dt, 0.15);
    poseRobot(dt, hand, bowAmount);
  }

  // Where the trumpeter's head is from the robot's, as a turn and a tilt of its head from its torso
  const _look = { yaw: 0, pitch: 0 };
  function lookAt() {
    if (!P.head || !rig?.headPosition) return _look;
    const at = toModel(rig.headPosition.x, rig.headPosition.z);
    _v.set(at.x, rig.headPosition.y + 0.05, at.z).sub(P.head);
    _v.applyQuaternion(_q.copy(Q.torso).invert());
    _look.yaw = Math.max(-1.2, Math.min(1.2, Math.atan2(_v.x, _v.z)));
    _look.pitch = Math.max(-0.3, Math.min(0.5, -Math.atan2(_v.y, Math.hypot(_v.x, _v.z))));
    return _look;
  }

  function poseRobot(dt, hand, bowAmount) {
    const r = robot;
    const kb = data.keyboard;
    const { bench } = data.robot;
    qy(r.yaw, _yawQ);
    _front.set(Math.sin(r.yaw), 0, Math.cos(r.yaw));
    _left.set(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
    // the pelvis: standing (bobbing as it walks) or on the bench
    const restPelvis = restOf('pelvis');
    const hipDrop = restPelvis.y - restOf('thigh_l').y;
    const seatedY = bench.top + 0.065 + hipDrop;
    const bob = 0.012 * r.gait * Math.cos(4 * Math.PI * r.phase);
    const pelvisY = lerp(restPelvis.y - 0.01 + bob - 0.05 * bowAmount, seatedY, r.sit);
    // seated, back on the bench a little
    _v.set(r.x, pelvisY, r.z).addScaledVector(_front, -0.03 * r.sit);
    setBone('pelvis', _v, _q2.copy(_yawQ).multiply(qx(0.06 * r.sit + 0.05 * bowAmount)));
    // the torso: leaning in to play, turned and tilted towards its hands; bent forward to bow; swaying a little as it walks
    const sway = 0.04 * r.gait * Math.sin(2 * Math.PI * r.phase);
    const torsoQ = new THREE.Quaternion().copy(Q.pelvis)
      .multiply(qy(r.turn * r.sit - sway))
      .multiply(qx((r.lean - 0.06) * r.sit + 0.85 * bowAmount))
      .multiply(qz(r.roll * r.sit));
    setBone('torso', joint('torso', 'pelvis', _w), torsoQ);
    setBone('head', joint('head', 'torso', _w), _q2.copy(Q.torso).multiply(qy(r.head.yaw)).multiply(qx(r.head.pitch + 0.35 * bowAmount)));

    // The arms
    for (const [i, s, side] of [[0, 'l', 1], [1, 'r', -1]]) {
      const shoulder = joint(`upper_${s}`, 'torso', new THREE.Vector3());
      const l1 = restOf(`upper_${s}`).distanceTo(restOf(`fore_${s}`)), l2 = restOf(`fore_${s}`).distanceTo(restOf(`hand_${s}`));
      const h = hand[i];
      const on = r.handsOn;
      // the wrist: over its keys (the fingertips on them, the hand angled down to them), or on its knee, or hanging
      const torsoLeft = _tl.set(1, 0, 0).applyQuaternion(Q.torso);
      let fingers = null;
      if (r.sit > 0.99) {
        // resting on its knee, or over its keys
        const wrist = _target;
        const onKnee = joint(`thigh_${s}`, 'pelvis', _knee).addScaledVector(_front, 0.3).addScaledVector(_left, side * 0.02);
        onKnee.y += 0.11;
        fingers = _fingers.copy(_front).multiplyScalar(0.8).add(_w.set(0, -0.6, 0)).normalize();
        if (h) {
          _along.fromArray(kb.along);
          _out.fromArray(kb.out);
          // the fingertips on its keys, the hand angled down to them from the wrist
          const tip = _tip.fromArray(kb.start).addScaledVector(_along, h.along).addScaledVector(_out, -h.depth);
          tip.y += 0.005;
          const keys = _w.copy(_out).negate().multiplyScalar(Math.cos(0.55)).add(_u.set(0, -Math.sin(0.55), 0));
          tip.addScaledVector(keys, -HAND);
          tip.y += h.height - 0.07;
          wrist.copy(onKnee).lerp(tip, on);
          fingers.lerp(keys, on).normalize();
        } else wrist.copy(onKnee);
        r.wrists[i].copy(wrist);
        _pole.copy(torsoLeft).multiplyScalar(side * 0.8).add(_v.set(0, -1, 0)).addScaledVector(_front, -0.5);
        const short = twoBone(shoulder, wrist, l1, l2, _pole, _mid, _end);
        if (h && on > 0.99) counts.short = Math.max(counts.short, short);
        armBones(s, shoulder, _mid, _end, fingers, side);
      } else {
        // hanging, swinging against the legs as it walks; bent a little
        const swing = -side * 0.32 * r.gait * Math.sin(2 * Math.PI * r.phase) - 0.1 * bowAmount;
        const upper = new THREE.Quaternion().copy(Q.torso).multiply(qz(side * 0.08)).multiply(qx(-swing));
        setBone(`upper_${s}`, shoulder, upper);
        const elbow = joint(`fore_${s}`, `upper_${s}`, new THREE.Vector3());
        setBone(`fore_${s}`, elbow, new THREE.Quaternion().copy(upper).multiply(qx(-0.25 - 0.2 * r.gait)));
        const wrist = joint(`hand_${s}`, `fore_${s}`, new THREE.Vector3());
        setBone(`hand_${s}`, wrist, Q[`fore_${s}`]);
        r.wrists[i].copy(wrist);
      }
    }
    // The legs: under it standing or walking, its feet planted in turn; seated, its feet on the floor before it, the right on the pedal
    const pedal = new THREE.Vector3(...data.robot.pedal);
    for (const [i, s, side] of [[0, 'l', 1], [1, 'r', -1]]) {
      const hip = joint(`thigh_${s}`, 'pelvis', new THREE.Vector3());
      const l1 = restOf(`thigh_${s}`).distanceTo(restOf(`shin_${s}`)), l2 = restOf(`shin_${s}`).distanceTo(restOf(`foot_${s}`));
      const ankleY = restOf(`foot_${s}`).y;
      // walking: each foot planted for half the stride, then swung forward, lifted
      const ph = (r.phase + (i === 0 ? 0 : 0.5)) % 1;
      const stance = ph < 0.5;
      const fwd = r.gait * (stance ? lerp(STEP / 2, -STEP / 2, ph / 0.5) : lerp(-STEP / 2, STEP / 2, smoothstep(0, 1, (ph - 0.5) / 0.5)));
      const up = stance ? 0 : r.gait * 0.07 * Math.sin(Math.PI * (ph - 0.5) / 0.5);
      const stand = new THREE.Vector3(r.x, ankleY + up, r.z).addScaledVector(_left, side * 0.1).addScaledVector(_front, fwd);
      // seated
      const seat = i === 1
        ? new THREE.Vector3(pedal.x, ankleY + 0.03, pedal.z).addScaledVector(_front, -0.16)
        : new THREE.Vector3(r.x, ankleY, r.z).addScaledVector(_front, 0.43).addScaledVector(_left, 0.14);
      const ankle = stand.lerp(seat, r.sit);
      _pole.copy(_front).add(_v.set(0, 0.3 * r.sit, 0));
      twoBone(hip, ankle, l1, l2, _pole, _mid, _end);
      const hinge = _left;
      setBone(`thigh_${s}`, hip, hinged(_v.subVectors(hip, _mid), hinge, new THREE.Quaternion()));
      setBone(`shin_${s}`, _mid, hinged(_v.subVectors(_mid, _end), hinge, new THREE.Quaternion()));
      // the foot flat, or its toes lifting as it swings
      setBone(`foot_${s}`, _end, new THREE.Quaternion().copy(_yawQ).multiply(qx(stance ? 0 : -0.25 * r.gait * Math.sin(Math.PI * (ph - 0.5) / 0.5))));
    }
    // hidden: every part folded to nothing
    for (const b of data.robot.bones) placeBone(b.node, P[b.name], Q[b.name], r.shown ? 1 : 0);
  }

  function armBones(s, shoulder, elbow, wrist, fingers, side) {
    const upperQ = basis(_v.subVectors(shoulder, elbow), _front, new THREE.Quaternion());
    setBone(`upper_${s}`, shoulder, upperQ);
    const hinge = _x.set(1, 0, 0).applyQuaternion(upperQ).clone();
    setBone(`fore_${s}`, elbow, hinged(_v.subVectors(elbow, wrist), hinge, new THREE.Quaternion()));
    // the hand: its fingers along `fingers`, its thumb in towards the middle
    const thumb = _w.set(-side, 0, 0).applyQuaternion(Q.torso);
    setBone(`hand_${s}`, wrist, basis(_u.copy(fingers).negate(), thumb, new THREE.Quaternion()));
  }

  const _bs = new THREE.Vector3();
  function placeBone(node, at, q, scale = 1) {
    const b = bones[boneIndex.get(node)];
    b.matrix.compose(at, q, _bs.setScalar(scale));
    // a bone folded to nothing folds about its joint
    b.matrixWorldNeedsUpdate = true;
  }

  // --- The music, looked up ------------------------------------------------------------------------------------------------------
  function trumpetLeads(t) {
    const sec = score.sections.findLast?.((x) => x.start <= t) ?? score.sections[0];
    const part = sec.parts.find((x) => t >= x.start && t < x.end);
    const k = seek(trumpetPhrases, t, cursors.phrase, 'start');
    cursors.phrase = k;
    const ph = trumpetPhrases[k];
    const inPhrase = ph && t < ph.end;
    return inPhrase && (part?.lead === 'trumpet' || ph.role === 'answer' || ph.role === 'trade' || ph.role === 'melody');
  }
  /** 1 on each beat, falling away over it */
  function beatPulse(t) {
    const k = seek(score.beats, t, cursors.beat);
    cursors.beat = k;
    const b = score.beats[k];
    if (!b) return 0;
    const next = score.beats[k + 1];
    const len = next ? next.t - b.t : 0.5;
    const u = (t - b.t) / len;
    return Math.exp(-u * 4) * (b.beat === 0 ? 1 : 0.6);
  }

  // --- The trumpeter -----------------------------------------------------------------------------------------------------------
  const _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion(), _tp = new THREE.Vector3(), _tp2 = new THREE.Vector3();
  const _lips = new THREE.Vector3(), _hangL = new THREE.Vector3(), _hangR = new THREE.Vector3();
  const _gripL = new THREE.Vector3(), _gripR = new THREE.Vector3(), _poleL = new THREE.Vector3(), _poleR = new THREE.Vector3();
  const trumpetAt = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const palmOf = (forearm) => {
    // the palm, in the rig's bind pose: down the forearm from the elbow, as far as its reach goes (FOREARM + 0.07)
    const b = PERSON_BIND[0][forearm];
    const side = Math.sign(b.x);
    return new THREE.Vector3(b.x + side * Math.sin(0.14) * 0.325, b.y - Math.cos(0.14) * 0.325, b.z);
  };
  const PALM_L = palmOf(PERSON_BONES.FOREARM_L), PALM_R = palmOf(PERSON_BONES.FOREARM_R);
  const CARRY = new THREE.Quaternion().setFromAxisAngle(AX, Math.PI / 2);

  function trumpeterUpdate(dt, t) {
    const tr = trumpeter;
    if (!tr.shown) return;
    follow(tr, dt, WALK, 2.6);
    const atMark = !tr.path.length && (director.phase === 'placed' || director.phase === 'playing' || director.phase === 'closing'
      || (director.phase === 'seating' && arrived(tr)));
    tr.play += ((atMark ? 1 : 0) - tr.play) * ease(dt, 0.3);
    if (tr.bowing) {
      tr.bow += dt / BOW;
      if (tr.bow >= 1) {
        tr.bow = 0;
        tr.bowing = false;
      }
    }
    const bowAmount = tr.bowing ? Math.sin(Math.PI * Math.min(1, tr.bow * 1.15)) ** 0.7 : 0;

    // The phrases: up for each, a breath before it; in the gaps lowered a little, turned to the piano, nodding
    const playing = t !== null && director.phase === 'playing';
    let raise = 0, breath = 0, toPiano = 0, nod = 0;
    let valves = [false, false, false];
    if (playing) {
      // the last phrase to start by RAISE from now: being played, about to be, or over
      const k = seek(trumpetPhrases, t + RAISE, cursors.ahead, 'start');
      cursors.ahead = k;
      const last = trumpetPhrases[k] ?? null, next = trumpetPhrases[k + 1] ?? null;
      if (last && t < last.end + 0.12) raise = 1;
      else {
        // a breath's gap keeps it up; a longer one takes it off the lips a little, a long one lower, turned to the piano
        const after = last ? t - last.end : Infinity;
        const until = next ? next.start - t : Infinity;
        const gap = after + until;
        raise = gap < 1.1 ? 1 : gap < 3 ? 0.55 : 0.25;
        toPiano = raise < 1 ? smoothstep(0.2, 0.8, Math.min(after, until)) * (gap < 3 ? 0.6 : 1) : 0;
        nod = toPiano * beatPulse(t);
      }
      // a breath before the phrase coming
      const coming = last && t < last.start ? last : next;
      if (coming && t < coming.start) breath = Math.sin(Math.PI * smoothstep(coming.start - 0.6, coming.start - 0.05, t));
      const now = sounding(trumpetNotes, t, 'trumpet');
      if (now.length) valves = valvesFor(now[now.length - 1].p);
    } else if (director.phase === 'closing') raise = 0.25;
    tr.raise += (raise - tr.raise) * ease(dt, raise > tr.raise ? 0.12 : 0.3);
    tr.breath += (breath - tr.breath) * ease(dt, 0.08);
    tr.look += (toPiano - tr.look) * ease(dt, 0.4);
    if (tr.raise > 0.9 && tr.raisedWas !== true) tr.raised++;
    tr.raisedWas = tr.raise > 0.9;
    const key = valves.map((v) => (v ? 1 : 0)).join('');
    if (key !== tr.lastValves && key.includes('1')) tr.valvePresses++;
    tr.lastValves = key;
    tr.valves = tr.valves.map((v, i) => v + ((valves[i] ? 1 : 0) - v) * ease(dt, 0.018));

    // Its feet: where it stands, turned to its mark's way, or to the piano in a gap
    const m = marks().trumpeter;
    if (atMark && tr.play > 0.5 && tr.face === null) tr.heading += wrap(lerp(m.facing, m.piano, 0.55 * tr.look) - tr.heading) * ease(dt, 0.5);
    const w = toWorld(tr.x, tr.z);
    rig.update(dt, w.x, w.z, tr.heading + yaw, () => 0, null, 0);

    // Its chest and head: a breath back, a bow forward, a nod; looking along the horn while it plays
    const pose = {
      chestPitch: -0.05 * tr.breath + 0.7 * bowAmount + 0.04 * (1 - tr.raise) * tr.play,
      chestYaw: 0, chestRoll: 0,
      headYaw: 0.25 * tr.look,
      headPitch: 0.06 * tr.nod + 0.35 * bowAmount - 0.04 * tr.raise * tr.play + 0.12 * (1 - tr.raise) * tr.play
    };
    tr.nod += (nod - tr.nod) * ease(dt, 0.06);
    // hanging first, for where its hands are when it carries the trumpet
    rig.hold(pose);
    rig.boneWorld(PERSON_BONES.FOREARM_L, PALM_L, _hangL);
    rig.boneWorld(PERSON_BONES.FOREARM_R, PALM_R, _hangR);
    // carried in the right hand, by its valves, its bell down
    rig.boneTurn(PERSON_BONES.FOREARM_R, _tq).multiply(CARRY);
    _tp.set(0, -0.01, 0.26).applyQuaternion(_tq).negate().add(_hangR);
    // played: at the lips raised, its bell a little down; lowered, held before the chest, the bell down and out
    const head = rig.headPosition, hq = rig.headQuaternion;
    _lips.set(0, 0.035, 0.11).applyQuaternion(hq).add(head);
    _tq2.copy(hq).multiply(qx(0.1));
    const raisedP = _tp2.copy(_lips);
    const chestQ = _q.copy(hq);
    const lowP = new THREE.Vector3(0, -0.25, 0.27).applyQuaternion(chestQ).add(head);
    const lowQ = new THREE.Quaternion().copy(chestQ).multiply(qx(0.95));
    const playP = lowP.lerp(raisedP, tr.raise);
    const playQ = lowQ.slerp(_tq2, tr.raise);
    trumpetAt.p.copy(_tp).lerp(playP, tr.play);
    trumpetAt.q.copy(_tq).slerp(playQ, tr.play);
    // its hands to it: the left round the valves' casings, the right over them, its fingers on the buttons
    _gripL.set(0.03, -0.025, 0.26).applyQuaternion(trumpetAt.q).add(trumpetAt.p);
    _gripR.set(-0.035, 0.055, 0.25).applyQuaternion(trumpetAt.q).add(trumpetAt.p);
    _gripL.lerp(_hangL, 1 - tr.play);
    _poleL.set(0.6, -1, -0.3).applyQuaternion(trumpetAt.q);
    _poleR.set(-0.7, -0.8, -0.3).applyQuaternion(trumpetAt.q);
    rig.hold({ ...pose, hands: [_gripL, _gripR], poles: [_poleL, _poleR] });
    crowd.begin();
    crowd.add(rig, 0, floor);
    crowd.end();
  }

  function placeTrumpet() {
    const shown = trumpeter.shown ? 1 : 0;
    const at = toModel(trumpetAt.p.x, trumpetAt.p.z);
    _tp.set(at.x, trumpetAt.p.y, at.z);
    _tq.copy(turnBack).multiply(trumpetAt.q);
    placeBone('trumpet', _tp, _tq, shown);
    data.valves.forEach((z, i) => {
      const r = rest[boneIndex.get(`valve_${i + 1}`)];
      _tp2.set(r.x, r.y - 0.014 * trumpeter.valves[i], r.z).applyQuaternion(_tq).add(_tp);
      placeBone(`valve_${i + 1}`, _tp2, _tq, shown);
    });
    for (const m of crowd.meshes) m.visible = trumpeter.shown && m.visible;
  }

  function poseAll(dt, t = null) {
    robotUpdate(dt, t);
    trumpeterUpdate(dt, t);
    placeTrumpet();
  }

  // --- Each frame ----------------------------------------------------------------------------------------------------------------
  function update(dt, concert) {
    frames++;
    if (!loaded || disposed) return;
    // a new score: what's played when, looked up as it goes
    if (concert?.score && concert.score !== score) {
      score = concert.score;
      hands = handPlan(score, data.keyboard);
      pianoNotes = score.notes.filter((n) => n.i === 'piano');
      trumpetNotes = score.notes.filter((n) => n.i === 'trumpet');
      trumpetPhrases = score.phrases.filter((p) => p.i === 'trumpet');
      cursors = { l: -1, r: -1, beat: -1, phrase: -1, ahead: -1 };
      soundCursor.piano = soundCursor.trumpet = -1;
    }
    const t = concert?.now?.() ?? null;
    before.forEach((b, i) => b.copy(robot.wrists[i]));
    direct(dt, concert, t);
    poseAll(dt, t);
    counts.handTravel += robot.wrists.reduce((a, w, i) => a + w.distanceTo(before[i]), 0);
    updateKeys(dt, director.phase === 'playing' || director.phase === 'closing' ? t : null);
    // the lights: the house down while they play, up for the bows; the stage lit while they're on it
    const state = concert?.state ?? 'idle';
    const active = state === 'loading' || state === 'playing';
    const dim = active && !['bowing-out', 'leaving', 'offstage'].includes(director.phase) ? 1 : 0;
    director.house += ((dim ? HOUSE_DIM : 1) - director.house) * ease(dt, 0.9);
    const lit = (robot.shown || trumpeter.shown) && (active || ['closing', 'rising', 'forward', 'bowing-out', 'leaving'].includes(director.phase)) ? 1 : 0;
    director.stage += (lit - director.stage) * ease(dt, 0.7);
    root.updateMatrixWorld(true);
  }

  /** The hall's lights while the stage has a show: the house's share of its light, and the lights over the stage, in the world's frame */
  function show() {
    if (!loaded || (director.house > 0.995 && director.stage < 0.005)) return null;
    const light = (s, v, up, intensity) => {
      const [x, y, z] = frame(s, v, data.stage.floor + up);
      return { at: [x, y, z], intensity: intensity * director.stage, distance: 18, color: 0xfff0d8 };
    };
    return { site: 'opera-house', room: 'hall', house: director.house, lights: [light(60.2, 2.2, 6.5, 30), light(60.2, -2.6, 6.5, 30)] };
  }

  /** How long the music should wait for them, s: 0 once they're in their places */
  function holdFor() {
    if (failed || disposed) return 0;
    if (!loaded) return LOAD_HOLD;
    return director.phase === 'placed' || director.phase === 'playing' ? 0 : WALK_ON_HOLD;
  }

  function debug(camera = null) {
    const seen = (p) => {
      if (!camera || !p) return null;
      _v.copy(p);
      _v.project(camera);
      return Math.abs(_v.x) < 1 && Math.abs(_v.y) < 1 && _v.z < 1;
    };
    const head = P.head && toWorld(P.head.x, P.head.z);
    const robotHead = head ? new THREE.Vector3(head.x, P.head.y + floor + 0.1, head.z) : null;
    const tHead = rig?.headPosition ? new THREE.Vector3(rig.headPosition.x, rig.headPosition.y + floor, rig.headPosition.z) : null;
    // the camera's frame is the drawn one, the world less the origin: the scene's own matrix moves it
    const scene = root.parent;
    if (scene && robotHead) robotHead.applyMatrix4(scene.matrixWorld);
    if (scene && tHead) tHead.applyMatrix4(scene.matrixWorld);
    const drawn = (m) => (m?.userData.drawnAt === undefined ? null : frames - m.userData.drawnAt);
    const tris = (g, n = 1) => (g.index ? g.index.count / 3 : g.attributes.position.count / 3) * n;
    let triangles = 0, draws = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      draws++;
      triangles += tris(o.geometry, o.isInstancedMesh ? o.count : o.count ?? 1);
    });
    return {
      loaded, failed, phase: director.phase, house: +director.house.toFixed(3), stageLight: +director.stage.toFixed(3),
      draws, triangles: Math.round(triangles),
      robot: {
        shown: robot.shown, seated: robot.sit === 1, drawn: Math.min(...robotMeshes.map(drawn).map((d) => d ?? Infinity)),
        seen: seen(robotHead), keysDown: keyState?.filter((k) => k.down > 0.5).length ?? 0, keyPresses: counts.keyPresses,
        handTravel: +counts.handTravel.toFixed(3), short: +counts.short.toFixed(3), handsOn: +robot.handsOn.toFixed(2), look: +(robot.look ?? 0).toFixed(2),
        wrists: robot.wrists.map((w) => w.toArray().map((c) => +c.toFixed(3)))
      },
      trumpeter: {
        shown: trumpeter.shown, drawn: crowd ? drawn(crowd.meshes[0]) : null, seen: seen(tHead), raise: +trumpeter.raise.toFixed(2),
        raised: trumpeter.raised, valvePresses: trumpeter.valvePresses, valves: trumpeter.valves.map((v) => +v.toFixed(2)), play: +trumpeter.play.toFixed(2)
      }
    };
  }

  return {
    update, show, holdFor, debug,
    get ready() { return holdFor() === 0; },
    get phase() { return director.phase; },
    dispose() {
      disposed = true;
      if (root.parent) dispose(root);
      else root.removeFromParent();
    }
  };
}

export { FINGERING, createConcertStage, handAt, handPlan, isBlack, keyAlong, twoBone, valvesFor, whitesBelow };
