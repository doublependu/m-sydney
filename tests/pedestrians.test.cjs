const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

const pedestriansSource = readFileSync(join(__dirname, '../js/pedestrians.js'), 'utf8');
const controllersSource = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const pedestrianSystemSource = ['traffic.js', 'pedestrian-system.js']
  .map((file) => readFileSync(join(__dirname, '../js', file), 'utf8')).join('\n');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));

// Lightweight numeric TSL & THREE harness for testing PersonCrowd, createPersonMaterial, and PersonRig without a GPU.
const shaderState = {
  attrs: {
    position: [0, 1.3, 0.08],
    normal: [0, 0, 1],
    skin: [0, 0, 0, 0],
    extra: [0, 0, 0],
    femaleDelta: [0, 0, 0],
    hairDelta: [0, 0, 0]
  },
  instanceIndex: 0,
  stage: 'fragment',
  sinCallsInFragment: 0,
  ifCallsInFragment: 0,
  vertexStageEvaluations: 0,
  varyingSnapshots: new Map()
};

const arr = (v) => (v instanceof TNode ? v.eval() : typeof v === 'number' ? [v] : v);
const broadcast = (a, b, fn) => {
  const va = arr(a), vb = arr(b);
  const n = Math.max(va.length, vb.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(va[i % va.length], vb[i % vb.length]);
  return out;
};
const smoothstepScalar = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hexToLinear = (hex) => {
  const srgb = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
};

class TNode {
  constructor(fn) {
    this._fn = typeof fn === 'function' ? fn : () => fn;
  }
  eval() { return this._fn(); }
  get x() { return new TNode(() => [this.eval()[0]]); }
  get y() { return new TNode(() => [this.eval()[1]]); }
  get z() { return new TNode(() => [this.eval()[2]]); }
  get w() { return new TNode(() => [this.eval()[3]]); }
  get xyz() { return new TNode(() => this.eval().slice(0, 3)); }
  add(b) { return new TNode(() => broadcast(this, b, (x, y) => x + y)); }
  sub(b) { return new TNode(() => broadcast(this, b, (x, y) => x - y)); }
  mul(b) { return new TNode(() => broadcast(this, b, (x, y) => x * y)); }
  div(b) { return new TNode(() => broadcast(this, b, (x, y) => x / y)); }
  lessThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x < y ? 1 : 0))); }
  greaterThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x > y ? 1 : 0))); }
  toVar() {
    let slot = null;
    const variable = new TNode(() => (slot ?? this.eval()));
    variable.assign = (rhs) => { slot = arr(rhs).slice(); };
    return variable;
  }
  assign() {}
}

const wrap = (v) => (v instanceof TNode ? v : new TNode(Array.isArray(v) ? v : [v]));

const tslStub = {
  Fn: (builder) => () => new TNode(() => arr(builder())),
  If: (cond, body) => {
    if (shaderState.stage === 'fragment') shaderState.ifCallsInFragment++;
    let matched = arr(cond)[0] > 0;
    if (matched) body();
    const api = {
      ElseIf(c, b) {
        if (shaderState.stage === 'fragment') shaderState.ifCallsInFragment++;
        if (!matched && arr(c)[0] > 0) {
          matched = true;
          b();
        }
        return api;
      },
      Else(b) {
        if (!matched) {
          matched = true;
          b();
        }
        return api;
      }
    };
    return api;
  },
  float: (v) => wrap(v),
  int: (v) => new TNode(() => arr(v).map((x) => x | 0)),
  vec2: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0]] : flat.slice(0, 2);
  }),
  vec3: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0], flat[0]] : flat.slice(0, 3);
  }),
  vec4: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0], flat[0], flat[0]] : flat.slice(0, 4);
  }),
  color: (hex) => new TNode(hexToLinear(hex)),
  attribute: (name) => new TNode(() => shaderState.attrs[name]),
  instanceIndex: new TNode(() => [shaderState.instanceIndex]),
  attributeArray: (count) => {
    const array = new Float32Array(count * 4);
    let uploads = 0;
    let lastRange = [0, 0];
    const value = {
      array,
      get uploads() { return uploads; },
      get lastRange() { return lastRange; },
      clearUpdateRanges() { lastRange = [0, 0]; },
      addUpdateRange(offset, len) { lastRange = [offset, len]; },
      set needsUpdate(v) { if (v) uploads++; }
    };
    const storage = {
      value,
      toReadOnly() { return storage; },
      setPBO() { return storage; },
      element(idxNode) {
        return new TNode(() => {
          const i = (arr(idxNode)[0] | 0) * 4;
          return [array[i], array[i + 1], array[i + 2], array[i + 3]];
        });
      }
    };
    return storage;
  },
  normalLocal: new TNode([0, 0, 1]),
  varying: (node, name) => {
    const key = name || Symbol('varying');
    return new TNode(() => {
      if (shaderState.varyingSnapshots.has(key)) return shaderState.varyingSnapshots.get(key);
      const prev = shaderState.stage;
      shaderState.stage = 'vertex';
      const val = arr(node).slice();
      shaderState.stage = prev;
      shaderState.varyingSnapshots.set(key, val);
      return val;
    });
  },
  vertexStage: (node) => new TNode(() => {
    shaderState.vertexStageEvaluations++;
    const prev = shaderState.stage;
    shaderState.stage = 'vertex';
    const val = arr(node).slice();
    shaderState.stage = prev;
    return val;
  }),
  cross: (a, b) => new TNode(() => {
    const u = arr(a), v = arr(b);
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  }),
  normalize: (a) => new TNode(() => {
    const u = arr(a);
    const len = Math.hypot(...u) || 1;
    return u.map((x) => x / len);
  }),
  sin: (a) => new TNode(() => {
    if (shaderState.stage === 'fragment') shaderState.sinCallsInFragment++;
    return arr(a).map(Math.sin);
  }),
  abs: (a) => new TNode(() => arr(a).map(Math.abs)),
  fract: (a) => new TNode(() => arr(a).map((x) => x - Math.floor(x))),
  max: (a, b) => new TNode(() => broadcast(a, b, Math.max)),
  clamp: (x, lo, hi) => new TNode(() => {
    const vx = arr(x), vlo = arr(lo), vhi = arr(hi);
    return vx.map((val, i) => Math.max(vlo[i % vlo.length], Math.min(vhi[i % vhi.length], val)));
  }),
  mix: (a, b, t) => new TNode(() => {
    const va = arr(a), vb = arr(b), vt = arr(t);
    const n = Math.max(va.length, vb.length, vt.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = vt[i % vt.length];
      out[i] = va[i % va.length] * (1 - k) + vb[i % vb.length] * k;
    }
    return out;
  }),
  step: (edge, x) => new TNode(() => broadcast(edge, x, (e, v) => (v < e ? 0 : 1))),
  smoothstep: (e0, e1, x) => new TNode(() => {
    const v0 = arr(e0), v1 = arr(e1), vx = arr(x);
    const n = Math.max(v0.length, v1.length, vx.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = smoothstepScalar(v0[i % v0.length], v1[i % v1.length], vx[i % vx.length]);
    return out;
  })
};

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  applyAxisAngle(axis, angle) {
    const q = new Quaternion().setFromAxisAngle(axis, angle);
    return this.applyQuaternion(q);
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return this;
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  identity() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5, s = Math.sin(half);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
    return this;
  }
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-7) {
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) { this.x = -vFrom.y; this.y = vFrom.x; this.z = 0; this.w = 0; }
      else { this.x = 0; this.y = -vFrom.z; this.z = vFrom.y; this.w = 0; }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
  setFromRotationMatrix(m) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s; this.x = (m32 - m23) * s; this.y = (m13 - m31) * s; this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s; this.x = 0.25 * s; this.y = (m12 + m21) / s; this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s; this.x = (m12 + m21) / s; this.y = 0.25 * s; this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = (m13 + m31) / s; this.y = (m23 + m32) / s; this.z = 0.25 * s;
    }
    return this;
  }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(xAxis, yAxis, zAxis) {
    this.elements = [
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      0, 0, 0, 1
    ];
    return this;
  }
}

