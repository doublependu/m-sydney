import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, vec3, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { getLocationLabel, isTypingInField, LANDMARK_SITES, ROADS, LANDMARKS, SPAWN, TELEPORT_LOCATIONS, suburbAt } from './city-config.js';
import { TOWER_SIGNS } from './tower-signs.js';
import { buildTileGround, buildWater } from './city-grid.js';
import { addHarbourBridge, addTowerSigns, buildLandmarks } from './landmarks.js';
import { buildMovingScenery } from './moving-scenery.js';
import { createCityBlocks } from './buildings.js';
import { walkable } from './arrivals.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { PhoneHud } from './phone-hud.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { CityMapSystem } from './city-map.js';
import { removeSceneCulling, setDrawDistance, setupSceneCullingSteps, updateSceneCulling } from './scene-culling.js';
import { Progress } from './progress.js';
import { CityAudioSystem } from './audio-system.js';
import { PauseMenu } from './pause-menu.js';
import { CHOICES, FrameWatcher, detectQuality, saveChoice } from './quality.js';
import { FrameStats, cacheShare } from './frame-stats.js';
import { createLightPools } from './light-pools.js';
import { IDLE, WorldBuilder, activity, runToEnd } from './world-jobs.js';
import { GEO, TILE, fetchFarFile, heldBytes, heldTiles, holdTile, holdTiles, isHeld, loadFar, releaseTile, tileExists, tileKeyAt, tilesNear } from './geodata.js';
import { estimateMemory } from './memory-estimate.js';
import { lastSessionNote, noteText, startSessionNote } from './session-note.js';
import { planTiles } from './tiles/tile-manager.js';
import { BLOCKS } from './city-config.js';
import { auditPrecision, moveOriginNear, origin, rebaseMeshes, setOrigin } from './world-origin.js';
import { createInteriors } from './interiors.js';
import { ceilingOver, decksAt, groundHeight, inTunnel, roadRoute, structuresAt, surfaceHeight, surfaceSlope } from './surfaces.js';
import { updateTunnelMouths } from './tunnel-mouths.js';
import { wheelContacts } from './ground-geometry.js';
import { BRIDGE_LENGTH, DECK_REACH, bridgeAt, bridgePoint, deckOver, deckSpanAt } from './bridge.js';
import { fullscreenElement, fullscreenSupported, onFullscreenChange, toggleFullscreen } from './fullscreen.js';

// Application setup, background city build and frame loop.

