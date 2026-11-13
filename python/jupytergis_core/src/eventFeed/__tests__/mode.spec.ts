import type {
  IJupyterGISModel,
  IJupyterGISTracker,
  IJupyterGISWidget,
  Modes,
} from '@jupytergis/schema';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { Event } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';

import { DocumentFocus } from '../focus';
import { MODE_SCHEMA, wireModeEvents } from '../mode';

function createModel() {
  const model = {
    filePath: 'maps/city.jGIS',
    isDisposed: false,
    currentMode: 'panning' as Modes,
    modeChanged: new Signal<object, Modes>({}),
    disposed: new Signal<object, void>({}),
    getClientId: () => 42,
    toggleMode(mode: Modes): void {
      this.setMode(this.currentMode === mode ? 'panning' : mode);
    },
    setMode(mode: Modes): void {
      if (this.currentMode === mode) {
        return;
      }
      this.currentMode = mode;
      this.modeChanged.emit(mode);
    },
    dispose(): void {
      this.isDisposed = true;
      this.disposed.emit();
    },
  };
  return model;
}

describe('mode events', () => {
  let emit: jest.Mock<void, [Event.Request]>;
  let counter: number;
  const page = {
    order: () => ({
      frontend_id: 'a4d7ce2a-58ee-4db9-a42b-3f6836ed339e',
      focus_seq: ++counter,
    }),
  };

  beforeEach(() => {
    emit = jest.fn();
    counter = 0;
  });

  const modes = () =>
    emit.mock.calls.map(([request]) => [
      request.data.object.previous,
      request.data.object.mode,
    ]);

  it('reports each change with the previous mode', () => {
    const model = createModel();
    wireModeEvents(model as unknown as IJupyterGISModel, page, emit);
    model.toggleMode('identifying');
    model.toggleMode('identifying');
    model.toggleMode('marking');
    model.setMode('panning');

    expect(modes()).toEqual([
      ['panning', 'identifying'],
      ['identifying', 'panning'],
      ['panning', 'marking'],
      ['marking', 'panning'],
    ]);
    expect(emit.mock.calls[0][0]).toMatchObject({
      schema_id: MODE_SCHEMA,
      version: '1',
      data: {
        subject: '42',
        verb: 'changed',
        frontend_id: 'a4d7ce2a-58ee-4db9-a42b-3f6836ed339e',
        focus_seq: 1,
        object: { document_path: 'maps/city.jGIS' },
      },
    });
    expect(emit.mock.calls.map(([request]) => request.data.focus_seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('reports nothing for the initial mode or setting the current mode', () => {
    const model = createModel();
    wireModeEvents(model as unknown as IJupyterGISModel, page, emit);
    model.setMode('panning');
    expect(emit).not.toHaveBeenCalled();
  });

  it('stops after the model is disposed', () => {
    const model = createModel();
    wireModeEvents(model as unknown as IJupyterGISModel, page, emit);
    model.dispose();
    model.toggleMode('identifying');
    expect(emit).not.toHaveBeenCalled();
  });

  it('numbers a mode change after the activation that caused it', async () => {
    const shell = {
      currentWidget: null as Widget | null,
      currentChanged: new Signal<object, void>({}),
      disposed: new Signal<object, void>({}),
    };
    jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const widgets = new Set<Widget>();
    const tracker = { has: (widget: Widget) => widgets.has(widget) };
    const focus = new DocumentFocus({
      shell: shell as unknown as JupyterFrontEnd.IShell,
      tracker: tracker as unknown as IJupyterGISTracker,
      emit,
    });
    const model = createModel();
    const widget = {
      id: 'map-a',
      model,
      isDisposed: false,
      disposed: new Signal<object, void>({}),
    };
    widgets.add(widget as unknown as Widget);
    focus.add(widget as unknown as IJupyterGISWidget);
    await Promise.resolve();
    wireModeEvents(model as unknown as IJupyterGISModel, focus, emit);

    // the tab becomes current and Identify is chosen in the same task
    shell.currentWidget = widget as unknown as Widget;
    shell.currentChanged.emit();
    model.toggleMode('identifying');
    await Promise.resolve();

    const data = emit.mock.calls.map(([request]) => request.data);
    expect(data.map(value => value.verb)).toEqual(['activated', 'changed']);
    expect(data.map(value => value.focus_seq)).toEqual([1, 2]);
    expect(data[0].frontend_id).toBe(data[1].frontend_id);
    focus.dispose();
    jest.restoreAllMocks();
  });
});
