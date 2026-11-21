// Paintings made up from a seed, and their labels, painted into one picture (an atlas) for a gallery's level (js/art.js). The whole of
// it is one function with nothing outside it, so it can be sent to a worker as its source and run there on an OffscreenCanvas, or run
// as it is on the page where a worker can't paint.
//
// paintAtlas({ width, height, items }) returns the canvas. Each item is { kind, seed, x, y, w, h } in the atlas's pixels: a painting
// ('landscape', 'portrait', 'still-life', 'abstract', 'ink', 'desert', 'bark'), or a label ({ kind: 'label', title, artist, year }).

function paintAtlas({ width, height, items }) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const g = canvas.getContext('2d');
  g.fillStyle = '#6b6258';
  g.fillRect(0, 0, width, height);

  // --- A seeded random, and colours ---------------------------------------------------------------------------------------------
  const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const css = ([r, gg, b], a = 1) => `rgba(${Math.round(r)},${Math.round(gg)},${Math.round(b)},${a})`;
  const mixc = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  const jitter = (c, r, k) => [c[0] + (r() - 0.5) * k, c[1] + (r() - 0.5) * k, c[2] + (r() - 0.5) * k];
  const pick = (r, list) => list[Math.floor(r() * list.length)];

  // Brushwork over what's painted: short strokes in the colours already there, a little off, so it reads as paint and not as a diagram
  function brushwork(r, x, y, w, h, n, size, k = 28, alpha = 0.3) {
    const data = g.getImageData(x, y, w, h).data;
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const px = r() * w, py = r() * h;
      const at = (Math.floor(py) * w + Math.floor(px)) * 4;
      const c = jitter([data[at], data[at + 1], data[at + 2]], r, k);
      const a = r() * Math.PI;
      const len = size * (0.6 + r());
      g.strokeStyle = css(c, alpha + r() * 0.35);
      g.lineWidth = Math.max(1, size * (0.25 + r() * 0.35));
      g.beginPath();
      g.moveTo(x + px - Math.cos(a) * len / 2, y + py - Math.sin(a) * len / 2);
      g.lineTo(x + px + Math.cos(a) * len / 2, y + py + Math.sin(a) * len / 2);
      g.stroke();
    }
  }
  function blob(cx, cy, rx, ry, colour, a = 1, rot = 0) {
    g.fillStyle = css(colour, a);
    g.beginPath();
    g.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, Math.PI * 2);
    g.fill();
  }
  function vgrad(x, y, w, h, stops) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    for (const [t, c] of stops) gr.addColorStop(t, css(c));
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  }
  function vignette(x, y, w, h, a) {
    const gr = g.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.2, x + w / 2, y + h / 2, Math.max(w, h) * 0.75);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, `rgba(0,0,0,${a})`);
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  }

  // --- The kinds ------------------------------------------------------------------------------------------------------------------
  // A landscape, as the colonial and Heidelberg painters had them: a sky, hills going blue into the distance, water sometimes, a
  // paddock and gum trees
  function landscape(r, x, y, w, h) {
    const moods = [
      { sky: ['#8fb3d6', '#e9dfc4'], land: ['#c9a75e', '#8c7a3e'], hills: '#7d8ca3' }, // a summer afternoon
      { sky: ['#5d79a8', '#f0c08a'], land: ['#a3884c', '#5e5532'], hills: '#6c6f8f' }, // evening
      { sky: ['#b9c9d6', '#eeeadb'], land: ['#8a9a5b', '#4f5d34'], hills: '#8d9aa8' }, // a grey morning
      { sky: ['#e8a273', '#f6dcb0'], land: ['#9c7c45', '#4d3f25'], hills: '#7a6678' } // dusk
    ];
    const m = pick(r, moods);
    const horizon = y + h * (0.38 + r() * 0.22);
    vgrad(x, y, w, horizon - y + 2, [[0, hex(m.sky[0])], [1, hex(m.sky[1])]]);
    for (let i = 0; i < 3 + r() * 5; i++) {
      const cx = x + r() * w, cy = y + r() * (horizon - y) * 0.6;
      for (let k = 0; k < 5; k++) blob(cx + (r() - 0.5) * w * 0.12, cy + (r() - 0.5) * h * 0.03, w * (0.04 + r() * 0.08), h * (0.015 + r() * 0.03), [250, 246, 236], 0.25);
    }
    // the hills, nearest last, each less blue
    const layers = 2 + Math.floor(r() * 2);
    for (let l = 0; l < layers; l++) {
      const t = (l + 1) / (layers + 1);
      const c = mixc(hex(m.hills), hex(m.land[0]), t * 0.8);
      const base = horizon + (h * 0.06) * l;
      const amp = h * (0.05 + r() * 0.07), f1 = 1 + r() * 3, f2 = 4 + r() * 6, p1 = r() * 6, p2 = r() * 6;
      g.fillStyle = css(c);
      g.beginPath();
      g.moveTo(x, y + h);
      for (let i = 0; i <= 40; i++) {
        const u = i / 40;
        g.lineTo(x + u * w, base - amp * (0.6 + 0.4 * Math.sin(u * f1 * 3 + p1)) - amp * 0.25 * Math.sin(u * f2 * 3 + p2));
      }
      g.lineTo(x + w, y + h);
      g.fill();
    }
    const ground = horizon + h * 0.08 * layers;
    // a line of trees along the furthest paddock's edge, blue-green with the distance
    for (let i = 0; i < 40; i++) {
      blob(x + r() * w, ground - h * 0.01 - r() * h * 0.02, w * (0.01 + r() * 0.02), h * (0.008 + r() * 0.015), mixc([60, 80, 60], hex(m.hills), 0.4), 0.7);
    }
    if (r() < 0.4) {
      // water across the foreground, the sky in it
      const wy = ground + (y + h - ground) * 0.15;
      vgrad(x, wy, w, (y + h - wy) * 0.55, [[0, mixc(hex(m.sky[1]), hex(m.hills), 0.3)], [1, mixc(hex(m.sky[0]), [40, 60, 80], 0.4)]]);
      g.strokeStyle = css([255, 255, 255], 0.25);
      for (let i = 0; i < 30; i++) {
        const ly = wy + r() * (y + h - wy) * 0.55, lx = x + r() * w;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx + w * (0.03 + r() * 0.08), ly);
        g.stroke();
      }
      vgrad(x, wy + (y + h - wy) * 0.55, w, (y + h - wy) * 0.45 + 1, [[0, hex(m.land[0])], [1, hex(m.land[1])]]);
    } else {
      vgrad(x, ground, w, y + h - ground + 1, [[0, hex(m.land[0])], [1, hex(m.land[1])]]);
    }
    // grass in the foreground, in strokes
    g.lineWidth = Math.max(1, w * 0.003);
    for (let i = 0; i < (w * h) / 200; i++) {
      const gx = x + r() * w, gy = y + h * (0.85 + r() * 0.15);
      g.strokeStyle = css(jitter(mixc(hex(m.land[0]), hex(m.land[1]), r()), r, 40), 0.6);
      g.beginPath();
      g.moveTo(gx, gy);
      g.lineTo(gx + (r() - 0.5) * w * 0.01, gy - h * (0.02 + r() * 0.03));
      g.stroke();
    }
    // gum trees: pale crooked trunks, olive crowns in clumps
    const trees = Math.floor(r() * 5);
    for (let i = 0; i < trees; i++) {
      const tx = x + w * (0.08 + r() * 0.84), ty = y + h * (0.82 + r() * 0.15);
      const th = h * (0.3 + r() * 0.45);
      g.strokeStyle = css([226, 214, 196]);
      g.lineWidth = Math.max(1.5, w * 0.012);
      g.beginPath();
      g.moveTo(tx, ty);
      let cx = tx, cy = ty;
      for (let k = 1; k <= 4; k++) {
        cx += (r() - 0.5) * w * 0.03;
        cy -= th / 4;
        g.lineTo(cx, cy);
      }
      g.stroke();
      for (let k = 0; k < 9; k++) blob(cx + (r() - 0.5) * th * 0.5, cy + (r() - 0.3) * th * 0.35, th * (0.08 + r() * 0.1), th * (0.05 + r() * 0.07),
        jitter([78, 90, 52], r, 30), 0.85);
    }
    brushwork(r, x, y, w, h, (w * h) / 22, Math.max(2, w / 45));
  }

  // A portrait: a head and shoulders against a dark ground, lit from one side
  function portrait(r, x, y, w, h) {
    const ground = pick(r, ['#3a3328', '#2a2d2a', '#4a3f33', '#5b5446', '#2e2a36']);
    vgrad(x, y, w, h, [[0, mixc(hex(ground), [90, 80, 70], 0.3)], [1, hex(ground)]]);
    const skin = pick(r, ['#e8c4a4', '#d9a886', '#c08a62', '#8d5a3b', '#f0d2b8']);
    const coat = pick(r, ['#1d1c1e', '#2b2a3d', '#3b2b22', '#5a1f22', '#284032', '#6b6a70']);
    const hair = pick(r, ['#2a1d14', '#4a3020', '#8a6a3a', '#1a1a1a', '#b8a58a', '#6d3a22']);
    const cx = x + w * (0.45 + r() * 0.1), head = Math.min(w, h) * (0.17 + r() * 0.05);
    const hy = y + h * (0.33 + r() * 0.06);
    // shoulders and the coat
    g.fillStyle = css(hex(coat));
    g.beginPath();
    g.moveTo(x + w * 0.05, y + h);
    g.quadraticCurveTo(cx - head * 2.6, hy + head * 1.7, cx, hy + head * 1.45);
    g.quadraticCurveTo(cx + head * 2.6, hy + head * 1.7, x + w * 0.95, y + h);
    g.fill();
    if (r() < 0.6) {
      g.fillStyle = css([236, 232, 220]);
      g.beginPath();
      g.moveTo(cx - head * 0.6, hy + head * 1.35);
      g.lineTo(cx, hy + head * 2.0);
      g.lineTo(cx + head * 0.6, hy + head * 1.35);
      g.fill();
    }
    blob(cx, hy + head * 1.15, head * 0.42, head * 0.5, hex(skin));
    // the head, its shade on the far side
    blob(cx, hy, head * 0.78, head, hex(skin));
    blob(cx + head * 0.3, hy + head * 0.1, head * 0.5, head * 0.85, mixc(hex(skin), [60, 40, 30], 0.35), 0.45);
    // hair, or a hat
    if (r() < 0.2) {
      blob(cx, hy - head * 0.75, head * 1.3, head * 0.22, hex(coat));
      blob(cx, hy - head * 0.95, head * 0.75, head * 0.45, hex(coat));
    } else {
      g.fillStyle = css(hex(hair));
      g.beginPath();
      g.ellipse(cx, hy - head * 0.25, head * 0.86, head * 0.85, 0, Math.PI, Math.PI * 2);
      g.fill();
      if (r() < 0.5) blob(cx - head * 0.7, hy + head * 0.2, head * 0.22, head * 0.7, hex(hair));
      if (r() < 0.5) blob(cx + head * 0.7, hy + head * 0.2, head * 0.22, head * 0.7, hex(hair));
    }
    // eyes, brows, the nose's shade, the mouth
    for (const s of [-1, 1]) {
      blob(cx + s * head * 0.32, hy + head * 0.05, head * 0.12, head * 0.06, [245, 240, 232]);
      blob(cx + s * head * 0.32, hy + head * 0.05, head * 0.06, head * 0.06, [50, 38, 30]);
      blob(cx + s * head * 0.32, hy - head * 0.13, head * 0.17, head * 0.035, mixc(hex(hair), hex(skin), 0.3));
    }
    blob(cx + head * 0.05, hy + head * 0.35, head * 0.07, head * 0.2, mixc(hex(skin), [80, 50, 40], 0.3), 0.7);
    blob(cx, hy + head * 0.62, head * 0.22, head * 0.06, mixc(hex(skin), [150, 50, 50], 0.5));
    vignette(x, y, w, h, 0.45);
    brushwork(r, x, y, w, h, (w * h) / 26, Math.max(2, w / 50), 18);
  }

  // A still life: a table's edge, a cloth, a jug or a vase, fruit, on a dark ground
  function stillLife(r, x, y, w, h) {
    vgrad(x, y, w, h, [[0, hex(pick(r, ['#2c2620', '#3a3530', '#283028', '#43362c']))], [1, [20, 18, 16]]]);
    const table = y + h * (0.62 + r() * 0.1);
    vgrad(x, table, w, y + h - table, [[0, hex(pick(r, ['#6b4426', '#5a3a22', '#7a5a3a']))], [1, [30, 20, 14]]]);
    // light from the left over the dark ground
    const gl = g.createRadialGradient(x + w * 0.2, y + h * 0.3, 0, x + w * 0.2, y + h * 0.3, w * 0.8);
    gl.addColorStop(0, 'rgba(255,235,200,0.18)');
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gl;
    g.fillRect(x, y, w, h);
    // the cloth, over the table's edge, in folds
    if (r() < 0.75) {
      const c0 = x + w * (0.05 + r() * 0.35), c1 = c0 + w * (0.25 + r() * 0.3);
      const cloth = hex(pick(r, ['#d8d2c2', '#c9c3b4', '#b8a88a', '#7a2a2a', '#3a4a6a']));
      g.fillStyle = css(cloth);
      g.beginPath();
      g.moveTo(c0, table - h * 0.01);
      g.lineTo(c1, table - h * 0.01);
      g.quadraticCurveTo(c1 + w * 0.03, table + (y + h - table) * 0.5, c1 - w * 0.02, y + h);
      g.lineTo(c0 + w * 0.03, y + h);
      g.quadraticCurveTo(c0 - w * 0.02, table + (y + h - table) * 0.5, c0, table - h * 0.01);
      g.fill();
      g.lineWidth = Math.max(1, w * 0.006);
      for (let i = 0; i < 5; i++) {
        const fx = c0 + (c1 - c0) * (0.15 + r() * 0.7);
        g.strokeStyle = css(mixc(cloth, [30, 25, 20], 0.35), 0.6);
        g.beginPath();
        g.moveTo(fx, table);
        g.quadraticCurveTo(fx + (r() - 0.5) * w * 0.05, table + (y + h - table) * 0.5, fx + (r() - 0.5) * w * 0.04, y + h);
        g.stroke();
      }
    }
    // a vessel: a jug or a vase, its outline turned about its middle
    const vx = x + w * (0.25 + r() * 0.5), vh = h * (0.3 + r() * 0.2), vw = w * (0.08 + r() * 0.08);
    const glaze = hex(pick(r, ['#d9d4c4', '#3a5a7a', '#8a3a2a', '#c9a24a', '#5a7a5a', '#e8e2d0']));
    g.fillStyle = css(glaze);
    g.beginPath();
    g.moveTo(vx - vw * 0.5, table);
    g.bezierCurveTo(vx - vw * 1.3, table - vh * 0.4, vx - vw * 0.4, table - vh * 0.8, vx - vw * 0.35, table - vh);
    g.lineTo(vx + vw * 0.35, table - vh);
    g.bezierCurveTo(vx + vw * 0.4, table - vh * 0.8, vx + vw * 1.3, table - vh * 0.4, vx + vw * 0.5, table);
    g.fill();
    blob(vx - vw * 0.4, table - vh * 0.45, vw * 0.12, vh * 0.15, [255, 255, 250], 0.35);
    if (r() < 0.5) {
      // flowers in it
      for (let i = 0; i < 14; i++) blob(vx + (r() - 0.5) * vw * 3.5, table - vh - r() * vh * 0.6, vw * 0.3, vw * 0.3, hex(pick(r, ['#c23a3a', '#e8d24a', '#f0f0e8', '#d87aa0', '#e08a2a'])));
      for (let i = 0; i < 10; i++) blob(vx + (r() - 0.5) * vw * 3, table - vh - r() * vh * 0.5, vw * 0.25, vw * 0.12, [60, 90, 50], 0.8, r() * 3);
    }
    // fruit along the cloth
    const fruit = 3 + Math.floor(r() * 5);
    for (let i = 0; i < fruit; i++) {
      const fx = x + w * (0.12 + r() * 0.76), fr = Math.min(w, h) * (0.035 + r() * 0.03);
      const c = hex(pick(r, ['#c8352a', '#e2c23a', '#8aa63a', '#d9772a', '#6a2a4a', '#e8d27a']));
      blob(fx, table + fr * 0.3, fr, fr, c);
      blob(fx + fr * 0.3, table + fr * 0.5, fr * 0.7, fr * 0.6, mixc(c, [20, 10, 10], 0.4), 0.4);
      blob(fx - fr * 0.35, table - fr * 0.2, fr * 0.25, fr * 0.2, [255, 255, 245], 0.6);
    }
    vignette(x, y, w, h, 0.35);
    brushwork(r, x, y, w, h, (w * h) / 28, Math.max(2, w / 50), 20);
  }

  // Abstracts of the century: a colour field, a grid, gestures, circles, stripes
  function abstract(r, x, y, w, h) {
    const palettes = [['#c0392b', '#e8c547', '#1f3a93', '#f2efe6', '#111111'], ['#2d3047', '#e0a458', '#93b7be', '#f1dabf', '#7c3626'],
      ['#3d0c11', '#d72638', '#f49d37', '#140f2d', '#3f88c5'], ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
      ['#1b1b1e', '#d8d4cc', '#8a8580', '#c2410c', '#4a5d6b']];
    const p = pick(r, palettes).map(hex);
    const kind = Math.floor(r() * 5);
    if (kind === 0) {
      g.fillStyle = css(p[0]);
      g.fillRect(x, y, w, h);
      const n = 2 + Math.floor(r() * 2);
      for (let i = 0; i < n; i++) {
        const top = y + h * (0.06 + i * (0.88 / n)), bh = h * (0.88 / n) * 0.86;
        g.fillStyle = css(p[1 + ((i + Math.floor(r() * 3)) % 4)], 0.9);
        g.fillRect(x + w * 0.08, top, w * 0.84, bh);
      }
      brushwork(r, x, y, w, h, (w * h) / 14, Math.max(3, w / 18), 18, 0.15);
    } else if (kind === 1) {
      g.fillStyle = css([242, 239, 230]);
      g.fillRect(x, y, w, h);
      const cols = [0, ...Array.from({ length: 2 + Math.floor(r() * 3) }, () => r()).sort(), 1];
      const rows = [0, ...Array.from({ length: 2 + Math.floor(r() * 3) }, () => r()).sort(), 1];
      for (let i = 0; i + 1 < cols.length; i++) {
        for (let j = 0; j + 1 < rows.length; j++) {
          if (r() < 0.3) {
            g.fillStyle = css(pick(r, [p[0], p[1], p[2]]));
            g.fillRect(x + cols[i] * w, y + rows[j] * h, (cols[i + 1] - cols[i]) * w, (rows[j + 1] - rows[j]) * h);
          }
        }
      }
      g.fillStyle = '#111';
      const t = Math.max(2, Math.min(w, h) * 0.025);
      for (const c of cols.slice(1, -1)) g.fillRect(x + c * w - t / 2, y, t, h);
      for (const c of rows.slice(1, -1)) g.fillRect(x, y + c * h - t / 2, w, t);
    } else if (kind === 2) {
      g.fillStyle = css(p[3]);
      g.fillRect(x, y, w, h);
      g.lineCap = 'round';
      for (let i = 0; i < 60 + r() * 80; i++) {
        g.strokeStyle = css(pick(r, p), 0.5 + r() * 0.5);
        g.lineWidth = Math.max(1, Math.min(w, h) * (0.005 + r() * 0.04));
        g.beginPath();
        let px = x + r() * w, py = y + r() * h;
        g.moveTo(px, py);
        for (let k = 0; k < 3; k++) {
          const nx = px + (r() - 0.5) * w * 0.5, ny = py + (r() - 0.5) * h * 0.5;
          g.quadraticCurveTo(px + (r() - 0.5) * w * 0.3, py + (r() - 0.5) * h * 0.3, nx, ny);
          px = nx;
          py = ny;
        }
        g.stroke();
      }
    } else if (kind === 3) {
      g.fillStyle = css(p[4]);
      g.fillRect(x, y, w, h);
      const n = 3 + Math.floor(r() * 5), cx = x + w / 2, cy = y + h / 2, R = Math.min(w, h) * 0.45;
      for (let i = 0; i < n; i++) blob(cx, cy, R * (1 - i / n), R * (1 - i / n), p[i % 4]);
    } else {
      let at = x;
      while (at < x + w) {
        const sw = w * (0.03 + r() * 0.12);
        g.fillStyle = css(pick(r, p));
        g.fillRect(at, y, sw + 1, h);
        at += sw;
      }
      brushwork(r, x, y, w, h, (w * h) / 30, Math.max(2, w / 40), 12, 0.12);
    }
  }

  // A hanging scroll: mountains in ink wash through mist, pines, an inscription and a seal, on silk in a brocade mount
  function ink(r, x, y, w, h) {
    const mount = hex(pick(r, ['#3a4a5a', '#5a3a2a', '#2f4a3a', '#6a5a3a']));
    g.fillStyle = css(mount);
    g.fillRect(x, y, w, h);
    const ix = x + w * 0.07, iy = y + h * 0.16, iw = w * 0.86, ih = h * 0.72;
    vgrad(ix, iy, iw, ih, [[0, [226, 214, 186]], [1, [212, 198, 168]]]);
    for (let l = 0; l < 3; l++) {
      const c = 150 - l * 45;
      const base = iy + ih * (0.45 + l * 0.18);
      g.fillStyle = css([c, c - 4, c - 10], 0.75);
      g.beginPath();
      g.moveTo(ix, iy + ih);
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        const peak = Math.exp(-((u - (0.3 + r() * 0.05 + l * 0.2)) ** 2) * 18);
        g.lineTo(ix + u * iw, base - peak * ih * (0.25 + 0.1 * (2 - l)) - r() * ih * 0.02);
      }
      g.lineTo(ix + iw, iy + ih);
      g.fill();
      // mist across its foot
      const gr = g.createLinearGradient(0, base - ih * 0.05, 0, base + ih * 0.08);
      gr.addColorStop(0, 'rgba(230,220,196,0)');
      gr.addColorStop(1, 'rgba(230,220,196,0.85)');
      g.fillStyle = gr;
      g.fillRect(ix, base - ih * 0.05, iw, ih * 0.13);
    }
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const px = ix + iw * r(), py = iy + ih * (0.7 + r() * 0.25);
      g.strokeStyle = css([40, 38, 32], 0.8);
      g.lineWidth = Math.max(1, iw * 0.012);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + (r() - 0.5) * iw * 0.03, py - ih * 0.1);
      g.stroke();
      for (let k = 0; k < 5; k++) blob(px + (r() - 0.5) * iw * 0.08, py - ih * (0.04 + r() * 0.07), iw * 0.04, ih * 0.008, [36, 44, 34], 0.8);
    }
    for (let i = 0; i < 18; i++) blob(ix + iw * 0.85, iy + ih * (0.05 + i * 0.02), iw * 0.012, ih * 0.006, [30, 28, 24], 0.85);
    g.fillStyle = css([176, 40, 32]);
    g.fillRect(ix + iw * 0.8, iy + ih * 0.45, iw * 0.06, iw * 0.06);
    brushwork(r, ix, iy, iw, ih, (iw * ih) / 40, Math.max(2, iw / 40), 10, 0.12);
  }

  // A desert painting in the manner of the Western Desert's: on a dark ground, concentric circles and the lines between them in dots of
  // ochre, white, red and yellow, fields of dots between
  function desert(r, x, y, w, h) {
    const pal = pick(r, [['#2a1a12', '#c8642c', '#e9e0cf', '#d9a637', '#8c2a1e'], ['#1c1714', '#e2d6bf', '#b5451b', '#e0b84a', '#6e7b4a'],
      ['#3a2216', '#f0e6d0', '#d27a35', '#a8321e', '#e8c766']]).map(hex);
    g.fillStyle = css(pal[0]);
    g.fillRect(x, y, w, h);
    const d = Math.max(1.2, Math.min(w, h) / 70);
    const dot = (px, py, c, s = d) => blob(px, py, s, s, jitter(c, r, 30), 0.95);
    // a field of dots in rows, each row its own colour
    for (let row = 0, py = y + d * 1.5; py < y + h; row++, py += d * 2.6) {
      const c = pal[1 + ((row + Math.floor(r() * 2)) % 4)];
      for (let px = x + d * 1.5 + (row % 2) * d * 1.3; px < x + w; px += d * 2.6) if (r() < 0.55) dot(px, py, c, d * 0.8);
    }
    // the places: concentric circles of dots, and the tracks between them
    const n = 2 + Math.floor(r() * 5);
    const sites = Array.from({ length: n }, () => [x + w * (0.15 + r() * 0.7), y + h * (0.15 + r() * 0.7), Math.min(w, h) * (0.06 + r() * 0.1)]);
    for (let i = 0; i + 1 < sites.length; i++) {
      const [ax, ay] = sites[i], [bx, by] = sites[i + 1];
      const L = Math.hypot(bx - ax, by - ay), c = pal[1 + Math.floor(r() * 4)];
      for (let t = 0; t < L; t += d * 2.4) for (const off of [-d * 1.3, d * 1.3]) {
        dot(ax + ((bx - ax) * t) / L - ((by - ay) / L) * off, ay + ((by - ay) * t) / L + ((bx - ax) / L) * off, c);
      }
    }
    for (const [cx, cy, R] of sites) {
      g.fillStyle = css(pal[0]);
      g.beginPath();
      g.arc(cx, cy, R * 1.1, 0, Math.PI * 2);
      g.fill();
      for (let k = 0, rr = R; rr > d; k++, rr -= d * 2.4) {
        const c = pal[1 + ((k + Math.floor(r() * 4)) % 4)];
        const m = Math.max(6, Math.floor((2 * Math.PI * rr) / (d * 2.5)));
        for (let j = 0; j < m; j++) dot(cx + rr * Math.cos((j / m) * Math.PI * 2), cy + rr * Math.sin((j / m) * Math.PI * 2), c);
      }
    }
  }

  // A bark painting in the manner of Arnhem Land's: on bark's dark red-brown, a panel or two of fine cross-hatching in ochres and
  // white, and a figure (a fish, a turtle, a kangaroo) filled with it
  function bark(r, x, y, w, h) {
    const ground = jitter(hex('#5a2e1c'), r, 30);
    g.fillStyle = css(ground);
    g.fillRect(x, y, w, h);
    const pal = [hex('#e9e2d2'), hex('#c9942f'), hex('#a3381f'), hex('#1e1a17')];
    const hatch = (px, py, pw, ph, ang, cols) => {
      g.save();
      g.beginPath();
      g.rect(px, py, pw, ph);
      g.clip();
      const step = Math.max(1.5, Math.min(w, h) / 60);
      g.lineWidth = Math.max(0.6, step * 0.35);
      for (let k = -ph - pw; k < pw + ph; k += step) {
        g.strokeStyle = css(cols[Math.floor(Math.abs(k / step)) % cols.length], 0.9);
        g.beginPath();
        g.moveTo(px + k, py);
        g.lineTo(px + k + Math.tan(ang) * ph, py + ph);
        g.stroke();
      }
      g.restore();
    };
    // a border of white, panels of hatching
    g.strokeStyle = css(pal[0]);
    g.lineWidth = Math.max(1, w * 0.02);
    g.strokeRect(x + w * 0.04, y + h * 0.03, w * 0.92, h * 0.94);
    const panels = 1 + Math.floor(r() * 3);
    for (let i = 0; i < panels; i++) {
      const py = y + h * (0.06 + (0.88 * i) / panels), ph = (h * 0.88) / panels - h * 0.02;
      hatch(x + w * 0.08, py, w * 0.84, ph, r() < 0.5 ? 0.6 : -0.6, r() < 0.5 ? [pal[0], pal[2]] : [pal[1], pal[0], pal[3]]);
      // a figure over it: a long body, its head and its tail, filled with its own hatching, outlined in white
      const cx = x + w / 2, cy = py + ph / 2, bw = w * 0.32, bh = ph * 0.36;
      g.fillStyle = css(ground);
      g.beginPath();
      g.ellipse(cx, cy, bw, bh, r() * 0.6 - 0.3, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.beginPath();
      g.ellipse(cx, cy, bw * 0.92, bh * 0.85, 0, 0, Math.PI * 2);
      g.clip();
      hatch(cx - bw, cy - bh, bw * 2, bh * 2, 1.0, [pal[0], pal[1]]);
      g.restore();
      g.strokeStyle = css(pal[0]);
      g.lineWidth = Math.max(1, w * 0.012);
      g.beginPath();
      g.ellipse(cx, cy, bw, bh, 0, 0, Math.PI * 2);
      g.moveTo(cx + bw, cy);
      g.lineTo(cx + bw * 1.35, cy - bh * 0.5);
      g.lineTo(cx + bw * 1.35, cy + bh * 0.5);
      g.closePath();
      g.stroke();
    }
    brushwork(r, x, y, w, h, (w * h) / 60, Math.max(2, w / 50), 14, 0.1);
  }

  function label(item) {
    const { x, y, w, h } = item;
    g.fillStyle = '#f4f2ec';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#1e1e1e';
    g.textBaseline = 'top';
    const fit = (text, font, size, ty) => {
      let s = size;
      do {
        g.font = `${font} ${s}px Georgia, 'Times New Roman', serif`;
        s -= 1;
      } while (g.measureText(text).width > w * 0.9 && s > 6);
      g.fillText(text, x + w * 0.05, y + ty);
    };
    fit(item.artist ?? '', 'bold', Math.round(h * 0.22), h * 0.1);
    fit(item.title ?? '', 'italic', Math.round(h * 0.2), h * 0.42);
    fit(String(item.year ?? ''), '', Math.round(h * 0.18), h * 0.7);
  }

  const painters = { landscape, portrait, 'still-life': stillLife, abstract, ink, desert, bark };
  for (const item of items) {
    g.save();
    g.beginPath();
    g.rect(item.x, item.y, item.w, item.h);
    g.clip();
    if (item.kind === 'label') label(item);
    else (painters[item.kind] ?? abstract)(rng(item.seed), item.x, item.y, item.w, item.h);
    g.restore();
  }
  return canvas;
}

export { paintAtlas };
