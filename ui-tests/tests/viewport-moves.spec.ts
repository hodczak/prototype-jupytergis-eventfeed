import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

test.use({ hasTouch: true });

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const view = (window as any).viewportTest.map.getView();
    return !view.getAnimating() && !view.getInteracting();
  });
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function count(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).viewportTest.moves.length);
}

test.beforeEach(async ({ page, tmpPath }) => {
  const file = `${tmpPath}/viewport.jGIS`;
  await page.contents.uploadContent(
    JSON.stringify({
      layers: {},
      sources: {},
      layerTree: [],
      options: { latitude: 0, longitude: 0, zoom: 1, projection: 'EPSG:3857' },
    }),
    'text',
    file,
  );
  await page.evaluate(async () => {
    const registry = await window.galata.getPlugin(
      '@jupyterlab/apputils-extension:settings',
    );
    await registry!.set(
      '@jupytergis/jupytergis-core:jupytergis-settings',
      'zoomButtonsEnabled',
      true,
    );
    const state = {
      moves: [] as any[],
      emissions: [] as any[],
      received: [] as any[],
      model: undefined as any,
      map: undefined as any,
    };
    (window as any).viewportTest = state;
    const events = window.jupyterapp.serviceManager.events;
    const emit = events.emit.bind(events);
    events.emit = request => {
      if (request.schema_id.endsWith('/viewport/v1')) {
        state.emissions.push({
          request,
          at: performance.now(),
          epoch: Date.now(),
        });
      }
      return emit(request);
    };
    events.stream.connect((_, event) => {
      if (event.schema_id.endsWith('/viewport/v1')) {
        state.received.push({
          event,
          at: performance.now(),
          epoch: Date.now(),
        });
      }
    });
    window.jupyterapp.shell.currentChanged.connect((_, args) => {
      const model = (args.newValue as any)?.model;
      if (model?.viewportMoved && state.model !== model) {
        state.model = model;
        model.viewportMoved.connect((_: unknown, move: any) =>
          state.moves.push({
            ...move,
            at: performance.now(),
            epoch: Date.now(),
          }),
        );
      }
    });
  });
  await page.notebook.openByPath(file);
  await expect(page.locator('.ol-viewport')).toBeVisible();
  await page.waitForFunction(() => {
    const state = (window as any).viewportTest;
    state.map = (window as any).jupytergisMaps?.[state.model?.filePath];
    return !!state.map;
  });
  await settle(page);
  expect(await count(page)).toBe(0);
});

test('real navigation publishes completed snapshots, including the first zoom', async ({
  page,
}) => {
  const initial = await page.evaluate(() => {
    const view = (window as any).viewportTest.map.getView();
    return { center: view.getCenter(), zoom: view.getZoom() };
  });
  await page.locator('.ol-zoom-in').click();
  await expect.poll(() => count(page)).toBe(1);
  const first = await page.evaluate(
    () => (window as any).viewportTest.moves[0].viewport,
  );
  expect(first.zoom).toBeCloseTo(initial.zoom + 1);
  expect(first.coordinates).toEqual({
    x: initial.center[0],
    y: initial.center[1],
  });

  await page.locator('.ol-zoom-out').click();
  await expect.poll(() => count(page)).toBe(2);
  const viewport = page.locator('.ol-viewport');
  const box = (await viewport.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => count(page)).toBe(3);
  await page.mouse.wheel(0, -2);
  await expect.poll(() => count(page)).toBe(4);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 50, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => count(page)).toBe(5);

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => count(page)).toBe(6);

  const cdp = await page.context().newCDPSession(page.mainFrame());
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 40, y, id: 1 },
      { x: x + 40, y, id: 2 },
    ],
  });
  for (const distance of [50, 65, 80, 100]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - distance, y, id: 1 },
        { x: x + distance, y, id: 2 },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect.poll(() => count(page)).toBe(7);
  await cdp.detach();
  await settle(page);
  const result = await page.evaluate(() => {
    const { map, moves } = (window as any).viewportTest;
    const view = map.getView();
    return {
      latest: moves.at(-1).viewport,
      center: view.getCenter(),
      zoom: view.getZoom(),
      extent: view.calculateExtent(map.getSize()),
      emitters: moves.map((move: any) => move.emitter),
    };
  });
  expect(result.latest).toEqual({
    coordinates: { x: result.center[0], y: result.center[1] },
    zoom: result.zoom,
    extent: result.extent,
  });
  expect(new Set(result.emitters).size).toBe(1);
  expect(result.emitters[0]).toBeTruthy();

  await page.evaluate(() => {
    const { map } = (window as any).viewportTest;
    const View = map.getView().constructor;
    map.setView(new View({ center: [0, 0], zoom: 1, multiWorld: true }));
  });
  await settle(page);
  expect(await count(page)).toBe(7);
  await page.locator('.ol-zoom-out').click();
  await expect.poll(() => count(page)).toBe(8);
  expect(
    await page.evaluate(
      () => (window as any).viewportTest.moves.at(-1).viewport.zoom,
    ),
  ).toBe(0);
});

