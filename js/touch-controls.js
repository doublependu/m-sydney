// Touch input stays separate from the keyboard, so releasing a finger never releases a held key.
const DEAD_ZONE = 0.15;
const MAX_RADIUS = 44;
const RUN_REACH = 0.85; // of the stick's travel past which you run, on foot

class TouchControls {
  constructor(controllerManager) {
    this.controller = controllerManager;
    this.root = document.getElementById('touch-controls');
    this.zone = document.getElementById('touch-zone');
    this.stick = document.getElementById('touch-stick');
    this.knob = document.getElementById('touch-stick-knob');
    this.buttons = this.root ? [...this.root.querySelectorAll('[data-touch-action]')] : [];
    this.buttonPointers = new Map();
    this.stickPointer = null;
    this.enabled = true;
    this.available = false;
    this.firstPerson = false;
    this.touchSeen = false;
    this.onAvailabilityChange = null;
    this.onStickPressed = null;
    this.media = window.matchMedia('(any-pointer: coarse)');

    if (!this.root || !this.zone || !this.stick || !this.knob) return;

    // The stick appears wherever the thumb lands, and isn't drawn otherwise
    this.zone.addEventListener('pointerdown', (event) => {
      if (!this.canInteract() || event.button !== 0 || this.stickPointer !== null || this.buttonPointers.has(event.pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      this.stickCenter = { x: event.clientX, y: event.clientY };
      this.stick.style.setProperty('--stick-left', `${event.clientX}px`);
      this.stick.style.setProperty('--stick-top', `${event.clientY}px`);
      this.stickPointer = event.pointerId;
      this.zone.setPointerCapture(event.pointerId);
      this.stick.classList.add('is-pressed');
      this.onStickPressed?.();
      this.moveStick(event);
    });
    this.zone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.stickPointer) return;
      event.preventDefault();
      event.stopPropagation();
      this.moveStick(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.zone.addEventListener(type, (event) => this.releaseStick(event.pointerId));
    }

    for (const button of this.buttons) {
      const action = button.getAttribute('data-touch-action');
      button.addEventListener('pointerdown', (event) => {
        if (!this.canInteract() || button.hidden || event.button !== 0 || this.buttonPointers.has(event.pointerId) || event.pointerId === this.stickPointer) return;
        event.preventDefault();
        event.stopPropagation();
        this.buttonPointers.set(event.pointerId, { button, action });
        button.setPointerCapture(event.pointerId);
        this.updateButton(button, action);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        button.addEventListener(type, (event) => this.releaseButton(event.pointerId));
      }
    }

    this.media.addEventListener('change', () => this.updateAvailability());
    // Hybrid devices can report a fine pointer until their first touch. Capture runs before the control handlers.
    document.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || this.touchSeen) return;
      this.touchSeen = true;
      this.updateAvailability();
    }, { capture: true, passive: true });
    window.addEventListener('blur', () => this.reset());
    window.addEventListener('resize', () => this.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reset();
    });

    this.setMode(controllerManager.activeMode || 'car');
    this.updateAvailability();
  }

  canInteract() {
    return this.enabled && this.available && !document.hidden;
  }

  updateAvailability() {
    const available = this.media.matches || this.touchSeen;
    const changed = available !== this.available;
    if (changed) this.reset();
    this.available = available;
    document.body.classList.toggle('touch-enabled', available);
    this.root.hidden = !this.enabled || !available;
    if (changed && typeof this.onAvailabilityChange === 'function') this.onAvailabilityChange(available);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.reset();
    if (this.root) this.root.hidden = !this.enabled || !this.available;
  }

  setMode(mode) {
    if (!['person', 'car', 'cyclist', 'helicopter'].includes(mode)) return;
    this.reset();
    if (!this.root) return;
    const labels = { up: mode === 'helicopter' ? 'Ascend' : 'Jump', down: 'Descend' };
    for (const button of this.buttons) {
      const action = button.getAttribute('data-touch-action');
      button.hidden = (action === 'up' && mode !== 'person' && mode !== 'helicopter') || (action === 'down' && mode !== 'helicopter');
      button.setAttribute('aria-label', labels[action]);
      const label = this.root.querySelector(`[data-touch-label="${action}"]`);
      if (label) label.textContent = labels[action];
    }
  }

  // In first person on foot the stick's sideways steps you aside (js/controllers.js), and a drag on the right side turns you
  setFirstPerson(on) {
    on = !!on;
    if (on === this.firstPerson) return;
    this.firstPerson = on;
    this.zone?.setAttribute('aria-label', `Movement: touch and drag up or down to move, left or right to ${on ? 'step aside' : 'turn'}`);
  }

  moveStick(event) {
    const dx = event.clientX - this.stickCenter.x;
    const dy = event.clientY - this.stickCenter.y;
    const distance = Math.hypot(dx, dy);
    const reach = Math.min(distance / MAX_RADIUS, 1);
    const strength = Math.max(0, (reach - DEAD_ZONE) / (1 - DEAD_ZONE));
    const x = distance ? dx / distance : 0;
    const y = distance ? dy / distance : 0;
    this.knob.style.setProperty('--stick-x', `${x * reach * MAX_RADIUS}px`);
    this.knob.style.setProperty('--stick-y', `${y * reach * MAX_RADIUS}px`);
    this.controller.setTouchInput('left', Math.max(0, -x * strength));
    this.controller.setTouchInput('right', Math.max(0, x * strength));
    this.controller.setTouchInput('forward', Math.max(0, -y * strength));
    this.controller.setTouchInput('backward', Math.max(0, y * strength));
    this.controller.setTouchInput('run', strength >= RUN_REACH);
  }

  releaseCapture(element, pointerId) {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }

  releaseStick(pointerId) {
    if (pointerId !== this.stickPointer || this.stickPointer === null) return;
    this.stickPointer = null;
    this.releaseCapture(this.zone, pointerId);
    this.stick.classList.remove('is-pressed');
    this.knob.style.setProperty('--stick-x', '0px');
    this.knob.style.setProperty('--stick-y', '0px');
    for (const action of ['forward', 'backward', 'left', 'right', 'run']) this.controller.setTouchInput(action, 0);
  }

  updateButton(button, action) {
    const held = [...this.buttonPointers.values()];
    const pressed = held.some((pointer) => pointer.button === button);
    button.classList.toggle('is-pressed', pressed);
    button.setAttribute('aria-pressed', String(pressed));
    this.controller.setTouchInput(action, held.some((pointer) => pointer.action === action) ? 1 : 0);
  }

  releaseButton(pointerId) {
    const pointer = this.buttonPointers.get(pointerId);
    if (!pointer) return;
    this.buttonPointers.delete(pointerId);
    this.releaseCapture(pointer.button, pointerId);
    this.updateButton(pointer.button, pointer.action);
  }

  reset() {
    this.releaseStick(this.stickPointer);
    for (const pointerId of this.buttonPointers.keys()) this.releaseButton(pointerId);
    for (const button of this.buttons) {
      button.classList.remove('is-pressed');
      button.setAttribute('aria-pressed', 'false');
    }
    this.controller.clearTouchInput();
  }
}

export { TouchControls };
