import type { IJupyterGISModel, IViewportMove } from '@jupytergis/schema';
import type { Event } from '@jupyterlab/services';
import type { JSONObject } from '@lumino/coreutils';

export function wireViewportEvents(
  model: IJupyterGISModel,
  emit: (request: Event.Request) => void,
): void {
  if (model.isDisposed) {
    return;
  }
  const publish = (_: IJupyterGISModel, { viewport }: IViewportMove): void => {
    if (model.isDisposed) {
      return;
    }
    emit({
      schema_id: 'https://schema.jupytergis.org/events/viewport/v1',
      version: '1',
      data: {
        subject: String(model.getClientId()),
        verb: 'moved',
        object: {
          document_path: model.filePath || null,
          new: viewport as unknown as JSONObject,
        },
      },
    });
  };
  const dispose = (): void => {
    model.viewportMoved.disconnect(publish);
    model.disposed.disconnect(dispose);
  };
  model.viewportMoved.connect(publish);
  model.disposed.connect(dispose);
}
