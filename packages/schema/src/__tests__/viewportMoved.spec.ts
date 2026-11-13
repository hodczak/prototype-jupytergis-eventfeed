import { IViewportMove } from '../interfaces';
import { JupyterGISModel } from '../model';

describe('completed viewport movements', () => {
  const originalDocument = globalThis.document;
  let model: JupyterGISModel;

  beforeEach(() => {
    globalThis.document = { querySelectorAll: () => [] } as unknown as Document;
    model = new JupyterGISModel({});
  });

  afterEach(() => {
    model.dispose();
    globalThis.document = originalDocument;
  });

  it('emits a local snapshot and view ID without changing awareness or options', () => {
    const moves: IViewportMove[] = [];
    const awareness = jest.fn();
    const options = model.getOptions();
    const localState = model.localState;
    model.viewportMoved.connect((_, move) => moves.push(move));
    model.sharedModel.awareness.on('change', awareness);
    const viewport = {
      coordinates: { x: 0, y: 0 },
      zoom: 0,
      extent: [0, 1, 2, 3] as [number, number, number, number],
    };

    model.notifyViewportMoved(viewport, 'view-a');
    model.notifyViewportMoved(viewport, 'view-b');

    expect(moves).toEqual([
      { viewport, emitter: 'view-a' },
      { viewport, emitter: 'view-b' },
    ]);
    expect(awareness).not.toHaveBeenCalled();
    expect(model.localState).toEqual(localState);
    expect(model.getOptions()).toEqual(options);
    model.sharedModel.awareness.off('change', awareness);
  });

  it('does not emit after disposal', () => {
    const listener = jest.fn();
    model.viewportMoved.connect(listener);
    model.dispose();
    model.notifyViewportMoved(
      { coordinates: { x: 0, y: 0 }, zoom: 0, extent: [0, 1, 2, 3] },
      'closed',
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
