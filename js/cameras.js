import * as THREE from 'three/webgpu';
import { origin } from './world-origin.js';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   category: 'follow', fov: 68 },
  { id: 'quay',        name: 'Circular Quay',            category: 'scenic', fov: 52 },
  { id: 'macquarie',   name: "Mrs Macquarie's Chair",    category: 'scenic', fov: 46 },
  { id: 'observatory', name: 'Observatory Hill',         category: 'scenic', fov: 50 },
  { id: 'kirribilli',  name: 'Kirribilli',               category: 'scenic', fov: 44 },
  { id: 'milsons',     name: 'Milsons Point',            category: 'scenic', fov: 48 },
  { id: 'tower',       name: 'Sydney Tower',             category: 'scenic', fov: 52 },
  { id: 'george',      name: 'George Street',            category: 'scenic', fov: 56 },
  { id: 'drone',       name: 'Auto-Director Aerial',     category: 'scenic', fov: 50 }
];

// A preset's vertical FOV alone leaves a tall phone looking through a slot, so widen it to keep this much across.
const MIN_HORIZONTAL_FOV = 48;
// m the chase camera aims past what it follows, from right behind it and level; and how far it has to be dragged up to look
// down at it instead (rad of pitch past the default)
const CHASE_LEAD = 5.2;
const CHASE_LOOK_DOWN = 0.45;
const DEFAULT_PITCH = 0.09;

// The drag: rad of orbit, or in first person on foot of turn and look, for each pixel across and up or down
const DRAG_TURN = 0.0065;
const DRAG_TILT = 0.005;

// First person on foot (`firstPerson`): the mouse, locked to the game, turns the walker (js/controllers.js look()) and looks up and
// down by its own pitch, as far as LOOK_LIMIT. MOUSE_TURN is rad for each count of the mouse at the speed set to 1 (`mouseSpeed`,
// js/pause-menu.js); a single event's count is cut to MOUSE_SPIKE, as some browsers report a jump now and then.
const LOOK_LIMIT = 70 * Math.PI / 180;
const MOUSE_TURN = 0.002;
const MOUSE_SPIKE = 400;
// The eye, m: up from the feet standing, over the seat sitting, and ahead of the body's centre. With the near plane at 0.1 m
// (js/main.js), the view stays inside the walker's 0.22 m round, so it never reaches through a wall you're up against.
const STANDING_EYE = 1.68;
const SEATED_EYE = 0.75;
const EYE_AHEAD = 0.1;
// s from where a follow camera was into the eye, on a switch to first person on foot
const GLIDE = 0.3;
// The eye's height over a step (a kerb, a threshold, sitting down): eased back up or down at no more than STEP_RATE m/s, 2 cm in a
// frame at 60 fps. A height that moves faster than STEP_SPEED counts as a step, and so does the first STEP_DROP of a drop off an edge
// (down a kerb the walker falls); a jump, a slope or the rest of a fall it follows at once, and anything of STEP_MAX or more (a teleport).
const STEP_RATE = 1.2;
const STEP_SPEED = 2.5;
const STEP_MAX = 0.8;
const STEP_DROP = 0.5;

const wrapAngle = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
// The cameras that orbit round what they follow, and so the ones you can steer by (js/controllers.js, steerToView())
const ORBITING = new Set(['chase', 'pov']);

