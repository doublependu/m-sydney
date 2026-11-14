// The pause screen. A native modal <dialog> handles the focus trap and keeps the page behind it inert;
// main.js decides what pausing freezes through onOpen / onClose.

// The mouse speed (js/cameras.js, the locked mouse in first person on foot): times the default, a quarter to four times, kept in the
// browser. Its slider moves in powers of two, doubling every quarter of its length.
const MOUSE_KEY = 'sydney-mouse-speed';
const MOUSE_RANGE = [0.25, 4];
const clampSpeed = (m) => Math.max(MOUSE_RANGE[0], Math.min(MOUSE_RANGE[1], m));

function readMouseSpeed(storage = globalThis.localStorage) {
  try {
    const m = Number(storage?.getItem(MOUSE_KEY));
    return m > 0 && Number.isFinite(m) ? clampSpeed(m) : 1;
  } catch {
    return 1; // Storage may be disabled
  }
}

function saveMouseSpeed(m, storage = globalThis.localStorage) {
  try {
    storage?.setItem(MOUSE_KEY, String(m));
  } catch { /* Storage may be disabled or full */ }
}

const speedLabel = (m) => `${m < 1 ? m.toFixed(2) : m.toFixed(1)}×`;

class PauseMenu {
  constructor({ onOpen, onClose, canOpen = () => true, mouseSpeed = 1, onMouseSpeed = null, storage = globalThis.localStorage } = {}) {
    this.root = document.getElementById('pause-menu');
    this.resumeButton = document.getElementById('pause-resume');
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.canOpen = canOpen; // false once there's no game left to pause
    this.isOpen = false;

    this.resumeButton?.addEventListener('click', () => this.close());
    // Esc goes through close() so the game resumes with it, not only the dialog
    this.root?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });

    // The mouse speed: changed at once as the slider moves, and kept
    const slider = document.getElementById('pause-mouse-speed');
    const shown = document.getElementById('pause-mouse-value');
    if (slider) {
      slider.value = String(Math.log2(mouseSpeed));
      if (shown) shown.textContent = speedLabel(mouseSpeed);
      slider.addEventListener('input', () => {
        const m = clampSpeed(2 ** Number(slider.value));
        if (shown) shown.textContent = speedLabel(m);
        saveMouseSpeed(m, storage);
        onMouseSpeed?.(m);
      });
    }
  }

  open() {
    if (this.isOpen || !this.root || !this.canOpen()) return;
    this.isOpen = true;
    this.onOpen?.();
    this.root.showModal();
    this.resumeButton?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.close();
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}

export { PauseMenu, readMouseSpeed, saveMouseSpeed };
