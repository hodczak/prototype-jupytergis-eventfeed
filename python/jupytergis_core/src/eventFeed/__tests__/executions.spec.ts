import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { Event } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import {
  IExecutionContext,
  NOTEBOOK_SCHEMA,
  wireExecutionRequests,
  wireShellExecutions,
} from '../executions';

function createKernel(id: string) {
  return { id, anyMessage: new Signal<object, any>({}) };
}

function createContext(path: string, kernel = createKernel('K1')) {
  const context = {
    path,
    session: { kernel } as { kernel: ReturnType<typeof createKernel> | null },
    kernelChanged: new Signal<object, unknown>({}),
    disposed: new Signal<object, unknown>({}),
  };
  return context;
}

function request(msgId: string, cellId?: string, msgType = 'execute_request') {
  return {
    header: { msg_id: msgId, msg_type: msgType },
    metadata: cellId === undefined ? {} : { cellId },
    content: { code: 'x = 1' },
  };
}

describe('execution requests', () => {
  let emit: jest.Mock<void, [Event.Request]>;

  beforeEach(() => {
    emit = jest.fn();
  });

  it('reports the cell and request id of each execute request this page sends', () => {
    const context = createContext('RTC:maps/analysis.ipynb');
    wireExecutionRequests(context as unknown as IExecutionContext, emit);
    const kernel = context.session.kernel as ReturnType<typeof createKernel>;
    kernel.anyMessage.emit({ msg: request('R1', 'cell-3'), direction: 'send' });
    // replies, other requests and other pages' messages are not requests of this page
    kernel.anyMessage.emit({ msg: request('R2', 'cell-3'), direction: 'recv' });
    kernel.anyMessage.emit({
      msg: request('R3', undefined, 'kernel_info_request'),
      direction: 'send',
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      schema_id: NOTEBOOK_SCHEMA,
      version: '1',
      data: {
        verb: 'requested',
        object: {
          document_path: 'maps/analysis.ipynb',
          kernel_id: 'K1',
          request_id: 'R1',
          cell_id: 'cell-3',
        },
      },
    });
  });

  it('follows a kernel change and stops when the context is disposed', () => {
    const context = createContext('console-1');
    wireExecutionRequests(context as unknown as IExecutionContext, emit);
    const first = context.session.kernel as ReturnType<typeof createKernel>;
    const second = createKernel('K2');
    context.session.kernel = second;
    context.kernelChanged.emit(undefined);
    first.anyMessage.emit({ msg: request('R1'), direction: 'send' });
    second.anyMessage.emit({ msg: request('R2'), direction: 'send' });
    expect(emit.mock.calls.map(([call]) => call.data.object)).toEqual([
      { document_path: 'console-1', kernel_id: 'K2', request_id: 'R2' },
    ]);
    context.disposed.emit(undefined);
    second.anyMessage.emit({ msg: request('R3'), direction: 'send' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('wires each notebook in the main area once, including later ones', () => {
    const first = createContext('a.ipynb');
    const widgets: object[] = [{ sessionContext: first }, { title: 'map' }];
    const shell = {
      widgets: () => widgets[Symbol.iterator](),
      currentChanged: new Signal<object, void>({}),
      layoutModified: new Signal<object, void>({}),
    };
    wireShellExecutions(shell as unknown as JupyterFrontEnd.IShell, emit);
    const second = createContext('b.ipynb', createKernel('K2'));
    widgets.push({ sessionContext: second });
    shell.layoutModified.emit();
    shell.currentChanged.emit();
    (first.session.kernel as ReturnType<typeof createKernel>).anyMessage.emit({
      msg: request('R1', 'c1'),
      direction: 'send',
    });
    (second.session.kernel as ReturnType<typeof createKernel>).anyMessage.emit({
      msg: request('R2', 'c2'),
      direction: 'send',
    });
    expect(
      emit.mock.calls.map(([call]) => call.data.object.request_id),
    ).toEqual(['R1', 'R2']);
    expect(() =>
      wireShellExecutions({} as JupyterFrontEnd.IShell, emit),
    ).not.toThrow();
  });
});
