import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { Event, Kernel, KernelMessage } from '@jupyterlab/services';
import type { ISignal } from '@lumino/signaling';

export const NOTEBOOK_SCHEMA =
  'https://schema.jupytergis.org/events/notebook/v1';

/**
 * The parts of a notebook's or console's session context that the observer reads.
 */
export interface IExecutionContext {
  readonly path: string;
  readonly session: { readonly kernel: Kernel.IKernelConnection | null } | null;
  readonly kernelChanged: ISignal<unknown, unknown>;
  readonly disposed: ISignal<unknown, unknown>;
}

function localPath(path: string): string {
  // a collaborative document's path carries its drive, such as `RTC:`
  return path.replace(/^[^/:]+:/, '');
}

/**
 * Report each execution request this page sends for a document: the request's id, which the
 * kernel's IOPub messages carry as their parent, with the document and the cell that sent it.
 * Only the page that sends a request knows its cell, so a listener on the kernel cannot.
 */
// trail: execution - the request id joins a cell to the kernel's broadcast of its execution.
export function wireExecutionRequests(
  context: IExecutionContext,
  emit: (request: Event.Request) => void,
): void {
  let kernel: Kernel.IKernelConnection | null = null;
  const onMessage = (
    _: Kernel.IKernelConnection,
    { msg, direction }: Kernel.IAnyMessageArgs,
  ): void => {
    if (
      direction !== 'send' ||
      msg.header.msg_type !== 'execute_request' ||
      !kernel
    ) {
      return;
    }
    const metadata = (msg as KernelMessage.IExecuteRequestMsg).metadata as {
      cellId?: unknown;
    };
    const cellId = metadata?.cellId;
    emit({
      schema_id: NOTEBOOK_SCHEMA,
      version: '1',
      data: {
        verb: 'requested',
        time: new Date().toISOString(),
        object: {
          document_path: localPath(context.path) || null,
          kernel_id: kernel.id,
          request_id: msg.header.msg_id,
          ...(typeof cellId === 'string' ? { cell_id: cellId } : {}),
        },
      },
    });
  };
  const attach = (): void => {
    kernel?.anyMessage.disconnect(onMessage);
    kernel = context.session?.kernel ?? null;
    kernel?.anyMessage.connect(onMessage);
  };
  const dispose = (): void => {
    kernel?.anyMessage.disconnect(onMessage);
    kernel = null;
    context.kernelChanged.disconnect(attach);
    context.disposed.disconnect(dispose);
  };
  context.kernelChanged.connect(attach);
  context.disposed.connect(dispose);
  attach();
}

/**
 * Observe the execution requests of every notebook and console in the main area, including ones
 * opened later. A widget is recognized by its session context.
 */
export function wireShellExecutions(
  shell: JupyterFrontEnd.IShell,
  emit: (request: Event.Request) => void,
): void {
  // some shells, such as embedded ones, list no widgets
  if (typeof shell.widgets !== 'function') {
    return;
  }
  const wired = new WeakSet<object>();
  const scan = (): void => {
    for (const widget of shell.widgets('main')) {
      const context = (widget as { sessionContext?: IExecutionContext })
        .sessionContext;
      if (
        !context ||
        wired.has(context) ||
        typeof context.kernelChanged?.connect !== 'function'
      ) {
        continue;
      }
      wired.add(context);
      wireExecutionRequests(context, emit);
    }
  };
  const layout = (shell as { layoutModified?: ISignal<unknown, void> })
    .layoutModified;
  layout?.connect(scan);
  shell.currentChanged?.connect(scan);
  scan();
}
