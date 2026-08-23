import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChargerDB } from '../../app/chargers.js';

const data = JSON.parse(readFileSync(new URL('../../data/chargers.json', import.meta.url), 'utf8'));
const db = new ChargerDB(data);

test('chargers.json has the expected shape', () => {
  assert.ok(data.count > 8000, `count ${data.count}`);
  assert.equal(data.sites.length, data.count);
  for (const s of data.sites) {
    assert.equal(typeof s.id, 'number');
    assert.equal(typeof s.lat, 'number');
    assert.equal(typeof s.lng, 'number');
    assert.equal(typeof s.status, 'string');
    assert.equal(typeof s.kw, 'number');
    assert.ok(Array.isArray(s.plugs));
  }
});

test('nearest open sites from Tromsø are Skibotn and Finnsnes (< 140 km)', () => {
  const near = db.nearest(69.6496, 18.9553, { n: 3, filter: s => db.isUsable(s) });
  const names = near.map(x => x.site.name);
  assert.ok(names.some(n => n.startsWith('Skibotn')), names.join(','));
  assert.ok(names.some(n => n.startsWith('Finnsnes')), names.join(','));
  near.forEach(x => assert.ok(x.distM < 140000));
  assert.ok(near[0].distM <= near[1].distM);
});

test('nearest respects maxM and byId works', () => {
  const near = db.nearest(69.6496, 18.9553, { n: 10, maxM: 30000, filter: s => db.isUsable(s) });
  assert.equal(near.length, 0);
  const some = db.sites[0];
  assert.equal(db.byId(some.id), some);
  assert.equal(db.byId(String(some.id)), some);
});

test('search finds sites by name, usable first', () => {
  const hits = db.search('berlin', 20);
  assert.ok(hits.length > 3);
  assert.ok(hits.every(s => `${s.name} ${s.city} ${s.country}`.toLowerCase().includes('berlin')));
  const firstUnusable = hits.findIndex(s => !db.isUsable(s));
  const lastUsable = hits.map(s => db.isUsable(s)).lastIndexOf(true);
  assert.ok(firstUnusable === -1 || firstUnusable > lastUsable);
});