class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setXYZ(i, x, y, z) {
    const o = i * this.itemSize;
    this.array[o] = x; this.array[o + 1] = y; this.array[o + 2] = z;
    return this;
  }
}
class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(array instanceof Float32Array ? array : new Float32Array(array), itemSize); }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  setIndex(indices) {
    this.index = indices instanceof BufferAttribute ? indices : new BufferAttribute(new Uint32Array(indices), 1);
    return this;
  }
  getIndex() { return this.index; }
  computeVertexNormals() {
    const pos = this.attributes.position;
    if (pos && !this.attributes.normal) this.attributes.normal = new Float32BufferAttribute(new Float32Array(pos.array.length), 3);
  }
  computeBoundingSphere() {
    this.boundingSphere = { center: new Vector3(), radius: 1 };
  }
}
class MeshStandardNodeMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.visible = true;
    this.count = 1;
    this.frustumCulled = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.matrixAutoUpdate = true;
  }
}

function mergeGeometries(geos) {
  let totalVerts = 0;
  let totalIndices = 0;
  const attrNames = Object.keys(geos[0].attributes);
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }
  const merged = new BufferGeometry();
  for (const name of attrNames) {
    const itemSize = geos[0].attributes[name].itemSize;
    const out = new Float32Array(totalVerts * itemSize);
    let offset = 0;
    for (const g of geos) {
      out.set(g.attributes[name].array, offset);
      offset += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new Float32BufferAttribute(out, itemSize));
  }
  const idx = new Uint32Array(totalIndices);
  let iOff = 0, vOff = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[iOff++] = src[i] + vOff;
    } else {
      for (let i = 0; i < count; i++) idx[iOff++] = i + vOff;
    }
    vOff += count;
  }
  merged.setIndex(new BufferAttribute(idx, 1));
  return merged;
}

const { PERSON_BONES, PersonCrowd, PersonRig, buildPersonGeometry, createPersonMaterial } = loadModule(pedestriansSource, {
  imports: {
    'three/webgpu': { Vector3, Quaternion, Matrix4, BufferAttribute, BufferGeometry, Float32BufferAttribute, MeshStandardNodeMaterial, Mesh },
    'three/tsl': tslStub,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries },
    './surfaces.js': { edgeHeight: () => 0, groundHeight: () => 0, surfaceHeight: () => 0, surfaceSlope: () => 0, sameLevel: (a, b) => Math.abs(a - b) < 3, chooseSurface: () => ({ sid: 0, y: 0 }), moveOver: (sid, y, fx, fz, x, z) => ({ x, z, sid: 0, y: 0, held: false }), structureAt: () => null, structuresAt: () => [], LINKS: [] }
  }
});
const STRIDE = 31;

test('PersonCrowd creates 2 LODs only when farDistance is finite and disables shadow casting on PeopleFar', () => {
  const streetCrowd = new PersonCrowd(16, { farDistance: 34, castShadow: true });
  assert.equal(streetCrowd.lods.length, 2);
  assert.equal(streetCrowd.meshes[0].name, 'PeopleNear');
  assert.equal(streetCrowd.meshes[1].name, 'PeopleFar');
  assert.equal(streetCrowd.meshes[0].castShadow, true);
  assert.equal(streetCrowd.meshes[1].castShadow, false);
  assert.equal(streetCrowd.meshes[0].matrixAutoUpdate, false);
  assert.equal(streetCrowd.meshes[1].matrixAutoUpdate, false);

  const playerCrowd = new PersonCrowd(1, { farDistance: Infinity, castShadow: true });
  assert.equal(playerCrowd.lods.length, 1);
  assert.equal(playerCrowd.meshes[0].name, 'PeopleNear');
  assert.equal(playerCrowd.meshes[0].castShadow, true);
});

test('PersonCrowd poses reach the texture WebGL2 reads them through, as well as the storage buffer', () => {
  const crowd = new PersonCrowd(4, { farDistance: Infinity });
  const attr = crowd.lods[0].pose.value;
  attr.pbo = { needsUpdate: false }; // three.js adds this when it builds the shader on WebGL2
  crowd.begin();
  crowd.add({ pose: new Float32Array(STRIDE * 4), x: 0, z: 0 }, 0);
  crowd.end();
  assert.equal(attr.pbo.needsUpdate, true);
});

test('PersonCrowd keeps 1 warm-up instance for 2 updates, then hides empty LODs with zero uploads', () => {
  const crowd = new PersonCrowd(8, { farDistance: 34 });
  const rig = new PersonRig({ seed: 2.5 });
  rig.reset(0, 0, 0, () => 0, null);

  for (const frame of [1, 2]) {
    crowd.begin();
    crowd.end();
    assert.equal(crowd.meshes[0].visible, true, `warm-up frame ${frame} near visible`);
    assert.equal(crowd.meshes[0].count, 1);
    assert.equal(crowd.meshes[1].visible, true, `warm-up frame ${frame} far visible`);
    assert.equal(crowd.meshes[1].count, 1);
  }

  const uploadsAfterWarmup = crowd.lods[0].pose.value.uploads;
  crowd.begin();
  crowd.end();
  assert.equal(crowd.meshes[0].visible, false);
  assert.equal(crowd.meshes[0].count, 0);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);
  assert.equal(crowd.lods[0].pose.value.uploads, uploadsAfterWarmup);

  crowd.begin();
  crowd.add(rig, 12);
  crowd.end();
  assert.equal(crowd.meshes[0].visible, true);
  assert.equal(crowd.meshes[0].count, 1);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);
});

