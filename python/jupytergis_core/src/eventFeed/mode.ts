import type { IJupyterGISModel, Modes } from '@jupytergis/schema';
import type { Event } from '@jupyterlab/services';

export const MODE_SCHEMA = 'https://schema.jupytergis.org/events/mode/v1';

/**
 * Supplies the page identity and counter that order tool changes with focus transitions.
 */
export interface IPageOrder {
  order(): { frontend_id: string; focus_seq: number };
}

/**
 * Report each change of a map model's interaction mode once. The initial `panning` is not a
 * change. Automatic resets are reported like any other change.
 */
// trail: mode - the mode is per model, so views sharing a model report each change once.
export function wireModeEvents(
  model: IJupyterGISModel,
  page: IPageOrder,
  emit: (request: Event.Request) => void,
): void {
  if (model.isDisposed) {
    return;
  }
  let previous: Modes = model.currentMode;
  const publish = (_: IJupyterGISModel, mode: Modes): void => {
    if (model.isDisposed || mode === previous) {
      return;
    }
    const { frontend_id, focus_seq } = page.order();
    emit({
      schema_id: MODE_SCHEMA,
      version: '1',
      data: {
        subject: String(model.getClientId()),
        verb: 'changed',
        time: new Date().toISOString(),
        frontend_id,
        focus_seq,
        object: {
          document_path: model.filePath || null,
          mode,
          previous,
        },
      },
    });
    previous = mode;
  };
  const dispose = (): void => {
    model.modeChanged.disconnect(publish);
    model.disposed.disconnect(dispose);
  };
  model.modeChanged.connect(publish);
  model.disposed.connect(dispose);
}
