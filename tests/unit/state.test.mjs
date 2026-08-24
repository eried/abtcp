import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTrip, defaultSettings, serialize, deserialize, migrate, createStore, newStop, toLocalIso, deepMerge } from '../../app/state.js';

const memStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), size: () => m.size }; };

test('default trip round-trips through serialize/deserialize', () => {
  const t = defaultTrip(new Date(2026, 7, 24, 12, 0));
  assert.equal(t.start.time, '2026-08-25T08:00');
  assert.deepEqual(deserialize(serialize(t)), t);
});

test('partial documents get defaults deep-merged', () => {
  const t = deserialize(JSON.stringify({ version: 1, stops: [{ id: 'a', kind: 'charger', siteId: 5, lat: 1, lng: 2, name: 'X', charge: { targetSoc: 70 } }], settings: { rules: { windowH: 48 } } }));
  assert.equal(t.settings.rules.windowH, 48);
  assert.equal(t.settings.rules.anchor, 'start');
  assert.equal(t.settings.reserveSoc, defaultSettings().reserveSoc);
  assert.equal(t.stops.length, 1);
  assert.equal(t.stops[0].charge.targetSoc, 70);
  assert.equal(t.stops[0].rest, null);
  assert.equal(t.stops[0].note, '');
  assert.deepEqual(t.legs, {});
  assert.equal(t.car.usableKwh, 75);
});

test('garbage and foreign JSON are rejected', () => {
  assert.throws(() => deserialize('not json'), /invalid JSON/);
  assert.throws(() => deserialize('{"foo":1}'), /Not an ABTCP/);
  assert.throws(() => deserialize('[]'), /Not an ABTCP/);
  assert.throws(() => deserialize(JSON.stringify({ version: 99, stops: [] })), /newer/);
});

test('newStop builds charger and point stops', () => {
  const site = { id: 42, tid: 'x', name: 'Skibotn, Norway', lat: 69.39, lng: 20.27, kw: 150, stalls: 6, status: 'OPEN', country: 'Norway' };
  const s = newStop({ site, targetSoc: 55 });
  assert.equal(s.kind, 'charger'); assert.equal(s.siteId, 42); assert.equal(s.kw, 150); assert.deepEqual(s.charge, { targetSoc: 55 }); assert.equal(s.rest, null);
  const p = newStop({ lat: 1, lng: 2, name: 'Hotel' });
  assert.equal(p.kind, 'point'); assert.equal(p.charge, null); assert.equal(p.siteId, null);
  assert.notEqual(s.id, p.id);
});

test('store autosaves on update and load restores; subscribers fire once per update', () => {
  const storage = memStorage();
  const store = createStore({ storage, trip: defaultTrip(new Date(2026, 0, 1)) });
  let fired = 0;
  const unsub = store.subscribe(() => fired++);
  store.update(t => { t.meta.name = 'Nordkapp run'; t.stops.push(newStop({ lat: 70, lng: 25, name: 'Nordkapp' })); });
  assert.equal(fired, 1);
  assert.equal(storage.size(), 1);
  const store2 = createStore({ storage });
  assert.equal(store2.load(), true);
  assert.equal(store2.trip.meta.name, 'Nordkapp run');
  assert.equal(store2.trip.stops.length, 1);
  unsub();
  store.update(() => {});
  assert.equal(fired, 1);
  store.reset();
  assert.equal(store.trip.stops.length, 0);
  const empty = createStore({ storage: memStorage() });
  assert.equal(empty.load(), false);
  const none = createStore({ storage: null });
  assert.equal(none.save(), false);
});

test('deepMerge replaces arrays and keeps base for undefined', () => {
  const out = deepMerge({ a: { b: 1, c: [1, 2] }, d: 4 }, { a: { c: [9] }, d: undefined });
  assert.deepEqual(out, { a: { b: 1, c: [9] }, d: 4 });
});

test('toLocalIso formats local time and migrate tolerates bad fields', () => {
  assert.equal(toLocalIso(new Date(2026, 8, 1, 7, 5)), '2026-09-01T07:05');
  const t = migrate({ version: 1, stops: 'nope', legs: 3, destination: 'x', visitedBefore: 'y' });
  assert.deepEqual(t.stops, []); assert.deepEqual(t.legs, {}); assert.equal(t.destination, null); assert.deepEqual(t.visitedBefore, []);
});

