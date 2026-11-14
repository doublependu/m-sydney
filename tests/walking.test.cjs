// Walking in first person: A and D step aside, the mouse turns you, the arrows still turn; in the chase camera A and D turn, as before
const assert = require('node:assert/strict');
const test = require('node:test');
const { keyboardHarness } = require('./helpers/controllers.cjs');

function walker({ firstPerson = false, indoors = false } = {}) {
  const harness = keyboardHarness();
  const { controller } = harness;
  const person = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0, verticalVel: 0 };
  controller.entities = { person };
  controller.activeMode = 'person';
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.indoors = indoors;
  controller.setFirstPerson?.(firstPerson);
  return {
    ...harness,
    person,
    walk(seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) controller.updatePerson(1 / 60);
    }
  };
}

const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) < tolerance, `${what}: ${actual} against ${expected}`);

test('in first person, A steps you to your left at 0.65 of the walk, facing the same way', () => {
  const w = walker({ firstPerson: true });
  w.key('keydown', 'KeyA');
  w.walk(1);
  const at = { x: w.person.position.x, z: w.person.position.z };
  w.walk(1);
  // Heading 0 faces +z; your left is +x
  near(w.person.heading, 0, 1e-9, 'heading');
  near(w.person.position.x - at.x, 1.5 * 0.65, 0.01, 'a second to the left');
  near(w.person.position.z - at.z, 0, 1e-9, 'none forward');
  w.key('keyup', 'KeyA');
  w.key('keydown', 'KeyD');
  w.walk(2);
  const back = { x: w.person.position.x };
  w.walk(1);
  near(w.person.position.x - back.x, -1.5 * 0.65, 0.01, 'D: a second to the right');
});

test('in first person, W with A goes at the walk, not faster', () => {
  const w = walker({ firstPerson: true });
  w.key('keydown', 'KeyW');
  w.key('keydown', 'KeyA');
  w.walk(1);
  const at = { x: w.person.position.x, z: w.person.position.z };
  w.walk(1);
  const dx = w.person.position.x - at.x, dz = w.person.position.z - at.z;
  near(Math.hypot(dx, dz), 1.5, 0.01, 'a second of walking');
  assert.ok(dx > 0.3 && dz > 0.3, `forward and to the left: ${dx.toFixed(2)}, ${dz.toFixed(2)}`);
  near(w.person.heading, 0, 1e-9, 'heading');
});

test('in first person, a look turns you by as much, at the next step', () => {
  const w = walker({ firstPerson: true });
  w.controller.look(0.5);
  w.walk(1 / 60);
  near(w.person.heading, -0.5, 1e-9, 'half a radian to the right');
  w.controller.look(-0.2);
  w.walk(1 / 60);
  near(w.person.heading, -0.3, 1e-9, 'and back to the left');
  // Out of first person, a look doesn't turn you, and one left over isn't kept for later
  w.controller.look(0.4);
  w.controller.setFirstPerson(false);
  w.walk(1 / 60);
  w.controller.setFirstPerson(true);
  w.walk(1 / 60);
  near(w.person.heading, -0.3, 1e-9, 'a look out of first person');
});

test('in first person, the view is where you go: no turning to a dragged camera', () => {
  const w = walker({ firstPerson: true });
  w.controller.viewOffset = 1;
  w.key('keydown', 'KeyW');
  w.walk(1);
  near(w.person.heading, 0, 1e-9, 'heading');
  assert.equal(!!w.person.followingView, false);
});

test('in the chase camera, A and D turn you, as before', () => {
  const w = walker();
  w.key('keydown', 'KeyA');
  w.walk(1);
  near(w.person.heading, 2.6, 0.02, 'a second of A');
  near(Math.hypot(w.person.position.x, w.person.position.z), 0, 1e-9, 'standing');
});

for (const firstPerson of [false, true]) {
  test(`the left arrow turns you at the walk's rate, outside and in${firstPerson ? ', in first person' : ''}`, () => {
    for (const [indoors, rate] of [[false, 2.6], [true, 1.6]]) {
      const w = walker({ firstPerson, indoors });
      w.key('keydown', 'ArrowLeft');
      w.walk(1);
      near(w.person.heading, rate, 0.02, `${indoors ? 'inside' : 'outside'}: a second of the arrow`);
    }
  });
}

test('A held as the camera changes moves from turning to stepping aside, and back', () => {
  const w = walker();
  w.key('keydown', 'KeyA');
  assert.equal(w.controller.keys.left, true);
  w.controller.setFirstPerson(true);
  assert.equal(w.controller.keys.left, false);
  assert.equal(w.controller.keys.sideLeft, true);
  w.controller.setFirstPerson(false);
  assert.equal(w.controller.keys.left, true);
  assert.equal(w.controller.keys.sideLeft, false);
  w.key('keyup', 'KeyA');
  assert.equal(w.controller.keys.left, false);
});

test("in first person, the touch stick's sideways steps you aside, and in chase it turns you", () => {
  const w = walker({ firstPerson: true });
  w.controller.setTouchInput('left', 1);
  assert.equal(w.controller.keys.sideLeft, 1);
  assert.equal(w.controller.keys.left, false);
  w.controller.setFirstPerson(false);
  assert.equal(w.controller.keys.left, 1);
  assert.equal(w.controller.keys.sideLeft, false);
  w.controller.setGamepadInput('right', 0.5);
  w.controller.setFirstPerson(true);
  assert.equal(w.controller.keys.sideRight, 0.5);
  assert.equal(w.controller.keys.right, false);
});

test('seated, stepping aside stands you up, and a look turns your view', () => {
  const w = walker({ firstPerson: true });
  w.controller.standUp = function () {
    this.entities.person.seat = null;
    return true;
  };
  w.person.seat = { x: 0, z: 0, heading: 0, seatY: 0.45, stand: { x: 0, z: 0.5 } };
  w.controller.look(0.3);
  w.walk(1 / 60);
  assert.ok(w.person.seat, 'still seated');
  near(w.person.heading, -0.3, 1e-9, 'looking round');
  w.key('keydown', 'KeyD');
  w.walk(1 / 60);
  assert.equal(w.person.seat, null, 'up');
});