test('buildPersonGeometry assigns constant partId across every triangle so flat/interpolated part varyings never bleed', () => {
  for (const detail of [1, 0]) {
    const geo = buildPersonGeometry(detail);
    const skin = geo.getAttribute('skin').array;
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const p0 = skin[idx[i] * 4 + 3];
      const p1 = skin[idx[i + 1] * 4 + 3];
      const p2 = skin[idx[i + 2] * 4 + 3];
      assert.equal(p0, p1);
      assert.equal(p1, p2);
    }
  }
});

test('createPersonMaterial hoists palette hashes to vertex stage, keeps positionNode clean, and makes PeopleFar branch-free', () => {
  const pose = tslStub.attributeArray(2 * STRIDE);
  const infoOffset = (STRIDE - 1) * 4;
  pose.value.array.set([7.3, 1.0, 1.02, 0.65], infoOffset);

  const nearMat = createPersonMaterial(pose, 1);
  const farMat = createPersonMaterial(pose, 0);

  // Evaluating positionNode (used by shadow pass) must not trigger any clothing vertexStage varyings
  shaderState.vertexStageEvaluations = 0;
  shaderState.varyingSnapshots.clear();
  nearMat.positionNode.eval();
  assert.equal(shaderState.vertexStageEvaluations, 0, 'shadow positionNode evaluates zero clothing/palette nodes');

  // PeopleNear fragment stage runs zero palette/hash sin() calls except hair strand sin() on hair parts
  for (const [partId, pos, extra] of [
    [0, [0.02, 1.35, 0.09], [0, 0, 0.5]],
    [1, [0.09, 0.6, 0.04], [0, 0, 0.4]],
    [2, [0.09, 0.02, 0.05], [0, 0, 0.3]],
    [3, [0.18, 1.1, 0.0], [0, 0, 0.95]],
    [4, [0.22, 0.85, 0.0], [0, 0, 0.5]],
    [5, [0.02, 1.62, 0.09], [0, 0, 0.5]]
  ]) {
    shaderState.attrs.skin = [0, 0, 0, partId];
    shaderState.attrs.position = pos;
    shaderState.attrs.extra = extra;
    shaderState.varyingSnapshots.clear();
    shaderState.sinCallsInFragment = 0;
    shaderState.stage = 'fragment';
    const col = nearMat.colorNode.eval();
    const rough = nearMat.roughnessNode.eval();
    assert.equal(shaderState.sinCallsInFragment, 0, `part ${partId} executes zero fragment sin() hashes`);
    assert.equal(col.length, 3);
    assert.ok(col.every((c) => Number.isFinite(c) && c >= 0 && c <= 1.5));
    assert.ok(rough[0] >= 0.35 && rough[0] <= 0.9);
  }

  // PeopleFar fragment stage runs zero If/ElseIf branches and zero fragment sin() calls across all parts
  for (const partId of [0, 1, 2, 3, 4, 5, 6, 7]) {
    shaderState.attrs.skin = [0, 0, 0, partId];
    shaderState.varyingSnapshots.clear();
    shaderState.sinCallsInFragment = 0;
    shaderState.ifCallsInFragment = 0;
    shaderState.stage = 'fragment';
    const col = farMat.colorNode.eval();
    const rough = farMat.roughnessNode.eval();
    assert.equal(shaderState.ifCallsInFragment, 0, 'PeopleFar fragment shader has zero branches');
    assert.equal(shaderState.sinCallsInFragment, 0, 'PeopleFar fragment shader has zero sin() calls');
    assert.equal(col.length, 3);
    assert.ok(col.every((c) => Number.isFinite(c) && c >= 0 && c <= 1.5));
    assert.ok(rough[0] >= 0.35 && rough[0] <= 0.9);
  }
});

test('PeopleNear hoisted varyings produce identical fragment color and roughness across triangle interiors', () => {
  const geo = buildPersonGeometry(1);
  const posArr = geo.getAttribute('position').array;
  const skinArr = geo.getAttribute('skin').array;
  const extraArr = geo.getAttribute('extra').array;
  const idxArr = geo.getIndex().array;

  const pose = tslStub.attributeArray(STRIDE);
  const nearMat = createPersonMaterial(pose, 1);
  const infoOffset = (STRIDE - 1) * 4;
  const bary = [0.23, 0.41, 0.36];

  for (const [seed, female, girth, hair] of [
    [1.1, 0, 1.0, 0.2],
    [4.2, 1, 0.96, 0.85],
    [9.7, 0, 1.06, 0.05] // tests bald male branch too
  ]) {
    pose.value.array.set([seed, female, girth, hair], infoOffset);

    // Sample triangles across the entire mesh (every 11th triangle covers all 8 body parts & transitions)
    for (let t = 0; t < idxArr.length; t += 33) {
      const i0 = idxArr[t], i1 = idxArr[t + 1], i2 = idxArr[t + 2];
      const vVar = [new Map(), new Map(), new Map()];
      const vIdx = [i0, i1, i2];

      // Evaluate vertex-stage varyings at each of the 3 triangle vertices, then interpolate with barycentric weights
      for (let k = 0; k < 3; k++) {
        const vi = vIdx[k];
        shaderState.attrs.position = [posArr[vi * 3], posArr[vi * 3 + 1], posArr[vi * 3 + 2]];
        shaderState.attrs.skin = [skinArr[vi * 4], skinArr[vi * 4 + 1], skinArr[vi * 4 + 2], skinArr[vi * 4 + 3]];
        shaderState.attrs.extra = [extraArr[vi * 3], extraArr[vi * 3 + 1], extraArr[vi * 3 + 2]];
        shaderState.varyingSnapshots = vVar[k];
        nearMat.colorNode.eval();
        nearMat.roughnessNode.eval();
      }

      const interpVaryings = new Map();
      for (const [key, val0] of vVar[0].entries()) {
        const val1 = vVar[1].get(key);
        const val2 = vVar[2].get(key);
        interpVaryings.set(key, val0.map((_, c) => val0[c] * bary[0] + val1[c] * bary[1] + val2[c] * bary[2]));
      }
      shaderState.varyingSnapshots = interpVaryings;
      const interpCol = nearMat.colorNode.eval();
      const interpRough = nearMat.roughnessNode.eval();

      // Compare against direct evaluation at the interpolated attributes (no cross-vertex varying bleed)
      shaderState.attrs.position = [0, 1, 2].map((c) =>
        posArr[i0 * 3 + c] * bary[0] + posArr[i1 * 3 + c] * bary[1] + posArr[i2 * 3 + c] * bary[2]);
      shaderState.attrs.skin = [0, 0, 0, skinArr[i0 * 4 + 3]];
      shaderState.attrs.extra = [0, 1, 2].map((c) =>
        extraArr[i0 * 3 + c] * bary[0] + extraArr[i1 * 3 + c] * bary[1] + extraArr[i2 * 3 + c] * bary[2]);
      shaderState.varyingSnapshots = new Map();
      const directCol = nearMat.colorNode.eval();
      const directRough = nearMat.roughnessNode.eval();

      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(interpCol[c] - directCol[c]) < 1e-12, `exact color match at tri ${t / 3}`);
      }
      assert.ok(Math.abs(interpRough[0] - directRough[0]) < 1e-12, `exact roughness match at tri ${t / 3}`);
    }
  }
});

