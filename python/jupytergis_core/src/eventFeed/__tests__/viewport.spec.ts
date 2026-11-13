import type { IJupyterGISModel, IViewportMove } from '@jupytergis/schema';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { Signal } from '@lumino/signaling';

import { eventFeedPlugin } from '../plugin';
import { wireViewportEvents } from '../viewport';

jest.mock('@jupytergis/schema', () => ({
  IJupyterGISDocTracker: {},
  newDocuments: { consume: () => false },
}));
jest.mock('../focus', () => ({
  DocumentFocus: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    order: jest.fn(),
  })),
}));

function createModel() {
  const model = {
    filePath: 'map.jGIS',
    isDisposed: false,
    getClientId: () => 42,
    viewportMoved: new Signal<object, IViewportMove>({}),
    viewportStateChanged: new Signal<object, unknown>({}),
    sharedLayersChanged: new Signal<object, unknown>({}),
    sharedSourcesChanged: new Signal<object, unknown>({}),
    modeChanged: new Signal<object, unknown>({}),
    currentMode: 'panning',
    disposed: new Signal<object, void>({}),
    sharedModel: { initialSyncReady: Promise.resolve() },
  };
  return model;
}

function createWidget(model: ReturnType<typeof createModel>) {
  return { model, disposed: new Signal<object, void>({}) };
}

function move(zoom: number, emitter = 'view-a'): IViewportMove {
  return {
    emitter,
    viewport: {
      coordinates: { x: zoom, y: 0 },
      zoom,
      extent: [0, 0, zoom + 1, zoom + 1],
    },
  };
}

describe('viewport feed', () => {
  it('publishes each completed snapshot synchronously, including zoom zero', () => {
    const model = createModel();
    const emit = jest.fn();
    wireViewportEvents(model as unknown as IJupyterGISModel, emit);
    const first = move(0);
    const second = move(2);
    model.viewportMoved.emit(first);
    expect(emit).toHaveBeenCalledTimes(1);
    model.viewportMoved.emit(second);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([request]) => request.data.object.new)).toEqual(
      [first.viewport, second.viewport],
    );
    expect(emit.mock.calls[0][0]).toEqual({
      schema_id: 'https://schema.jupytergis.org/events/viewport/v1',
      version: '1',
      data: {
        subject: '42',
        verb: 'moved',
        object: { document_path: 'map.jGIS', new: first.viewport },
      },
    });
  });

  it('reads the current path and ignores collaboration awareness', () => {
    const model = createModel();
    const emit = jest.fn();
    wireViewportEvents(model as unknown as IJupyterGISModel, emit);
    model.viewportStateChanged.emit({
      isLocalClient: true,
      currentValue: { value: move(1).viewport },
    });
    model.viewportStateChanged.emit({
      isLocalClient: false,
      currentValue: { value: move(1).viewport },
    });
    expect(emit).not.toHaveBeenCalled();
    model.filePath = 'renamed.jGIS';
    model.viewportMoved.emit(move(2));
    expect(emit.mock.calls[0][0].data.object.document_path).toBe(
      'renamed.jGIS',
    );
    model.filePath = '';
    model.viewportMoved.emit(move(3));
    expect(emit.mock.calls[1][0].data.object.document_path).toBeNull();
  });

  it('disconnects on model disposal and refuses an already disposed model', () => {
    const model = createModel();
    const emit = jest.fn();
    wireViewportEvents(model as unknown as IJupyterGISModel, emit);
    model.isDisposed = true;
    model.disposed.emit();
    model.viewportMoved.emit(move(2));
    wireViewportEvents(model as unknown as IJupyterGISModel, emit);
    model.viewportMoved.emit(move(3));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('viewport plugin lifecycle', () => {
  async function start(model: ReturnType<typeof createModel>) {
    const first = createWidget(model);
    const second = createWidget(model);
    const emit = jest.fn().mockResolvedValue(undefined);
    const tracker = {
      forEach: (callback: (widget: typeof first) => void) =>
        [first, second].forEach(callback),
      widgetAdded: new Signal<object, typeof first>({}),
    };
    const app = { serviceManager: { events: { emit } }, shell: {} };
    await eventFeedPlugin.activate(app as unknown as JupyterFrontEnd, tracker);
    return { first, second, emit };
  }

  it('keeps one subscription when views share a model and the first view closes', async () => {
    const model = createModel();
    const { first, emit } = await start(model);
    emit.mockClear();
    model.viewportMoved.emit(move(1));
    expect(emit).toHaveBeenCalledTimes(1);
    first.disposed.emit();
    emit.mockClear();
    model.viewportMoved.emit(move(2, 'view-b'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].data.object.new.zoom).toBe(2);
  });

  it('does not wire a model disposed before initial sync completes', async () => {
    const model = createModel();
    let ready: () => void = () => undefined;
    model.sharedModel.initialSyncReady = new Promise<void>(resolve => {
      ready = resolve;
    });
    const { emit } = await start(model);
    emit.mockClear();
    model.isDisposed = true;
    model.disposed.emit();
    ready();
    await Promise.resolve();
    model.viewportMoved.emit(move(1));
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports server emission failures through the existing warning path', async () => {
    const model = createModel();
    const { emit } = await start(model);
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const error = new Error('connection closed');
    emit.mockRejectedValueOnce(error);
    model.viewportMoved.emit(move(1));
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith(
      '[jupytergis event-feed] failed to emit event',
      error,
    );
    warning.mockRestore();
  });
});
