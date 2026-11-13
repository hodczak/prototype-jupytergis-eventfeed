import type { IJGISSource, IJupyterGISModel } from '@jupytergis/schema';
import { PathExt } from '@jupyterlab/coreutils';

/**
 * Where a source's data comes from, as the event feed reports it. Never holds secrets or inline
 * data.
 */
export interface ISourceReference {
  id: string;
  type: string;
  path?: string | null;
  resolved_path?: string | null;
  tables?: string[];
  urls?: string[];
  inline?: { field: string; size: number };
}

/**
 * Query parameters kept in reported URLs. Every other parameter is removed.
 */
// trail: resources - empty until specific parameters are known to be harmless.
export const SAFE_QUERY_PARAMETERS: ReadonlySet<string> = new Set<string>();

const URL_FIELDS = ['url', 'serverUrl'] as const;
const INLINE_FIELDS = ['data', 'feature', 'processGraph'] as const;

function isUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Remove user information, the fragment and every query parameter not in `safe`. Works on the
 * string, so tile templates such as `{z}` stay as written.
 */
export function sanitizeUrl(
  url: string,
  safe: ReadonlySet<string> = SAFE_QUERY_PARAMETERS,
): string {
  let rest = url;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    rest = rest.slice(0, hash);
  }
  let query = '';
  const mark = rest.indexOf('?');
  if (mark >= 0) {
    query = rest.slice(mark + 1);
    rest = rest.slice(0, mark);
  }
  const scheme = rest.indexOf('://');
  if (scheme >= 0) {
    const start = scheme + 3;
    let end = rest.indexOf('/', start);
    if (end < 0) {
      end = rest.length;
    }
    const at = rest.lastIndexOf('@', end);
    if (at >= start) {
      rest = rest.slice(0, start) + rest.slice(at + 1);
    }
  }
  const kept = query.split('&').filter(part => {
    if (!part) {
      return false;
    }
    let name = part.split('=')[0];
    try {
      name = decodeURIComponent(name);
    } catch {
      return false;
    }
    return safe.has(name);
  });
  return kept.length ? `${rest}?${kept.join('&')}` : rest;
}

/**
 * The Contents path that JupyterGIS loads for `path`, relative to the map at `documentPath`. A
 * leading `/` means the server root. The result never climbs above the root.
 */
export function resolvePath(documentPath: string, path: string): string | null {
  let joined: string;
  if (path.startsWith('/')) {
    joined = path;
  } else {
    joined = PathExt.joinWithLeadingSlash(
      '/',
      PathExt.dirname(documentPath),
      path,
    );
  }
  const out = PathExt.normalize(joined);
  return out || null;
}

/**
 * The UTF-8 size of the value's JSON, in bytes.
 */
function inlineSize(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      size += 1;
    } else if (code < 0x800) {
      size += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // a surrogate pair is one four-byte character
      size += 4;
      i++;
    } else {
      size += 3;
    }
  }
  return size;
}

/**
 * The reference that a source holds. `documentPath` is the map's path, used to resolve a
 * relative `path`.
 */
export function sourceReference(
  id: string,
  source: IJGISSource | Record<string, any> | undefined,
  documentPath: string,
): ISourceReference | undefined {
  if (!source || typeof source.type !== 'string') {
    return undefined;
  }
  const parameters: Record<string, any> = source.parameters ?? {};
  const out: ISourceReference = { id, type: source.type };
  const urls: string[] = [];
  const path = parameters.path;
  if (typeof path === 'string' && path) {
    if (isUrl(path)) {
      out.path = null;
      out.resolved_path = null;
      urls.push(path);
    } else {
      out.path = path;
      out.resolved_path = documentPath ? resolvePath(documentPath, path) : null;
    }
  }
  if (typeof parameters.tables === 'string' && parameters.tables.trim()) {
    out.tables = parameters.tables
      .split(',')
      .map((table: string) => table.trim())
      .filter(Boolean);
  }
  for (const field of URL_FIELDS) {
    const value = parameters[field];
    if (typeof value === 'string' && value) {
      urls.push(value);
    }
  }
  if (Array.isArray(parameters.urls)) {
    for (const item of parameters.urls) {
      if (typeof item?.url === 'string' && item.url) {
        urls.push(item.url);
      }
    }
  }
  if (urls.length) {
    out.urls = urls.map(url => sanitizeUrl(url));
  }
  if (out.path === undefined) {
    for (const field of INLINE_FIELDS) {
      const value = parameters[field];
      if (value !== undefined && value !== null) {
        out.inline = { field, size: inlineSize(value) };
        break;
      }
    }
  }
  return out;
}

/**
 * Whether two references name the same data. The size of inline data is display metadata, so
 * edits inside inline data do not count as a change.
 */
export function isSameReference(
  a: ISourceReference | undefined,
  b: ISourceReference | undefined,
): boolean {
  const key = (reference: ISourceReference | undefined) =>
    reference &&
    JSON.stringify([
      reference.type,
      reference.path ?? null,
      reference.resolved_path ?? null,
      reference.tables ?? [],
      reference.urls ?? [],
      reference.inline?.field ?? null,
    ]);
  return key(a) === key(b);
}

/**
 * The last known reference of each source in one map. A layer removal can be observed after its
 * orphaned source is gone, so `get` falls back to the cached reference.
 */
// trail: resources - layer messages carry their data reference without waiting for a save.
export class SourceReferences {
  constructor(private readonly _model: IJupyterGISModel) {}

  /**
   * Cache the references of every source in the map, after its initial synchronization.
   */
  seed(): void {
    const sources = this._model.sharedModel.sources ?? {};
    for (const [id, source] of Object.entries(sources)) {
      this.remember(id, source);
    }
  }

  /**
   * The reference of a source value, resolved against the map's current path.
   */
  compute(
    id: string,
    source: IJGISSource | Record<string, any> | undefined,
  ): ISourceReference | undefined {
    const out = sourceReference(id, source, this._model.filePath);
    return out;
  }

  /**
   * Compute and cache the reference of a source value. Returns it.
   */
  remember(
    id: string,
    source: IJGISSource | Record<string, any> | undefined,
  ): ISourceReference | undefined {
    const reference = this.compute(id, source);
    if (reference) {
      this._cache.set(id, reference);
    }
    return reference;
  }

  /**
   * The source's current reference, or its last known one if it was removed.
   */
  get(id: string | undefined): ISourceReference | undefined {
    if (!id) {
      return undefined;
    }
    const live = this._model.sharedModel.getLayerSource(id);
    if (live) {
      return this.remember(id, live);
    }
    return this._cache.get(id);
  }

  private _cache = new Map<string, ISourceReference>();
}
