import type { IViewPortState } from '@jupytergis/schema';
import type OlMap from 'ol/Map';
import { unByKey } from 'ol/Observable';
import type { EventsKey } from 'ol/events';
import {
  DoubleClickZoom,
  DragPan,
  DragZoom,
  KeyboardPan,
  KeyboardZoom,
  MouseWheelZoom,
  PinchZoom,
} from 'ol/interaction';
import type Interaction from 'ol/interaction/Interaction';
import { defaults } from 'ol/interaction/defaults';

const VIEWPORT_WHEEL_TIMEOUT = 80;

export function createViewportInteractions() {
  const interactions = defaults({ onFocusOnly: true });
  interactions.forEach((interaction, index) => {
    if (interaction instanceof MouseWheelZoom) {
      interactions.setAt(
        index,
        new MouseWheelZoom({
          onFocusOnly: true,
          timeout: VIEWPORT_WHEEL_TIMEOUT,
        }),
      );
    }
  });
  return interactions;
}

export class ViewportMoves {
  constructor(
    private readonly map: OlMap,
    private readonly publish: (viewport: IViewPortState) => void,
    private readonly following: () => boolean,
    controlsTarget: HTMLElement = map.getViewport(),
  ) {
    const interactions = map.getInteractions();
    interactions.forEach(interaction => this._observe(interaction));
    this._keys.push(
      interactions.on('add', event => this._observe(event.element)),
      interactions.on('remove', event => this._release(event.element)),
      map.on('moveend', this._complete),
      map.on('postrender', this._settled),
      map.on('change:view', () => this.suppress()),
      map.on('change:size', () => this.suppress()),
    );
    this._controlsTarget = controlsTarget;
    controlsTarget.addEventListener('click', this._beforeZoom, true);
    controlsTarget.addEventListener('click', this._afterZoom);
    map.getViewport().addEventListener('pointercancel', this._cancel);
  }

  suppress(): void {
    this._start = undefined;
    this._suppressed = true;
    this._clearWheel();
    this.map.render();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._start = undefined;
    this._clearWheel();
    unByKey(this._keys);
    for (const interaction of this._handlers.keys()) {
      this._release(interaction);
    }
    this._controlsTarget.removeEventListener('click', this._beforeZoom, true);
    this._controlsTarget.removeEventListener('click', this._afterZoom);
    this.map.getViewport().removeEventListener('pointercancel', this._cancel);
  }

  private _observe(interaction: Interaction): void {
    if (
      this._handlers.has(interaction) ||
      ![
        DoubleClickZoom,
        DragPan,
        DragZoom,
        KeyboardPan,
        KeyboardZoom,
        MouseWheelZoom,
        PinchZoom,
      ].some(type => interaction instanceof type)
    ) {
      return;
    }
    const original = interaction.handleEvent;
    this._handlers.set(interaction, original);
    interaction.handleEvent = event => {
      const before = this._snapshot();
      const view = this.map.getView();
      const wasBusy = view.getAnimating() || view.getInteracting();
      const result = original.call(interaction, event);
      if (this._disposed || this._suppressed || this.following()) {
        this._start = undefined;
        return result;
      }
      const after = this._snapshot();
      const started =
        !wasBusy && (view.getAnimating() || view.getInteracting());
      if (before && (started || !this._equal(before, after))) {
        this._start ??= before;
      }
      if (
        interaction instanceof MouseWheelZoom &&
        event.type === 'wheel' &&
        !result
      ) {
        const delta = (event.originalEvent as WheelEvent).deltaY;
        const zoom = view.getZoom();
        if (
          before &&
          zoom !== undefined &&
          delta !== 0 &&
          view.getConstrainedZoom(zoom - Math.sign(delta)) !== zoom
        ) {
          this._start ??= before;
          this._clearWheel();
          this._wheelTimer = setTimeout(() => {
            this._wheelTimer = undefined;
            this.map.render();
          }, VIEWPORT_WHEEL_TIMEOUT);
        }
      }
      return result;
    };
  }

  private _release(interaction: Interaction): void {
    const original = this._handlers.get(interaction);
    if (original) {
      interaction.handleEvent = original;
      this._handlers.delete(interaction);
      if (!this._disposed) {
        this.suppress();
      }
    }
  }

  private _beforeZoom = (event: MouseEvent): void => {
    this._controlStart = undefined;
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('.ol-zoom-in, .ol-zoom-out');
    if (button && this._controlsTarget.contains(button)) {
      this._controlStart = this._snapshot();
    }
  };

  private _afterZoom = (): void => {
    const before = this._controlStart;
    this._controlStart = undefined;
    if (!before || this._suppressed || this.following() || this._disposed) {
      return;
    }
    if (
      this.map.getView().getAnimating() ||
      !this._equal(before, this._snapshot())
    ) {
      this._start ??= before;
    }
  };

  private _complete = (): void => {
    const before = this._start;
    this._start = undefined;
    if (!before || this._suppressed || this.following() || this._disposed) {
      return;
    }
    const viewport = this._snapshot();
    if (viewport && !this._equal(before, viewport)) {
      this.publish(viewport);
    }
  };

  private _settled = (): void => {
    const view = this.map.getView();
    if (!view.getAnimating() && !view.getInteracting() && !this._wheelTimer) {
      this._start = undefined;
      this._suppressed = false;
    }
  };

  private _cancel = (): void => {
    this.suppress();
  };

  private _clearWheel(): void {
    clearTimeout(this._wheelTimer);
    this._wheelTimer = undefined;
  }

  private _snapshot(): IViewPortState | undefined {
    const view = this.map.getView();
    const center = view.getCenter();
    const zoom = view.getZoom();
    const size = this.map.getSize();
    if (
      !center ||
      zoom === undefined ||
      !size ||
      size.some(value => value <= 0)
    ) {
      return undefined;
    }
    const extent = view.calculateExtent(size);
    if (![...center, zoom, ...size, ...extent].every(Number.isFinite)) {
      return undefined;
    }
    return {
      coordinates: { x: center[0], y: center[1] },
      zoom,
      extent: [extent[0], extent[1], extent[2], extent[3]],
    };
  }

  private _equal(a: IViewPortState, b?: IViewPortState): boolean {
    return (
      !!b &&
      a.coordinates.x === b.coordinates.x &&
      a.coordinates.y === b.coordinates.y &&
      a.zoom === b.zoom &&
      a.extent.every((value, index) => value === b.extent[index])
    );
  }

  private _keys: EventsKey[] = [];
  private _handlers = new Map<Interaction, Interaction['handleEvent']>();
  private _controlsTarget: HTMLElement;
  private _start?: IViewPortState;
  private _controlStart?: IViewPortState;
  private _wheelTimer?: ReturnType<typeof setTimeout>;
  private _suppressed = false;
  private _disposed = false;
}