test('renderPed skips hidden rig updates beyond 50m while preserving <=50m footstep audio gait and dives', () => {
  const match = pedestrianSystemSource.match(/  function renderPed\([^]*?\n  \}/);
  assert.ok(match, 'renderPed is present');

  const runRenderPed = ({ inView, x, z, diveStart = -Infinity, clock = 10 }) => {
    let calls = 0;
    let drawn = 0;
    const ped = {
      x, z, ux: 0, uz: 1, dir: 1, dodge: 0, dodgeTarget: 0, diveStart, diveHeading: 0.5,
      rig: { placed: true, update() { calls++; } }
    };
    const renderPed = vm.runInNewContext(`(${match[0].trim()})`, {
      hasView: true,
      visible: () => inView,
      pedGround: () => 0,
      focusX: 0,
      focusZ: 0,
      clock,
      PEDESTRIAN_DIVE_DURATION: 2.5,
      Math,
      pedCrowd: { add() { drawn++; } }
    });
    renderPed(ped, 1 / 60);
    return { calls, drawn, placed: ped.rig.placed };
  };

  // Hidden within 50 m (covers 45 m footstep audio radius): gait still updates
  const nearHidden = runRenderPed({ inView: false, x: 30, z: 30 });
  assert.equal(nearHidden.calls, 1);
  assert.equal(nearHidden.drawn, 0);
  assert.equal(nearHidden.placed, true);

  // Hidden beyond 50 m and not diving: rig.update is skipped and rig is marked unplaced for clean re-entry
  const farHidden = runRenderPed({ inView: false, x: 45, z: 45 });
  assert.equal(farHidden.calls, 0);
  assert.equal(farHidden.drawn, 0);
  assert.equal(farHidden.placed, false);

  // Hidden beyond 50 m while diving: dive still completes
  const farDiving = runRenderPed({ inView: false, x: 45, z: 45, diveStart: 9.0, clock: 10.0 });
  assert.equal(farDiving.calls, 1);
  assert.equal(farDiving.drawn, 0);

  // Visible beyond 50 m: poses and draws normally
  const farVisible = runRenderPed({ inView: true, x: 80, z: 80 });
  assert.equal(farVisible.calls, 1);
  assert.equal(farVisible.drawn, 1);
});

test('poseCharacters skips stationary inactive cyclist IK/uploads and culls parked characters beyond 320m', () => {
  const noopTarget = { addEventListener() {} };
  const { ThirdPersonControllerManager } = loadModule(controllersSource, {
    globals: { window: noopTarget, document: { ...noopTarget, hidden: false } },
    imports: {
      'three/webgpu': {},
      './city-config.js': { SPAWN: { x: 0, z: 0, heading: 0 }, landAt: () => true, isTypingInField: () => false },
      './bridge.js': { DECK_SID: 0 },
      './arrivals.js': { FLY: { AREA: 200 }, arrivalFor: () => null, holdOnFootway: () => null },
      './surfaces.js': { edgeHeight: () => 0, groundHeight: () => 0, surfaceHeight: () => 0, surfaceSlope: () => 0, sameLevel: (a, b) => Math.abs(a - b) < 3, chooseSurface: () => ({ sid: 0, y: 0 }), moveOver: (sid, y, fx, fz, x, z) => ({ x, z, sid: 0, y: 0, held: false }), structureAt: () => null, structuresAt: () => [], LINKS: [] },
      './terrain.js': { terrainHeight: () => 0, terrainSlope: () => 0 },
      './tsl-materials.js': {},
      './cars.js': {},
      './helicopter.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './building-collision.js': polygonCollision,
      './interior-data.js': { WALKER: 0.22 },
      './model-sites.js': { MODEL_SITES: [] }
    }
  });

  const makeMockCrowd = () => ({
    updates: 0,
    adds: 0,
    ends: 0,
    begin() {},
    add() { this.adds++; },
    end() { this.updates++; this.ends++; }
  });

  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.activeMode = 'car';
  controller.getGroundHeight = () => 0.22;

  let personUpdates = 0;
  let bikeRides = 0;
  const person = {
    type: 'person',
    position: { x: -11.6, y: 0.22, z: 0 },
    heading: 0,
    mesh: { visible: true },
    rig: { placed: true, update() { personUpdates++; this.placed = true; } },
    crowd: makeMockCrowd()
  };
  const cyclist = {
    type: 'cyclist',
    position: { x: 8.15, y: 0, z: 0 },
    heading: 0,
    leanAngle: 0,
    pedalPhase: 0,
    mesh: { visible: true },
    leanPivot: {},
    bikeFrame: {},
    helmet: {
      visible: true,
      quaternion: { copy() {} },
      position: { set() { return this; }, applyQuaternion() { return this; }, add() { return this; } }
    },
    riderRig: { headQuaternion: {}, headPosition: {}, ride() { bikeRides++; } },
    riderCrowd: makeMockCrowd()
  };
  const car = { type: 'car', position: { x: 3.6, y: 0, z: 0 }, carState: { value: { x: 0, w: 0 } } };
  controller.entities = { person, cyclist, car };

  // Within 320m: a parked bicycle's rider poses once then skips IK & uploads. Nobody walks about unless it's the player
  cyclist._parked = true;
  for (let i = 0; i < 5; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 0 });
  assert.equal(personUpdates, 0);
  assert.equal(bikeRides, 1, 'stationary parked cyclist solves ride IK only once');
  assert.equal(cyclist.riderCrowd.adds, 1);

  // Move focus > 320m away (e.g. One WTC at z = 4000): warm-up finishes, then both stop updating & hide crowds
  for (let i = 0; i < 6; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.mesh.visible, false);
  assert.equal(person.rig.placed, false);
  assert.equal(cyclist.helmet.visible, false);
  assert.equal(cyclist.mesh.visible, true, 'cyclist root stays visible so its child SpotLight stays in scene lights');

  const endsBeforeIdle = person.crowd.ends + cyclist.riderCrowd.ends;
  for (let i = 0; i < 10; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.crowd.ends + cyclist.riderCrowd.ends, endsBeforeIdle, 'zero crowd calls while parked >320m away');
  assert.equal(personUpdates, 0);
  assert.equal(bikeRides, 1);

  // Switching mode to cyclist immediately restores visibility & poses even when camera has not caught up yet
  controller.setMode('cyclist');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(cyclist.helmet.visible, true);
  assert.equal(bikeRides, 2);

  // Switching to walking brings the walker back at once, however far away the camera still is
  controller.setMode('person');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.mesh.visible, true);
  assert.equal(personUpdates, 1);
});

