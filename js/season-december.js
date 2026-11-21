import { createChristmasHouses } from './christmas-houses.js';
import { disposeChristmasMaterials } from './christmas-materials.js';
import { CITY_TREES, clearingOf, createCityTrees } from './christmas-trees.js';

// December, 1-26 December (js/seasons.js): Christmas.
// - The city's big trees: Martin Place's, the one afloat on Darling Harbour, and five more, drawn whole near you and as a glow far off
//   (js/christmas-trees.js).
// - The houses near you have their lights and decorations, a few on most streets and almost every house on the streets known for them
//   (js/christmas.js, js/christmas-houses.js).
//
// Each of December's things is a feature: { *work(x, z), update(dt, elapsed), state(), debug(command), stop() }, run in turn, the first
// with work to do taking the step. start() does nothing heavy: the shaders are compiled only once there's something near you to draw (a
// compile is 50-70 ms on a phone, in one piece), and the trees and the houses share them (js/christmas-materials.js).

function treesFeature(ctx) {
  const { quality, origin, player } = ctx;
  const trees = createCityTrees({
    level: quality.level,
    reach: () => quality.buildingDetail,
    far: () => quality.farRange,
    env: { ground: ctx.ground.top, prepare: ctx.ground.prepare, glow: ctx.glow, water: ctx.water },
    origin,
    reveal: ctx.reveal,
    anchor: ctx.anchor,
    clear: ctx.clear,
    colliders: ctx.colliders
  });
  const here = () => player.getActiveEntity().position;
  return {
    name: 'trees',
    // Seen from the air too: they're made while flying
    work: (x, z) => trees.work(x, z),
    update: (dt, elapsed) => trees.update(elapsed),
    state: () => trees.state(here().x, here().z),
    // { trees: true }: each tree, how far it is and where its plinth was laid; { clearings: true }: the street trees standing in each
    // one's clearing, of those within reach; { treesShown }: the trees shown or hidden at once
    debug(command) {
      const { x, z } = here();
      if (command.treesShown !== undefined) {
        trees.group.visible = !!command.treesShown;
        return trees.group.visible;
      }
      if (command.trees) return trees.list(x, z);
      if (command.clearings) {
        return CITY_TREES.map((t) => ({ id: t.id, c: clearingOf(t) })).filter(({ c }) => c && Math.hypot(c.x - x, c.z - z) <= quality.buildingDetail)
          .map(({ id, c }) => ({ id, trees: ctx.treeField()?.treesNear?.(c.x, c.z, c.r).length ?? null }));
      }
      return null;
    },
    stop() {
      trees.stop();
      if (trees.shown()) ctx.remove(trees.group);
    }
  };
}

function housesFeature(ctx) {
  const { quality, origin, player } = ctx;
  const houses = createChristmasHouses({
    level: quality.level,
    reach: () => quality.houseDetail,
    squares: () => [...(ctx.lots()?.squares?.values() ?? [])],
    lotsPending: () => ctx.lots()?.treesState?.().pending ?? true,
    env: {
      ground: ctx.ground.top,
      look: ctx.houses.look,
      roofFrame: ctx.houses.roofFrame,
      entry: ctx.houses.entry,
      trees: (x, z, r) => ctx.treeField()?.treesNear?.(x, z, r) ?? [],
      glow: ctx.glow
    },
    prepare: ctx.ground.prepare,
    origin,
    reveal: ctx.reveal,
    anchor: ctx.anchor
  });
  const here = () => player.getActiveEntity().position;
  return {
    name: 'houses',
    // Nothing to do flying high: the lots aren't worked out up there
    *work(x, z) {
      if (ctx.flying()) return false;
      return yield* houses.work(x, z);
    },
    update: (dt, elapsed) => houses.update(elapsed),
    state: () => houses.state(),
    // { houses: r }: the decorated houses within r of you; { census: r }: each street's houses there and how many are decorated;
    // { shown }: the decorations shown or hidden at once, for measuring what they cost
    debug(command) {
      const { x, z } = here();
      if (command.shown !== undefined) {
        houses.group.visible = !!command.shown;
        return houses.group.visible;
      }
      if (command.houses) return houses.list(x, z, command.houses);
      if (command.census) return houses.census(x, z, command.census);
      return null;
    },
    stop() {
      houses.clear();
      if (houses.shown()) ctx.remove(houses.group);
    }
  };
}

function start(ctx) {
  const features = [treesFeature(ctx), housesFeature(ctx)];
  return {
    update(dt, elapsed) {
      for (const f of features) f.update?.(dt, elapsed);
    },
    *work(x, z) {
      for (const f of features) if (yield* f.work(x, z)) return true;
      return false;
    },
    state: () => ({ ready: true, ...Object.fromEntries(features.map((f) => [f.name, f.state()])) }),
    debug(command = {}) {
      for (const f of features) {
        const answer = f.debug?.(command);
        if (answer !== null && answer !== undefined) return answer;
      }
      return null;
    },
    stop() {
      for (const f of features) f.stop();
      disposeChristmasMaterials();
    }
  };
}

export { start };
