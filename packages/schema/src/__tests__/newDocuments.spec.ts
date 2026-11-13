import { NewDocuments } from '../newDocuments';

describe('new document registry', () => {
  let now: number;
  let registry: NewDocuments;

  beforeEach(() => {
    now = 1000;
    registry = new NewDocuments(500, () => now);
  });

  it('consumes a registration once', () => {
    registry.register('maps/untitled.jGIS');
    expect(registry.consume('maps/untitled.jGIS')).toBe(true);
    expect(registry.consume('maps/untitled.jGIS')).toBe(false);
  });

  it('matches paths with and without a drive prefix', () => {
    registry.register('RTC:maps/untitled.jGIS');
    expect(registry.consume('maps/untitled.jGIS')).toBe(true);
    registry.register('/untitled1.jGIS');
    expect(registry.consume('untitled1.jGIS')).toBe(true);
  });

  it('does not mark an open after a discarded registration', () => {
    registry.register('untitled.jGIS');
    registry.discard('untitled.jGIS');
    expect(registry.consume('untitled.jGIS')).toBe(false);
  });

  it('expires an abandoned registration', () => {
    registry.register('untitled.jGIS');
    now += 501;
    expect(registry.consume('untitled.jGIS')).toBe(false);
  });

  it('ignores other paths', () => {
    registry.register('untitled.jGIS');
    expect(registry.consume('world.jGIS')).toBe(false);
    expect(registry.consume('untitled.jGIS')).toBe(true);
  });
});