test('filters no-ops, resize, camera changes and follow restoration', async ({
  page,
}) => {
  await page.locator('.ol-zoom-out').click();
  await expect.poll(() => count(page)).toBe(1);
  await page.locator('.ol-zoom-out').click();
  await settle(page);
  expect(await count(page)).toBe(1);

  await page.locator('.ol-viewport').click();
  await page.keyboard.press('a');
  await page.evaluate(() => {
    (window as any).viewportTest.map.getView().setCenter([1000, 0]);
  });
  await settle(page);
  await page.setViewportSize({ width: 1200, height: 850 });
  await settle(page);
  expect(await count(page)).toBe(1);

  await page.evaluate(() => {
    const { model } = (window as any).viewportTest;
    const remote = model.getClientId() + 1;
    model.sharedModel.awareness.getStates().set(remote, {
      ...model.localState,
      user: {
        username: 'viewport-test',
        display_name: 'Viewport Test',
        color: '#123456',
      },
      viewportState: {
        value: {
          coordinates: { x: 10000, y: 20000 },
          zoom: 4,
          extent: [0, 0, 100, 100],
        },
      },
    });
    model.setUserToFollow(remote);
  });
  await settle(page);
  await page.evaluate(() =>
    (window as any).viewportTest.model.setUserToFollow(undefined),
  );
  await settle(page);
  expect(await count(page)).toBe(1);
  await page.locator('.ol-zoom-in').click();
  await expect.poll(() => count(page)).toBe(2);

  await page.evaluate(() => {
    const { model } = (window as any).viewportTest;
    model.flyToGeometrySignal.emit({
      getExtent: () => [50000, 50000, 60000, 60000],
    });
  });
  await settle(page);
  expect(await count(page)).toBe(2);
});

test.afterEach(async ({ page }, testInfo) => {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = (window as any).viewportTest;
        return state.received.length;
      }),
    )
    .toBe(await count(page));
  const observed = await page.evaluate(() => {
    const { moves, emissions, received } = (window as any).viewportTest;
    return { moves, emissions, received };
  });
  expect(observed.emissions).toHaveLength(observed.moves.length);
  for (let index = 0; index < observed.moves.length; index++) {
    expect(observed.emissions[index].request.data.object.new).toEqual(
      observed.moves[index].viewport,
    );
    expect(
      Math.abs(observed.emissions[index].at - observed.moves[index].at),
    ).toBeLessThan(50);
  }
  await testInfo.attach('viewport-events', {
    body: JSON.stringify(observed),
    contentType: 'application/json',
  });
});

test('keeps the remaining view connected when the original view closes', async ({
  page,
}) => {
  await page.locator('.ol-zoom-in').click();
  await expect.poll(() => count(page)).toBe(1);
  const sameModel = await page.evaluate(async () => {
    const manager = await window.galata.getPlugin(
      '@jupyterlab/docmanager-extension:manager',
    );
    const first = window.jupyterapp.shell.currentWidget!;
    const second = manager!.cloneWidget(first)!;
    (window as any).viewportTest.first = first;
    window.jupyterapp.shell.add(second, 'main', { mode: 'split-right' });
    window.jupyterapp.shell.activateById(second.id);
    return (first as any).model === (second as any).model;
  });
  expect(sameModel).toBe(true);
  await expect(page.locator('.ol-viewport')).toHaveCount(2);
  await page.waitForFunction(() => {
    const state = (window as any).viewportTest;
    const second = (window as any).jupytergisMaps[state.model.filePath];
    if (second && second !== state.map) {
      state.map = second;
      return true;
    }
    return false;
  });
  await settle(page);
  await page.evaluate(() => (window as any).viewportTest.first.dispose());
  await expect(page.locator('.ol-viewport')).toHaveCount(1);
  await settle(page);
  await page.locator('.ol-zoom-in').click();
  await expect.poll(() => count(page)).toBe(2);
  const emitters = await page.evaluate(() =>
    (window as any).viewportTest.moves.map((move: any) => move.emitter),
  );
  expect(new Set(emitters).size).toBe(2);
});

test('does not publish a movement after its view closes', async ({ page }) => {
  await page.locator('.ol-viewport').hover();
  await page.mouse.wheel(0, -120);
  await page.evaluate(() => window.jupyterapp.shell.currentWidget!.dispose());
  await page.waitForTimeout(600);
  expect(await count(page)).toBe(0);
});
