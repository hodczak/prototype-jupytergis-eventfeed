import type { IJupyterGISWidget } from '@jupytergis/schema';
import type { Event } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import {
  wireDocumentEvents,
  wireLayerEvents,
  wireSourceEvents,
} from '../plugin';
import { SourceReferences } from '../sources';

const mockRegistered = new Set<string>();

jest.mock('@jupytergis/schema', () => ({
  IJupyterGISDocTracker: {},
  newDocuments: {
    consume: (path: string) => mockRegistered.delete(path),
  },
}));

function createWidget() {
  const sources: Record<string, any> = {};
  const model = {
    filePath: 'maps/city.jGIS',
    getClientId: () => 42,
    sharedLayersChanged: new Signal<object, any>({}),
    sharedSourcesChanged: new Signal<object, any>({}),
    sharedModel: {
      get sources() {
        return sources;
      },
      getLayerSource: (id: string) => sources[id],
    },
  };
  const widget = {
    id: 'map-a',
    model,
    disposed: new Signal<object, void>({}),
  };
  return { widget, model, sources };
}

const crossings = {
  name: 'crossings',
  type: 'GeoJSONSource',
  parameters: { path: '../data/crossings.geojson' },
};
const reference = {
  id: 's1',
  type: 'GeoJSONSource',
  path: '../data/crossings.geojson',
  resolved_path: 'data/crossings.geojson',
};

describe('event feed wiring', () => {
  let emit: jest.Mock<void, [Event.Request]>;

  beforeEach(() => {
    emit = jest.fn();
    mockRegistered.clear();
  });

  const data = () => emit.mock.calls.map(([request]) => request.data);

  it('reports the first view of a mockRegistered new map as created', () => {
    const { widget } = createWidget();
    mockRegistered.add('maps/city.jGIS');
    const props = {
      widget: widget as unknown as IJupyterGISWidget,
      clientId: '42',
      emit,
    };
    wireDocumentEvents(props);
    wireDocumentEvents(props);
    expect(data().map(value => value.verb)).toEqual(['created', 'opened']);
    widget.disposed.emit();
    expect(data()[2].verb).toBe('closed');
  });

  it('adds locality and the source reference to layer messages', () => {
    const { widget, model, sources } = createWidget();
    const references = new SourceReferences(model as any);
    const props = {
      widget: widget as unknown as IJupyterGISWidget,
      clientId: '42',
      emit,
    };
    wireLayerEvents(props, references);
    sources.s1 = crossings;
    const layer = {
      name: 'crossings',
      type: 'VectorLayer',
      parameters: { source: 's1' },
    };
    model.sharedLayersChanged.emit({
      layerChange: [
        { id: 'L1', oldValue: undefined, newValue: layer, local: true },
      ],
    });
    const restyled = {
      ...layer,
      parameters: { ...layer.parameters, color: 'red' },
    };
    model.sharedLayersChanged.emit({
      layerChange: [
        { id: 'L1', oldValue: layer, newValue: restyled, local: false },
      ],
    });
    // a dialog closed with OK and no edits writes an identical layer
    model.sharedLayersChanged.emit({
      layerChange: [
        {
          id: 'L1',
          oldValue: restyled,
          newValue: JSON.parse(JSON.stringify(restyled)),
          local: true,
        },
      ],
    });
    // the orphaned source can disappear before the layer removal is observed
    delete sources.s1;
    model.sharedLayersChanged.emit({
      layerChange: [
        { id: 'L1', oldValue: restyled, newValue: undefined, local: true },
      ],
    });

    expect(data().map(item => item.verb)).toEqual([
      'added',
      'updated',
      'removed',
    ]);
    const [added, updated, removed] = data();
    expect(added).toMatchObject({ verb: 'added', local: true });
    expect(added.object.source).toEqual(reference);
    expect(updated).toMatchObject({ verb: 'updated', local: false });
    expect(updated.object.source).toBeUndefined();
    expect(removed.object.source).toEqual(reference);
  });

  it('names the new source when a layer switches sources', () => {
    const { widget, model, sources } = createWidget();
    const references = new SourceReferences(model as any);
    wireLayerEvents(
      { widget: widget as unknown as IJupyterGISWidget, clientId: '42', emit },
      references,
    );
    sources.s1 = crossings;
    sources.s2 = {
      type: 'GeoJSONSource',
      parameters: { path: 'other.geojson' },
    };
    model.sharedLayersChanged.emit({
      layerChange: [
        {
          id: 'L1',
          oldValue: { parameters: { source: 's1' } },
          newValue: { parameters: { source: 's2' } },
          local: true,
        },
      ],
    });
    expect(data()[0].object.source).toMatchObject({
      id: 's2',
      resolved_path: 'maps/other.geojson',
    });
  });

  it('reports source additions, reference changes and removals only', () => {
    const { widget, model } = createWidget();
    const references = new SourceReferences(model as any);
    wireSourceEvents(
      { widget: widget as unknown as IJupyterGISWidget, clientId: '42', emit },
      references,
    );
    const moved = {
      ...crossings,
      parameters: { path: '../data/crossings_2026.geojson' },
    };
    const inline = (count: number) => ({
      type: 'GeoJSONSource',
      parameters: { data: { features: new Array(count).fill(0) } },
    });
    const changes = [
      { id: 's1', oldValue: undefined, newValue: crossings, local: true },
      { id: 's1', oldValue: crossings, newValue: moved, local: true },
      // edits inside inline data, such as a drawn feature, keep the reference
      { id: 's2', oldValue: inline(1), newValue: inline(2), local: true },
      { id: 's1', oldValue: moved, newValue: undefined, local: false },
    ];
    for (const change of changes) {
      model.sharedSourcesChanged.emit({ sourceChange: [change] });
    }

    expect(data().map(value => value.verb)).toEqual([
      'added',
      'updated',
      'removed',
    ]);
    const [added, updated, removed] = data();
    expect(added.object).toEqual({
      document_path: 'maps/city.jGIS',
      source_id: 's1',
      new: reference,
    });
    expect(updated.object.old).toEqual(reference);
    expect(updated.object.new).toMatchObject({
      resolved_path: 'data/crossings_2026.geojson',
    });
    expect(removed).toMatchObject({ local: false });
    expect(removed.object.new).toBeUndefined();
    expect(removed.object.old).toMatchObject({
      resolved_path: 'data/crossings_2026.geojson',
    });
  });
});
