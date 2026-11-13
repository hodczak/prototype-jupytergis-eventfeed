import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

// trail: events - the requests the event feed sends, as the page emits them.
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: any[] = [];
    (window as any).feedLog = log;
    const events = window.jupyterapp.serviceManager.events;
    const emit = events.emit.bind(events);
    events.emit = request => {
      if (request.schema_id.startsWith('https://schema.jupytergis.org/')) {
        log.push(JSON.parse(JSON.stringify(request)));
      }
      return emit(request);
    };
  });
}

async function emitted(page: Page, kind: string): Promise<any[]> {
  return page.evaluate(
    kind =>
      (window as any).feedLog
        .filter((request: any) => request.schema_id.endsWith(`/${kind}/v1`))
        .map((request: any) => request.data),
    kind,
  );
}

const MAP = {
  layers: {},
  sources: {},
  layerTree: [],
  options: { latitude: 0, longitude: 0, zoom: 2, projection: 'EPSG:3857' },
  metadata: {},
};

const POINTS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'a' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
  ],
};

test.describe('event feed', () => {
  test.beforeEach(async ({ page }) => {
    await record(page);
  });

  test('a map made from the launcher reports created, not opened', async ({
    page,
  }) => {
    await page
      .locator('.jp-LauncherCard', { hasText: 'GIS Project' })
      .first()
      .click();
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    await expect
      .poll(async () => (await emitted(page, 'document')).length)
      .toBeGreaterThan(0);
    const verbs = (await emitted(page, 'document')).map(data => data.verb);
    expect(verbs).toContain('created');
    expect(verbs).not.toContain('opened');
  });

  test('layers and sources carry locality and their data reference', async ({
    page,
    tmpPath,
  }) => {
    await page.contents.uploadContent(
      JSON.stringify(POINTS),
      'text',
      `${tmpPath}/data/points.geojson`,
    );
    await page.contents.uploadContent(
      JSON.stringify(MAP),
      'text',
      `${tmpPath}/maps/city.jGIS`,
    );
    await page.notebook.openByPath(`${tmpPath}/maps/city.jGIS`);
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const model = (window.jupyterapp.shell.currentWidget as any).model;
      model.sharedModel.addSource('S1', {
        name: 'points',
        type: 'GeoJSONSource',
        parameters: { path: '../data/points.geojson' },
      });
      model.addLayer('L1', {
        name: 'points',
        type: 'VectorLayer',
        visible: true,
        parameters: { source: 'S1' },
      });
      model.sharedModel.updateObjectParameters('S1', {
        path: 'https://user:pw@example.org/points.geojson?key=secret',
      });
    });
    await expect
      .poll(async () => (await emitted(page, 'source')).length)
      .toBe(2);
    const [layer] = await emitted(page, 'layer');
    expect(layer).toMatchObject({ verb: 'added', local: true });
    expect(layer.object.source).toEqual({
      id: 'S1',
      type: 'GeoJSONSource',
      path: '../data/points.geojson',
      resolved_path: `${tmpPath}/data/points.geojson`,
    });
    const [, updated] = await emitted(page, 'source');
    expect(updated.verb).toBe('updated');
    expect(updated.object.old.resolved_path).toBe(
      `${tmpPath}/data/points.geojson`,
    );
    expect(updated.object.new).toEqual({
      id: 'S1',
      type: 'GeoJSONSource',
      path: null,
      resolved_path: null,
      urls: ['https://example.org/points.geojson'],
    });
  });

  test('tool changes share the page counter with focus changes', async ({
    page,
    tmpPath,
  }) => {
    await page.contents.uploadContent(
      JSON.stringify(POINTS),
      'text',
      `${tmpPath}/points.geojson`,
    );
    const map = {
      ...MAP,
      sources: {
        S1: {
          name: 'points',
          type: 'GeoJSONSource',
          parameters: { path: 'points.geojson' },
        },
      },
      layers: {
        L1: {
          name: 'points',
          type: 'VectorLayer',
          visible: true,
          parameters: { source: 'S1' },
        },
      },
      layerTree: ['L1'],
    };
    await page.contents.uploadContent(
      JSON.stringify(map),
      'text',
      `${tmpPath}/tools.jGIS`,
    );
    await page.notebook.openByPath(`${tmpPath}/tools.jGIS`);
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    await page
      .locator('.jp-gis-layerTitle', { hasText: 'points' })
      .first()
      .click();
    const identify = page
      .locator('.jp-Toolbar [data-command="jupytergis:identify"]')
      .first();
    await identify.click();
    await identify.click();
    await expect.poll(async () => (await emitted(page, 'mode')).length).toBe(2);
    const modes = await emitted(page, 'mode');
    expect(modes.map(data => [data.object.previous, data.object.mode])).toEqual(
      [
        ['panning', 'identifying'],
        ['identifying', 'panning'],
      ],
    );
    const focus = (await emitted(page, 'document')).filter(
      data => data.focus_seq,
    );
    const activated = focus.filter(data => data.verb === 'activated').pop();
    expect(modes[0].frontend_id).toBe(activated.frontend_id);
    expect(modes[0].focus_seq).toBeGreaterThan(activated.focus_seq);
    expect(modes[1].focus_seq).toBe(modes[0].focus_seq + 1);
  });

  test('a notebook cell execution request names its cell', async ({ page }) => {
    await page.notebook.createNew();
    await page.notebook.setCell(0, 'code', 'x = 1');
    await page.notebook.runCell(0);
    await expect
      .poll(async () => (await emitted(page, 'notebook')).length)
      .toBeGreaterThan(0);
    const [request] = await emitted(page, 'notebook');
    const cellId = await page.evaluate(
      () =>
        (window.jupyterapp.shell.currentWidget as any).content.widgets[0].model
          .id,
    );
    expect(request.verb).toBe('requested');
    expect(request.object.cell_id).toBe(cellId);
    expect(request.object.request_id).toMatch(/.+/);
    expect(request.object.document_path).toMatch(/\.ipynb$/);
  });

  test('keyboard, marker, draw and automatic tool changes', async ({
    page,
    tmpPath,
  }) => {
    await page.contents.uploadContent(
      JSON.stringify(POINTS),
      'text',
      `${tmpPath}/points.geojson`,
    );
    const map = {
      ...MAP,
      sources: {
        S1: {
          name: 'points',
          type: 'GeoJSONSource',
          parameters: { path: 'points.geojson' },
        },
        S2: {
          name: 'tiles',
          type: 'RasterSource',
          parameters: {
            url: 'https://tile.example.org/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
          },
        },
      },
      layers: {
        L1: {
          name: 'points',
          type: 'VectorLayer',
          visible: true,
          parameters: { source: 'S1' },
        },
        L2: {
          name: 'tiles',
          type: 'RasterLayer',
          visible: true,
          parameters: { source: 'S2' },
        },
      },
      layerTree: ['L2', 'L1'],
    };
    await page.contents.uploadContent(
      JSON.stringify(map),
      'text',
      `${tmpPath}/tools.jGIS`,
    );
    await page.notebook.openByPath(`${tmpPath}/tools.jGIS`);
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    const pick = (name: string) =>
      page.locator('.jp-gis-layerTitle', { hasText: name }).first().click();
    const modes = async () =>
      (await emitted(page, 'mode')).map(data => [
        data.object.previous,
        data.object.mode,
      ]);

    // the keyboard, then Escape twice: the second Escape changes nothing
    await pick('points');
    await page.locator('.data-jgis-keybinding').first().focus();
    await page.keyboard.press('Control+i');
    await expect.poll(modes).toEqual([['panning', 'identifying']]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect.poll(modes).toHaveLength(2);
    await page.waitForTimeout(300);
    expect((await modes())[1]).toEqual(['identifying', 'panning']);
    expect(await modes()).toHaveLength(2);

    // Add Marker: a click adds a marker source and layer, which carries its inline reference
    const marker = page
      .locator('.jp-Toolbar [data-command="jupytergis:addMarker"]')
      .first();
    await marker.click();
    const box = (await page.locator('.ol-viewport').first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => (await emitted(page, 'layer')).length)
      .toBe(1);
    const [added] = await emitted(page, 'layer');
    expect(added.object.source).toMatchObject({
      type: 'MarkerSource',
      inline: { field: 'feature' },
    });
    await marker.click();

    // Edit Features with the raster layer selected makes an empty draw layer first
    await pick('tiles');
    await page
      .locator('.jp-Toolbar [data-command="jupytergis:toggleDrawFeatures"]')
      .first()
      .click();
    await expect
      .poll(async () => (await emitted(page, 'layer')).length)
      .toBe(2);
    // selecting a layer that cannot be drawn into returns to panning by itself
    await pick('tiles');
    await expect.poll(async () => (await modes()).length).toBe(6);
    const all = await modes();
    expect(all.slice(2)).toEqual([
      ['panning', 'marking'],
      ['marking', 'panning'],
      ['panning', 'drawing'],
      ['drawing', 'panning'],
    ]);

    // two views of one map share its tool, and report each change once
    await page.evaluate(() => {
      window.jupyterapp.commands.execute('docmanager:clone');
      return null;
    });
    await page.waitForTimeout(1000);
    await pick('points');
    await page
      .locator('.jp-Toolbar [data-command="jupytergis:identify"]:visible')
      .first()
      .click();
    await expect.poll(async () => (await modes()).length).toBe(7);
    await page.waitForTimeout(500);
    expect(await modes()).toHaveLength(7);
  });

  test('a source changed from Python reaches the open map as not local', async ({
    page,
    tmpPath,
  }) => {
    await page.contents.uploadContent(
      JSON.stringify(POINTS),
      'text',
      `${tmpPath}/points.geojson`,
    );
    const map = {
      ...MAP,
      sources: {
        S1: {
          name: 'points',
          type: 'GeoJSONSource',
          parameters: { path: 'points.geojson' },
        },
      },
    };
    await page.contents.uploadContent(
      JSON.stringify(map),
      'text',
      `${tmpPath}/city.jGIS`,
    );
    await page.notebook.openByPath(`${tmpPath}/city.jGIS`);
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    await page.notebook.createNew('edit.ipynb');
    await page.notebook.setCell(
      0,
      'code',
      "from jupytergis import GISDocument\ndoc = GISDocument('city.jGIS')",
    );
    await page.notebook.runCell(0);
    await page.waitForTimeout(3000);
    await page.notebook.addCell(
      'code',
      "source = dict(doc._sources['S1'])\n" +
        "source['parameters'] = {**source['parameters'], 'path': 'other.geojson'}\n" +
        "doc._sources['S1'] = source",
    );
    // running the first cell added an empty one after it
    await page.notebook.runCell((await page.notebook.getCellCount()) - 1);
    await expect
      .poll(async () => (await emitted(page, 'source')).length)
      .toBeGreaterThan(0);
    const [updated] = await emitted(page, 'source');
    expect(updated).toMatchObject({ verb: 'updated', local: false });
    expect(updated.object.old.resolved_path).toBe(`${tmpPath}/points.geojson`);
    expect(updated.object.new.resolved_path).toBe(`${tmpPath}/other.geojson`);
  });

  test('playing the temporal slider sends no layer message', async ({
    page,
    tmpPath,
  }) => {
    const dated = {
      type: 'FeatureCollection',
      features: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map(
        (date, index) => ({
          type: 'Feature',
          properties: { date },
          geometry: { type: 'Point', coordinates: [index, index] },
        }),
      ),
    };
    await page.contents.uploadContent(
      JSON.stringify(dated),
      'text',
      `${tmpPath}/dated.geojson`,
    );
    const map = {
      ...MAP,
      sources: {
        S1: {
          name: 'dated',
          type: 'GeoJSONSource',
          parameters: { path: 'dated.geojson' },
        },
      },
      layers: {
        L1: {
          name: 'dated',
          type: 'VectorLayer',
          visible: true,
          parameters: { source: 'S1' },
        },
      },
      layerTree: ['L1'],
    };
    await page.contents.uploadContent(
      JSON.stringify(map),
      'text',
      `${tmpPath}/time.jGIS`,
    );
    await page.notebook.openByPath(`${tmpPath}/time.jGIS`);
    await expect(page.locator('.ol-viewport').first()).toBeVisible();
    await page
      .locator('.jp-gis-layerTitle', { hasText: 'dated' })
      .first()
      .click();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.jupyterapp.commands.execute('jupytergis:temporalController');
      return null;
    });
    const controls = page.locator('.jp-gis-temporal-slider-controls button');
    await expect(controls.first()).toBeVisible();
    await controls.nth(1).click();
    await page.waitForTimeout(2500);
    await controls.nth(0).click();
    expect(await emitted(page, 'layer')).toEqual([]);
    expect(await emitted(page, 'source')).toEqual([]);
  });
});
