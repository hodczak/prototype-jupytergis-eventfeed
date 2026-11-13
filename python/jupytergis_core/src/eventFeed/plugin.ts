import {
  IJupyterGISDocTracker,
  IJupyterGISModel,
  IJupyterGISTracker,
  IJupyterGISWidget,
  newDocuments,
} from '@jupytergis/schema';
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';
import type { Event } from '@jupyterlab/services';
import { JSONExt, type JSONObject } from '@lumino/coreutils';

import { wireShellExecutions } from './executions';
import { DocumentFocus } from './focus';
import { wireModeEvents } from './mode';
import { isSameReference, SourceReferences } from './sources';
import { wireViewportEvents } from './viewport';

interface IEventWiringProps {
  widget: IJupyterGISWidget;
  clientId: string;
  emit: (request: Event.Request) => void;
}

const LAYER_SCHEMA = 'https://schema.jupytergis.org/events/layer/v1';
const SOURCE_SCHEMA = 'https://schema.jupytergis.org/events/source/v1';

export const wireDocumentEvents = ({
  widget,
  clientId,
  emit,
}: IEventWiringProps): void => {
  const DOCUMENT_SCHEMA = 'https://schema.jupytergis.org/events/document/v1';
  const path = widget.model.filePath || null;
  // trail: created - the first view of a map JupyterGIS just made reports created, not opened.
  const verb = path && newDocuments.consume(path) ? 'created' : 'opened';

  emit({
    schema_id: DOCUMENT_SCHEMA,
    version: '1',
    data: {
      subject: clientId,
      verb,
      object: { document_path: path },
    },
  });

  widget.disposed.connect(() => {
    emit({
      schema_id: DOCUMENT_SCHEMA,
      version: '1',
      data: {
        subject: clientId,
        verb: 'closed',
        object: { document_path: widget.model.filePath || null },
      },
    });
  });
};

export const wireLayerEvents = (
  { widget, clientId, emit }: IEventWiringProps,
  references: SourceReferences,
): void => {
  widget.model.sharedLayersChanged.connect((_, change) => {
    for (const { id, oldValue, newValue, local } of change.layerChange ?? []) {
      const verb = !oldValue ? 'added' : !newValue ? 'removed' : 'updated';
      // trail: no-op - pressing OK in a dialog without edits writes the same layer again.
      if (
        verb === 'updated' &&
        JSONExt.deepEqual(
          oldValue as unknown as JSONObject,
          newValue as unknown as JSONObject,
        )
      ) {
        continue;
      }
      const oldSource = oldValue?.parameters?.source as string | undefined;
      const newSource = newValue?.parameters?.source as string | undefined;
      // trail: resources - an update names its source only when the layer switched sources.
      let source;
      if (verb === 'added') {
        source = references.get(newSource);
      } else if (verb === 'removed') {
        source = references.get(oldSource);
      } else if (oldSource !== newSource) {
        source = references.get(newSource);
      }

      emit({
        schema_id: LAYER_SCHEMA,
        version: '1',
        data: {
          subject: clientId,
          verb,
          ...(local === undefined ? {} : { local }),
          object: {
            document_path: widget.model.filePath || null,
            layer_id: id,
            ...(oldValue ? { old: oldValue as unknown as JSONObject } : {}), // TODO: Better typing
            ...(newValue ? { new: newValue as unknown as JSONObject } : {}), // TODO: Better typing
            ...(source ? { source: source as unknown as JSONObject } : {}),
          },
        },
      });
    }
  });
};

export const wireSourceEvents = (
  { widget, clientId, emit }: IEventWiringProps,
  references: SourceReferences,
): void => {
  widget.model.sharedSourcesChanged.connect((_, change) => {
    for (const { id, oldValue, newValue, local } of change.sourceChange ?? []) {
      // trail: resources - the old value comes from Yjs, not the cache another handler may update.
      const previous = oldValue ? references.compute(id, oldValue) : undefined;
      const current = newValue ? references.remember(id, newValue) : undefined;
      let verb: 'added' | 'updated' | 'removed';
      if (!previous && current) {
        verb = 'added';
      } else if (previous && !current) {
        verb = 'removed';
      } else if (previous && current && !isSameReference(previous, current)) {
        verb = 'updated';
      } else {
        // trail: resources - edits inside inline data or detected bands are not source events.
        continue;
      }

      emit({
        schema_id: SOURCE_SCHEMA,
        version: '1',
        data: {
          subject: clientId,
          verb,
          ...(local === undefined ? {} : { local }),
          object: {
            document_path: widget.model.filePath || null,
            source_id: id,
            ...(previous ? { old: previous as unknown as JSONObject } : {}),
            ...(current ? { new: current as unknown as JSONObject } : {}),
          },
        },
      });
    }
  });
};

export const eventFeedPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupytergis:core:event-feed',
  autoStart: true,
  requires: [IJupyterGISDocTracker],
  activate: (app: JupyterFrontEnd, tracker: IJupyterGISTracker): void => {
    const events = app.serviceManager.events;
    const wiredModels = new WeakSet<IJupyterGISModel>();

    const emit = (request: Event.Request): void => {
      events.emit(request).catch((error: unknown) => {
        console.warn('[jupytergis event-feed] failed to emit event', error);
      });
    };

    const focus = new DocumentFocus({ shell: app.shell, tracker, emit });
    wireShellExecutions(app.shell, emit);

    const wireJupyterGISEvents = (widget: IJupyterGISWidget): void => {
      // trail: focus - each view needs focus tracking even when views share a model.
      focus.add(widget);

      // Two widgets can share the same model. We only want to connect these
      // handlers once per document.
      if (wiredModels.has(widget.model)) {
        return;
      }

      wiredModels.add(widget.model);

      const eventWiringProps: IEventWiringProps = {
        widget: widget,
        clientId: String(widget.model.getClientId()),
        emit: emit,
      };

      wireDocumentEvents(eventWiringProps);
      wireModeEvents(widget.model, focus, emit);

      // When the document loads, a bunch of signals come through, e.g. all the
      // existing layers come through as 'added' events (among other events).
      // Connecting before the document loads results in a bunch of "added"
      // spam as those signals fire. We only care about the events triggered by
      // the user intentionally, so we wait until the document's initial sync
      // is complete to wire these signals.
      const model = widget.model;
      void model.sharedModel.initialSyncReady.then(() => {
        if (model.isDisposed) {
          return;
        }
        const references = new SourceReferences(model);
        references.seed();
        wireLayerEvents(eventWiringProps, references);
        wireSourceEvents(eventWiringProps, references);
        wireViewportEvents(model, emit);
      });
    };

    tracker.forEach(wireJupyterGISEvents);
    tracker.widgetAdded.connect((_, widget) => wireJupyterGISEvents(widget));
  },
};
