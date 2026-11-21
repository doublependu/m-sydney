import * as THREE from 'three/webgpu';
import { createCarpetMaterial, createCarpets, flowerTexture, flowerTextureSteps } from './jacaranda-carpets.js';
import { CARDS, createCarPetals, restingSpotsSteps } from './car-petals.js';

// November (js/seasons.js): the jacarandas in flower drop carpets of it under their crowns near you (js/jacaranda-carpets.js), and your car
// starts the day with flowers on it, which blow off as you drive (js/car-petals.js).
//
// start() does nothing heavy: where the flowers lie on the car and their shader are made in work()'s steps, a few milliseconds a frame as
// the world's jobs have room. Made between frames as fast as they'd go, they cost the phone a tenth of its frames for the first five
// seconds after the city completed. The carpets' texture and shader are made only once there's a carpet near you to draw: a compile is
// 50-70 ms on a phone, the texture longer, and most places have no jacaranda near.


function start(ctx) {
  const { quality, player, origin } = ctx;
  const heightAt = ctx.ground.top;
  const car = player.entities.car;
  let carpets = null, petals = null, map = null, stage = null, carpetStage = null, ready = false;

  function* setUp() {
    carpets = createCarpets({
      level: quality.level,
      reach: () => quality.houseDetail,
      trees: (x, z, r) => ctx.treeField()?.treesNear?.(x, z, r, 'jacaranda') ?? [],
      heightAt,
      prepare: ctx.ground.prepare,
      squares: () => [...(ctx.lots()?.squares ?? [])].map(([key, entry]) => ({ key, ...entry.square })),
      origin
    });
    // Under a jacaranda's crown: one of those with a carpet near you
    const under = (x, z) => carpets.carpets().some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (t.crown * 0.9) ** 2);
    const body = car.chassisPivot.children.find((o) => o.isMesh && o.geometry?.attributes?.partId)?.geometry;
    const spots = body ? yield* restingSpotsSteps(body, CARDS[quality.level] ?? CARDS.high) : null;
    yield;
    petals = spots ? createCarPetals({ car, spots, heightAt, under, origin }) : null;
    yield;

    // Compiled before it's shown: one card on the car, the flowers in the air all spent
    stage = new THREE.Group();
    stage.name = 'November';
    if (petals) {
      stage.add(petals.group);
      stage.add(petals.cards);
      petals.cards.count = 1;
      petals.cards.visible = true;
      petals.flying.visible = true;
    }
    // Written from the origin, as the lots are (js/lot-details.js): anchored before it's revealed and again after
    ctx.anchor(stage);
    yield ctx.reveal(stage);
    ctx.anchor(stage);
    stage.updateMatrixWorld(true);
    if (petals) {
      car.chassisPivot.add(petals.cards);
      petals.cards.updateMatrixWorld(true);
      // As it stood overnight: unless it's been driven off already, while the city was still coming in
      petals.setLoad(Math.abs(car.speed || 0) < 2.8 ? 1 : 0);
    }
    ready = true;
  }
  let setting = null;
  const setup = { ms: 0, steps: 0, longest: 0 }; // what setting up took, a step at a time

  // The carpets' texture and material, and their mesh into the scene, its shaders compiled with the first carpet's first triangle
  function* showCarpets() {
    map = flowerTexture(yield* flowerTextureSteps());
    carpets.setMaterial(createCarpetMaterial(map));
    carpets.mesh.userData.ownMaterial = true; // let go of with the stage
    carpetStage = new THREE.Group();
    carpetStage.name = 'Jacarandas';
    carpetStage.add(carpets.mesh);
    carpets.mesh.geometry.setDrawRange(0, 3);
    carpets.mesh.visible = true;
    ctx.anchor(carpetStage);
    yield ctx.reveal(carpetStage);
    ctx.anchor(carpetStage);
    carpetStage.updateMatrixWorld(true);
    carpets.refill();
  }

  return {
    update(dt, elapsed) {
      if (ready) petals?.update(dt, elapsed);
    },
    *work(x, z) {
      if (!ready) {
        setting ??= setUp();
        for (;;) {
          const began = performance.now();
          const { value, done } = setting.next();
          const ms = performance.now() - began;
          setup.ms += ms;
          setup.steps++;
          setup.longest = Math.max(setup.longest, ms);
          if (done) break;
          yield value;
        }
        return true;
      }
      if (ctx.flying()) return false;
      if (!carpetStage && carpets.carpets().length) {
        yield* showCarpets();
        return true;
      }
      return yield* carpets.work(x, z);
    },
    state: () => ({ ready, setup: { ms: Math.round(setup.ms), steps: setup.steps, longest: Math.round(setup.longest) },
      carpets: carpets?.state() ?? null, petals: petals?.state() ?? null }),
    // For the scripts: { load } puts that much on the car; { census: r } counts the jacarandas the tree field holds within r of you, by
    // 100 m square, the most first
    debug(command = {}) {
      if (command.load !== undefined) petals?.setLoad(command.load);
      if (command.census) {
        const { x, z } = player.getActiveEntity().position;
        const all = ctx.treeField()?.treesNear?.(x, z, command.census, 'jacaranda') ?? [];
        const squares = new Map();
        for (const t of all) {
          const key = `${Math.floor(t.x / 100) * 100},${Math.floor(t.z / 100) * 100}`;
          squares.set(key, (squares.get(key) || 0) + 1);
        }
        return { total: all.length, squares: [...squares].sort((a, b) => b[1] - a[1]).slice(0, 20) };
      }
      return { carpets: carpets?.state() ?? null, petals: petals?.state() ?? null,
        trees: (carpets?.carpets() ?? []).map((t) => ({ x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 100) / 100, z: Math.round(t.z * 10) / 10, crown: Math.round(t.crown * 10) / 10 })) };
    },
    stop() {
      petals?.clear();
      carpets?.clear();
      if (stage) ctx.remove(stage);
      if (carpetStage) ctx.remove(carpetStage);
      map?.dispose();
    }
  };
}

export { start };
