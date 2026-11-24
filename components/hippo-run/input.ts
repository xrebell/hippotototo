/**
 * Keyboard + pointer -> timestamped, preallocated ring buffer of semantic InputEvents.
 * Owner: UI engineer.
 *
 * Behaviour (spec §3, CONTRACTS §6.1):
 *  - Action keys: Space / ArrowUp / W -> 'actionDown' on keydown (e.repeat ignored), 'actionUp'
 *    when the LAST held action key/pointer is released. Every new key/pointer press emits its own
 *    'actionDown' (two thumbs: a second thumb while the first is held is a second press).
 *  - ArrowDown / S -> 'slam'. P / Escape -> 'pause'. M -> 'mute'. R -> 'restart'.
 *    Enter / NumpadEnter -> 'confirm'. Letter shortcuts match the typed letter (e.key, so AZERTY
 *    and friends work) as well as the physical QWERTY position (e.code).
 *  - Pointer Events on the canvas (any pointer type; mouse: primary button only). The canvas
 *    button hook `hooks.hitTest(cssX, cssY)` runs FIRST: a press on a canvas button emits only
 *    'button' (never ACTION) and is not tracked as held. game.ts's hook converts CSS px to logical
 *    view units with the view metrics: ((cssX - padX) / s, cssY / s).
 *  - pointerup / pointercancel are listened to on `window`, so a release outside the canvas (or a
 *    cancelled touch) still releases. The canvas also captures the pointer when possible.
 *  - preventDefault: Space / arrow keydown (also on repeats, so held keys never scroll), canvas
 *    pointerdown, contextmenu, and selectstart / dragstart on the canvas.
 *  - hooks.onGesture() is called synchronously inside every keydown / pointerdown handler before
 *    queuing (AudioContext unlock must run inside the user gesture). It is also called on pointerup:
 *    browsers only grant user activation for touch on pointerup / touchend, so the first tap on a
 *    phone unlocks audio there. onGesture is idempotent and cheap.
 *  - Ring buffer of POOLS.inputEvents (32) records allocated once; when full, the OLDEST event is
 *    overwritten. next() copies into one pooled record (valid until the next call).
 *  - Last-device tracking ('keyboard' | 'mouse' | 'touch') for "TAP" vs "SPACE" prompts.
 *  - TWO_ZONE_TOUCH (config): left 40% of the canvas = 'slam', right 60% = 'actionDown' (ships false).
 *  - Keys with Ctrl / Meta / Alt are ignored so browser shortcuts keep working. Keydowns aimed at a
 *    focused link / button / form field / contenteditable (not the canvas or body) are left to that
 *    element (Enter follows the link); keyups still clear held keys but skip preventDefault.
 *  - pointerdown calls window.focus() and blurs a focused page control, so a click on the canvas
 *    takes the keyboard as a normal click would (preventDefault on pointerdown otherwise keeps focus
 *    on the host page of an iframe, or on a previously focused link).
 *  - The canvas gets touch-action / user-select / -webkit-touch-callout: none while mounted (the
 *    page CSS sets them too); previous inline values are restored by destroy().
 *  - Hot path: handlers allocate nothing except the browser's own event objects.
 */
import { POOLS, TWO_ZONE_SPLIT, TWO_ZONE_TOUCH } from './config';
import type { ButtonId, InputApi, InputDevice, InputEvent, InputHooks, InputKind } from './types';

/** Simultaneous action pointers tracked (extra contacts still press, they just are not tracked). */
const MAX_POINTERS = 10;
/** Simultaneous held action keys tracked (Space, ArrowUp, W, + layout variants). */
const MAX_KEYS = 6;

/** Semantic key classes. */
const K_NONE = 0;
const K_ACTION = 1;
const K_SLAM = 2;
const K_PAUSE = 3;
const K_MUTE = 4;
const K_RESTART = 5;
const K_CONFIRM = 6;

