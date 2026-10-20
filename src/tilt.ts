/**
 * Steering by tilting the phone, like a wheel: tilt right to move one lane right, left for left.
 * The position the phone is in when steering is switched on counts as "straight". Holding the
 * tilt keeps changing lanes every so often; coming back to the middle re-arms it.
 * Works in portrait and landscape. iOS asks for permission first (from a tap).
 */

const TRIGGER_DEG = 18;
const REARM_DEG = 8;
const REPEAT_MS = 900;
const INVERT_KEY = 'overdrive.tilt.invert';

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

/** Permission already granted (iOS and recent Chrome only give it from a tap). */
let granted = false;

function permissionApi(): (() => Promise<'granted' | 'denied'>) | undefined {
  const ctor = (typeof window !== 'undefined' ? window.DeviceOrientationEvent : undefined) as OrientationCtor | undefined;
  return typeof ctor?.requestPermission === 'function' ? ctor.requestPermission.bind(ctor) : undefined;
}

export class TiltSteer extends EventTarget {
  /** Current tilt relative to straight, degrees (+ = right), for an on-screen indicator. */
  tilt = 0;
  enabled = false;
  private zero?: number;
  private armed = true;
  private lastFire = 0;
  private readonly onEvent = (e: DeviceOrientationEvent) => this.read(e);

  constructor(
    private onLeft: () => void,
    private onRight: () => void,
  ) {
    super();
  }

  /** Phones and tablets with a motion sensor. */
  static available(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
  }

  static get inverted(): boolean {
    try {
      return localStorage.getItem(INVERT_KEY) === '1';
    } catch {
      return false;
    }
  }

  static set inverted(on: boolean) {
    try {
      localStorage.setItem(INVERT_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }

  /**
   * Asks for the motion sensor up front. Call it inside a tap (e.g. "Start race"): later,
   * when the race begins, steering can switch on without another tap.
   */
  static prime(): void {
    const ask = permissionApi();
    if (!ask || granted || !TiltSteer.available()) return;
    ask()
      .then((r) => (granted = r === 'granted'))
      .catch(() => {});
  }

  /** Resolves false if the sensor can't be used (or needs a tap first). */
  async enable(): Promise<boolean> {
    if (this.enabled) return true;
    const ask = permissionApi();
    try {
      if (ask && !granted) granted = (await ask()) === 'granted';
      if (ask && !granted) return false;
    } catch {
      return false;
    }
    this.zero = undefined;
    this.armed = true;
    window.addEventListener('deviceorientation', this.onEvent);
    this.enabled = true;
    this.changed();
    return true;
  }

  disable(): void {
    window.removeEventListener('deviceorientation', this.onEvent);
    this.enabled = false;
    this.tilt = 0;
    this.changed();
  }

  /** Takes the current position as straight. */
  recenter(): void {
    this.zero = undefined;
  }

  private read(e: DeviceOrientationEvent): void {
    if (e.gamma === null || e.beta === null) return;
    // Left/right tilt of the screen as the player sees it, whatever the orientation.
    const angle = screen.orientation?.angle ?? 0;
    let raw = angle === 90 ? -e.beta : angle === 270 || angle === -90 ? e.beta : angle === 180 ? -e.gamma : e.gamma;
    if (TiltSteer.inverted) raw = -raw;
    if (this.zero === undefined) this.zero = raw;
    this.tilt = Math.max(-90, Math.min(90, raw - this.zero));

    const now = performance.now();
    const beyond = Math.abs(this.tilt) >= TRIGGER_DEG;
    if (Math.abs(this.tilt) <= REARM_DEG) this.armed = true;
    if (beyond && (this.armed || now - this.lastFire >= REPEAT_MS)) {
      this.armed = false;
      this.lastFire = now;
      if (this.tilt > 0) this.onRight();
      else this.onLeft();
      this.dispatchEvent(new CustomEvent('steer', { detail: this.tilt > 0 ? 'right' : 'left' }));
    }
    this.changed();
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}
