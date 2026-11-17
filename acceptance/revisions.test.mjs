import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

async function session(scenario = 'feature', run) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-matrix-'));
  const source = await createSource({ scenario });
  try {
    await run(source, await new Repository(directory).open(), directory);
  } finally {
    source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('matrix 3: a failed device document leaves readings pending with raw values, never zero', async () => {
  await session('feature', async (source, repository) => {
    source.state.failDoc = 'device';
    const summary = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(summary.complete, false);
    assert.equal(summary.interpretationComplete, false);
    const work = repository.workRecords();
    assert.equal(work.length, 2);
    for (const record of work) {
      assert.equal(record.status, 'pending');
      assert.equal(record.reason, 'device-element-unresolved');
      assert.equal(record.value, null, 'unidentified data must not be represented as a number');
      assert.equal(record.readings.length, 1);
      assert.equal(typeof record.readings[0].rawValue, 'number');
    }
    assert.deepEqual(
      work.flatMap(r => r.readings.map(reading => reading.rawValue)).sort(),
      [200, 300]
    );
    const notes = repository.snapshot().notes;
    assert.ok(notes.some(note => note.kind === 'source-unavailable' && note.document === 'device'));
    assert.ok(notes.some(note => note.kind === 'unresolved-reading'));
  });
});

test('matrix 3: a 404 missing document is an explicit gap and is recovered on redelivery', async () => {
  await session('feature', async (source, repository) => {
    source.state.missingDoc = 'device';
    const first = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(first.documentComplete, false);
    assert.deepEqual(first.pendingFetches, [{ id: 'device', outcome: 'missing', status: 404 }]);
    assert.ok(repository.workRecords().every(r => r.status === 'pending'));

    source.state.missingDoc = null;
    const second = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(second.complete, true);
    const ids = repository.workRecords().map(r => r.id).sort();
    assert.deepEqual(ids, [...fixture.expectedIds].sort());
  });
});

test('matrix 4: late device description is a targeted supplement with an audit trail', async () => {
  await session('feature', async (source, repository) => {
    source.state.failDoc = 'device';
    await collect({ base: source.base, repository, mode: 'managed' });
    const pendingKeys = repository.workRecords().map(r => r.key).sort();

    source.state.failDoc = null;
    const summary = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(summary.supplements, 2);
    const work = repository.workRecords();
    // Same structural identities; only the explanation changed.
    assert.deepEqual(work.map(r => r.key).sort(), pendingKeys);
    assert.ok(work.every(r => r.status === 'resolved'));
    for (const record of work) {
      assert.equal(record.revisions.length, 1);
      assert.equal(record.revisions[0].trigger, 'supplement');
      assert.equal(record.revisions[0].from.status, 'pending');
      assert.equal(record.revisions[0].to.status, 'resolved');
      // The raw value is preserved across re-interpretation.
      assert.ok(record.revisions[0].to.evidence.devices.length >= 1);
    }
    const left = work.find(r => r.id.endsWith('boom-left:volume'));
    assert.equal(left.readings[0].rawValue, 200);
    assert.equal(left.value, 20);
    assert.equal(left.unit, 'L');
  });
});

test('matrix 4: round=2 device revision changes 3 L to 6 L while raw 300 and old version stay traceable', async () => {
  await session('feature', async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const before = repository.workRecords().find(r => r.id.endsWith('boom-right:volume'));
    assert.equal(before.value, 3);
    const oldDeviceDigest = before.evidence.devices[0];

    source.state.round = 2;
    const summary = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(summary.revisions, 1);
    assert.equal(summary.supplements, 0);

    const after = repository.workRecords().find(r => r.id.endsWith('boom-right:volume'));
    assert.equal(after.value, 6);
    assert.equal(after.readings[0].rawValue, 300);
    assert.equal(after.readings[0].unit, 'L');
    assert.equal(after.revisions.length, 1);
    assert.equal(after.revisions[0].trigger, 'revision');
    assert.equal(after.revisions[0].from.value, 3);
    assert.equal(after.revisions[0].to.value, 6);

    // Both device versions are retained; old explanation and raw 300 remain auditable.
    const evidence = repository.snapshot().evidence;
    assert.ok(evidence[oldDeviceDigest], 'previous device bytes must remain retained');
    assert.notEqual(after.evidence.devices[0], oldDeviceDigest);
    const deviceDoc = repository.documents().find(d => d.id === 'device');
    assert.equal(deviceDoc.versions.length, 2);
    const oldBytes = await repository.readEvidence(oldDeviceDigest);
    assert.ok(oldBytes.toString('utf8').includes('C="0.01"'));
  });
});

test('same DDI on two booms is never merged and each keeps its own unit basis', async () => {
  await session('feature', async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const work = repository.workRecords();
    const ddi0001 = work.filter(r => r.ddi === '0001');
    assert.equal(ddi0001.length, 2);
    const left = ddi0001.find(r => r.id.includes('boom-left'));
    const right = ddi0001.find(r => r.id.includes('boom-right'));
    const scaleOf = record => record.readings[0].basis.find(step => step.step === 'presentation').scale;
    assert.equal(scaleOf(left), 0.1);
    assert.equal(scaleOf(right), 0.01);
    assert.equal(left.value, 20);
    assert.equal(right.value, 3);
    for (const record of [left, right]) {
      const presentation = record.readings[0].basis.find(step => step.step === 'presentation');
      assert.ok(presentation, 'the DVP explanation must be attached to each reading');
      assert.equal(presentation.unit, 'L');
    }
  });
});

test('interpretation is independent of document delivery order', async () => {
  // Reorder the catalog at the HTTP boundary: the intake only sees HTTP.
  const directory = await mkdtemp(join(tmpdir(), 'managed-order-'));
  const source = await createSource({ scenario: 'feature' });
  const proxy = await createReorderingProxy(source.base);
  try {
    const repository = await new Repository(directory).open();
    await collect({ base: proxy.base, repository, mode: 'managed' });
    assert.deepEqual(
      repository.workRecords().map(r => r.id).sort(),
      [...fixture.expectedIds].sort()
    );
  } finally {
    await proxy.close();
    source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Local proxy that reverses the catalog document order, exercising the
// intake purely over HTTP like the simulator contract requires.
async function createReorderingProxy(upstream) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/taskdata') {
      const catalog = await (await fetch(upstream + req.url)).json();
      catalog.documents = [...catalog.documents].reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog));
      return;
    }
    const upstreamResponse = await fetch(upstream + req.url);
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}