test('undo/redo walks the history and keeps the leg cache', () => {
  const storage = memStorage();
  let clock = 0;
  const store = createStore({ storage, trip: defaultTrip(new Date(2026, 0, 1)), now: () => (clock += 1000) });
  assert.equal(store.canUndo(), false);
  assert.equal(store.undo(), false);
  store.update(t => { t.stops.push(newStop({ lat: 1, lng: 2, name: 'A' })); t.legs['x'] = { status: 'ok' }; });
  store.update(t => { t.stops.push(newStop({ lat: 3, lng: 4, name: 'B' })); });
  assert.equal(store.trip.stops.length, 2);
  assert.equal(store.canUndo(), true);
  assert.equal(store.undo(), true);
  assert.deepEqual(store.trip.stops.map(s => s.name), ['A']);
  assert.deepEqual(store.trip.legs, { x: { status: 'ok' } }, 'route cache survives undo');
  assert.equal(store.undo(), true);
  assert.equal(store.trip.stops.length, 0);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), true);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.trip.stops.map(s => s.name), ['A']);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.trip.stops.map(s => s.name), ['A', 'B']);
  assert.equal(store.redo(), false);
  store.update(t => { t.meta.name = 'branch'; });
  assert.equal(store.canRedo(), false, 'a new edit clears the redo branch');
});

test('rapid edits coalesce into one undo step and history is capped', () => {
  let clock = 0;
  const fast = createStore({ storage: null, trip: defaultTrip(new Date(2026, 0, 1)), now: () => clock });
  fast.update(t => { t.start.soc = 80; });
  clock += 100;
  fast.update(t => { t.start.soc = 70; });
  clock += 100;
  fast.update(t => { t.start.soc = 60; });
  fast.undo();
  assert.equal(fast.trip.start.soc, 90, 'a slider drag is a single undo step');
  const capped = createStore({ storage: null, trip: defaultTrip(new Date(2026, 0, 1)), historyLimit: 3, coalesceMs: 0, now: () => (clock += 1000) });
  for (let i = 0; i < 6; i++) capped.update(t => { t.start.soc = 50 + i; });
  let steps = 0;
  while (capped.undo()) steps++;
  assert.equal(steps, 3, 'history capped at historyLimit');
});

test('batch groups a whole action into one undo step; updateQuiet stays out of history', async () => {
  let clock = 0;
  const store = createStore({ storage: null, trip: defaultTrip(new Date(2026, 0, 1)), coalesceMs: 0, now: () => (clock += 1000) });
  await store.batch(async () => {
    store.update(t => { t.stops.push(newStop({ lat: 1, lng: 1, name: 'A' })); });
    store.updateQuiet(t => { t.legs['k1'] = { status: 'ok' }; });
    store.update(t => { t.stops.push(newStop({ lat: 2, lng: 2, name: 'B' })); });
    store.update(t => { t.stops[0].charge = { targetSoc: 80 }; });
  });
  assert.equal(store.trip.stops.length, 2);
  assert.equal(store.undo(), true);
  assert.equal(store.trip.stops.length, 0, 'one undo reverts the whole batch');
  assert.equal(store.canUndo(), false, 'the batch produced exactly one entry');
  assert.equal(store.redo(), true);
  assert.equal(store.trip.stops.length, 2);
  const before = store.canUndo();
  store.updateQuiet(t => { t.legs['k2'] = { status: 'ok' }; });
  assert.equal(store.canUndo(), before, 'a cache write adds no history entry');
  assert.equal(store.trip.legs.k2.status, 'ok');
});

test('a batch, import or reset is never coalesced into the previous edit', async () => {
  let clock = 0;
  const store = createStore({ storage: null, trip: defaultTrip(new Date(2026, 0, 1)), coalesceMs: 500, now: () => clock });
  store.update(t => { t.stops.push(newStop({ lat: 1, lng: 1, name: 'A' })); });
  clock += 50; // a batch starting right after an edit must still be its own undo step
  await store.batch(async () => {
    store.update(t => { t.stops.push(newStop({ lat: 2, lng: 2, name: 'B' })); });
    store.update(t => { t.stops.push(newStop({ lat: 3, lng: 3, name: 'C' })); });
  });
  assert.deepEqual(store.trip.stops.map(s => s.name), ['A', 'B', 'C']);
  assert.equal(store.undo(), true);
  assert.deepEqual(store.trip.stops.map(s => s.name), ['A'], 'one undo reverts only the batch');
  assert.equal(store.undo(), true);
  assert.deepEqual(store.trip.stops.map(s => s.name), []);
  clock += 10;
  store.replace(defaultTrip(new Date(2026, 0, 2)));
  clock += 10;
  store.reset();
  assert.equal(store.historyDepth().undo, 2, 'replace and reset each add a step');
});