function readPlayerState() {
  try {
    return JSON.parse(localStorage.getItem('sydney-player-state'));
  } catch {
    return null; // Missing or unavailable storage does not prevent playing.
  }
}

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // Once the overlay drops, the bar at the top left carries on for whatever is still being built
  const progress = new Progress(document.getElementById('hud-progress'));
  // Only shader compilation has measurable progress; other stages use the sweeping bar.
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  async function showLoadingStage(message) {
    if (loadingStatus) loadingStatus.textContent = message;
    if (loadingTrack) loadingTrack.classList.add('is-indeterminate');
    if (document.hidden) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  // Signs are drawn to canvases with Inter during the city build. A slow font must not hold the game back, though.
  const fontsReady = Promise.race([
    document.fonts?.load('800 16px Inter').catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);

  // iOS ignores user-scalable=no in the viewport meta; these are the events it lets a page cancel instead.
  for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  await showLoadingStage('Initializing graphics...');

  // 1. Pick the graphics level, then initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer
  const quality = await detectQuality();
  const renderer = new THREE.WebGPURenderer({
    antialias: quality.msaa,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality.shadowTile > 0;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);
  // Memory pressure, a driver reset or a long spell in the background can take the GPU away, and it doesn't come back
  // by itself: say so, with the way back, rather than leave a frozen picture. Never reloads on its own, which would
  // loop on a device that keeps losing it.
  let graphicsLost = false;
  renderer.onDeviceLost = (info) => {
    graphicsLost = true;
    renderer._onDeviceLost(info);
    renderer.setAnimationLoop(null);
    savePlayerState();
    const dialog = document.getElementById('graphics-lost');
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.getElementById('graphics-lost-reload').addEventListener('click', () => location.reload());
    if (!dialog.open) dialog.showModal();
  };

  let interactive = false; // set once the loading screen drops
  let holdStill = false; // debug only: draw without moving anything
  let fastClock = false; // debug only: the simulation moves only when a script asks it to, see advance()
  let compileTargetInUse = false;
  let worldBuilder = null;
  let worldCompleteAt = null;
  let interactiveAt = null;

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  const initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push([label, Math.round(now - initMark)]);
    initMark = now;
  };

  await renderer.init();
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage('Creating sky and environment lighting...');
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer, { shadowTile: quality.shadowTile || 1024 });
  markInit('lighting');

  // 3. The starting view: water, roads, sidewalks, landmarks and the buildings around the player. Everything else
  //    continues behind the game (buildRestOfWorld below) so the player can move as soon as possible.
  await showLoadingStage('Building streets and sidewalks...');
  await fontsReady;
  const lightPools = createLightPools(scene);
  const savedState = readPlayerState();
  const startPosition = savedState?.entities?.[savedState.activeMode] ?? SPAWN;
  // Ground and buildings before the first frame: less of them at the lower levels, where the start is tightest
  const startRadius = 450 * quality.drawDistance;
  // Only the tiles the first view stands on: the rest of the map follows behind the game
  const startTiles = await holdTiles(tilesNear(startPosition.x, startPosition.z, startRadius + 60));
  markInit('tiles');
  const inStart = (x, z) => (x - startPosition.x) ** 2 + (z - startPosition.z) ** 2 < startRadius ** 2;
  // The tiles drawn: their stages, colliders and culling, to let go of together. `done` once all of a tile is there.
  const builtTiles = new Map();
  for (const tile of startTiles) {
    const stage = new THREE.Group();
    stage.name = 'TileStart';
    runToEnd(buildTileGround(tile, stage, { part: inStart, last: false }));
    rebaseMeshes(stage);
    scene.add(stage);
    builtTiles.set(tile.key, { tile, stages: [stage], colliders: [], culling: [], done: false, startPart: true });
  }
  markInit('cityGrid');

  // 4. Initialize Third-Person Controllers (Person, Car, Cyclist, Helicopter) & Multi-Camera System
  await showLoadingStage('Preparing player, vehicles and controls...');
  const controllerManager = new ThirdPersonControllerManager(scene, []);
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = savedState;
    if (saved?.version === 1) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y, Number.isInteger(p.surface) ? p.surface : 0);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  markInit('controllers');

  await showLoadingStage('Raising the nearest buildings...');
  const cityBlocks = createCityBlocks(scene);
  for (const record of builtTiles.values()) {
    const colliders = runToEnd(cityBlocks.addBuildings(record.tile, record.tile.buildings.filter((b) => inStart(b.cx, b.cz)), record.stages[0]));
    record.colliders.push(...colliders);
    controllerManager.addColliders(colliders);
  }
  cityBlocks.update(startPosition.x, startPosition.z, true);
  markInit('blocks');

  // These arrive with the rest of the city, see buildRestOfWorld()
  let movingScenery = null;
  let streetDetails = null;
  let trafficSystem = null;
  // ?debug=1&cars=0: the streets to yourself, for the scenarios that need to know nobody else is there
  const debugCars = new URLSearchParams(location.search).get('debug') === '1' && new URLSearchParams(location.search).has('cars') ? Number(new URLSearchParams(location.search).get('cars')) : null;

  let interiorReturn = null; // js/interiors.js returnSpot(), once there are interiors
  function savePlayerState() {
    try {
      // Inside a building, what's inside it won't be there on a reload: back outside the door you came in by
      const outside = controllerManager.activeMode === 'person' ? interiorReturn?.() ?? null : null;
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, outside && mode === 'person'
        ? { x: outside.x, y: 0, z: outside.z, heading: outside.heading, surface: 0 }
        : { x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading, surface: entity.surface || 0 }]));
      localStorage.setItem('sydney-player-state', JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  scene.add(cameraSystem.camera); // so it moves with the world when the origin does (js/world-origin.js)
  const touchControls = new TouchControls(controllerManager);
  const phoneHud = new PhoneHud();
  touchControls.onStickPressed = () => phoneHud.hideHint();
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager }, { onStateChange: updateSoundButton });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? 'Mute sound' : 'Enable sound');
    soundButton.title = audioSystem.supported ? `${audioSystem.enabled ? 'Mute' : 'Enable'} sound [N]` : 'Web Audio is unavailable';
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });

  // Everything that moves or animates: only these get new world matrices per frame.
  // Crowd, tree and building-detail animation changes instance/pose buffers, not Object3D transforms.
  const dynamicRoots = [
    lightPools.traffic,
    scene.getObjectByName('StoreClusteredLights'),
    lightPools.street,
    ...Object.values(controllerManager.entities).map((entity) => entity.mesh),
    controllerManager.entities.cyclist.helmet
  ];
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;

  // On WebGPU, small InstancedMeshes (<= 1000 instances) keep their matrices in uniform buffers that three.js
  // re-uploads on every draw of every pass (~2.5 MB/frame with the shadow cascades, stalling the GPU queue).
  // Storage attributes only upload when needed; WebGL2 needs ordinary instanced attributes for correct transforms.
  function useStorageInstancing(root) {
    if (!renderer.backend.isWebGPUBackend) return;
    root.traverse((object) => {
      if (object.isInstancedMesh && !object.instanceMatrix.isStorageInstancedBufferAttribute) {
        object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
      }
    });
  }
  useStorageInstancing(scene);

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  await showLoadingStage('Setting up visual effects, map and interface...');
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  let sceneMRT;
  let reflections;
  if (quality.ssr) {
    const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
    const maxSSRRoughness = 0.75;
    sceneMRT = mrt({
      output: output,
      normal: normalView,
      metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
    });
    sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
    sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(sceneMRT);

    const scenePassColor = scenePass.getTextureNode('output');
    const scenePassDepth = scenePass.getTextureNode('depth');
    const scenePassNormal = scenePass.getTextureNode('normal');
    const scenePassMetalRough = scenePass.getTextureNode('metalRough');

    const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
      metalnessNode: scenePassMetalRough.r,
      roughnessNode: scenePassMetalRough.g,
      camera: cameraSystem.camera
    });
    ssrPass.resolutionScale = 0.5;
    ssrPass.blurQuality = 1;
    ssrPass.maxDistance.value = 42;
    ssrPass.thickness.value = 0.85;
    // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
    ssrPass.quality.value = 0.25;
    ssrPass.binaryRefine = true;
    ssrPass.intensity.value = 0.50;
    ssrPass.screenEdgeFadeBlack = true;

    // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
    const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
    reflections = ssrPass.mul(reflectionMask);
  } else {
    // Stays an MRT with one target: without any, the scene's WGSL gets empty output structures and fails to compile.
    sceneMRT = mrt({ output: output });
    scenePass.setMRT(sceneMRT);
    reflections = vec3(0);
  }
  const colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), reflections, quality);
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elMiniSpeed = document.getElementById('hud-mini-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      switchTravelMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => {
      if (!pauseMenu.isOpen) mapSystem.toggleFullMap(!mapSystem.isFullMapOpen);
    },
    onCloseMap: () => mapSystem.toggleFullMap(false),
    onTogglePause: () => pauseMenu.toggle(),
    onUse: () => controllerManager.onUse?.()
  });

  const pauseMenu = new PauseMenu({
    canOpen: () => !graphicsLost, // Esc, and a phone hiding the tab, would otherwise stack it over Reload
    onOpen() {
      closePopovers();
      controllerManager.resetInput();
      touchControls.setEnabled(false);
      gamepadControls.setEnabled(false);
      audioSystem.setPaused(true);
    },
    onClose() {
      touchControls.setEnabled(!mapSystem.isFullMapOpen);
      gamepadControls.setEnabled(!mapSystem.isFullMapOpen);
      audioSystem.setPaused(false);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && interactive) pauseMenu.open();
  });
  document.getElementById('btn-pause')?.addEventListener('click', () => pauseMenu.open());

  // Graphics levels decide what gets built and compiled, so a change reloads. Player state saves on the way out.
  for (const button of document.querySelectorAll('[data-quality]')) {
    const choice = button.getAttribute('data-quality');
    button.setAttribute('aria-pressed', String(choice === quality.choice));
    if (choice === 'auto') button.textContent = `Auto (${quality.level})`;
    button.addEventListener('click', () => {
      if (choice === quality.choice) return;
      saveChoice(CHOICES.includes(choice) ? choice : 'auto');
      location.reload();
    });
  }

  if (fullscreenSupported) {
    const buttons = [document.getElementById('btn-fullscreen'), document.getElementById('pause-fullscreen')].filter(Boolean);
    for (const button of buttons) {
      button.hidden = false;
      button.addEventListener('click', () => toggleFullscreen()?.catch(() => {}));
    }
    onFullscreenChange(() => {
      const active = Boolean(fullscreenElement());
      for (const button of buttons) {
        button.setAttribute('aria-pressed', String(active));
        if (button.id === 'pause-fullscreen') button.textContent = active ? 'Exit full screen' : 'Full screen';
        else button.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
      }
    });
  }

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Walk'], [['Shift'], 'Run'], [['A', 'D'], 'Turn'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['B'], 'Horn'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend']]
  };
  // Top speeds in km/h (controllers.js caps them at 6, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedKmh = { person: 22, car: 130, cyclist: 68, helicopter: 187 };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  // The player changing how they travel: the new mode starts from where this one is, with a short fade over a long move
  function switchTravelMode(mode) {
    const moved = controllerManager.switchMode(mode);
    selectMode(mode);
    if (moved > 50) {
      cameraSystem.snap();
      const fade = document.getElementById('mode-fade');
      fade?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
    }
  }

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    // Baking the sky takes over the renderer. A compile under way steps aside for it, or the sky's pipeline is built
    // for the scene's render targets, and gets its target back afterwards.
    const compiling = compileTargetInUse;
    if (compiling) setCompileTarget(false);
    const relight = progress.start('Changing the light', 1);
    lightingSystem.applyPreset(timeId);
    relight.done();
    if (compiling) setCompileTarget(true);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTravelMode(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the place's name over its street corner, drawn as a pair of street-name signs
  const placeNames = new Set(LANDMARKS.map((l) => l.name));
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else if (placeNames.has(label) || (!label.includes(' & ') && !ROADS.some((r) => r.name === label))) {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = 'near';
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  // Registered before the map's own key handler, so the Esc that closes the map doesn't also pause the game.
  // A native popover closes on Esc by itself; the pause dialog does too, through its cancel event.
  window.addEventListener('keydown', (e) => {
    if (!interactive || e.repeat || isTypingInField(e)) return;
    if (e.code === 'KeyP') {
      pauseMenu.toggle();
    } else if (e.code === 'Escape' && !pauseMenu.isOpen && !mapSystem.isFullMapOpen) {
      if (supportsPopover && document.querySelector('.popover:popover-open')) return;
      e.preventDefault(); // the dialog opens during this very key press, which must not count as closing it too
      pauseMenu.open();
    }
  });

  // High up, nobody can see a lamp post or which lane a car is in: those can wait longer to catch up
  const flying = () => controllerManager.activeMode === 'helicopter' && controllerManager.getActiveEntity().position.y > 60;
  const EDGE_SPEED = 12, EDGE_REACH = 200; // m/s, m
  // Somewhere the map isn't drawn yet: the player waits there, behind a fade, until it is
  let awaitingGround = null;
  // Set by a teleport: until everything around there is in, the loading bar says so (buildRestOfWorld)
  let arrival = null;
  let streaming = null; // the bar's tasks for the map coming in, once the first build is done
  const groundWaits = []; // ms, for tools/play

  function awaitGround(x, z, askedX = x, askedZ = z, heading = 0) {
    if (!worldBuilder || groundReady(x, z)) return;
    awaitingGround = { x, z, askedX, askedZ, heading, until: performance.now() + 15000, since: performance.now() };
    document.getElementById('mode-fade')?.classList.add('fading');
  }

  function teleportTo(x, z, heading = Math.PI, name = null) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    // The loading bar follows the map coming in around here, from now: whatever's being built for the last place can take a while yet
    arrival = { x: destination.x, z: destination.z, name };
    if (worldCompleteAt !== null) startStreaming(destination.x, destination.z, 0);
    awaitGround(destination.x, destination.z, x, z, heading);
    standOnSurfaces();
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: getLocationLabel(destination.x, destination.z)
    };
    return destination;
  }

  const mapSystem = new CityMapSystem({
    controllerManager,
    cameraSystem,
    // A copy, because the map redraws its footprint layers whenever this list grows. It gets the full city in one go.
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) {
        mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
      }
    },
    onTeleport: teleportTo,
    isPaused: () => pauseMenu.isOpen
  });

  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-teleport');
      const loc = TELEPORT_LOCATIONS[key];
      if (loc) {
        teleportTo(loc.x, loc.z, loc.heading, btn.querySelector('.pop-name')?.textContent.trim() || null); // the menu's own name for the place
      }
      closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Global keyboard shortcuts for modes (1-4), cameras (V / 5-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e) || pauseMenu.isOpen) return;
    switch (e.code) {
      case 'Digit1':
        switchTravelMode('person');
        break;
      case 'Digit2':
        switchTravelMode('car');
        break;
      case 'Digit3':
        switchTravelMode('cyclist');
        break;
      case 'Digit4':
        switchTravelMode('helicopter');
        break;
      case 'Digit5':
        selectCamera('chase', true);
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('quay', true);
        break;
      case 'Digit9':
        selectCamera('macquarie', true);
        break;
      case 'Digit0':
        selectCamera('observatory', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  // Window resizes, rotation and mobile browser bars all land here. The new size is applied at the start of the next
  // frame, so the canvas never gets cleared without a fresh image to replace it.
  const viewport = { width: container.clientWidth, height: container.clientHeight };
  let resizePending = false;
  const onViewportChange = () => {
    resizePending = container.clientWidth !== viewport.width || container.clientHeight !== viewport.height;
  };
  new ResizeObserver(onViewportChange).observe(container);
  window.visualViewport?.addEventListener('resize', onViewportChange);

  function applyViewportSize() {
    resizePending = false;
    viewport.width = container.clientWidth;
    viewport.height = container.clientHeight;
    cameraSystem.onResize(viewport.width, viewport.height);
    renderer.setSize(viewport.width, viewport.height);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  }

  // Initialize the UI and chase camera around the restored player, or the default taxi on a first visit.
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Compile what the starting view shows behind the loading screen, then the rest a job at a time once the player can
  // move. Overlapping compileAsync() jobs keep compilation moving while individual jobs yield to the browser.
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  let laterCompileJobs = [];

  // Plain meshes that share a material share its shader, so one job compiles them in turn (the first build serves the
  // rest); every instanced mesh gets a build of its own unless its chunks share a pipeline
  function collectCompileJobs(root) {
    const camera = cameraSystem.camera;
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );
    // A stage that isn't in the scene yet compiles whole, without working out each object's bounds
    const allInView = root !== scene;
    const pipelines = new Map();
    root.traverseVisible((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      // Shadow stand-ins only draw in the shadow maps, which compile with the frame that needs them
      if (o.userData.shadowProxy) return;
      const key = o.userData.sharesPipelineWith || o;
      let entry = pipelines.get(key);
      if (!entry) pipelines.set(key, (entry = { object: o, inView: false }));
      if (!entry.inView && (allInView || !o.frustumCulled || frustum.intersectsObject(o))) entry.inView = true;
    });
    const groups = { now: { jobs: [], byMaterial: new Map() }, later: { jobs: [], byMaterial: new Map() } };
    for (const { object, inView } of pipelines.values()) {
      const { jobs, byMaterial } = inView ? groups.now : groups.later;
      if (object.isInstancedMesh || Array.isArray(object.material)) {
        jobs.push([object]);
        continue;
      }
      let job = byMaterial.get(object.material);
      if (!job) {
        job = [];
        byMaterial.set(object.material, job);
        jobs.push(job);
      }
      job.push(object);
    }
    return { now: groups.now.jobs, later: groups.later.jobs };
  }

  // compileAsync() works across many tasks and reads the render target at each step, so its target stays set between
  // frames. Those pipelines must be the very ones the scene pass asks for. renderFrame() steps aside for the frame.
  function setCompileTarget(inUse) {
    compileTargetInUse = inUse;
    renderer.setRenderTarget(inUse ? scenePass.renderTarget : null);
    renderer.setMRT(inUse ? sceneMRT : null);
  }

  function renderFrame() {
    if (compileTargetInUse) {
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
    }
    renderPipeline.render();
    if (compileTargetInUse) setCompileTarget(true);
  }

  // compileAsync() culls during its synchronous start, and most of these objects are out of view by design
  function compileObject(object) {
    const { frustumCulled, visible } = object;
    object.frustumCulled = false;
    object.visible = true;
    const compiled = renderer.compileAsync(object, cameraSystem.camera, scene);
    object.frustumCulled = frustumCulled;
    object.visible = visible;
    return compiled.catch((e) => console.warn('[compile]', e)); // the frame that needs it compiles it instead
  }

  async function precompileShaders() {
    await showLoadingStage('Preparing the view...');
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    cameraSystem.update(0, 0);
    const { now, later } = collectCompileJobs(scene);
    laterCompileJobs = later;

    await showLoadingStage(`Compiling scene shaders... 0 / ${now.length} batches`);
    setLoadingProgress(0);
    setCompileTarget(true);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < now.length) {
        const job = now[next++];
        // Each compile starts in a task of its own: compileAsync() keeps one precompilation state on the renderer,
        // which must not be mid-step for two of them in the same microtask checkpoint
        for (const object of job) {
          await nextTask();
          await compileObject(object);
        }
        done++;
        if (loadingStatus) {
          loadingStatus.textContent = `Compiling scene shaders... ${done} / ${now.length} batches (${Math.round((done / now.length) * 100)}%)`;
        }
        setLoadingProgress(done / now.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    setCompileTarget(false);
  }

  await precompileShaders();
  markInit('compile');
  await showLoadingStage('Preparing shadows and the first frame...');

  // Stages revealed at once (models and their far versions as the city completes) compile one after another. Side by side, the first to
  // finish took the scene pass's target from under the others mid-compile, and two compiles shared the renderer's one precompile state:
  // their pipelines didn't match what the scene pass drew with, and frames failed ("[Texture "output"] usage ... includes writable
  // usage", "Color target has no corresponding fragment stage output").
  let compileQueue = Promise.resolve();
  function compileJobs(jobs, task = null) {
    const run = compileQueue.then(() => compileJobsNow(jobs, task));
    compileQueue = run.catch(() => {});
    return run;
  }

  // Runs between frames once the game is interactive, a few objects per frame, so that a shader nobody has reached yet
  // doesn't stall the moment the player turns towards it.
  async function compileJobsNow(jobs, task = null) {
    setCompileTarget(true);
    try {
      let sliceStart = performance.now();
      const total = jobs.reduce((sum, job) => sum + job.length, 0) || 1;
      let done = 0;
      for (const job of jobs) {
        for (const object of job) {
          await compileObject(object);
          task?.set(++done / total);
          if (performance.now() - sliceStart > 3) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            sliceStart = performance.now();
          }
        }
      }
    } finally {
      setCompileTarget(false);
    }
  }

  const settled = (root) => root.traverse((o) => { o.userData.lifted = true; });

  // Everything not laid on the ground as it was built: instanced props and small parts ride at their origin, merged
  // meshes vertex by vertex.
  // A stage can have tens of thousands of things to lift, and asking the ground's height isn't free: this mustn't hold up a frame. It's not in the
  // scene yet, so nothing minds how long it takes.
  async function liftStage(stage) {
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    let since = performance.now();
    const breathe = async () => {
      if (performance.now() - since < 5) return;
      await new Promise((resolve) => setTimeout(resolve));
      since = performance.now();
    };
    const objects = [];
    stage.traverse((o) => {
      if (o.isMesh && !o.userData.lifted) objects.push(o);
    });
    for (const o of objects) {
      o.userData.lifted = true;
      if (o.isInstancedMesh) {
        const array = o.instanceMatrix.array;
        for (let i = 0; i < o.count; i++) {
          at.set(array[i * 16 + 12], array[i * 16 + 13], array[i * 16 + 14]).applyMatrix4(o.matrixWorld);
          array[i * 16 + 13] += groundHeight(at.x, at.z);
          if ((i & 31) === 31) await breathe();
        }
        o.instanceMatrix.needsUpdate = true;
        o.computeBoundingSphere?.();
        await breathe();
        continue;
      }
      const position = o.geometry?.attributes?.position;
      if (!position || position.isInterleavedBufferAttribute) continue;
      o.geometry.computeBoundingBox();
      const { min, max } = o.geometry.boundingBox;
      if (Math.max(max.x - min.x, max.z - min.z) < 12 || !position.array.length) {
        at.setFromMatrixPosition(o.matrixWorld);
        o.position.y += groundHeight(at.x, at.z);
        o.updateMatrix();
        o.updateMatrixWorld(true);
        await breathe();
        continue;
      }
      matrix.copy(o.matrixWorld).invert();
      for (let i = 0; i < position.count; i++) {
        at.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        at.y += groundHeight(at.x, at.z);
        at.applyMatrix4(matrix);
        position.setXYZ(i, at.x, at.y, at.z);
        if ((i & 31) === 31) await breathe();
      }
      position.needsUpdate = true;
      o.geometry.computeBoundingSphere();
      o.geometry.computeBoundingBox();
      await breathe();
    }
  }

  // A stage of the city is built off to the side and joins the scene with its shaders ready, so it appears at once
  async function revealStage(stage, task = null) {
    stage.updateMatrixWorld(true);
    useStorageInstancing(stage);
    await liftStage(stage);
    rebaseMeshes(stage);
    stage.updateMatrixWorld(true);
    const { now, later } = collectCompileJobs(stage);
    await compileJobs([...now, ...later], task);
    scene.add(stage);
    stage.updateMatrixWorld(true);
    task?.done();
  }

  // A generator step that moves its task along as it yields: towards done, at a pace set by how many yields it usually
  // takes, without ever reaching the end before it does
  function* tracked(job, task, expected) {
    let n = 0;
    let step = job.next();
    while (!step.done) {
      task.set(1 - Math.exp(-(++n) / expected));
      const sent = yield step.value;
      step = job.next(sent);
    }
    task.done();
    return step.value;
  }

  // What the last session left if the browser killed it, read before this one writes its own (js/session-note.js)
  let lastNote = null;
  try { lastNote = lastSessionNote(localStorage); } catch { /* no storage */ }

  // ?stats=1: the numbers that matter, on screen, for trying it on a phone with no developer tools to hand
  function showStats() {
    if (new URLSearchParams(location.search).get('stats') !== '1') return;
    const el = document.createElement('div');
    el.id = 'stats-readout';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;padding:6px 8px;background:#000c;color:#fff;font:12px/1.4 monospace;pointer-events:none;white-space:pre;border-radius:4px';
    document.body.append(el);
    const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    const stats = new FrameStats(performance.now());
    // Where it loaded, and how much of what it needed to get there came from the browser's cache: a first visit, or the
    // first after a deploy that renamed the tiles, fetches it all
    const loadedFrom = (() => {
      const loadedAt = controllerManager.getActiveEntity().position; // shown as it becomes playable
      const at = loadedAt ? `at ${Math.round(loadedAt.x)}, ${Math.round(loadedAt.z)}, ${getLocationLabel(loadedAt.x, loadedAt.z)}` : '';
      const share = cacheShare(performance.getEntriesByType('resource'), interactiveAt ?? Infinity);
      const cache = share.known ? `${share.cached} of ${share.files} files from cache, ${Math.round(share.bytes / 1024)} KB fetched` : `${share.files} files, cache not reported`;
      return `loaded ${at}, ${cache}`;
    })();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stats.pause(performance.now());
    });
    // The game's own loop runs before this one in each frame, so frameWork is the frame that came before this one's wait
    const tick = (now) => {
      if (stats.frame(now, frameWork)) {
        const heap = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : 'n/a';
        const held = Math.round(countMemory(now).total / 1048576);
        const { x, z } = controllerManager.getActiveEntity().position;
        el.textContent = `loaded in ${(interactiveAt / 1000).toFixed(2)} s, ${backend}, ${quality.level}\n`
          + `${loadedFrom}\n`
          + `${stats.lines(now)}\n`
          + `city ${worldCompleteAt === null ? 'building' : `done at ${(worldCompleteAt / 1000).toFixed(1)} s`}, tiles ${[...builtTiles.values()].filter((r) => r.done).length}, heap ${heap}, holds about ${held} MB\n`
          + `at ${Math.round(x)}, ${Math.round(z)}, ${getLocationLabel(x, z)}`
          + (lastNote ? `\n${noteText(lastNote)}` : '');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // What a stage held on the GPU. Materials stay: every tile and window shares them, and a new one compiles nothing.
  function disposeStage(stage) {
    stage.removeFromParent();
    stage.traverse((o) => {
      // three.js keeps a record of how it draws each mesh, listening on the material, which never goes away here. Only this
      // event lets go of it: without it every mesh ever drawn stays in memory, geometry and all.
      if (o.isInstancedMesh) o.dispose();
      else if (o.isMesh) o.dispatchEvent({ type: 'dispose' });
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      o.userData.replacedGeometry?.dispose();
      if (o.userData.ownMaterial) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }

  // --- Tiles around the player -----------------------------------------------------------------------------------------
  const shadowOf = () => [lightingSystem.sunLight.shadow, renderer.backend.isWebGPUBackend === true];
  let operaPlain = []; // js/opera-house.js: what the Opera House's model takes the place of near it
  let towerPlain = null; // js/landmarks.js: Sydney Tower as the game draws it, which its model takes the place of
  const interiors = createInteriors({
    reveal: (group) => revealStage(group),
    shown: (id, on) => {
      if (id === 'opera-house') for (const mesh of operaPlain) mesh.visible = !on;
      if (id === 'sydney-tower' && towerPlain) towerPlain.visible = !on;
    },
    lights: lightPools.interiorLights,
    colliders: { add: (list) => controllerManager.addColliders(list), remove: (list) => controllerManager.removeColliders(list) },
    // Not in the first view: a model comes once the city round you has
    tileBuilt: (x, z) => worldCompleteAt !== null && builtTiles.get(tileKeyAt(x, z))?.done === true,
    // ...but its far version, a draw or two, as soon as the ground it stands on is: the map's buildings it replaces aren't in the tile.
    // Round the start, that's the part of its tile built before you can move.
    tileReady: (x, z) => {
      const record = builtTiles.get(tileKeyAt(x, z));
      return !!record && (record.done || (record.startPart === true && inStart(x, z)));
    },
    // Far versions as far as the far level reaches at most: each is a draw or two, and a few KB
    farReach: () => (worldCompleteAt === null ? 0 : quality.farRange),
    debug: new URLSearchParams(location.search).get('debug') === '1'
  });
  let indoors = false;
  let indoorShelter = 0.85; // how far the room you're in shuts out the sky (js/interiors.js): a glazed foyer less, a concert hall all of it
  // Inside a house the city stays drawn, for the view from its windows: only the walk slows, and the sky's light dims
  function setIndoors(on) {
    if (on === indoors) return;
    indoors = on;
    controllerManager.indoors = on;
    cameraSystem.indoors = on;
  }
  interiorReturn = () => interiors.returnSpot();
  const lookDirection = new THREE.Vector3();
  const useActions = { sit: (seat) => controllerManager.sitAt(seat), stand: () => controllerManager.standUp() };
  const useInterior = () => interiors.use(useActions);
  controllerManager.onUse = useInterior;
  controllerManager.onStand = () => interiors.stood();
  const usePrompt = document.getElementById('use-prompt');
  const usePromptLabel = document.getElementById('use-prompt-label');
  const touchUse = document.getElementById('touch-use');
  const touchUseLabel = document.getElementById('touch-use-label');
  touchUse?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    useInterior();
  });
  let shownPrompt = null;
  function showPrompt(label) {
    if (label === shownPrompt) return;
    shownPrompt = label;
    if (usePrompt) usePrompt.hidden = !label;
    if (touchUse) touchUse.hidden = !label;
    if (label) {
      if (usePromptLabel) usePromptLabel.textContent = label;
      if (touchUseLabel) touchUseLabel.textContent = label;
      touchUse?.setAttribute('aria-label', label);
    }
  }
  let farLevel = null;
  let farStage = null;
  const farStages = new Map(); // key -> the stage of that square
  const tileFailedAt = new Map();

  function* buildTile(key) {
    activity.label = `tile ${key}`;
    let tile = null;
    yield holdTile(key).then((t) => { tile = t; }).catch(() => { tileFailedAt.set(key, performance.now()); });
    if (!tile) return;
    let record = builtTiles.get(key);
    if (!record) builtTiles.set(key, (record = { tile, stages: [], colliders: [], culling: [], done: false }));
    const stage = new THREE.Group();
    stage.name = 'Tile';
    const started = record.startPart;
    const ground = yield* buildTileGround(tile, stage, { part: started ? (x, z) => !inStart(x, z) : () => true });
    const buildings = yield* cityBlocks.addBuildings(tile, started ? tile.buildings.filter((b) => !inStart(b.cx, b.cz)) : tile.buildings, stage);
    if (builtTiles.get(key) !== record) { // let go of while it was being built
      disposeStage(stage);
      return;
    }
    record.colliders.push(...ground, ...buildings);
    controllerManager.addColliders(ground);
    controllerManager.addColliders(buildings);
    yield revealStage(stage);
    record.stages.push(stage);
    const [shadow, storage] = shadowOf();
    record.culling.push(yield* setupSceneCullingSteps(scene, record.stages, shadow, storage));
    record.done = true;
    farLevel?.setShown(tile.ix, tile.iz, true);
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z, true);
  }

  function dropTile(key) {
    const record = builtTiles.get(key);
    if (!record) return;
    builtTiles.delete(key);
    farLevel?.setShown(record.tile.ix, record.tile.iz, false);
    for (const handle of record.culling) removeSceneCulling(handle);
    for (const stage of record.stages) disposeStage(stage);
    controllerManager.removeColliders(record.colliders);
    cityBlocks.removeTile(record.tile);
    releaseTile(key);
  }

  // Debug only: all of the map, all the time, for scenarios about the roads rather than about fetching them
  const wholeCity = new URLSearchParams(location.search).get('debug') === '1' && new URLSearchParams(location.search).get('wholeCity') === '1';
  const tileRange = wholeCity ? 1e6 : quality.buildingDetail;
  // ?wholeCity=1, for scripted drives faster than the map could come: all of the CBD and around it, from the start
  const inTheCbd = (key) => {
    const [ix, iz] = key.split('_').map(Number);
    return tileExists(key) && ix >= -4 && ix <= 3 && iz >= -6 && iz <= 3;
  };
  function wantedTiles() {
    const entity = controllerManager.getActiveEntity();
    const { x, z } = entity.position;
    const speed = entity.speed || 0, heading = entity.heading || 0;
    const failed = (key) => performance.now() - (tileFailedAt.get(key) ?? -Infinity) < 5000;
    const plan = planTiles({ x, z, vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed, range: tileRange, ...(wholeCity && { exists: inTheCbd }), built: new Set([...builtTiles].filter(([, r]) => r.done).map(([k]) => k)) });
    plan.load = plan.load.filter((key) => !failed(key));
    return plan;
  }

  /** Is the ground around (x, z) drawn, so someone can stand on it? */
  function groundReady(x, z, radius = 300) {
    return tilesNear(x, z, radius).every((key) => {
      const record = builtTiles.get(key);
      return record && (record.done || record.startPart);
    });
  }

  // --- Street furniture and traffic: rebuilt around the player as they travel ------------------------------------------
  // Each stands on the tiles held at the time. A new set takes the place of the old in one frame, in the same places.
  let cityCode = null;
  let detailStage = null, detailCulling = null;
  let paintStage = null, paintCulling = null;
  let windowAt = null;
  const TRAFFIC_RADIUS = wholeCity ? 1e6 : 1000; // m of road around the player that traffic can use
  const REBUILD_AFTER = Math.max(400, tileRange * 0.5); // m moved

  function* rebuildDetails(tasks = null) {
    activity.label = 'street furniture';
    const { buildStreetDetails } = cityCode;
    const stage = new THREE.Group();
    const allColliders = controllerManager.colliders;
    const job = buildStreetDetails(stage, allColliders, lightPools);
    const built = tasks?.details ? yield* tracked(job, tasks.details, 120) : yield* job;
    yield revealStage(stage);
    const [shadow, storage] = shadowOf();
    const culling = yield* setupSceneCullingSteps(scene, [stage], shadow, storage);
    removeSceneCulling(detailCulling);
    if (detailStage) disposeStage(detailStage);
    detailStage = stage;
    detailCulling = culling;
    streetDetails = built;
    return built;
  }

  function* rebuildTraffic(x, z, tasks = null) {
    activity.label = 'traffic';
    const { buildRoadNetworkSteps, buildRoadPaintSteps, createRoadPaintChunkBuilder, createTrafficSystem } = cityCode;
    const R = TRAFFIC_RADIUS + 200;
    const nearWindow = (c) => c.maxX > x - R && c.minX < x + R && c.maxZ > z - R && c.minZ < z + R;
    // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they stay
    // inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them. Elevated building
    // sections that clear even a bus don't obstruct ground traffic.
    const obstacles = [
      ...BLOCKS.filter((b) => b.median && nearWindow(b)).map((b) => ({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ })),
      ...streetDetails.footprints.filter(nearWindow),
      ...controllerManager.colliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5 && nearWindow(c))
    ];
    const network = yield* buildRoadNetworkSteps(obstacles, streetDetails.signalIntersections, { x, z, radius: TRAFFIC_RADIUS });
    tasks?.traffic.set(0.4);
    const paint = new THREE.Group();
    yield* buildRoadPaintSteps(paint, network, createRoadPaintChunkBuilder('RoadMarkings'), cityCode);
    settled(paint);
    yield revealStage(paint);
    const [shadow, storage] = shadowOf();
    const culling = yield* setupSceneCullingSteps(scene, [paint], shadow, storage);
    removeSceneCulling(paintCulling);
    if (paintStage) disposeStage(paintStage);
    paintStage = paint;
    paintCulling = culling;
    tasks?.traffic.set(0.6);
    if (trafficSystem) {
      trafficSystem.setNetwork(network);
    } else {
      const trafficStage = new THREE.Group();
      const made = yield* createTrafficSystem(trafficStage, obstacles, streetDetails.signalIntersections, {
        numCars: debugCars ?? quality.cars, numBuses: debugCars === null ? quality.buses : 1, numPeds: debugCars === null ? quality.pedestrians : 1, lightPools, firstNetwork: network,
        // The cars parked along the kerbs stand in the player's way
        kerbsideChanged: (old, now) => { controllerManager.removeColliders(old); controllerManager.addColliders(now); }
      });
      tasks?.traffic.set(0.8);
      yield* made.populate(cameraSystem.currentPos);
      settled(trafficStage); // writes its own transforms on the ground every frame
      yield revealStage(trafficStage, tasks?.traffic);
      trafficSystem = made;
      controllerManager.vehicleAt = (vx, vz, y) => [...made.cars, ...made.buses].some((v) => v.edge
        && Math.abs(v.x - vx) < 6 && Math.abs(v.z - vz) < 6 && Math.abs((v.ry ?? y) - y) < 3);
      mapSystem.trafficSystem = made;
      audioSystem.attachCity({ trafficSystem, streetDetails });
      dynamicRoots.push(made.group);
    }
    audioSystem.sources.attachCity({ trafficSystem, streetDetails });
    windowAt = { x, z };
  }

  // Street furniture and traffic can take a while to rebuild. If the ground under the player goes missing meanwhile, as it does
  // after a teleport, that comes first: `job` waits, and nothing is drawing to a half-built city.
  function* groundFirst(job) {
    let step = job.next();
    let checkedAt = performance.now();
    while (!step.done) {
      const sent = yield step.value;
      if (awaitingGround || performance.now() - checkedAt > 250) {
        checkedAt = performance.now();
        const { x, z } = controllerManager.getActiveEntity().position;
        const doing = activity.label;
        while (!groundReady(x, z, 300)) {
          const key = wantedTiles().load[0];
          if (!key) break;
          yield* buildTile(key);
        }
        activity.label = doing;
      }
      step = job.next(sent);
    }
    return step.value;
  }

  function* buildRestOfWorld() {
    // The whole of the work, weighted by how long each step takes (desktop, js/progress.js timings())
    const [shaders, download, buildings, streets, moreBuildings, suburbs, details, traffic, finishing] = progress.plan([
      ['Compiling shaders', 3], ['Downloading the rest of the city', 1], ['Raising the buildings', 2],
      ['Laying the streets', 3], ['Raising the rest of the buildings', 4], ['Building the suburbs', 2],
      ['Putting out street furniture', 3], ['Starting the traffic', 3], ['Finishing the city', 2]
    ]);
    yield compileJobs(laterCompileJobs, shaders).then(() => shaders.done());
    laterCompileJobs = [];

    // Code the first view doesn't need, and the map's far level
    let city;
    download.begin();
    yield Promise.all([
      loadFar(),
      Promise.all([import('./horizon.js'), import('./street-details.js'), import('./traffic.js'), import('./road-network.js'), import('./road-paint.js'), import('./road-paint-tags.js'), import('./far-level.js')])
        .then((modules) => { city = Object.assign({}, ...modules); })
    ]).then(() => download.done());
    cityCode = city;
    // A garden's small plants are drawn as far as the graphics level has things drawn (js/trees.js)
    city.setPlantDistance(quality.drawDistance);
    const { buildHorizon, createFarLevel } = city;

    settled(cityBlocks.group); // streamed around the player, on each building's own base
    buildings.begin();
    yield revealStage(cityBlocks.group);

    // Far away first: the whole skyline, cheaply, before any of it is drawn in full
    const here = () => controllerManager.getActiveEntity().position;
    farLevel = createFarLevel();
    for (const record of builtTiles.values()) farLevel.setShown(record.tile.ix, record.tile.iz, true);
    farStage = new THREE.Group();
    farStage.name = 'FarLevel';
    seaSheet = buildWater(farStage);
    yield revealStage(farStage);
    while (yield* nextFarSquare(here().x, here().z, { forMap: true }));
    yield* mapSystem.prepareBlocks(farLevel.footprints);

    // The landmarks wait for the map under them. It's let go of again if it's far from the player.
    const landmarkTiles = LANDMARK_TILES();
    const heldForLandmarks = landmarkTiles.filter((key) => !isHeld(key));
    yield holdTiles(landmarkTiles);
    const landmarkStage = new THREE.Group();
    const { colliders: landmarkColliders, group: landmarks, operaPlain: plain, towerPlain: tower } = buildLandmarks(landmarkStage);
    operaPlain = plain;
    towerPlain = tower;
    controllerManager.addColliders(landmarkColliders);
    yield;
    addHarbourBridge(landmarks);
    addTowerSigns(landmarks);
    yield;
    for (const key of heldForLandmarks) if (!builtTiles.has(key)) releaseTile(key);
    yield revealStage(landmarkStage, buildings);

    // The tiles in range, nearest first
    let plan = wantedTiles();
    const total = Math.max(1, plan.load.length);
    let doneTiles = 0;
    while (plan.load.length) {
      const half = total / 2;
      const task = doneTiles < half ? streets : moreBuildings;
      task.set(doneTiles < half ? doneTiles / half : (doneTiles - half) / half);
      yield* buildTile(plan.load[0]);
      doneTiles++;
      plan = wantedTiles();
    }
    streets.done();
    moreBuildings.done();

    const surroundingsStage = new THREE.Group();
    yield* tracked(buildHorizon(surroundingsStage), suburbs, 200);
    const scenery = buildMovingScenery(surroundingsStage);
    yield revealStage(surroundingsStage);
    movingScenery = scenery;
    dynamicRoots.push(scenery.group);
    {
      const [shadow, storage] = shadowOf();
      yield* setupSceneCullingSteps(scene, [surroundingsStage, landmarkStage], shadow, storage);
    }

    yield* rebuildDetails({ details });
    traffic.begin();
    const { x: startX, z: startZ } = here();
    yield* rebuildTraffic(startX, startZ, { traffic });
    traffic.done();
    finishing.done();
    setDrawDistance(quality.drawDistance);
    worldCompleteAt = performance.now();
    console.log(`[world] complete at ${Math.round(worldCompleteAt)} ms`);
    if (debugFrames) console.log(`[world] steps: ${progress.timings().map(([label, ms]) => `${label} ${ms}ms`).join(', ')}`);

    // From here on, keep up with the player. One thing at a time, the ground under them first, so a frame never pays for much.
    let detailsAt = { x: startX, z: startZ };
    let detailsDoneAt = detailsAt; // where street furniture was last put out round, once it's done: null while it's being done
    let plannedAt = -Infinity, plannedX = Infinity, plannedZ = Infinity;
    for (;;) {
      const { x, z } = here();
      // Nothing to do most frames: only look again after a while, or a little way on
      if (performance.now() - plannedAt < 1000 && (x - plannedX) ** 2 + (z - plannedZ) ** 2 < 400) {
        yield IDLE;
        continue;
      }
      plannedAt = performance.now();
      plannedX = x;
      plannedZ = z;
      const next = wantedTiles();
      if (worldCompleteAt !== null) followStreaming(x, z, next, detailsAt, detailsDoneAt);
      keepToBudget(performance.now());
      for (const key of next.drop) dropTile(key);
      for (const t of heldTiles()) {
        // Held for a moment by something else, like a jump across the map
        if (!builtTiles.has(t.key) && Math.hypot((t.ix + 0.5) * TILE - x, (t.iz + 0.5) * TILE - z) > tileRange + 2000) releaseTile(t.key);
      }
      if (next.load.length && !groundReady(x, z, 600)) {
        yield* buildTile(next.load[0]);
      } else if (Math.hypot(x - detailsAt.x, z - detailsAt.z) > REBUILD_AFTER * (flying() ? 1.5 : 1)) {
        detailsAt = { x, z };
        detailsDoneAt = null;
        yield* groundFirst(rebuildDetails());
        detailsDoneAt = { x, z };
        yield* groundFirst(rebuildTraffic(x, z));
      } else if (Math.hypot(x - windowAt.x, z - windowAt.z) > TRAFFIC_RADIUS * (flying() ? 0.75 : 0.4)) {
        yield* groundFirst(rebuildTraffic(x, z));
      } else if (next.load.length) {
        yield* buildTile(next.load[0]);
      } else if (!(yield* nextFarSquare(x, z))) {
        yield IDLE;
        continue;
      }
      plannedAt = -Infinity; // something changed: there may be more
      yield;
    }
  }
  // The loading bar once the first build is done (js/progress.js). After a teleport: the ground and buildings in range, the street
  // furniture and the traffic, all of them, named for the suburb. On the move: only while the ground ahead isn't there yet, as when
  // flying faster than it comes in. A batch done within 300 ms never shows.
  function startStreaming(x, z, toLoad) {
    if (arrival && streaming && !streaming.full) {
      for (const t of streaming.tasks) t.done();
      streaming = null;
    }
    if (streaming) {
      if (arrival && streaming.arrival !== arrival) {
        streaming.arrival = arrival;
        streaming.tasks[0].rename(`Loading ${arrival.name || suburbAt(x, z) || 'the map'}`);
      }
      return;
    }
    const where = arrival?.name || suburbAt(x, z) || 'the map';
    const full = !!arrival;
    const tasks = full
      ? progress.plan([[`Loading ${where}`, 3], ['Putting out street furniture', 1], ['Starting the traffic', 1]])
      : [progress.start(`Loading ${where}`, 1)];
    streaming = { full, tasks, total: Math.max(1, toLoad), arrival };
  }

  function followStreaming(x, z, next, detailsAt, detailsDoneAt) {
    const groundShort = next.load.length > 0 && !groundReady(x, z, 600);
    // A teleport in the middle of a short batch makes it a full one, and another teleport renames it
    if (arrival && streaming && !streaming.full) {
      for (const t of streaming.tasks) t.done();
      streaming = null;
    }
    if (arrival && streaming && streaming.arrival !== arrival) {
      streaming.arrival = arrival;
      streaming.total = Math.max(1, next.load.length);
      streaming.tasks[0].rename(`Loading ${arrival.name || suburbAt(x, z) || 'the map'}`);
    }
    if (!streaming && (arrival || groundShort)) startStreaming(x, z, next.load.length);
    if (!streaming) return;
    const [tiles, details, traffic] = streaming.tasks;
    streaming.total = Math.max(streaming.total, next.load.length);
    const tilesDone = streaming.full ? next.load.length === 0 : !groundShort;
    tiles.set(1 - next.load.length / streaming.total);
    if (tilesDone) tiles.done();
    if (!streaming.full) {
      if (tilesDone) streaming = null;
      return;
    }
    const detailsDone = !!detailsDoneAt && Math.hypot(x - detailsAt.x, z - detailsAt.z) <= REBUILD_AFTER * (flying() ? 1.5 : 1);
    const trafficDone = !!windowAt && Math.hypot(x - windowAt.x, z - windowAt.z) <= TRAFFIC_RADIUS * (flying() ? 0.75 : 0.4);
    if (detailsDone) details.done();
    if (trafficDone && detailsDone) traffic.done();
    if (tilesDone && detailsDone && trafficDone) {
      streaming = null;
      arrival = null;
    }
  }

  // The squares of the far level around (x, z), each its own stage: one more of them each time, or one gone. False when it's all as it should be.
  const FAR_KEEP = 1000; // m past the range before one is let go
  // A budget for what the game holds, by its own count (js/memory-estimate.js), since iOS gives no figure and kills a tab that holds
  // too much. Over it, the far level reaches less far, a kilometre at a time; back under, it reaches out again.
  const MEMORY_BUDGET = { low: 170, medium: 280, high: 420 }; // MB
  const FAR_REACH_LEAST = 2500; // m
  let farReach = quality.farRange, reachedAt = -Infinity;
  function keepToBudget(now) {
    const held = countMemory(now).total / 1048576, budget = MEMORY_BUDGET[quality.level] ?? MEMORY_BUDGET.medium;
    if (held > budget && farReach > FAR_REACH_LEAST && now - reachedAt > 3000) {
      farReach = Math.max(FAR_REACH_LEAST, farReach - 1000);
      reachedAt = now;
    } else if (held < budget * 0.8 && farReach < quality.farRange && now - reachedAt > 10000) {
      farReach = Math.min(quality.farRange, farReach + 1000);
      reachedAt = now;
    }
  }
  function* nextFarSquare(x, z, options = {}) {
    activity.label = 'far level';
    const { farSquaresNear } = cityCode;
    for (const [key, stage] of farStages) {
      if (farSquaresNear(x, z, farReach + FAR_KEEP).includes(key)) continue;
      farLevel.dropSquare(key);
      farStages.delete(key);
      disposeStage(stage);
      return true;
    }
    for (const key of farSquaresNear(x, z, farReach)) {
      if (farStages.has(key)) continue;
      const stage = new THREE.Group();
      stage.name = 'FarSquare';
      const meshes = yield* farLevel.addSquare(key, options);
      if (meshes.length) stage.add(...meshes);
      yield revealStage(stage);
      farStage.add(stage);
      stage.updateMatrixWorld(true);
      farStages.set(key, stage);
      farLevel.setSquareHeld(key, true);
      return true;
    }
    return false;
  }

  // Where the landmarks stand, and the tall towers with their names
  const LANDMARK_TILES = () => [...new Set([
    ...Object.values(LANDMARK_SITES).map(({ x, z }) => tileKeyAt(x, z)),
    ...TOWER_SIGNS.map(({ x, z }) => tileKeyAt(x, z)),
    ...bridgeTiles()
  ])].filter((key) => Object.hasOwn(GEO.tiles, key));
  function bridgeTiles() {
    const keys = [];
    for (let i = 0; i + 1 < GEO.bridge.length; i += 2) keys.push(tileKeyAt(GEO.bridge[i], GEO.bridge[i + 1]));
    return keys;
  }

  // 6. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let firstFrameDone = false;
  let grabWanted = null;
  let frameWork = null; // the longest piece of work in the last frame drawn: { label, ms }
  let seaSheet = null; // the sea, one sheet at sea level across the world (js/city-grid.js)
  // What the game holds by its own count, in bytes, worked out every couple of seconds (js/memory-estimate.js): { total, parts }
  let memory = { total: 0, parts: {} };
  let memoryAt = -Infinity;
  function countMemory(now, force = false) {
    if (!force && now - memoryAt < 2000) return memory;
    memoryAt = now;
    const { width, height } = renderer.domElement;
    memory = estimateMemory(scene, {
      'map data': heldBytes() * 3, // unpacked into JavaScript objects
      // The frame's own buffers: colour, depth and the post-processing passes, about 32 bytes a pixel in all
      'screen buffers': width * height * 32
    });
    return memory;
  }
  const shadowFocus = new THREE.Vector3();
  const MAX_FRAMES_IN_FLIGHT = 2;
  let framesInFlight = 0;
  let fastSinceFrame = 0;

  if (elFps) elFps.textContent = '60';

  // Read-only view for tools/play, which steers through real input events and only uses this to check the result.
  const debugFrames = new URLSearchParams(location.search).get('debug') === '1'
    ? { simMs: 0, submitMs: 0, count: 0, gaps: [], lastStart: performance.now() }
    : null;
  if (debugFrames) {
    window.__gameDebug = Object.freeze({
      places: TELEPORT_LOCATIONS,
      load: () => ({ stages: Object.fromEntries(initTimings), interactiveAt: interactiveAt ?? null }),
      clock: () => elapsed,
      // For tools/build-map-images.mjs
      async prepareMapImages() {
        mapSystem.toggleFullMap(true);
        mapSystem.toggleFullMap(false);
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      mapImage: (x0, z0, size, px, buildings) => mapSystem.renderImage(x0, z0, size, px, buildings),
      farBuildings: async (key) => (await fetchFarFile(key)).buildings,
      interior: () => interiors.state(),
      // What the walker can bump into within r of (x, z): each collider's bounds and heights, and whether it's a model's (`level`)
      collidersNear: (x, z, r) => controllerManager.nearColliders(x, z, r)
        .filter((c) => c.maxX > x - r && c.minX < x + r && c.maxZ > z - r && c.minZ < z + r)
        .map((c) => ({ minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ, minY: c.minY ?? 0, maxY: c.maxY, baseY: c.baseY, level: !!c.level,
          outer: c.polygon?.outer?.map((p) => [p.x, p.z]) ?? null, obb: !!c.obb })),
      // F, as a scenario presses it
      use: () => useInterior(),
      seaShown: () => seaSheet?.visible ?? null,
      farReach: () => farReach,
      streaming: () => streaming && { full: streaming.full, total: streaming.total, arrival: streaming.arrival, tasks: streaming.tasks.map((t) => ({ ...t.task })) },
      lastSession: () => lastNote,
      // What the game holds by its own count, in MB, with the largest parts
      memory: (split = null) => {
        const m = split ? estimateMemory(scene, {}, { split }) : countMemory(performance.now(), true);
        return { total: Math.round(m.total / 1048576), parts: Object.fromEntries(Object.entries(m.parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / 1048576)])) };
      },
      gpuMemory: () => ({ ...renderer.info.memory }),
      origin: () => ({ ...origin }),
      setOrigin: (x, z) => setOrigin(scene, x, z),
      // Everything rewrites what it draws, with no time going by
      rewrite: () => simulate(0, performance.now()),
      auditPrecision: () => auditPrecision(scene),
      paused: () => pauseMenu.isOpen,
      worldCompleteAt: () => worldCompleteAt,
      progress: () => ({ ...progress.state(), shown: progress.shown, timings: progress.timings() }),
      depthMode: () => ({ reversed: !!renderer.reversedDepthBuffer, logarithmic: !!renderer.logarithmicDepthBuffer, near: cameraSystem.camera.near, far: cameraSystem.camera.far }),
      holdStill(on) {
        holdStill = !!on;
        lightingSystem.sky.cloudSpeed.value = on ? 0 : 0.000015;
      },
      grab: () => new Promise((resolve) => { grabWanted = resolve; }),
      // For pictures of the city alone
      showPlayer(on) {
        controllerManager.getActiveEntity().mesh.visible = !!on;
      },
      // For long scripted drives (npm run play -- --fast): the simulation stops following the wall clock and moves only
      // through advance(), as fast as it can step, with a frame drawn now and then.
      setFast(on) {
        fastClock = !!on;
      },
      advance(ms) {
        if (pauseMenu.isOpen) return elapsed;
        const steps = Math.max(1, Math.round((ms / 1000) * 60));
        for (let i = 0; i < steps; i++) simulate(1 / 60, performance.now());
        fastSinceFrame += ms;
        if (fastSinceFrame >= 1000 && framesInFlight < MAX_FRAMES_IN_FLIGHT) {
          fastSinceFrame = 0;
          drawFrame();
        }
        return elapsed;
      },
      onDeck: () => !!controllerManager.getActiveEntity().deck,
      // The ground at (x, z) and the tops of the decks drawn over it, the Harbour Bridge's whole width counting: what a body on the ground
      // there is held to (js/surfaces.js solidUnder()), for the scenarios that check it never ends up inside one
      decksOver(x, z) {
        const tops = decksAt(x, z, 0).over.map((o) => o.y), bridge = deckOver(x, z, 0);
        if (bridge) tops.push(bridge.top);
        return { ground: groundHeight(x, z), tops };
      },
      // Which side of the road every car on a two-way street is on, measured from where it actually is
      trafficSides() {
        const sides = { left: 0, right: 0 };
        for (const car of trafficSystem?.cars ?? []) {
          const e = car.edge;
          if (!e?.opposite || car.conn) continue;
          const lateral = -(car.x - e.x0) * e.dz + (car.z - e.z0) * e.dx;
          if (lateral < -0.3) sides.left++;
          else if (lateral > 0.3) sides.right++;
        }
        return sides;
      },
      // The people out within r of (x, z), each as [x, z, on a garden's path (js/pedestrian-routes.js)]
      walkers(x, z, r = 300) {
        return (trafficSystem?.peds ?? []).filter((p) => p.placed && Math.hypot(p.x - x, p.z - z) <= r).map((p) => [p.x, p.z, p.path ? 1 : 0]);
      },
      // Where the corridor heads from (x, z), for steering across the bridge
      bridgeAim(x, z, direction = 1) {
        // Across all of the deck's roads: the southbound and the Cahill's lanes run up to 28 m east of the corridor's line
        const here = bridgeAt(x, z, DECK_REACH);
        if (!here) return null;
        const along = (m) => bridgePoint(Math.max(0, Math.min(BRIDGE_LENGTH, here.s + m * direction)));
        const ahead = along(22), at = along(0), next = along(2);
        // west, east: the deck's roads' outer edges here, m east of the corridor's line (js/bridge.js deckSpanAt). aheadWest, aheadEast:
        // where they are at the point ahead, for steering along an edge that comes in or goes out
        const span = deckSpanAt(here.s), far = deckSpanAt(Math.max(0, Math.min(BRIDGE_LENGTH, here.s + 22 * direction)));
        return { h: Math.atan2(ahead.x - x, ahead.z - z), tangent: Math.atan2(next.x - at.x, next.z - at.z),
          aheadX: ahead.x, aheadZ: ahead.z, s: Math.round(here.s), off: +here.off.toFixed(1), y: +here.y.toFixed(1), west: span.west, east: span.east,
          aheadWest: far.west, aheadEast: far.east };
      },
      // A place on the bridge's corridor s metres from its south end: its centre, the normal to the east and the heading north
      bridgePlace(s) {
        const p = bridgePoint(Math.max(0, Math.min(BRIDGE_LENGTH, s)));
        const span = deckSpanAt(Math.max(0, Math.min(BRIDGE_LENGTH, s)));
        return { x: p.x, z: p.z, nx: -p.uz, nz: p.ux, h: Math.atan2(p.ux, p.uz), west: span.west, east: span.east };
      },
      // For looking at the city, and for putting a scenario where it needs to start. `deck` puts the player on the Harbour Bridge's deck
      // above (x, z) instead of the street under it.
      // Resolves once the map is there and the traffic around it, whatever had to be fetched.
      async goto(x, z, heading, mode, deck = false, altitude = null) {
        if (mode) selectMode(mode);
        // On the deck, what's under (x, z) has to be held before it can be found
        await holdTiles(tilesNear(x, z, 60));
        let result = null;
        if (altitude !== null) controllerManager.teleportActiveTo(x, z, heading, altitude);
        else if (!deck) result = teleportTo(x, z, heading);
        else {
          // Up on the highest structure there, the Harbour Bridge's deck if it's over (x, z)
          const top = structuresAt(x, z).sort((a, b) => b.y - a.y)[0];
          controllerManager.teleportActiveTo(x, z, heading, null, top?.sid ?? 0);
        }
        // Drawn at the new height at once: waiting for the map can take many frames, or none under the fast clock
        standOnSurfaces();
        await window.__gameDebug.mapReady(x, z);
        return result;
      },
      // The camera put at (x, y, z), looking at (tx, ty, tz), with the player on foot below where it looks so the city there is
      // built; null to give the camera back
      async view(from, to) {
        if (!from) {
          cameraSystem.fixedView = null;
          return;
        }
        await window.__gameDebug.goto(to[0], to[2], 0, 'person');
        cameraSystem.fixedView = { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to) };
      },
      // Waits for the map and traffic around (x, z)
      async mapReady(x, z, timeout = 90000) {
        const until = performance.now() + timeout;
        const ready = () => worldCompleteAt !== null && groundReady(x, z, 500) && windowAt && Math.hypot(windowAt.x - x, windowAt.z - z) < TRAFFIC_RADIUS * 0.5;
        while (!ready() && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
        return ready();
      },
      // Holds the whole map's roads while `fn` works out something that needs them all, like a route for a scenario
      // The tiles in a box around some points, for as long as it takes to work something out over them
      async withMapAround(points, fn, margin = 2500) {
        const x0 = Math.min(...points.map((p) => p.x)) - margin, x1 = Math.max(...points.map((p) => p.x)) + margin;
        const z0 = Math.min(...points.map((p) => p.z)) - margin, z1 = Math.max(...points.map((p) => p.z)) + margin;
        const keys = Object.keys(GEO.tiles).filter((key) => {
          const [ix, iz] = key.split('_').map(Number);
          return (ix + 1) * TILE > x0 && ix * TILE < x1 && (iz + 1) * TILE > z0 && iz * TILE < z1;
        });
        const before = new Set(heldTiles().map((t) => t.key));
        await holdTiles(keys);
        const result = fn();
        for (const t of heldTiles()) if (!before.has(t.key) && !builtTiles.has(t.key)) releaseTile(t.key);
        return result;
      },
      waitingForGround: () => !!awaitingGround,
      groundWaits: () => groundWaits.slice(),
      tileState: () => ({ known: Object.keys(GEO.tiles), built: [...builtTiles.keys()], done: [...builtTiles].filter(([, r]) => r.done).map(([k]) => k), held: heldTiles().map((t) => t.key), windowAt, colliders: controllerManager.colliders.length, gpu: { ...renderer.info.memory } }),
      quality: () => ({ choice: quality.choice, level: quality.level, pixelRatio: renderer.getPixelRatio() }),
      trafficNear: (x, z, radius) => [...(trafficSystem?.cars ?? []), ...(trafficSystem?.buses ?? [])]
        .filter((v) => v.edge && Math.hypot(v.x - x, v.z - z) < radius)
        .map((v) => ({ x: v.x, z: v.z, y: v.ry, deck: !!v.edge.deck, sid: v.edge.sid || 0, speed: v.speed, struck: v.impactTime > 0 })),
      // What each car is doing, for working out why traffic has stopped
      trafficDetail: (x, z, radius) => [...(trafficSystem?.cars ?? []), ...(trafficSystem?.buses ?? [])]
        .filter((v) => v.edge && Math.hypot(v.x - x, v.z - z) < radius)
        .map((v) => ({ x: Math.round(v.x), z: Math.round(v.z), speed: +v.speed.toFixed(1), link: v.edge.link, edge: v.edge.id, lane: v.lane, lanes: v.edge.lanes.length, s: Math.round(v.s), len: Math.round(v.edge.len),
          deck: !!v.edge.deck, wait: +(v.wait || 0).toFixed(1), conn: !!v.conn, turn: v.move?.turn, to: v.move?.to?.id, toLink: v.move?.to?.link, toLanes: v.move?.to?.lanes.length, out: v.move?.out?.[v.lane], yielding: !!v.yielding, signal: !!v.edge.to.signal, moves: v.edge.moves.length, axis: v.edge.axisIndex, why: v.speed < 0.5 ? trafficSystem.holdingBack(v) : '', acc: +(v.acc ?? 0).toFixed(2), impact: +(v.impactTime ?? 0).toFixed(2), panic: v.panicUntil > 0, nose: +(v.nose ?? 0).toFixed(2), bus: !!v.bus, evade: +(v.evade ?? 0).toFixed(1), commit: !!v.commit, out2: v.out })),
      // The ways into each signalled junction near (x, z), and what its lights show them, for the scenarios on signals
      signalApproaches: (x, z, radius) => (trafficSystem?.network.nodes ?? [])
        .filter((n) => n.signal && Math.hypot(n.x - x, n.z - z) < radius)
        .flatMap((n) => n.in.map((e) => ({
          x: e.sx + e.dx * e.len + e.rx * e.lanes[0], z: e.sz + e.dz * e.len + e.rz * e.lanes[0], dx: e.dx, dz: e.dz, len: e.len, sid: e.sid || 0,
          junction: `${Math.round(n.x)},${Math.round(n.z)}`, group: e.lightGroup, showing: n.lights.phaseOf(e.lightGroup), groups: n.lights.groups.length, nodes: n.cluster.length
        }))),
      roadRoom: () => trafficSystem?.roadRoom(),
      recycled: () => trafficSystem?.recycled(),
      audioState: () => audioSystem.context?.state ?? 'none',
      input: () => ({ ...controllerManager.keys }),
      player() {
        const entity = controllerManager.getActiveEntity();
        const { x, y, z } = entity.position;
        const mode = controllerManager.activeMode;
        return {
          mode, x, y, z, heading: entity.heading, speed: entity.speed, onFootway: !!entity.onFootway, deck: !!entity.deck, footpath: walkable(x, z),
          ground: controllerManager.getGroundHeight(x, z, mode),
          roof: controllerManager.roofHeightAt(x, z, y),
          frame: simulatedFrames, surface: entity.surface || 0, surfaceY: surfaceHeight(entity.surface || 0, x, z, entity.surfaceY ?? null), drawnY: entity.mesh?.position.y ?? null
        };
      },
      // Where the player is on screen (-1..1 across and up, depth in m), how far round the camera is, and which way it
      // looks, for the camera scenarios
      framing() {
        const entity = controllerManager.getActiveEntity();
        const at = (entity.mesh ? entity.mesh.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(entity.position.x - origin.x, entity.position.y, entity.position.z - origin.z));
        at.y += entity.type === 'car' ? 0.7 : 1;
        const camera = cameraSystem.camera;
        camera.updateMatrixWorld();
        const depth = at.clone().applyMatrix4(camera.matrixWorldInverse).z * -1;
        const screen = at.clone().project(camera);
        const look = cameraSystem.currentLookAt, from = cameraSystem.currentPos;
        return {
          x: screen.x, y: screen.y, depth, heading: entity.heading, orbit: cameraSystem.orbitYawOffset, pitch: cameraSystem.orbitPitchOffset,
          viewYaw: Math.atan2(look.x - from.x, look.z - from.z), following: !!entity.followingView, speed: entity.speed,
          // The rider's helmet over the bike as each is drawn
          riderUp: entity.type === 'cyclist' && entity.helmet ? entity.helmet.position.y - entity.mesh.position.y : null
        };
      },
      // Where the walker's head and pelvis are drawn, in the world and on the screen (-1..1), with the camera, for measuring how
      // smoothly each moves from frame to frame (tools/play/walk-trace.mjs)
      personPose() {
        const p = controllerManager.entities.person;
        const rig = p?.rig;
        if (!rig?.placed) return null;
        const a = rig.pose;
        const base = surfaceHeight(p.surface || 0, p.position.x, p.position.z, p.surfaceY ?? null);
        const camera = cameraSystem.camera;
        camera.updateMatrixWorld();
        // Each bone's joint, as PersonRig.writeBone() stored it, and as PersonCrowd.add() stands it on the ground
        const joint = (b) => {
          const o = b * 8;
          const v = rig.bind[b].clone().applyQuaternion(new THREE.Quaternion(a[o], a[o + 1], a[o + 2], a[o + 3])).multiplyScalar(a[o + 7]);
          const world = [a[o + 4] + v.x + rig.poseOriginX, a[o + 5] + v.y + base, a[o + 6] + v.z + rig.poseOriginZ];
          const screen = new THREE.Vector3(world[0] - origin.x, world[1], world[2] - origin.z).project(camera);
          return { world, screen: [screen.x, screen.y] };
        };
        return {
          t: performance.now(), frame: simulatedFrames, x: p.position.x, z: p.position.z, heading: p.heading, speed: p.speed,
          gait: rig.gait, run: rig.run, phase: rig.phase, swing: rig.feet.map((f) => f.swing), pelvisY: rig.pelvisY, standY: rig.standY,
          head: joint(2), pelvis: joint(0),
          camera: [camera.position.x + origin.x, camera.position.y, camera.position.z + origin.z]
        };
      },
      // The camera as drawn, on the ground or structure under the player
      camera: () => {
        const { x, y, z } = cameraSystem.camera.position;
        const player = controllerManager.getActiveEntity();
        const sid = player.surface || 0;
        const bodyY = surfaceHeight(sid, player.position.x, player.position.z, player.surfaceY ?? null) + Math.max(0, player.position.y);
        return {
          aspect: cameraSystem.camera.aspect, fov: cameraSystem.camera.fov, x, y, z, shelter: lightingSystem.shelter,
          ceiling: Math.min(ceilingOver(sid, bodyY, player.position.x, player.position.z), ceilingOver(sid, bodyY, x, z))
        };
      },
      // A route can run past the tiles held
      route: (waypoints) => window.__gameDebug.withMapAround(waypoints, () => roadRoute(waypoints)),
      handover: () => trafficSystem?.handover ?? { count: 0, kept: 0, lost: 0 },
      // Averages since the previous read, so a script can measure one stretch of play
      frameCost() {
        const { simMs, submitMs, count, gaps } = debugFrames;
        Object.assign(debugFrames, { simMs: 0, submitMs: 0, count: 0, gaps: [] });
        gaps.sort((a, b) => a - b);
        const at = (q) => Number((gaps[Math.floor(gaps.length * q)] ?? 0).toFixed(1));
        const seconds = gaps.reduce((sum, gap) => sum + gap, 0) / 1000;
        return {
          simMs: simMs / (count || 1), submitMs: submitMs / (count || 1), frames: count,
          fps: Number((count / (seconds || 1)).toFixed(1)), p50: at(0.5), p95: at(0.95), p99: at(0.99)
        };
      },
      // What's in the scene and showing, by name: meshes and triangles, biggest first
      sceneStats() {
        const byName = new Map();
        const walk = (o) => {
          if (!o.visible) return;
          if (o.isMesh && o.geometry) {
            const key = o.name || o.parent?.name || o.material?.type || 'mesh';
            const entry = byName.get(key) ?? byName.set(key, { name: key, meshes: 0, triangles: 0 }).get(key);
            entry.meshes++;
            entry.triangles += ((o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3) * (o.isInstancedMesh ? o.count : 1);
          }
          for (const child of o.children) walk(child);
        };
        walk(scene);
        return [...byName.values()].sort((a, b) => b.triangles - a.triangles).slice(0, 30);
      },
      renderInfo() {
        const { render } = renderer.info;
        return { backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2', drawCalls: render.drawCalls, triangles: render.triangles };
      }
    });
  }

  const frameWatcher = new FrameWatcher(quality, {
    storage: localStorage,
    onPixelScale: (scale) => renderer.setPixelRatio(quality.pixelRatio / quality.pixelScale * scale)
  });

  renderer.setAnimationLoop((now) => {
    const resized = resizePending;
    if (resized) applyViewportSize();
    if (pauseMenu.isOpen) {
      lastTime = now;
      gamepadControls.update(0); // its pause button has to keep working
      if (resized) renderFrame();
      return;
    }

    // Submitting faster than the GPU finishes fills the queue until the browser stalls the page for several frames at
    // once, a 17, 17, 100 ms rhythm that feels worse than an even pace at the same average. Skip until it has caught up.
    // Two frames stay in flight: the completion signal arrives late, so waiting for every frame halves the frame rate.
    if (framesInFlight >= MAX_FRAMES_IN_FLIGHT) return;

    // Scripts looking for flicker draw the same moment over and over (tools/play/flicker.mjs)
    if (holdStill) {
      lastTime = now;
      renderFrame();
      if (grabWanted) {
        grabWanted(renderer.domElement.toDataURL('image/jpeg', 0.85));
        grabWanted = null;
      }
      return;
    }

    // A script is moving the world through advance(): only draw when it wants a picture
    if (fastClock) {
      lastTime = now;
      if (grabWanted) drawFrame();
      return;
    }

    const frameStart = debugFrames && performance.now();
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    if (worldCompleteAt !== null) frameWatcher.update(rawDt); // building the city slows frames on purpose
    const t0 = performance.now();
    simulate(dt, now);

    const simEnd = debugFrames && performance.now();
    const t1 = performance.now();

    drawFrame();
    const t2 = performance.now();
    // The rest of the city gets what this frame left of a 30 FPS budget
    // While the first city goes up, whatever a frame has spare. After that the player comes first: the map only has to keep ahead.
    const spare = 33 - (performance.now() - frameStart);
    // And behind the fade after a teleport, there's nothing to play yet: as fast as it'll go.
    worldBuilder?.step(worldCompleteAt === null || awaitingGround ? Math.max(4, Math.min(20, spare)) : Math.max(2, Math.min(6, spare - 4)));
    // What this frame spent longest on, for the next frame to blame if it comes late (?stats=1)
    frameWork = t1 - t0 > t2 - t1 ? { label: 'simulation', ms: t1 - t0 } : { label: 'drawing', ms: t2 - t1 };
    if (worldBuilder?.longest && worldBuilder.longest.ms > frameWork.ms) frameWork = worldBuilder.longest;
    if (debugFrames) {
      debugFrames.simMs += simEnd - frameStart;
      debugFrames.submitMs += performance.now() - simEnd;
      debugFrames.count++;
      debugFrames.gaps.push(frameStart - debugFrames.lastStart);
      debugFrames.lastStart = frameStart;
    }
    if (!firstFrameDone) {
      firstFrameDone = true;
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame, i.e. until the city is on screen
      const device = renderer.backend.device;
      if (loadingStatus) loadingStatus.textContent = 'Waiting for graphics to finish the first frame...';
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.map(([label, ms]) => `${label} ${ms}ms`).join(', ')}`);
        interactiveAt = performance.now();
        phoneHud.showHint();
        interactive = true;
        showStats();
        try {
          startSessionNote(localStorage, () => {
            const { x, z } = controllerManager.getActiveEntity().position;
            return { x: Math.round(x), z: Math.round(z), mode: controllerManager.activeMode, memoryMB: Math.round(memory.total / 1048576), tiles: builtTiles.size };
          });
        } catch { /* no storage: nothing to note */ }
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        audioSystem.ready = true;
        audioSystem.prepareSounds();
        setLoadingProgress(1);
        worldBuilder = new WorldBuilder(buildRestOfWorld());
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const kmh = Math.round(Math.abs(activeEnt.speed) * 3.6);
      const altitude = Math.max(0, Math.round(activeEnt.position.y + surfaceHeight(activeEnt.surface || 0, activeEnt.position.x, activeEnt.position.z)));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(kmh);
      if (elMiniSpeed) elMiniSpeed.textContent = String(kmh);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, kmh / (topSpeedKmh[mode] || 130))})`;
      if (elAltitude) elAltitude.textContent = altitude.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(getLocationLabel(where.x, where.z));
    }
  });

  // One step of the world: everything that moves, then each thing lifted onto the surface under it. dt in seconds.
  const groundUnder = (entity) => surfaceHeight(entity.surface || 0, entity.position.x, entity.position.z, entity.surfaceY ?? null);
  function standOnSurfaces() {
    for (const entity of Object.values(controllerManager.entities)) {
      const p = entity.position;
      entity.mesh.rotation.order = 'YXZ';
      if (entity.type === 'car') {
        const rest = wheelContacts(p.x, p.z, entity.heading, entity.surface || 0, entity.surfaceY ?? null);
        entity.mesh.position.y = p.y + rest.y;
        entity.mesh.rotation.x = -rest.pitch;
        entity.mesh.rotation.z = rest.roll;
        continue;
      }
      entity.mesh.position.y = p.y + groundUnder(entity);
      if (entity.type === 'cyclist') {
        const slope = surfaceSlope(entity.surface || 0, p.x, p.z, Math.sin(entity.heading), Math.cos(entity.heading), entity.surfaceY ?? null);
        entity.mesh.rotation.x = -Math.atan(slope);
      }
    }
  }

  let simulatedFrames = 0;
  function simulate(dt, now) {
    simulatedFrames++;
    elapsed += dt;
    // First, before anything writes what it'll draw this frame from where the origin is
    if (cameraSystem.initialized) moveOriginNear(scene, cameraSystem.currentPos.x, cameraSystem.currentPos.z);

    if (awaitingGround && (groundReady(awaitingGround.x, awaitingGround.z) || now > awaitingGround.until)) {
      groundWaits.push(Math.round(now - awaitingGround.since));
      // Its spot was chosen before the buildings here existed: now choose again, or the player could be standing inside one
      const { askedX, askedZ, heading } = awaitingGround;
      awaitingGround = null;
      controllerManager.teleportActiveTo(askedX, askedZ, heading);
      standOnSurfaces();
      document.getElementById('mode-fade')?.classList.remove('fading');
    }

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    gamepadControls.update(dt);
    if (!awaitingGround) controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null);
    // Outrunning the map: slow down near the edge of what's drawn, rather than drive off it
    if (worldCompleteAt !== null && controllerManager.activeMode !== 'helicopter') {
      const active = controllerManager.getActiveEntity();
      if (Math.abs(active.speed) > EDGE_SPEED && !groundReady(active.position.x, active.position.z, EDGE_REACH)) {
        const slow = Math.max(0.9, 1 - dt * 2);
        active.speed *= slow;
        if (active.vx !== undefined) { active.vx *= slow; active.vz *= slow; }
      }
    }
    cameraSystem.update(dt, elapsed);
    if (streetDetails) {
      streetDetails.signalClock.value = elapsed;
      streetDetails.updateSignals(elapsed, dt, trafficSystem);
    }
    trafficSystem?.setParked(controllerManager.parkedCar());
    trafficSystem?.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    movingScenery?.update(elapsed);
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(cameraSystem.camera);
    streetDetails?.update?.(cameraSystem.camera);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    // The world so far is the flat simulation. What gets drawn stands on its surface (js/surfaces.js): the ground, or
    // the bridge, viaduct or tunnel it's on. Everyone moved a moment ago, and the next frame rewrites these from their
    // flat state. A car rests on its four wheels, pitched and rolled to the surface under each.
    standOnSurfaces();
    // Following the player, the camera rides on their ground; a scenic one on its own
    const eye = cameraSystem.camera.position;
    const follows = !cameraSystem.fixedView && cameraSystem.getActivePreset().category === 'follow';
    const followed = controllerManager.getActiveEntity();
    // A view put somewhere by hand (__gameDebug.view()) is where it was put, in the world's own heights
    const eyeGround = cameraSystem.fixedView ? 0 : follows ? groundUnder(followed) : groundHeight(eye.x, eye.z);
    eye.y += eyeGround;
    const bodyY = eyeGround + Math.max(0, followed.position.y);
    {
      // Doors, seats and the rooms seen from the camera, now it's where it'll be drawn from. In a building or beside one, a following
      // camera is kept clear of its walls, floors and ceilings, looking on from over your head, and comes in as near as 0.1 m to them.
      const head = follows ? { x: followed.position.x, y: bodyY + 1.8, z: followed.position.z } : null;
      const here = interiors.update(dt, followed, controllerManager.activeMode, eye, cameraSystem.camera.getWorldDirection(lookDirection), head);
      setIndoors(here.indoors);
      indoorShelter = here.shelter ?? 0.85;
      showPrompt(here.prompt);
      const near = here.kept ? 0.1 : 0.35;
      if (cameraSystem.camera.near !== near) {
        cameraSystem.camera.near = near;
        cameraSystem.camera.updateProjectionMatrix();
      }
      // Right over your head, you'd fill the view: you aren't drawn (your crowd of one shows you again next frame, js/pedestrians.js)
      if (here.close && controllerManager.activeMode === 'person') for (const m of followed.crowd?.meshes ?? []) m.visible = false;
    }
    if (follows) {
      // Under a tunnel's roof or a deck, the camera stays under it too, over the player and where it is itself
      const sid = followed.surface || 0, { x, z } = followed.position;
      const top = Math.min(ceilingOver(sid, bodyY, x, z), ceilingOver(sid, bodyY, eye.x, eye.z));
      if (eye.y > top - 0.6) eye.y = Math.max(bodyY + 0.8, top - 0.6);
      // Inside a tunnel the sky's light fades out, and back in at the far portal. Inside a house, some comes in through its windows.
      const eyeInTube = inTunnel(sid, eye.x, eye.z);
      const shelterGoal = indoors ? indoorShelter : inTunnel(sid, x, z) && eyeInTube ? 1 : 0;
      lightingSystem.setShelter(lightingSystem.shelter + (shelterGoal - lightingSystem.shelter) * Math.min(1, dt * 2.5));
      // A tunnel that goes below sea level has the sea's sheet running through it. From inside a closed tube nothing outside
      // shows anyway, so the sea isn't drawn while the camera's in one.
      if (seaSheet) seaSheet.visible = !eyeInTube;
    } else {
      lightingSystem.setShelter(0);
      if (seaSheet) seaSheet.visible = true;
    }
    cameraSystem.camera.updateMatrixWorld();
    updateTunnelMouths(eye.x, eye.z);
    shadowFocus.copy(cameraSystem.currentPos);
    shadowFocus.y += eyeGround;
    lightingSystem.update(shadowFocus);
    updateSceneCulling(eye);
    // Traffic collisions can move the player after controller updates; finalize moving hierarchies here.
    for (const root of dynamicRoots) root.updateMatrixWorld();
  }

  // Render frame via TSL RenderPipeline (SSR + Bloom)
  function drawFrame() {
    renderFrame();
    if (grabWanted) {
      grabWanted(renderer.domElement.toDataURL('image/jpeg', 0.85)); // Inside the frame: a WebGPU canvas is blank after it
      grabWanted = null;
    }
    if (firstFrameDone && renderer.backend.device) {
      framesInFlight++;
      renderer.backend.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => { framesInFlight--; });
    }
  }
}

initApp();
