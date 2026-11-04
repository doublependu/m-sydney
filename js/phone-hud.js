// The HUD on a phone: everything that isn't needed while driving goes behind one button, so it covers as little of the city as
// possible. What's left fades back after a few seconds without a touch. css/style.css has the layout: this only says what's
// open. On any bigger screen, or with a mouse, it stays out of the way.

const IDLE_MS = 4000;
const STREET_MS = 4000;
const HINT_KEY = 'sydney-stick-hint';

class PhoneHud {
  constructor({ body = document.body, storage = localStorage } = {}) {
    this.body = body;
    this.storage = storage;
    this.menuButton = document.getElementById('btn-phone-menu');
    this.toolbar = document.getElementById('hud-toolbar');
    this.modes = document.getElementById('mode-switch');
    this.location = document.getElementById('hud-location');
    this.hint = document.getElementById('touch-hint');
    this.compact = window.matchMedia('(max-width: 600px), (max-height: 600px)');
    if (!this.menuButton) return;

    this.menuButton.addEventListener('click', () => this.setMenu(!this.body.classList.contains('phone-menu-open')));
    document.addEventListener('pointerdown', (event) => this.touched(event), { capture: true, passive: true });

    // The mode bar shows only the current mode: a tap on it opens the others, and choosing one closes them
    this.modes?.addEventListener('click', (event) => {
      if (!this.active()) return;
      const button = event.target.closest?.('.mode-btn');
      if (!button) return;
      if (!this.modes.classList.contains('is-open')) {
        event.stopPropagation();
        this.setModes(true);
      } else this.setModes(false);
    }, { capture: true });

    // The street's name shows when it changes, then gets out of the way
    if (this.location) {
      new MutationObserver(() => {
        this.location.classList.add('is-fresh');
        clearTimeout(this.streetTimer);
        this.streetTimer = setTimeout(() => this.location.classList.remove('is-fresh'), STREET_MS);
      }).observe(this.location, { childList: true });
    }
    // A HUD hidden with the eye button on a bigger screen would have no way back here, where there's no eye button
    if (this.active()) this.body.classList.remove('hud-minimized');
    this.wake();
  }

  /** Only on a touch screen small enough for the compact layout */
  active() {
    return this.body.classList.contains('touch-enabled') && this.compact.matches;
  }

  setMenu(open) {
    if (open) {
      // The rest of the sheet hangs below the toolbar, which is one row or two by the screen's width
      this.body.classList.add('phone-menu-open');
      const bottom = this.toolbar?.getBoundingClientRect().bottom ?? 120;
      document.documentElement.style.setProperty('--phone-sheet-y', `${Math.round(bottom + 8)}px`);
    } else this.body.classList.remove('phone-menu-open');
    this.menuButton.setAttribute('aria-expanded', String(open));
  }

  setModes(open) {
    this.modes?.classList.toggle('is-open', open);
    this.body.classList.toggle('phone-modes-open', open);
  }

  touched(event) {
    this.wake();
    const target = event.target;
    if (!target?.closest) return;
    // A touch anywhere else closes what's open
    if (this.body.classList.contains('phone-menu-open')
      && !target.closest('#btn-phone-menu, #hud-toolbar, #hud-cluster, .brand, .popover')) this.setMenu(false);
    if (this.modes?.classList.contains('is-open') && !target.closest('#mode-switch')) this.setModes(false);
  }

  wake() {
    this.body.classList.remove('hud-idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.body.classList.contains('phone-menu-open') && !this.modes?.classList.contains('is-open')) this.body.classList.add('hud-idle');
    }, IDLE_MS);
  }

  /** How to drive, the first time. Goes at the first press of the stick, or by itself. */
  showHint(seconds = 8) {
    if (!this.hint || !this.body.classList.contains('touch-enabled')) return;
    let seen = null;
    try { seen = this.storage.getItem(HINT_KEY); } catch { /* Storage may be disabled */ }
    if (seen) return;
    this.hint.hidden = false;
    this.hintTimer = setTimeout(() => this.hideHint(), seconds * 1000);
  }

  hideHint() {
    if (!this.hint || this.hint.hidden) return;
    this.hint.hidden = true;
    clearTimeout(this.hintTimer);
    try { this.storage.setItem(HINT_KEY, '1'); } catch { /* Storage may be disabled */ }
  }
}

export { PhoneHud };
