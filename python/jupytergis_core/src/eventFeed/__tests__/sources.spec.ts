import {
  isSameReference,
  resolvePath,
  sanitizeUrl,
  sourceReference,
  SourceReferences,
} from '../sources';

describe('sanitizeUrl', () => {
  it('removes credentials, the query and the fragment', () => {
    expect(
      sanitizeUrl('https://user:secret@example.org/a.geojson?token=x&v=2#top'),
    ).toBe('https://example.org/a.geojson');
  });

  it('keeps parameters on the safe list', () => {
    const safe = new Set(['v']);
    expect(sanitizeUrl('https://example.org/a?token=x&v=2', safe)).toBe(
      'https://example.org/a?v=2',
    );
  });

  it('keeps tile templates as written', () => {
    expect(
      sanitizeUrl('https://{s}.tile.example.org/{z}/{x}/{y}.png?apikey=k'),
    ).toBe('https://{s}.tile.example.org/{z}/{x}/{y}.png');
  });

  it('keeps an @ in the path', () => {
    expect(sanitizeUrl('https://example.org/@scope/a.json')).toBe(
      'https://example.org/@scope/a.json',
    );
  });
});

describe('resolvePath', () => {
  it.each([
    ['maps/city.jGIS', '../data/x.geojson', 'data/x.geojson'],
    ['maps/city.jGIS', 'x.geojson', 'maps/x.geojson'],
    ['maps/city.jGIS', './sub/x.geojson', 'maps/sub/x.geojson'],
    ['maps/city.jGIS', '/data/x.geojson', 'data/x.geojson'],
    ['city.jGIS', '../../x.geojson', 'x.geojson'],
    ['city.jGIS', 'x.geojson', 'x.geojson'],
  ])('resolves %s + %s to %s', (document, path, expected) => {
    expect(resolvePath(document, path)).toBe(expected);
  });
});

describe('sourceReference', () => {
  it('reports a relative path and the path JupyterGIS loads', () => {
    const source = {
      name: 'crossings',
      type: 'GeoJSONSource',
      parameters: {
        path: '../data/crossings.geojson',
        httpHeaders: 'Authorization: x',
      },
    };
    expect(sourceReference('s1', source, 'maps/city.jGIS')).toEqual({
      id: 's1',
      type: 'GeoJSONSource',
      path: '../data/crossings.geojson',
      resolved_path: 'data/crossings.geojson',
    });
  });

  it('treats an http path as a URL', () => {
    const source = {
      type: 'GeoJSONSource',
      parameters: { path: 'https://example.org/eq.geojson?key=1' },
    };
    expect(sourceReference('s1', source, 'map.jGIS')).toEqual({
      id: 's1',
      type: 'GeoJSONSource',
      path: null,
      resolved_path: null,
      urls: ['https://example.org/eq.geojson'],
    });
  });

  it('lists GeoPackage tables', () => {
    const source = {
      type: 'GeoPackageVectorSource',
      parameters: { path: 'roads.gpkg', tables: 'roads, bridges' },
    };
    expect(sourceReference('s1', source, 'map.jGIS')).toMatchObject({
      resolved_path: 'roads.gpkg',
      tables: ['roads', 'bridges'],
    });
  });

  it('collects URLs from url, urls and serverUrl fields', () => {
    const tiff = {
      type: 'GeoTiffSource',
      parameters: {
        urls: [
          { url: 'https://a.org/1.tif?x=1' },
          { url: 'https://a.org/2.tif' },
        ],
      },
    };
    expect(sourceReference('s1', tiff, 'map.jGIS')?.urls).toEqual([
      'https://a.org/1.tif',
      'https://a.org/2.tif',
    ]);
    const tiles = {
      type: 'RasterSource',
      parameters: {
        url: 'https://tile.org/{z}/{x}/{y}.png',
        urlParameters: { key: 'secret' },
      },
    };
    expect(sourceReference('s2', tiles, 'map.jGIS')).toEqual({
      id: 's2',
      type: 'RasterSource',
      urls: ['https://tile.org/{z}/{x}/{y}.png'],
    });
  });

  it('describes inline data by field and size and omits tokens', () => {
    const openeo = {
      type: 'OpenEOTileSource',
      parameters: {
        serverUrl: 'https://openeo.org',
        authBearer: 'token',
        processGraph: { a: 1 },
      },
    };
    expect(sourceReference('s1', openeo, 'map.jGIS')).toEqual({
      id: 's1',
      type: 'OpenEOTileSource',
      urls: ['https://openeo.org'],
      inline: { field: 'processGraph', size: 7 },
    });
    const embedded = {
      type: 'GeoJSONSource',
      parameters: { data: { type: 'FeatureCollection', features: [] } },
    };
    expect(sourceReference('s2', embedded, 'map.jGIS')).toEqual({
      id: 's2',
      type: 'GeoJSONSource',
      inline: { field: 'data', size: 42 },
    });
  });

  it('gives nothing for a value without a type', () => {
    expect(sourceReference('s1', undefined, 'map.jGIS')).toBeUndefined();
    expect(
      sourceReference('s1', { parameters: {} }, 'map.jGIS'),
    ).toBeUndefined();
  });
});

describe('isSameReference', () => {
  it('ignores the size of inline data', () => {
    expect(
      isSameReference(
        { id: 's', type: 'GeoJSONSource', inline: { field: 'data', size: 1 } },
        { id: 's', type: 'GeoJSONSource', inline: { field: 'data', size: 9 } },
      ),
    ).toBe(true);
  });

  it('detects another path', () => {
    expect(
      isSameReference(
        { id: 's', type: 'GeoJSONSource', path: 'a', resolved_path: 'a' },
        { id: 's', type: 'GeoJSONSource', path: 'b', resolved_path: 'b' },
      ),
    ).toBe(false);
  });
});

describe('SourceReferences', () => {
  it('falls back to the last reference after the source is removed', () => {
    const sources: Record<string, any> = {
      s1: { type: 'GeoJSONSource', parameters: { path: 'a.geojson' } },
    };
    const model = {
      filePath: 'maps/city.jGIS',
      sharedModel: {
        get sources() {
          return sources;
        },
        getLayerSource: (id: string) => sources[id],
      },
    };
    const references = new SourceReferences(model as any);
    references.seed();
    delete sources.s1;
    expect(references.get('s1')).toEqual({
      id: 's1',
      type: 'GeoJSONSource',
      path: 'a.geojson',
      resolved_path: 'maps/a.geojson',
    });
    expect(references.get('missing')).toBeUndefined();
    expect(references.get(undefined)).toBeUndefined();
  });
});