test('A rider is drawn on the saddle, on whatever the bike stands on, whatever the ground is elsewhere', () => {
  // The simulation is flat: the bike's frame is at its flat height, and it's drawn on its surface, a road or a deck. The crowd
  // stood the rider on the ground at the rig's x and z instead, which a rider never set: (0, 0), 22.5 m in the CBD.
  const load = (groundHeight) => loadModule(pedestriansSource, {
    imports: {
      'three/webgpu': { Vector3, Quaternion, Matrix4, BufferAttribute, BufferGeometry, Float32BufferAttribute, MeshStandardNodeMaterial, Mesh },
      'three/tsl': tslStub,
      'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries },
      './surfaces.js': { edgeHeight: () => 0, groundHeight, surfaceHeight: () => 0, surfaceSlope: () => 0, sameLevel: (a, b) => Math.abs(a - b) < 3, chooseSurface: () => ({ sid: 0, y: 0 }), moveOver: (sid, y, fx, fz, x, z) => ({ x, z, sid: 0, y: 0, held: false }), structureAt: () => null, structuresAt: () => [], LINKS: [] }
    }
  });
  const frame = { seat: new Vector3(0, 0.98, -0.28), bars: new Vector3(0, 0.98, 0.4), gripHalf: 0.22, bracket: new Vector3(0, 0.34, -0.145), crankLength: 0.17 };
  // The bike's frame where the simulation has it: (x, flat y, z)
  const bikeAt = (x, y, z) => ({ updateWorldMatrix() {}, matrixWorld: { decompose(p, q, s) { p.set(x, y, z); q.x = q.y = q.z = 0; q.w = 1; s.set(1, 1, 1); } } });
  const drawn = (mod, bike, base) => {
    const crowd = new mod.PersonCrowd(1, { farDistance: Infinity });
    const rig = new mod.PersonRig({ seed: 12.8 });
    rig.ride(bike, 0.7, frame);
    crowd.begin();
    crowd.add(rig, 0, base);
    crowd.end();
    return { pose: Array.from(crowd.lods[0].pose.value.array.slice(0, STRIDE * 4)), head: rig.headPosition.y + base, rig };
  };
  const flat = load(() => 0);
  const hilly = load((x, z) => 22.5 + 0.05 * x - 0.02 * z);
  // On a street at the start, on the bridge's deck, and at (0, 0)
  for (const [x, z, base] of [[397, -1000, 28.03], [-120, -2500, 61.4], [0, 0, 22.5]]) {
    const a = drawn(flat, bikeAt(x, 0, z), base), b = drawn(hilly, bikeAt(x, 0, z), base);
    assert.equal(b.rig.x, x, 'the rig is where the bike is');
    for (let i = 0; i < a.pose.length; i++) assert.ok(Math.abs(a.pose[i] - b.pose[i]) < 1e-3, `pose value ${i} at (${x}, ${z}): ${a.pose[i]} drawn as ${b.pose[i]}`);
    // Exactly as high as what the bike stands on
    const low = drawn(hilly, bikeAt(x, 0, z), 0);
    for (let bone = 0; bone < 4; bone++) assert.ok(Math.abs(b.pose[bone * 8 + 5] - low.pose[bone * 8 + 5] - base) < 1e-3, `bone ${bone} raised by ${b.pose[bone * 8 + 5] - low.pose[bone * 8 + 5]}, not ${base}`);
    assert.ok(b.head > base + 1.3 && b.head < base + 2, `head at ${b.head.toFixed(2)} on a bike at ${base}`);
  }
});

// Where a bone's point is drawn (from PersonRig.writeBone()'s pose: rotation, the bone's root less its bind offset, scale)
function boneWorldPos(rig, bone, localPos = rig.bind[bone]) {
  const o = bone * 8;
  const q = new Quaternion(rig.pose[o], rig.pose[o + 1], rig.pose[o + 2], rig.pose[o + 3]);
  const p = localPos.clone().applyQuaternion(q).multiplyScalar(rig.pose[o + 7]);
  p.x += rig.pose[o + 4];
  p.y += rig.pose[o + 5];
  p.z += rig.pose[o + 6];
  return p;
}

// How far a knee is bent, in degrees (0 straight)
function legKneeBendDeg(rig, legIndex) {
  const B = PERSON_BONES;
  const hip = boneWorldPos(rig, legIndex === 0 ? B.THIGH_L : B.THIGH_R);
  const knee = boneWorldPos(rig, legIndex === 0 ? B.SHIN_L : B.SHIN_R);
  const ankle = boneWorldPos(rig, legIndex === 0 ? B.FOOT_L : B.FOOT_R);
  const u1 = hip.sub(knee).normalize();
  const u2 = ankle.sub(knee).normalize();
  return 180 - Math.acos(Math.max(-1, Math.min(1, u1.dot(u2)))) * 180 / Math.PI;
}

// The lowest point of a shoe's sole, its heel or its toe
function lowestSole(rig) {
  const B = PERSON_BONES;
  let lowest = Infinity;
  for (let i = 0; i < 2; i++) {
    const side = rig.feet[i].side;
    const heel = boneWorldPos(rig, i === 0 ? B.FOOT_L : B.FOOT_R, new Vector3(side * 0.09, 0, -0.078));
    const toe = boneWorldPos(rig, i === 0 ? B.TOE_L : B.TOE_R, new Vector3(side * 0.09, 0.005, 0.208));
    lowest = Math.min(lowest, heel.y, toe.y);
  }
  return lowest;
}

