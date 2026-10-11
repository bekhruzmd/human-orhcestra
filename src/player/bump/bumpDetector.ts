/**
 * High-pass acceleration spike detector for the Web "Bump" engine.
 *
 * Detects physical phone-to-phone taps by measuring total acceleration
 * vector magnitude sqrt(x^2 + y^2 + z^2) over a high-pass threshold (~25 m/s²),
 * with debouncing to prevent multiple triggers from a single physical tap.
 */

export interface BumpDetectorOptions {
  /** Threshold in m/s² (default: 25 m/s², approximately ~2.5G) */
  threshold?: number;
  /** Debounce cooldown in milliseconds (default: 1500ms) */
  debounceMs?: number;
  /** Callback fired when an acceleration spike is detected */
  onSpike?: (magnitude: number, timestamp: number) => void;
}

export class BumpDetector {
  private threshold: number;
  private debounceMs: number;
  private onSpike?: (magnitude: number, timestamp: number) => void;
  private isListening = false;
  private lastSpikeTime = 0;
  private motionHandler: ((e: DeviceMotionEvent) => void) | null = null;
  private permissionState: 'unknown' | 'granted' | 'denied' | 'none' = 'unknown';

  constructor(options: BumpDetectorOptions = {}) {
    this.threshold = options.threshold ?? 25;
    this.debounceMs = options.debounceMs ?? 1500;
    this.onSpike = options.onSpike;
  }

  /**
   * Handle iOS Safari DeviceMotionEvent.requestPermission() flow.
   * Returns true if permission is granted or if permission is not required by browser.
   */
  public async requestPermission(): Promise<boolean> {
    const DM = (window as any).DeviceMotionEvent;
    if (!DM) {
      this.permissionState = 'none';
      return false;
    }

    if (typeof DM.requestPermission === 'function') {
      try {
        const response = await DM.requestPermission();
        this.permissionState = response === 'granted' ? 'granted' : 'denied';
        return response === 'granted';
      } catch (err) {
        console.warn('[BumpDetector] Permission request error:', err);
        this.permissionState = 'denied';
        return false;
      }
    }

    // Non-iOS or older browsers: permission not needed
    this.permissionState = 'granted';
    return true;
  }

  /**
   * Start listening for acceleration spikes.
   */
  public start(onSpike?: (magnitude: number, timestamp: number) => void): boolean {
    if (onSpike) this.onSpike = onSpike;
    if (this.isListening) return true;

    this.motionHandler = (e: DeviceMotionEvent) => {
      // Prefer linear acceleration (excluding gravity), fallback to accelerationIncludingGravity
      const acc = e.acceleration && (e.acceleration.x != null)
        ? e.acceleration
        : e.accelerationIncludingGravity;

      if (!acc) return;

      const x = acc.x ?? 0;
      const y = acc.y ?? 0;
      const z = acc.z ?? 0;

      // Calculate total acceleration magnitude: sqrt(x^2 + y^2 + z^2)
      const magnitude = Math.hypot(x, y, z);
      const now = performance.now();

      // Check if threshold exceeded and debounce cooldown has elapsed
      if (magnitude >= this.threshold && now - this.lastSpikeTime > this.debounceMs) {
        this.lastSpikeTime = now;
        const timestamp = Date.now();
        console.log(`[BumpDetector] Physical spike detected! Mag: ${magnitude.toFixed(1)} m/s²`);
        if (this.onSpike) {
          this.onSpike(magnitude, timestamp);
        }
      }
    };

    window.addEventListener('devicemotion', this.motionHandler, { passive: true });
    this.isListening = true;
    return true;
  }

  /**
   * Stop listening for acceleration spikes.
   */
  public stop(): void {
    if (!this.isListening || !this.motionHandler) return;
    window.removeEventListener('devicemotion', this.motionHandler);
    this.motionHandler = null;
    this.isListening = false;
  }

  /**
   * For testing or desktop development: manually simulate a bump impact.
   */
  public simulateSpike(): void {
    const now = performance.now();
    if (now - this.lastSpikeTime > this.debounceMs) {
      this.lastSpikeTime = now;
      const timestamp = Date.now();
      console.log('[BumpDetector] Simulated spike triggered');
      if (this.onSpike) {
        this.onSpike(30, timestamp);
      }
    }
  }

  public get active(): boolean {
    return this.isListening;
  }
}
