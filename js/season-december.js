import { createChristmasHouses } from './christmas-houses.js';

// December, 1-26 December (js/seasons.js): Christmas. The houses near you have their lights and decorations, a few on most streets and
// almost every house on the streets known for them (js/christmas.js, js/christmas-houses.js).
//
// Each of December's things is a feature: { *work(x, z), update(dt, elapsed), state(), debug(command), stop() }, run in turn, the first
// with work to do taking the step. start() does nothing heavy: the houses' shaders are compiled only once there's a decorated house near
// you to draw (a compile is 50-70 ms on a phone, in one piece), and most of the city's start has none.

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
    work: (x, z) => houses.work(x, z),
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
  const features = [housesFeature(ctx)];
  return {
    update(dt, elapsed) {
      for (const f of features) f.update?.(dt, elapsed);
    },
    *work(x, z) {
      if (ctx.flying()) return false;
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
    }
  };
}

export { start };