// What's left of each value after a quadratic through the 7 samples round it, by time: a step back and forth from one frame to the
// next, not a stride's bob (tools/play/walk-trace.mjs measures the walker in the game the same way)
function jitterOf(ts, vs) {
  const out = [];
  for (let i = 3; i + 3 < vs.length; i++) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (let k = i - 3; k <= i + 3; k++) {
      const t = ts[k] - ts[i], y = vs[k];
      s0 += 1; s1 += t; s2 += t * t; s3 += t * t * t; s4 += t * t * t * t;
      y0 += y; y1 += y * t; y2 += y * t * t;
    }
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    out.push(Math.abs(vs[i] - (y0 * (s2 * s4 - s3 * s3) - s1 * (y1 * s4 - s3 * y2) + s2 * (y1 * s3 - s2 * y2)) / det));
  }
  return out;
}

test('PersonRig walking and running: knees never lock straight, the pelvis rises and falls smoothly, feet stay near the hips and above the pavement', () => {
  const dt = 1 / 60;
  // The people in the street (1.2-1.7 m/s), your walk (1.5), your run inside (2.4) and out (6), js/controllers.js ON_FOOT
  for (const speed of [1.2, 1.5, 2.4, 6]) {
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
    let z = 0;
    rig.reset(0, 0, 0, () => 0);
    let minPelvisY = Infinity, maxPelvisY = -Infinity, minKneeDeg = 180, minRelZ = Infinity, maxRelZ = -Infinity, minSoleY = Infinity;
    for (let f = 0; f < 180; f++) {
      z += speed * dt;
      rig.update(dt, 0, z, 0, () => 0);
      if (f < 60) continue;
      minPelvisY = Math.min(minPelvisY, rig.pelvisY);
      maxPelvisY = Math.max(maxPelvisY, rig.pelvisY);
      for (let i = 0; i < 2; i++) {
        minKneeDeg = Math.min(minKneeDeg, legKneeBendDeg(rig, i));
        minRelZ = Math.min(minRelZ, rig.feet[i].az - z);
        maxRelZ = Math.max(maxRelZ, rig.feet[i].az - z);
      }
      minSoleY = Math.min(minSoleY, lowestSole(rig));
    }
    assert.ok(minKneeDeg > 6.5, `${speed} m/s: the knee gives at full stretch rather than snapping straight (${minKneeDeg.toFixed(1)} degrees)`);
    assert.ok(minPelvisY > 0.85 && maxPelvisY - minPelvisY < 0.055, `${speed} m/s: the pelvis rises and falls within [${minPelvisY.toFixed(3)}, ${maxPelvisY.toFixed(3)}]`);
    assert.ok(minRelZ > -0.58 && maxRelZ < 0.48, `${speed} m/s: the swinging foot is carried with the body, not left behind or thrown ahead [${minRelZ.toFixed(2)}, ${maxRelZ.toFixed(2)}]`);
    assert.ok(minSoleY > -0.005, `${speed} m/s: soles stay above the pavement (${(minSoleY * 100).toFixed(2)} cm)`);
  }
});

test('PersonRig walking backward rolls from the ball of the foot to the heel, upright', () => {
  // Walking back and running back (0.65 of each pace, js/controllers.js ASIDE)
  for (const speed of [0.975, 3.9]) {
    const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
    const dt = 1 / 60;
    let z = 0;
    rig.reset(0, 0, 0, () => 0);
    let maxFrontStancePitch = -Infinity, maxTouchdownPitch = -Infinity;
    for (let f = 0; f < 180; f++) {
      z -= speed * dt;
      rig.update(dt, 0, z, 0, () => 0);
      if (f < 60) continue;
      for (const foot of rig.feet) {
        const relZ = foot.az - z;
        if (!foot.swing && relZ > 0.2) maxFrontStancePitch = Math.max(maxFrontStancePitch, foot.pitch);
        if (!foot.swing && relZ < -0.05) maxTouchdownPitch = Math.max(maxTouchdownPitch, foot.pitch);
      }
    }
    assert.ok(rig.back > 0.95, `${speed} m/s: it walks backward`);
    assert.ok(rig.pelvisTilt < 0.05, `${speed} m/s: the pelvis stays upright going back (${rig.pelvisTilt.toFixed(3)} rad)`);
    assert.ok(maxTouchdownPitch > 0.05, `${speed} m/s: a foot lands on its ball behind the hips`);
    assert.ok(maxFrontStancePitch <= 0.02, `${speed} m/s: a planted foot ahead of the hips never goes up on its toes (${maxFrontStancePitch.toFixed(3)} rad)`);
  }
});

test('PersonRig turning: the head leads, the feet step round on the spot, and a run banks into the turn', () => {
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  const dt = 1 / 60;
  let heading = 0;
  rig.reset(0, 0, 0, () => 0);
  let totalPhase = 0, prevPhase = rig.phase;
  // Turning on the spot at the arrows' 2.6 rad/s, outside (js/controllers.js ON_FOOT)
  for (let f = 0; f < 60; f++) {
    heading += 2.6 * dt;
    rig.update(dt, 0, 0, heading, () => 0);
    let dp = rig.phase - prevPhase;
    if (dp < 0) dp += 1;
    totalPhase += dp;
    prevPhase = rig.phase;
  }
  assert.ok(rig.yawRate > 2.2, `the body turns with you (${rig.yawRate.toFixed(2)} rad/s)`);
  assert.ok(rig.headTurn > 0.25, `the head leads into the turn (${rig.headTurn.toFixed(2)} rad)`);
  assert.ok(totalPhase > 0.8, `the feet step round on the spot (${totalPhase.toFixed(2)} cycles)`);

  // Running round to the left at 6 m/s
  let x = 0, z = 0;
  for (let f = 0; f < 90; f++) {
    heading += 2.6 * dt;
    x += Math.sin(heading) * 6 * dt;
    z += Math.cos(heading) * 6 * dt;
    rig.update(dt, x, z, heading, () => 0);
  }
  assert.ok(rig.bank < -0.06, `a run banks into the turn (${rig.bank.toFixed(3)} rad)`);
});

