/**
 * Paths of maps that JupyterGIS created and has not opened yet.
 *
 * The code that creates a map registers its path before opening it. The event feed consumes the
 * registration when it reports the first view of that map, and reports `created` instead of
 * `opened`. A registration expires after `ttl` milliseconds, so an abandoned one cannot mark a
 * later, unrelated open of the same path.
 */
// trail: created - the creating code knows a map is new; the event feed only sees it open.
export class NewDocuments {
  constructor(ttl = 30_000, now: () => number = Date.now) {
    this._ttl = ttl;
    this._now = now;
  }

  /**
   * Register the path of a map that was just created.
   */
  register(path: string): void {
    this._paths.set(normalize(path), this._now() + this._ttl);
  }

  /**
   * Remove a registration, for example after the map failed to open.
   */
  discard(path: string): void {
    this._paths.delete(normalize(path));
  }

  /**
   * Whether the path was registered and has not expired. Removes the registration.
   */
  consume(path: string): boolean {
    const key = normalize(path);
    const expiry = this._paths.get(key);
    this._paths.delete(key);
    return expiry !== undefined && expiry >= this._now();
  }

  private _paths = new Map<string, number>();
  private _ttl: number;
  private _now: () => number;
}

/**
 * Removes a drive prefix such as `RTC:` and leading slashes.
 */
function normalize(path: string): string {
  return path.replace(/^[^/:]+:/, '').replace(/^\/+/, '');
}

/**
 * The page's registry. `@jupytergis/schema` is a shared singleton, so every JupyterGIS extension
 * on the page sees the same instance.
 */
export const newDocuments = new NewDocuments();
