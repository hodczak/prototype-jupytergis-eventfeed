import type { IJupyterGISTracker, IJupyterGISWidget } from '@jupytergis/schema';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { Event } from '@jupyterlab/services';
import { UUID } from '@lumino/coreutils';

interface IDocumentFocusOptions {
  shell: JupyterFrontEnd.IShell;
  tracker: IJupyterGISTracker;
  emit: (request: Event.Request) => void;
}

type FocusReason =
  | 'initial_state'
  | 'document_switch'
  | 'window_focused'
  | 'window_blurred'
  | 'page_visible'
  | 'page_hidden'
  | 'widget_closed';

// trail: focus - record active map views independently of document open/close events.
export class DocumentFocus {
  constructor(private readonly _options: IDocumentFocusOptions) {
    if (!_options.shell.currentChanged) {
      return;
    }

    // trail: focus - the map tracker remembers its last map after another tool takes focus.
    _options.shell.currentChanged.connect(this._onCurrentChanged, this);
    _options.shell.disposed.connect(this.dispose, this);
    window.addEventListener('focus', this._onWindowFocus);
    window.addEventListener('blur', this._onWindowBlur);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._schedule('initial_state');
  }

  add(widget: IJupyterGISWidget): void {
    if (
      this._disposed ||
      !this._options.shell.currentChanged ||
      widget.isDisposed ||
      this._widgets.has(widget)
    ) {
      return;
    }

    const onDisposed = (): void => {
      // trail: focus - deactivate before the lifecycle listener emits closed.
      if (this._active === widget) {
        this._publish(widget, 'deactivated', 'widget_closed');
        this._active = null;
      }
      this._widgets.delete(widget);
      widget.disposed.disconnect(onDisposed);
      this._schedule('document_switch');
    };

    this._widgets.set(widget, onDisposed);
    widget.disposed.connect(onDisposed);
    this._schedule('document_switch');
  }

  /**
   * Number another page-ordered event, such as a tool change, with the focus counter. A pending
   * focus transition is published first, so an activation precedes a tool change it caused.
   */
  // trail: mode - focus and tool changes share one page counter.
  order(): { frontend_id: string; focus_seq: number } {
    this.flush();
    return { frontend_id: this._frontendId, focus_seq: ++this._sequence };
  }

  /**
   * Publish a scheduled focus transition now instead of in the next microtask.
   */
  flush(): void {
    if (this._scheduled && !this._disposed) {
      this._scheduled = false;
      this._reconcile();
    }
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._options.shell.disposed.disconnect(this.dispose, this);
    this._options.shell.currentChanged?.disconnect(
      this._onCurrentChanged,
      this,
    );
    window.removeEventListener('focus', this._onWindowFocus);
    window.removeEventListener('blur', this._onWindowBlur);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    for (const [widget, onDisposed] of this._widgets) {
      widget.disposed.disconnect(onDisposed);
    }
    this._widgets.clear();
    this._active = null;
  }

  private _schedule(reason: FocusReason): void {
    this._reason = reason;
    if (this._disposed || this._scheduled) {
      return;
    }
    this._scheduled = true;

    // trail: focus - overlapping shell and browser signals describe one state transition.
    void Promise.resolve().then(() => {
      if (!this._scheduled) {
        return;
      }
      this._scheduled = false;
      if (!this._disposed) {
        this._reconcile();
      }
    });
  }

  private _reconcile(): void {
    const { shell, tracker } = this._options;
    const current = shell.currentWidget as IJupyterGISWidget | null;
    let next: IJupyterGISWidget | null = null;
    if (
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      current &&
      !current.isDisposed &&
      tracker.has(current) &&
      this._widgets.has(current)
    ) {
      next = current;
    }

    let reason = this._reason;
    if (this._initial) {
      reason = 'initial_state';
      this._initial = false;
    }
    if (next === this._active) {
      return;
    }
    if (this._active) {
      this._publish(this._active, 'deactivated', reason);
    }
    this._active = next;
    if (next) {
      this._publish(next, 'activated', reason);
    }
  }

  private _publish(
    widget: IJupyterGISWidget,
    verb: 'activated' | 'deactivated',
    reason: FocusReason,
  ): void {
    this._options.emit({
      schema_id: 'https://schema.jupytergis.org/events/document/v1',
      version: '1',
      data: {
        subject: String(widget.model.getClientId()),
        verb,
        time: new Date().toISOString(),
        frontend_id: this._frontendId,
        // trail: focus - one page counter orders transitions between different maps.
        focus_seq: ++this._sequence,
        object: {
          document_path: widget.model.filePath || null,
          widget_id: widget.id,
          reason,
        },
      },
    });
  }

  private _onCurrentChanged(): void {
    this._schedule('document_switch');
  }

  private _onWindowFocus = (): void => {
    this._schedule('window_focused');
  };

  private _onWindowBlur = (): void => {
    this._schedule('window_blurred');
  };

  private _onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this._schedule('page_visible');
    } else {
      this._schedule('page_hidden');
    }
  };

  private _frontendId = UUID.uuid4();
  private _sequence = 0;
  private _active: IJupyterGISWidget | null = null;
  private _widgets = new Map<IJupyterGISWidget, () => void>();
  private _reason: FocusReason = 'initial_state';
  private _initial = true;
  private _scheduled = false;
  private _disposed = false;
}
