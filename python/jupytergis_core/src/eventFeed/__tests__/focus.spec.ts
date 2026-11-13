import type { IJupyterGISTracker, IJupyterGISWidget } from '@jupytergis/schema';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { Event } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';

import { DocumentFocus } from '../focus';

function createWidget(id: string, model = createModel()) {
  const widget = {
    id,
    model,
    isDisposed: false,
    disposed: new Signal<object, void>({}),
    dispose(): void {
      this.isDisposed = true;
      this.disposed.emit();
    },
  };
  return widget;
}

function createModel() {
  return { filePath: 'maps/city.jGIS', getClientId: () => 42 };
}

describe('document focus events', () => {
  let focus: DocumentFocus;
  let emit: jest.Mock<void, [Event.Request]>;
  let widgets: Set<Widget>;
  let shell: {
    currentWidget: Widget | null;
    currentChanged: Signal<object, void>;
    disposed: Signal<object, void>;
  };
  let hasFocus: jest.SpyInstance<boolean, []>;
  let visibility: jest.SpyInstance<DocumentVisibilityState, []>;

  const select = async (widget: ReturnType<typeof createWidget> | null) => {
    shell.currentWidget = widget as unknown as Widget;
    shell.currentChanged.emit();
    await Promise.resolve();
  };

  const add = (id: string, model = createModel()) => {
    const widget = createWidget(id, model);
    widgets.add(widget as unknown as Widget);
    focus.add(widget as unknown as IJupyterGISWidget);
    return widget;
  };

  const start = () => {
    const tracker = { has: (widget: Widget) => widgets.has(widget) };
    focus = new DocumentFocus({
      shell: shell as unknown as JupyterFrontEnd.IShell,
      tracker: tracker as unknown as IJupyterGISTracker,
      emit,
    });
  };

  const verbs = () => emit.mock.calls.map(([request]) => request.data.verb);

  beforeEach(() => {
    emit = jest.fn();
    widgets = new Set();
    shell = {
      currentWidget: null,
      currentChanged: new Signal({}),
      disposed: new Signal({}),
    };
    hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    visibility = jest
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    start();
  });

  afterEach(() => {
    focus.dispose();
    jest.restoreAllMocks();
  });

  it('reports an initially active map as an initial observation', async () => {
    focus.dispose();
    const map = createWidget('map-a');
    shell.currentWidget = map as unknown as Widget;
    start();
    widgets.add(map as unknown as Widget);
    focus.add(map as unknown as IJupyterGISWidget);
    await Promise.resolve();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      schema_id: 'https://schema.jupytergis.org/events/document/v1',
      version: '1',
      data: {
        subject: '42',
        verb: 'activated',
        focus_seq: 1,
        object: {
          document_path: 'maps/city.jGIS',
          widget_id: 'map-a',
          reason: 'initial_state',
        },
      },
    });
    const data = emit.mock.calls[0][0].data;
    expect(data.frontend_id).toMatch(/^[\da-f-]{36}$/);
    expect(new Date(data.time as string).toISOString()).toBe(data.time);
  });

  it('reports leaving and returning to the same open map', async () => {
    const map = add('map-a');
    await Promise.resolve();
    await select(map);
    await select(createWidget('notebook'));
    await select(map);

    expect(verbs()).toEqual(['activated', 'deactivated', 'activated']);
    expect(emit.mock.calls[0][0].data.object).toMatchObject({
      reason: 'document_switch',
    });
  });

  it('orders transitions between views sharing a model', async () => {
    const model = createModel();
    const first = add('map-a', model);
    const second = add('map-b', model);
    await select(first);
    await select(second);

    expect(verbs()).toEqual(['activated', 'deactivated', 'activated']);
    const data = emit.mock.calls.map(([request]) => request.data);
    expect(data.map(value => value.focus_seq)).toEqual([1, 2, 3]);
    expect(new Set(data.map(value => value.frontend_id)).size).toBe(1);
    expect(data.map(value => value.object)).toMatchObject([
      { widget_id: 'map-a' },
      { widget_id: 'map-a' },
      { widget_id: 'map-b' },
    ]);
  });

  it('coalesces browser signals and waits for both visibility and focus', async () => {
    await select(add('map-a'));
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new globalThis.Event('blur'));
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new globalThis.Event('visibilitychange'));
    await Promise.resolve();
    expect(verbs()).toEqual(['activated', 'deactivated']);
    expect(emit.mock.calls[1][0].data.object).toMatchObject({
      reason: 'page_hidden',
    });

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new globalThis.Event('visibilitychange'));
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(2);

    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new globalThis.Event('focus'));
    await Promise.resolve();
    expect(verbs()).toEqual(['activated', 'deactivated', 'activated']);
    expect(emit.mock.calls[2][0].data.object).toMatchObject({
      reason: 'window_focused',
    });
  });

  it('keeps map context during repeated signals and internal focus changes', async () => {
    const map = add('map-a');
    await select(map);
    shell.currentChanged.emit();
    window.dispatchEvent(new globalThis.Event('focus'));
    document.dispatchEvent(new globalThis.Event('visibilitychange'));
    const sidebar = document.createElement('input');
    document.body.append(sidebar);
    sidebar.focus();
    await Promise.resolve();
    sidebar.remove();

    expect(verbs()).toEqual(['activated']);
  });

  it('deactivates on window blur even when the page stays visible', async () => {
    await select(add('map-a'));
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new globalThis.Event('blur'));
    await Promise.resolve();
    expect(verbs()).toEqual(['activated', 'deactivated']);
    expect(emit.mock.calls[1][0].data.object).toMatchObject({
      reason: 'window_blurred',
    });
  });

  it('uses the current path after a rename', async () => {
    const map = add('map-a');
    await select(map);
    map.model.filePath = 'maps/renamed.jGIS';
    await select(null);

    expect(emit.mock.calls[0][0].data.object).toMatchObject({
      document_path: 'maps/city.jGIS',
    });
    expect(emit.mock.calls[1][0].data.object).toMatchObject({
      document_path: 'maps/renamed.jGIS',
    });
  });

  it('deactivates synchronously before closed and ignores a disposed selection', async () => {
    const map = add('map-a');
    await select(map);
    const order: string[] = [];
    emit.mockImplementation(request => order.push(request.data.verb as string));
    map.disposed.connect(() => order.push('closed'));
    map.dispose();

    expect(order).toEqual(['deactivated', 'closed']);
    expect(emit.mock.calls[1][0].data.object).toMatchObject({
      reason: 'widget_closed',
    });
    await Promise.resolve();
    expect(verbs()).toEqual(['activated', 'deactivated']);
  });

  it('activates a map that is registered after it becomes current', async () => {
    const map = createWidget('map-a');
    await select(map);
    expect(emit).not.toHaveBeenCalled();
    widgets.add(map as unknown as Widget);
    focus.add(map as unknown as IJupyterGISWidget);
    await Promise.resolve();
    expect(verbs()).toEqual(['activated']);
  });

  it('does not treat a notebook containing a map as that map', async () => {
    add('embedded-map');
    await select(createWidget('notebook'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not guess focus when the shell has no selection signal', async () => {
    focus.dispose();
    const map = createWidget('map-a');
    focus = new DocumentFocus({
      shell: {
        currentWidget: map,
        disposed: new Signal({}),
      } as unknown as JupyterFrontEnd.IShell,
      tracker: { has: () => true } as unknown as IJupyterGISTracker,
      emit,
    });
    focus.add(map as unknown as IJupyterGISWidget);
    window.dispatchEvent(new globalThis.Event('focus'));
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });

  it('disconnects listeners and cancels pending reconciliation on disposal', async () => {
    const map = add('map-a');
    shell.currentWidget = map as unknown as Widget;
    focus.dispose();
    focus.dispose();
    await Promise.resolve();
    shell.currentChanged.emit();
    window.dispatchEvent(new globalThis.Event('focus'));
    document.dispatchEvent(new globalThis.Event('visibilitychange'));
    map.dispose();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });

  it('disconnects browser listeners when the application shell is disposed', async () => {
    const map = add('map-a');
    shell.currentWidget = map as unknown as Widget;
    shell.disposed.emit();
    await Promise.resolve();
    shell.currentChanged.emit();
    window.dispatchEvent(new globalThis.Event('focus'));
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });
});
