import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevation, elevationUrl, valhallaBody } from '../../app/services/elevation.js';

/** fake fetch: handler(url, init) → { status, json } */
const fakeFetch = handler => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  f.calls = calls;
  return f;
};
const valhallaOk = (url, init) => {
  if (!url.includes('valhalla')) return { status: 500, json: {} };
  const shape = JSON.parse(init.body).shape;
  return { json: { height: shape.map(p => Math.round(p.lat * 10)) } };
};
const openMeteoOk = url => {
  if (!url.includes('open-meteo')) return { status: 500, json: {} };
  const lats = new URL(url).searchParams.get('latitude').split(',');
  return { json: { elevation: lats.map(l => Math.round(+l * 10)) } };
};

test('Valhalla is used first: 250 points in one POST, cached afterwards', async () => {
  const f = fakeFetch(valhallaOk);
  const el = createElevation({ fetchImpl: f });
  const pts = Array.from({ length: 250 }, (_, i) => ({ lat: 60 + i * 0.01, lng: 10 }));
  const res = await el.sample(pts);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'text/plain');
  assert.equal(JSON.parse(f.calls[0].init.body).shape.length, 250);
  assert.equal(res.length, 250);
  assert.equal(res[0], 600);
  assert.equal(res[249], Math.round((60 + 249 * 0.01) * 10));
  assert.equal(el.lastProvider, 'valhalla');
  await el.sample(pts.slice(0, 50));
  assert.equal(f.calls.length, 1);
  assert.equal(el.calls, 1);
});

test('falls back to Open-Meteo in batches of 100 when Valhalla fails', async () => {
  const f = fakeFetch((url, init) => (url.includes('valhalla') ? { status: 503, json: {} } : openMeteoOk(url)));
  const el = createElevation({ fetchImpl: f, batch: 100 });
  const pts = Array.from({ length: 250 }, (_, i) => ({ lat: 60 + i * 0.01, lng: 10 }));
  const res = await el.sample(pts);
  assert.equal(f.calls.filter(c => c.url.includes('valhalla')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('open-meteo')).length, 3);
  assert.equal(res[249], Math.round((60 + 249 * 0.01) * 10));
  assert.equal(el.lastProvider, 'open-meteo');
  assert.ok(elevationUrl([{ lat: 60.123456, lng: 10.1 }]).endsWith('latitude=60.12346&longitude=10.10000'));
  assert.equal(valhallaBody([{ lat: 1.123456, lng: 2 }]), '{"shape":[{"lat":1.12346,"lon":2}],"range":false}');
});

test('throws when both providers return garbage; null heights become 0', async () => {
  const bad = createElevation({ fetchImpl: fakeFetch(() => ({ json: { nope: 1 } })) });
  await assert.rejects(bad.sample([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]), /unexpected data/);
  const nulls = createElevation({ fetchImpl: fakeFetch((url, init) => ({ json: { height: JSON.parse(init.body).shape.map(() => null) } })) });
  assert.deepEqual(await nulls.sample([{ lat: 1, lng: 1 }]), [0]);
  const noValhalla = createElevation({ fetchImpl: fakeFetch(openMeteoOk), valhallaUrl: null });
  assert.deepEqual(await noValhalla.sample([{ lat: 3, lng: 1 }]), [30]);
});