test('PersonRig jumping: a crouch with the arms back, a tuck, the legs reaching down to land, and a landing that gives', () => {
  const dt = 1 / 60;
  const B = PERSON_BONES;

  // Standing: the crouch before take-off comes as a negative `air` (js/controllers.js poseCharacters())
  const standRig = new PersonRig({ seed: 4.2, scale: 1.0 });
  standRig.reset(0, 0, 0, () => 0);
  const standPelvis0 = standRig.pelvisY;
  const handOffset = new Vector3(0.24, 0.92, 0);
  let minPrepPelvisY = Infinity, minPrepHandRelZ = Infinity;
  for (let p = 1; p <= 5; p++) {
    standRig.update(dt, 0, 0, 0, () => 0, null, -p / 5);
    minPrepPelvisY = Math.min(minPrepPelvisY, standRig.pelvisY);
    minPrepHandRelZ = Math.min(minPrepHandRelZ, boneWorldPos(standRig, B.FOREARM_L, handOffset).z - boneWorldPos(standRig, B.UPPER_ARM_L).z);
  }
  assert.ok(standPelvis0 - minPrepPelvisY > 0.05, `it crouches before taking off (${((standPelvis0 - minPrepPelvisY) * 100).toFixed(1)} cm)`);
  assert.ok(minPrepHandRelZ < -0.05, `the arms swing back before take-off (${minPrepHandRelZ.toFixed(2)} m)`);

  // Then up at the walker's 5.2 m/s, under its 14.5 m/s² (js/controllers.js updatePerson())
  let sy = 0, svy = 5.2, apexAnkleClearance = 0, preLandAnkleClearance = Infinity, maxStandLandDrop = 0, minStandSoleY = Infinity;
  for (let f = 0; f < 65; f++) {
    if (svy !== 0 || sy > 0) {
      svy -= 14.5 * dt;
      sy += svy * dt;
      if (sy <= 0) sy = svy = 0;
    }
    standRig.update(dt, 0, 0, 0, () => 0, null, sy > 0 ? Math.max(0.006, sy) : 0);
    if (Math.abs(svy) < 0.35 && sy > 0.8) apexAnkleClearance = Math.max(apexAnkleClearance, standRig.feet[0].ay - sy);
    if (svy < -4.2 && sy > 0.05 && sy < 0.25) preLandAnkleClearance = Math.min(preLandAnkleClearance, standRig.feet[0].ay - sy);
    if (f > 15 && sy === 0) maxStandLandDrop = Math.max(maxStandLandDrop, standRig.landDrop);
    minStandSoleY = Math.min(minStandSoleY, lowestSole(standRig));
  }
  assert.ok(apexAnkleClearance - preLandAnkleClearance > 0.1, `the legs reach down before landing (${apexAnkleClearance.toFixed(3)} -> ${preLandAnkleClearance.toFixed(3)} m)`);
  assert.ok(maxStandLandDrop > 0.07, `the landing gives at the knees (${(maxStandLandDrop * 100).toFixed(1)} cm)`);
  assert.ok(minStandSoleY > -0.005, `the soles never go under the pavement (${(minStandSoleY * 100).toFixed(2)} cm)`);

  // Running at 6 m/s: a split leap, the leading foot ahead of the hips, the trailing one not dragged behind
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  let z = 0, y = 0, vy = 0;
  rig.reset(0, 0, 0, () => 0);
  for (let f = 0; f < 90; f++) {
    z += 6 * dt;
    rig.update(dt, 0, z, 0, () => 0, null, 0);
  }
  vy = 5.2;
  let apexKneeBend = 0, maxLeadFootRelZ = -Infinity, minTrailFootRelZ = Infinity, landed = false, maxLandDrop = 0;
  for (let f = 0; f < 60; f++) {
    z += 6 * dt;
    if (vy !== 0 || y > 0) {
      vy -= 14.5 * dt;
      y = Math.max(0, y + vy * dt);
      if (y === 0) vy = 0;
    }
    rig.update(dt, 0, z, 0, () => 0, null, y > 0 ? Math.max(0.006, y) : 0);
    if (y > 0.4) {
      const r0 = rig.feet[0].az - z, r1 = rig.feet[1].az - z;
      maxLeadFootRelZ = Math.max(maxLeadFootRelZ, r0, r1);
      minTrailFootRelZ = Math.min(minTrailFootRelZ, r0, r1);
    }
    if (y > 0.8) apexKneeBend = Math.max(apexKneeBend, legKneeBendDeg(rig, 0), legKneeBendDeg(rig, 1));
    if (f > 10 && y === 0) {
      landed = true;
      maxLandDrop = Math.max(maxLandDrop, rig.landDrop);
    }
  }
  assert.ok(apexKneeBend > 45, `the knees fold at the top of a running jump (${apexKneeBend.toFixed(1)} degrees)`);
  assert.ok(maxLeadFootRelZ > 0.18, `the leading foot stays ahead of the hips (${maxLeadFootRelZ.toFixed(2)} m)`);
  assert.ok(minTrailFootRelZ > -0.52, `the trailing foot isn't dragged behind (${minTrailFootRelZ.toFixed(2)} m)`);
  assert.ok(landed && maxLandDrop > 0.025, `the landing gives into the next stride (${(maxLandDrop * 100).toFixed(2)} cm)`);

  // A heel kicked up over the knee: the shin turns on the thigh's hinge, never flipping round it
  rig.reset(0, 0, 0, () => 0);
  rig.solveLeg(0, new Vector3(0.09, 0.92, 0), new Vector3(0.09, 0.62, -0.32), 0);
  const quat = (bone) => new Quaternion(rig.pose[bone * 8], rig.pose[bone * 8 + 1], rig.pose[bone * 8 + 2], rig.pose[bone * 8 + 3]);
  const xThigh = new Vector3(1, 0, 0).applyQuaternion(quat(B.THIGH_L));
  const xShin = new Vector3(1, 0, 0).applyQuaternion(quat(B.SHIN_L));
  assert.ok(xThigh.dot(xShin) > 0.98, `the shin keeps the thigh's hinge (dot ${xThigh.dot(xShin).toFixed(4)})`);
});

test('PersonRig running at 6 m/s stays smooth under uneven browser frames', () => {
  const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
  const dtSeq = [0.0142, 0.0189, 0.0155, 0.0208, 0.0138, 0.0174, 0.0166];
  let z = 0, t = 0;
  rig.reset(0, 0, 0, () => 0);
  let maxFrameStep = 0, prevPelvisY = rig.pelvisY;
  const ts = [], ys = [];
  for (let f = 0; f < 400; f++) {
    const dt = dtSeq[f % dtSeq.length];
    z += 6 * dt;
    t += dt;
    rig.update(dt, 0, z, 0, () => 0);
    if (f >= 90) {
      ts.push(t);
      ys.push(rig.pelvisY);
      maxFrameStep = Math.max(maxFrameStep, Math.abs(rig.pelvisY - prevPelvisY));
    }
    prevPelvisY = rig.pelvisY;
  }
  const bob = Math.max(...ys) - Math.min(...ys);
  const jitter = Math.max(...jitterOf(ts, ys));
  assert.ok(bob < 0.03, `the run's bob is a gentle one (${(bob * 100).toFixed(2)} cm)`);
  // The bob itself moves up to 7 mm in the longest of these frames: more than that is a jump from one frame to the next
  assert.ok(maxFrameStep < 0.008, `no jump of the pelvis from one frame to the next (${(maxFrameStep * 100).toFixed(2)} cm)`);
  assert.ok(jitter < 0.002, `no step back and forth off a smooth curve (${(jitter * 1000).toFixed(2)} mm)`);
});

