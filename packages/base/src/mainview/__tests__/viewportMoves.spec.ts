/** @jest-environment jsdom */
import Collection from 'ol/Collection';
import Map from 'ol/Map';
import MapBrowserEvent from 'ol/MapBrowserEvent';
import View from 'ol/View';
import Zoom from 'ol/control/Zoom';
import { KeyboardZoom, MouseWheelZoom } from 'ol/interaction';

import { ViewportMoves } from '../viewportMoves';

describe('completed viewport movements', () => {
  let map: Map;
  let moves: ViewportMoves;
  let keyboard: KeyboardZoom;
  let publish: jest.Mock;
  let controls: HTMLDivElement;
  let following: boolean;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.ResizeObserver = class {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    controls = document.createElement('div');
    document.body.append(controls);
    keyboard = new KeyboardZoom({ duration: 0 });
    map = new Map({
      view: new View({ center: [0, 0], zoom: 1 }),
      controls: [new Zoom({ duration: 0, target: controls })],
      interactions: new Collection([keyboard]),
    });
    map.setSize([800, 600]);
    publish = jest.fn();
    following = false;
    moves = new ViewportMoves(map, publish, () => following, controls);
  });

  afterEach(() => {
    moves.dispose();
    map.dispose();
    controls.remove();
    jest.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  function zoom(key = '+'): void {
    const event = new KeyboardEvent('keydown', { key });
    Object.defineProperty(event, 'target', { value: map.getViewport() });
    keyboard.handleEvent(new MapBrowserEvent('keydown', map, event));
  }

  function complete(): void {
    map.dispatchEvent('moveend');
    map.dispatchEvent('postrender');
  }

  it('reports the first fixed-center zoom, including zoom zero', () => {
    zoom('-');
    complete();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual({
      coordinates: { x: 0, y: 0 },
      zoom: 0,
      extent: map.getView().calculateExtent([800, 600]),
    });
  });

  it('does not report initialization or an unrelated keypress', () => {
    complete();
    zoom('a');
    map.getView().setCenter([1000, 1000]);
    complete();
    expect(publish).not.toHaveBeenCalled();
  });

  it('clears a no-op zoom at the limit before a later camera change', () => {
    map.getView().setZoom(0);
    zoom('-');
    complete();
    map.getView().setCenter([1000, 0]);
    complete();
    expect(publish).not.toHaveBeenCalled();
  });

  it('observes zoom controls outside the map viewport', () => {
    controls.querySelector<HTMLButtonElement>('.ol-zoom-in')!.click();
    complete();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].zoom).toBe(2);
  });

  it('keeps separate snapshots for successive movements', () => {
    zoom();
    complete();
    zoom();
    complete();
    expect(publish.mock.calls.map(([viewport]) => viewport.zoom)).toEqual([
      2, 3,
    ]);
    expect(publish.mock.calls[0][0].coordinates).not.toBe(
      map.getView().getCenter(),
    );
    expect(publish.mock.calls[0][0].extent).not.toEqual(
      publish.mock.calls[1][0].extent,
    );
  });

  it('suppresses navigation interrupted by an automatic movement', () => {
    zoom();
    moves.suppress();
    map.getView().setCenter([1000, 1000]);
    complete();
    expect(publish).not.toHaveBeenCalled();
    zoom();
    complete();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('suppresses follow and restoration after the follow flag clears', () => {
    following = true;
    zoom();
    complete();
    moves.suppress();
    following = false;
    map.getView().setCenter([1000, 1000]);
    complete();
    expect(publish).not.toHaveBeenCalled();
    zoom();
    complete();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['resize', 'replacement', 'cancel'])(
    'drops pending navigation on %s',
    reason => {
      zoom();
      if (reason === 'resize') {
        map.setSize([900, 700]);
      } else if (reason === 'replacement') {
        map.setView(new View({ center: [500, 0], zoom: 4 }));
      } else {
        map.getViewport().dispatchEvent(new Event('pointercancel'));
      }
      complete();
      expect(publish).not.toHaveBeenCalled();
      zoom();
      complete();
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects missing map size and non-finite snapshots', () => {
    map.setSize(undefined);
    complete();
    zoom();
    complete();
    expect(publish).not.toHaveBeenCalled();
    map.setSize([800, 600]);
    complete();
    zoom();
    jest
      .spyOn(map.getView(), 'calculateExtent')
      .mockReturnValue([NaN, 0, 0, 0]);
    complete();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish after disposal and restores interaction handlers', () => {
    zoom();
    moves.dispose();
    complete();
    zoom();
    complete();
    expect(publish).not.toHaveBeenCalled();
    expect(keyboard.handleEvent).toBe(KeyboardZoom.prototype.handleEvent);
  });

  it('clears a zero-delta wheel without authorizing another movement', () => {
    const wheel = new MouseWheelZoom();
    map.addInteraction(wheel);
    const event = new WheelEvent('wheel', { deltaY: 0 });
    const browserEvent = new MapBrowserEvent('wheel', map, event);
    browserEvent.pixel = [400, 300];
    wheel.handleEvent(browserEvent);
    map.getView().setCenter([1000, 0]);
    complete();
    expect(publish).not.toHaveBeenCalled();
  });
});