/** Map a keyboard event to a key class (no allocation: string compares only). */
function classifyKey(code: string, key: string): number {
  switch (code) {
    case 'Space':
    case 'ArrowUp':
    case 'KeyW':
      return K_ACTION;
    case 'ArrowDown':
    case 'KeyS':
      return K_SLAM;
    case 'Escape':
    case 'KeyP':
      return K_PAUSE;
    case 'KeyM':
      return K_MUTE;
    case 'KeyR':
      return K_RESTART;
    case 'Enter':
    case 'NumpadEnter':
      return K_CONFIRM;
    default:
      break;
  }
  // Fall back on the typed character (non-QWERTY layouts, virtual keyboards without `code`).
  switch (key) {
    case ' ':
    case 'Spacebar':
    case 'ArrowUp':
    case 'Up':
    case 'w':
    case 'W':
      return K_ACTION;
    case 'ArrowDown':
    case 'Down':
    case 's':
    case 'S':
      return K_SLAM;
    case 'Escape':
    case 'Esc':
    case 'p':
    case 'P':
      return K_PAUSE;
    case 'm':
    case 'M':
      return K_MUTE;
    case 'r':
    case 'R':
      return K_RESTART;
    case 'Enter':
      return K_CONFIRM;
    default:
      return K_NONE;
  }
}

/** Keys whose default action (page scroll) must be suppressed. */
function isScrollKey(code: string, key: string): boolean {
  return (
    code === 'Space' ||
    code === 'ArrowUp' ||
    code === 'ArrowDown' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight' ||
    key === ' ' ||
    key === 'Spacebar'
  );
}

function deviceOf(e: PointerEvent): InputDevice {
  return e.pointerType === 'mouse' ? 'mouse' : 'touch';
}