test('PersonRig running: the body springs, lowest at mid-stance and highest in flight; swinging feet follow the shins; the arms pump against the legs', () => {
  const dt = 1 / 60;
  const B = PERSON_BONES;

  // Walking is highest as one leg passes the other, after each heel strike's dip
  const walkRig = new PersonRig({ seed: 1, scale: 1.0 });
  walkRig.reset(0, 0, 0, () => 0);
  let wz = 0, walkContactY = 0, walkContactN = 0, walkPassY = 0, walkPassN = 0;
  for (let f = 0; f < 240; f++) {
    wz += 1.5 * dt;
    walkRig.update(dt, 0, wz, 0, () => 0);
    if (f < 90) continue;
    const p = walkRig.phase % 0.5;
    if (p > 0.08 && p < 0.16) { walkContactY += walkRig.pelvisY; walkContactN++; }
    if (p > 0.28 && p < 0.38) { walkPassY += walkRig.pelvisY; walkPassN++; }
  }
  assert.ok(walkPassY / walkPassN > walkContactY / walkContactN + 0.012, 'a walk is higher passing than taking the weight');

  const runRig = new PersonRig({ seed: 1, scale: 1.0 });
  runRig.reset(0, 0, 0, () => 0);
  let rz = 0, midStanceY = 0, midStanceN = 0, midFlightY = 0, midFlightN = 0, maxDorsiflex = -Infinity;
  let maxRightHandRelZ = -Infinity, minLeftHandRelZ = Infinity;
  for (let f = 0; f < 240; f++) {
    rz += 6 * dt;
    runRig.update(dt, 0, rz, 0, () => 0);
    if (f < 90) continue;
    const bothSwing = runRig.feet[0].swing && runRig.feet[1].swing;
    const p = runRig.phase % 0.5;
    if (!bothSwing && p > 0.08 && p < 0.16) { midStanceY += runRig.pelvisY; midStanceN++; }
    if (bothSwing && p > 0.33 && p < 0.43) { midFlightY += runRig.pelvisY; midFlightN++; }
    // A swinging foot hangs from its shin, not held level like a hoverboard under the heel kicked up behind
    for (let i = 0; i < 2; i++) {
      if (!runRig.feet[i].swing) continue;
      const footBone = i === 0 ? B.FOOT_L : B.FOOT_R;
      const knee = boneWorldPos(runRig, i === 0 ? B.SHIN_L : B.SHIN_R);
      const ankle = boneWorldPos(runRig, footBone);
      const shinPitch = Math.atan2(knee.z - ankle.z, knee.y - ankle.y);
      const o = footBone * 8;
      const footFwd = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(runRig.pose[o], runRig.pose[o + 1], runRig.pose[o + 2], runRig.pose[o + 3]));
      maxDorsiflex = Math.max(maxDorsiflex, shinPitch - Math.atan2(-footFwd.y, footFwd.z));
    }
    // As the left foot pushes off and the right knee drives forward, the left hand comes forward and the right goes back
    if (runRig.phase > 0.24 && runRig.phase < 0.30) {
      minLeftHandRelZ = Math.min(minLeftHandRelZ, boneWorldPos(runRig, B.FOREARM_L, new Vector3(0.24, 0.92, 0)).z - boneWorldPos(runRig, B.UPPER_ARM_L).z);
      maxRightHandRelZ = Math.max(maxRightHandRelZ, boneWorldPos(runRig, B.FOREARM_R, new Vector3(-0.24, 0.92, 0)).z - boneWorldPos(runRig, B.UPPER_ARM_R).z);
    }
  }
  assert.ok(midFlightY / midFlightN > midStanceY / midStanceN + 0.01,
    `a run is higher in flight (${(midFlightY / midFlightN).toFixed(3)}) than at mid-stance (${(midStanceY / midStanceN).toFixed(3)})`);
  assert.ok(maxDorsiflex < 0.5, `a swinging foot follows its shin (${(maxDorsiflex * 180 / Math.PI).toFixed(1)} degrees off)`);
  assert.ok(minLeftHandRelZ > 0.12 && maxRightHandRelZ < 0.05, `the arms swing against the legs (left ${minLeftHandRelZ.toFixed(2)} m, right ${maxRightHandRelZ.toFixed(2)} m)`);
});

test('PersonRig sat down and stood up again starts walking cleanly, with nothing of a jump or a turn carried over', () => {
  const dt = 1 / 60;
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  rig.reset(0, 0, 0, () => 0);
  // In the air, turning, when it sits
  let heading = 0;
  for (let f = 0; f < 20; f++) {
    heading += 2.6 * dt;
    rig.update(dt, 0, 0, heading, () => 0, null, 0.5);
  }
  rig.sit(2, 2, 0, 0.45);
  for (const field of ['airBlend', 'landDrop', 'back', 'yawRate', 'arm', 'thighSplit', 'jumpPrep', 'sprint']) assert.equal(rig[field], 0, `${field} is cleared on sitting`);
  assert.equal(rig.wasAirborne, false);
  // Up again and walking off from the seat's stand spot: as one that was never sat down or in the air
  const fresh = new PersonRig({ seed: 4.2, scale: 1.0 });
  fresh.reset(2, 2.5, 0, () => 0);
  fresh.time = rig.time; // the idle sway and breathing follow the rig's own clock
  let z = 2.5;
  rig.update(dt, 2, z, 0, () => 0);
  assert.equal(rig.placed, true, 'standing up places the feet again');
  for (let f = 0; f < 90; f++) {
    z += 1.5 * dt;
    rig.update(dt, 2, z, 0, () => 0);
    fresh.update(dt, 2, z, 0, () => 0);
    assert.ok(Math.abs(rig.pelvisY - fresh.pelvisY) < 1e-9 && Math.abs(rig.feet[0].az - fresh.feet[0].az) < 1e-9, `frame ${f}: walks off as a fresh rig does`);
  }
});