function fittedFov(verticalFov, aspect) {
  const radians = Math.PI / 180;
  const across = 2 * Math.atan(Math.tan((verticalFov * radians) / 2) * aspect) / radians;
  if (across >= MIN_HORIZONTAL_FOV) return verticalFov;
  return 2 * Math.atan(Math.tan((MIN_HORIZONTAL_FOV * radians) / 2) / aspect) / radians;
}

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.lookTarget = new THREE.Vector3();
    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = DEFAULT_PITCH;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;
    this.indoors = false; // set by js/main.js
    this.indoorPull = 0;
    this.lookPitch = 0; // rad up (+) or down that first person on foot looks
    this.mouseSpeed = 1; // times MOUSE_TURN, for the locked mouse (js/pause-menu.js)
    this.unlockedAt = -Infinity; // performance.now() when the pointer lock last ended, for the Esc that ended it (js/main.js)
    this.onLockChange = null; // (locked) => {}, set by js/main.js
    this._firstPerson = false;
    this.glide = null;
    this._eyeY = null;
    this._eyeLag = 0;
    this._eyeGrounded = true;
    this._drop = Infinity;

    this.fixedView = null;
    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      // In first person on foot, a click locks the mouse to the game, to look round with; until it's locked, a drag looks round
      if (e.button === 0 && e.pointerType === 'mouse' && this.firstPerson) this.lockPointer();
      if (this.pointerLocked) return;
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.pointerLocked) {
        // Locked: the mouse's own counts, which go on past the screen's edge
        if (!this.firstPerson) return;
        const spike = (v) => Math.max(-MOUSE_SPIKE, Math.min(MOUSE_SPIKE, Number(v) || 0));
        const turn = MOUSE_TURN * this.mouseSpeed;
        this.look(spike(e.movementX) * turn, -spike(e.movementY) * turn);
        return;
      }
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else if (this.firstPerson) {
        this.look(dx * DRAG_TURN, -dy * DRAG_TILT);
      } else {
        this.orbitYawOffset -= dx * DRAG_TURN;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * DRAG_TILT));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      const locked = this.pointerLocked;
      if (!locked) this.unlockedAt = performance.now();
      this.onLockChange?.(locked);
    });
  }

  /** On foot in the first-person camera: where the mouse looks round, and the controls change (js/controllers.js setFirstPerson()) */
  get firstPerson() {
    return this.activePresetId === 'pov' && this.controllerManager.getActiveEntity()?.type === 'person';
  }

  get pointerLocked() {
    return !!this.domElement && document.pointerLockElement === this.domElement;
  }

  // Raw input where the browser has it, so the system's mouse acceleration doesn't count; the plain lock where it doesn't (Linux's
  // Chrome refuses the raw one). Asked for on a click or a key press: browsers lock only on a gesture.
  lockPointer() {
    const canvas = this.domElement;
    if (!canvas?.requestPointerLock || this.pointerLocked) return;
    const plain = () => {
      try {
        canvas.requestPointerLock()?.catch?.(() => {});
      } catch { /* refused: a drag looks round instead */ }
    };
    let asked;
    try {
      asked = canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      plain();
      return;
    }
    asked?.catch?.((error) => {
      if (error?.name === 'NotSupportedError') plain();
    });
  }

  unlockPointer() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /**
   * Looks round in first person on foot: `dx` rad to the right, which turns the walker, and `dy` rad up, to LOOK_LIMIT. From the locked
   * mouse, a drag, the gamepad's right stick, and __gameDebug.look().
   */
  look(dx, dy) {
    if (!this.firstPerson) return;
    if (Number.isFinite(dy)) this.lookPitch = Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, this.lookPitch + dy));
    if (dx) this.controllerManager.look?.(dx);
  }

  // Into first person on foot, you face where the camera looked, level, and it glides from where it was into your eye (`glide`, from a
  // follow camera that was in place). Out of it, the chase camera starts behind you, where you looked. Called whenever the camera or the
  // mode may have changed; true in first person on foot.
  syncFirstPerson(glideFrom = null) {
    const on = this.firstPerson;
    if (on === this._firstPerson) return on;
    this._firstPerson = on;
    const entity = this.controllerManager.getActiveEntity();
    if (on && entity) entity.heading += this.orbitYawOffset;
    this.lookPitch = 0;
    this.orbitYawOffset = 0;
    if (!on) {
      this.orbitPitchOffset = DEFAULT_PITCH;
      this.unlockPointer();
    }
    this.glide = on && glideFrom ? { t: 0, from: glideFrom.pos, look: glideFrom.look } : null;
    this._eyeY = null;
    return on;
  }

  /** The glide into first person is mostly done: the body can go */
  get bodyHidden() {
    return this.firstPerson && (!this.glide || this.glide.t > GLIDE * 0.6);
  }

  /**
   * The eye's height in the world, in first person on foot, eased over a step: given where it would be (m, the world's heights), whether
   * the walker's on the ground and how fast it's going up (m/s), and dt. Returns where to draw it.
   */
  easeEye(y, grounded, vy, dt) {
    const last = this._eyeY, wasGrounded = this._eyeGrounded;
    this._eyeY = y;
    this._eyeGrounded = grounded;
    // (Gliding in from another camera, it's on its way down to the eye already)
    if (last === null || !(dt > 0) || this.glide) {
      this._eyeLag = 0;
      return y;
    }
    const rise = y - last;
    // Off the ground: off an edge, or a jump. A frame in the air, or landing, is part of the drop.
    if (!grounded && wasGrounded) this._drop = vy <= 0 ? 0 : Infinity;
    const offEdge = (!grounded || !wasGrounded) && rise < 0 && (this._drop -= rise) <= STEP_DROP;
    const step = offEdge || (grounded && wasGrounded && Math.abs(rise) > Math.max(0.03, STEP_SPEED * dt));
    if (Math.abs(rise) >= STEP_MAX) this._eyeLag = 0;
    else if (step) this._eyeLag = Math.max(-0.5, Math.min(0.5, this._eyeLag - rise));
    const lag = this._eyeLag;
    const back = Math.min(Math.abs(lag), STEP_RATE * dt, Math.max(0.3 * dt, Math.abs(lag) * (1 - Math.exp(-12 * dt))));
    this._eyeLag = lag - Math.sign(lag) * back;
    return y + this._eyeLag;
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // From a follow camera in place, first person glides in from where it was
    const from = this.initialized && !this.fixedView && this.getActivePreset().category === 'follow'
      ? { pos: this.currentPos.clone?.() ?? null, look: this.currentLookAt.clone?.() ?? null } : null;
    this.activePresetId = preset.id;
    this.camera.fov = fittedFov(preset.fov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
    this.syncFirstPerson(from?.pos && from.look ? from : null);
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    // In first person on foot, the right stick turns you and looks up and down
    if (this.firstPerson) {
      if (lookX || lookY) this.look(lookX * 2.0 * dt, -lookY * 1.25 * dt);
      return;
    }
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = DEFAULT_PITCH;
    this.lookPitch = 0;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  // A cut to wherever the followed thing now is, keeping the camera you've chosen
  snap() {
    this.initialized = false;
    this.followEntity = null;
    this._turnEntity = null;
  }

  // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination. On foot in first person, if
  // `keepFirstPerson`, it stays first person, looking level.
  resetForTeleport(keepFirstPerson = false) {
    const keep = keepFirstPerson && this.firstPerson;
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this._turnEntity = null;
    this.glide = null;
    this._eyeY = null;
    if (keep) this.initialized = false;
    else this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.fov = fittedFov(this.getActivePreset().fov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    // A view put somewhere by hand, for pictures (js/main.js, __gameDebug.view())
    if (this.fixedView) {
      this.currentPos.copy(this.fixedView.from);
      this.currentLookAt.copy(this.fixedView.to);
      this.camera.position.copy(this.currentPos);
      this.camera.lookAt(this.lookTarget.set(this.currentLookAt.x - origin.x, this.currentLookAt.y, this.currentLookAt.z - origin.z));
      return;
    }
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;
    // A mode switch can take you in or out of first person on foot as well as a camera switch
    const firstPerson = this.syncFirstPerson();

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    // Turning to where the camera looks (js/controllers.js): whatever you turned, the camera turns back, so it stays put while
    // you come round to it
    const turned = entity === this._turnEntity ? wrapAngle(entity.heading - this._turnHeading) : 0;
    this._turnEntity = entity;
    this._turnHeading = entity.heading;
    if (entity.followingView) this.orbitYawOffset -= turned;
    this.orbitYawOffset = wrapAngle(this.orbitYawOffset); // dragged round and round, it's still only so far round

    if (!this.isDragging && !entity.followingView && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        // Inside a building (js/interiors.js) it comes in closer, eased, as rooms are only a few metres across
        this.indoorPull += ((this.indoors ? 1 : 0) - this.indoorPull) * (1 - Math.exp(-dt * 3));
        const pull = 1 - 0.42 * this.indoorPull;
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01)) * pull;
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        // It aims past you the way it looks, not the way you face: from behind and level it looks ahead down the road, and
        // orbited round, or looking down from above, it looks at you. Aiming ahead of your heading put you off the side of the
        // screen at 90 degrees, and behind the camera at 180 when it was nearer to you than that point (walking, cycling);
        // aiming over your head put you below the screen when dragged up to look down.
        // Inside, it looks ahead level, at about its own height, over your head into the room, rather than up at the ceiling
        const lookUpBias = (entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55)) * (1 - this.indoorPull) + 0.55 * this.indoorPull;
        const behind = Math.max(0, Math.cos(this.orbitYawOffset));
        const level = Math.max(0, 1 - Math.max(0, this.orbitPitchOffset - DEFAULT_PITCH) / CHASE_LOOK_DOWN);
        const ahead = behind * level;
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * CHASE_LEAD * ahead,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias * ahead,
          entity.position.z + Math.cos(totalYaw) * CHASE_LEAD * ahead
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        if (firstPerson) {
          // On foot: the eye just ahead of the body's centre, looking the way you face, up or down by its own pitch
          const sin = Math.sin(entity.heading), cos = Math.cos(entity.heading);
          const eyeY = entity.seat ? entity.seat.seatY + SEATED_EYE : STANDING_EYE;
          const level = Math.cos(this.lookPitch) * 10, up = Math.sin(this.lookPitch) * 10;
          desiredPos.set(entity.position.x + sin * EYE_AHEAD, entity.position.y + eyeY, entity.position.z + cos * EYE_AHEAD);
          desiredLook.set(desiredPos.x + sin * level, desiredPos.y + up, desiredPos.z + cos * level);
          break;
        }
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        let seatOffset = 0; // Right-hand drive: the driver sits to the right of the car's centre line
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
          seatOffset = 0.36;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset - Math.cos(entity.heading) * seatOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset + Math.sin(entity.heading) * seatOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'quay': {
        // From the ferry wharves, across the Quay to the bridge
        const sway = Math.sin(elapsed * 0.22) * 3.0;
        desiredPos.set(250.0 + sway, 9.0, -1420.0);
        desiredLook.set(-120.0, 34.0, -2300.0);
        break;
      }

      case 'macquarie': {
        // The classic view: Opera House in front of the bridge
        const sway = Math.sin(elapsed * 0.18) * 4.0;
        desiredPos.set(1210.0 + sway, 7.0, -1950.0);
        desiredLook.set(240.0, 30.0, -2130.0);
        break;
      }

      case 'observatory': {
        const pan = Math.sin(elapsed * 0.16) * 120.0;
        desiredPos.set(-420.0, 42.0, -1640.0);
        desiredLook.set(-160.0 + pan, 40.0, -2500.0);
        break;
      }

      case 'kirribilli': {
        // Across the water from the north shore: the bridge, the Opera House and the whole CBD
        const sway = Math.sin(elapsed * 0.2) * 5.0;
        desiredPos.set(640.0 + sway, 14.0, -2820.0);
        desiredLook.set(120.0, 70.0, -1100.0);
        break;
      }

      case 'milsons': {
        desiredPos.set(-300.0, 8.0, -2790.0);
        desiredLook.set(-120.0, 62.0, -2120.0);
        break;
      }

      case 'tower': {
        const pan = Math.sin(elapsed * 0.14) * 300.0;
        desiredPos.set(143.0, 262.0, -311.0);
        desiredLook.set(120.0 + pan, 60.0, -2300.0);
        break;
      }

      case 'george': {
        const sway = Math.sin(elapsed * 0.25) * 1.2;
        desiredPos.set(-30.0 + sway, 5.5, -420.0);
        desiredLook.set(-210.0, 22.0, -1500.0);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius + 200.0,
          alt,
          Math.sin(angle) * radius - 1400.0
        );
        desiredLook.set(200.0, 60.0, -1400.0);
        break;
      }
    }

    if (this.glide && firstPerson) {
      // Into the eye from where the camera was, eased in and out, then fixed to it
      this.glide.t += dt;
      const t = Math.min(1, this.glide.t / GLIDE), k = t * t * (3 - 2 * t);
      this.currentPos.copy(this.glide.from).lerp(desiredPos, k);
      this.currentLookAt.copy(this.glide.look).lerp(desiredLook, k);
      if (t >= 1) this.glide = null;
      this.initialized = true;
      this.followEntity = null;
    } else if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    // How far round the camera is from the heading, for steering by it, where the camera orbits
    // (In first person on foot the view is your heading: nothing to steer by)
    this.controllerManager.viewOffset = ORBITING.has(this.activePresetId) && !firstPerson ? wrapAngle(this.orbitYawOffset) : null;

    this.camera.position.copy(this.currentPos);
    // lookAt() goes by the drawn frame
    this.camera.lookAt(this.lookTarget.set(this.currentLookAt.x - origin.x, this.currentLookAt.y, this.currentLookAt.z - origin.z));
  }
}

export { CAMERA_PRESETS, CameraSystem };
