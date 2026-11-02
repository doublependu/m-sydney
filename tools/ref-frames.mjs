// Saves a frame of each reference video every 10 s, to ref/frames/<video>/<seconds>.jpg, with ref/frames/index.json.
// ref/ isn't committed, and nothing from it ships. usage: node tools/ref-frames.mjs [--every=10] [--width=1920] [--jobs=6]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REF = join(ROOT, 'ref');
const option = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const every = option('every', 10), width = option('width', 1920), jobs = option('jobs', 6);

const SHORT = { 'Driving Around The City': 'drive-city', 'Driving across the Sydney Harbour Bridge': 'drive-bridge', 'Martin Place to Circular Quay': 'walk-martin-place', 'walking tour Hyde Park': 'walk-hyde-park', 'Royal Botanic Garden': 'walk-botanic-garden' };
const nameOf = (file) => Object.entries(SHORT).find(([key]) => file.includes(key))?.[1] ?? file.replace(/\W+/g, '-').toLowerCase();

const index = {};
const tasks = [];
for (const file of readdirSync(REF).filter((f) => f.endsWith('.webm')).sort()) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(REF, file)], { encoding: 'utf8' });
  const duration = Number(probe.stdout);
  const name = nameOf(file);
  mkdirSync(join(REF, 'frames', name), { recursive: true });
  index[name] = { file, duration, every, frames: [] };
  for (let t = 5; t < duration; t += every) {
    const out = join(REF, 'frames', name, `${String(t).padStart(5, '0')}.jpg`);
    index[name].frames.push(t);
    if (!existsSync(out)) tasks.push({ t, file: join(REF, file), out });
  }
}
console.log(`${tasks.length} frames to save`);

let done = 0;
const worker = async () => {
  for (let task = tasks.shift(); task; task = tasks.shift()) {
    await new Promise((resolve) => {
      spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(task.t), '-i', task.file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', task.out], { stdio: 'inherit' })
        .on('close', resolve);
    });
    if (++done % 50 === 0) console.log(`${done} saved, ${tasks.length} to go`);
  }
};
await Promise.all(Array.from({ length: jobs }, worker));
writeFileSync(join(REF, 'frames', 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
console.log('ref/frames/index.json written');