export function createInput(canvas: HTMLCanvasElement, hooks: InputHooks): InputApi {
  /* ---------------- ring buffer (allocated once) ---------------- */
  const cap = POOLS.inputEvents;
  const ring: InputEvent[] = [];
  for (let i = 0; i < cap; i++) {
    ring.push({ kind: 'actionDown', time: 0, device: 'keyboard', button: null, x: 0, y: 0 });
  }
  /** Record handed out by next(); copied from the ring so the slot is free immediately. */
  const out: InputEvent = { kind: 'actionDown', time: 0, device: 'keyboard', button: null, x: 0, y: 0 };
  let head = 0;
  let count = 0;

  /* ---------------- held state ---------------- */
  /** Held action keys, by KeyboardEvent.code (or .key when code is empty). '' = free slot. */
  const heldKeys: string[] = [];
  for (let i = 0; i < MAX_KEYS; i++) heldKeys.push('');
  let keyCount = 0;
  /** Held action pointers by pointerId; -1 = free slot. */
  const pointerIds: number[] = [];
  for (let i = 0; i < MAX_POINTERS; i++) pointerIds.push(-1);
  let pointerCount = 0;
  let syntheticHeld = false;
  let lastDev: InputDevice = 'keyboard';
  let destroyed = false;

  /* ---------------- canvas styles (restored on destroy) ---------------- */
  const style = canvas.style as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string };
  const prevTouchAction = style.touchAction;
  const prevUserSelect = style.userSelect;
  const prevWebkitUserSelect = style.webkitUserSelect;
  const prevCallout = style.webkitTouchCallout;
  try {
    style.touchAction = 'none';
    style.userSelect = 'none';
    style.webkitUserSelect = 'none';
    style.webkitTouchCallout = 'none';
  } catch (_e) {
    /* styles are a nicety; the page CSS sets them as well */
  }

  function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : 0;
  }

  function push(kind: InputKind, device: InputDevice, button: ButtonId | null, x: number, y: number): void {
    let slot: number;
    if (count === cap) {
      // Full: overwrite the oldest event.
      slot = head;
      head = (head + 1) % cap;
    } else {
      slot = (head + count) % cap;
      count++;
    }
    const e = ring[slot];
    e.kind = kind;
    e.time = now();
    e.device = device;
    e.button = button;
    e.x = x;
    e.y = y;
    if (device !== 'synthetic') lastDev = device;
  }

  function anyHeld(): boolean {
    return keyCount > 0 || pointerCount > 0 || syntheticHeld;
  }

  function gesture(): void {
    try {
      hooks.onGesture();
    } catch (_e) {
      /* audio unlock must never break input */
    }
  }

  /* ---------------- held keys ---------------- */
  /** Returns false when the key was already held (OS auto-repeat without e.repeat). */
  function addKey(id: string): boolean {
    for (let i = 0; i < MAX_KEYS; i++) if (heldKeys[i] === id) return false;
    for (let i = 0; i < MAX_KEYS; i++) {
      if (heldKeys[i] === '') {
        heldKeys[i] = id;
        keyCount++;
        return true;
      }
    }
    return true; // more simultaneous keys than slots: still a press, just not tracked
  }

  function removeKey(id: string): boolean {
    for (let i = 0; i < MAX_KEYS; i++) {
      if (heldKeys[i] === id) {
        heldKeys[i] = '';
        keyCount--;
        return true;
      }
    }
    return false;
  }

  /* ---------------- held pointers ---------------- */
  function addPointer(id: number): void {
    for (let i = 0; i < MAX_POINTERS; i++) if (pointerIds[i] === id) return;
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (pointerIds[i] === -1) {
        pointerIds[i] = id;
        pointerCount++;
        return;
      }
    }
  }

  function removePointer(id: number): boolean {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (pointerIds[i] === id) {
        pointerIds[i] = -1;
        pointerCount--;
        return true;
      }
    }
    return false;
  }

  /* ---------------- keyboard ---------------- */
  /** A key event aimed at an interactive page element other than the game canvas. */
  function isControlTarget(target: EventTarget | null): boolean {
    const t = target as Element | null;
    if (!t || t === document.body || t === canvas) return false;
    if (typeof t.closest !== 'function') return false;
    return t.closest('a,button,input,select,textarea,[contenteditable]') !== null;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Keys aimed at a focused page control (a link, button, field) belong to that control: Enter
    // follows the link, Space activates the button. No preventDefault, no game event.
    if (isControlTarget(e.target)) return;
    const code = e.code || '';
    const key = e.key || '';
    if (isScrollKey(code, key)) e.preventDefault();
    if (e.repeat) return;
    const k = classifyKey(code, key);
    if (k === K_NONE) return;
    if (k === K_PAUSE || k === K_MUTE || k === K_RESTART || k === K_CONFIRM || k === K_SLAM) e.preventDefault();
    gesture();
    switch (k) {
      case K_ACTION:
        if (addKey(code !== '' ? code : key)) push('actionDown', 'keyboard', null, 0, 0);
        break;
      case K_SLAM:
        push('slam', 'keyboard', null, 0, 0);
        break;
      case K_PAUSE:
        push('pause', 'keyboard', null, 0, 0);
        break;
      case K_MUTE:
        push('mute', 'keyboard', null, 0, 0);
        break;
      case K_RESTART:
        push('restart', 'keyboard', null, 0, 0);
        break;
      case K_CONFIRM:
        push('confirm', 'keyboard', null, 0, 0);
        break;
      default:
        break;
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (destroyed) return;
    const code = e.code || '';
    const key = e.key || '';
    if (isScrollKey(code, key) && !isControlTarget(e.target)) e.preventDefault();
    // Releases are honoured even with modifiers held (Space down, Ctrl, Space up), and on any
    // target (focus may have moved to a link while the key was down): held keys always clear.
    if (!removeKey(code !== '' ? code : key)) return;
    if (!anyHeld()) push('actionUp', 'keyboard', null, 0, 0);
  }

  /* ---------------- pointer ---------------- */
  function onPointerDown(e: PointerEvent): void {
    if (destroyed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    // preventDefault on pointerdown also suppresses the focus change, so inside an iframe the
    // keyboard would stay with the host page, and a focused link would keep Space / Enter (see
    // isControlTarget): take focus explicitly, as a normal click would.
    try {
      window.focus();
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && ae !== canvas && typeof ae.blur === 'function') ae.blur();
    } catch (_e) {
      /* focus is best effort (sandboxed frames) */
    }
    gesture();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const device = deviceOf(e);
    // Canvas buttons first: a press on a button never becomes ACTION.
    let btn: ButtonId | null = null;
    try {
      btn = hooks.hitTest(x, y);
    } catch (_e) {
      btn = null;
    }
    if (btn !== null) {
      push('button', device, btn, x, y);
      return;
    }
    if (TWO_ZONE_TOUCH && device === 'touch' && x < rect.width * TWO_ZONE_SPLIT) {
      push('slam', device, null, x, y);
      return;
    }
    addPointer(e.pointerId);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_e) {
      /* capture is optional: window listeners catch releases anyway */
    }
    push('actionDown', device, null, x, y);
  }

  function onPointerUp(e: PointerEvent): void {
    if (destroyed) return;
    // Touch only grants user activation on pointerup: unlock audio here too.
    gesture();
    if (!removePointer(e.pointerId)) return;
    if (!anyHeld()) push('actionUp', deviceOf(e), null, 0, 0);
  }

  function onPointerCancel(e: PointerEvent): void {
    if (destroyed) return;
    if (!removePointer(e.pointerId)) return;
    if (!anyHeld()) push('actionUp', deviceOf(e), null, 0, 0);
  }

  function onLostCapture(e: PointerEvent): void {
    // Capture lost without a pointerup reaching us (e.g. element hidden): treat as a release.
    if (destroyed) return;
    if (!removePointer(e.pointerId)) return;
    if (!anyHeld()) push('actionUp', deviceOf(e), null, 0, 0);
  }

  function onPrevent(e: Event): void {
    if (e.cancelable) e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('contextmenu', onPrevent);
  canvas.addEventListener('selectstart', onPrevent);
  canvas.addEventListener('dragstart', onPrevent);

  const api: InputApi = {
    next(): InputEvent | null {
      if (count === 0) return null;
      const e = ring[head];
      out.kind = e.kind;
      out.time = e.time;
      out.device = e.device;
      out.button = e.button;
      out.x = e.x;
      out.y = e.y;
      head = (head + 1) % cap;
      count--;
      return out;
    },
    pending(): number {
      return count;
    },
    clear(): void {
      head = 0;
      count = 0;
    },
    isHeld(): boolean {
      return anyHeld();
    },
    lastDevice(): InputDevice {
      return lastDev;
    },
    inject(kind: InputKind, button?: ButtonId | null): void {
      if (kind === 'actionDown') {
        syntheticHeld = true;
      } else if (kind === 'actionUp') {
        syntheticHeld = false;
        // a synthetic release only reports when nothing real is still held
        if (anyHeld()) return;
      }
      push(kind, 'synthetic', button === undefined ? null : button, 0, 0);
    },
    releaseAll(): void {
      const was = anyHeld();
      for (let i = 0; i < MAX_KEYS; i++) heldKeys[i] = '';
      keyCount = 0;
      for (let i = 0; i < MAX_POINTERS; i++) {
        const id = pointerIds[i];
        if (id !== -1) {
          try {
            if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
          } catch (_e) {
            /* ignore */
          }
        }
        pointerIds[i] = -1;
      }
      pointerCount = 0;
      syntheticHeld = false;
      if (was) push('actionUp', lastDev, null, 0, 0);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      canvas.removeEventListener('contextmenu', onPrevent);
      canvas.removeEventListener('selectstart', onPrevent);
      canvas.removeEventListener('dragstart', onPrevent);
      for (let i = 0; i < MAX_POINTERS; i++) {
        const id = pointerIds[i];
        if (id !== -1) {
          try {
            if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
          } catch (_e) {
            /* ignore */
          }
        }
        pointerIds[i] = -1;
      }
      pointerCount = 0;
      for (let i = 0; i < MAX_KEYS; i++) heldKeys[i] = '';
      keyCount = 0;
      syntheticHeld = false;
      head = 0;
      count = 0;
      try {
        style.touchAction = prevTouchAction;
        style.userSelect = prevUserSelect;
        style.webkitUserSelect = prevWebkitUserSelect === undefined ? '' : prevWebkitUserSelect;
        style.webkitTouchCallout = prevCallout === undefined ? '' : prevCallout;
      } catch (_e) {
        /* ignore */
      }
    },
  };
  return api;
}
