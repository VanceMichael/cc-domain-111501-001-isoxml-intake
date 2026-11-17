import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createSource } from '../simulator/source.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';

const taskXml = '<ISO11783_TaskData VersionMajor="4" VersionMinor="3">'
  + '<TSK A="task-1" B="North"><TIM A="2026-11-01T10:00:00Z" D="4">'
  + '<DLV A="0001" B="200" C="det-left"/></TIM></TSK></ISO11783_TaskData>';

// Device whose element points at process data carrying a different DDI than
// the reading reports: an irreconcilable source, not a missing one.
const conflictDeviceXml = '<ISO11783_TaskData VersionMajor="4" VersionMinor="3"><DVC A="dvc-9" B="BrokenSprayer">'
  + '<DET A="det-left" B="3" C="boom-left" D="1" E="0"><DOR A="10"/></DET>'
  + '<DPD A="10" B="0007" C="0" D="1" E="other-quantity" F="20"/>'
  + '<DVP A="20" B="0" C="0.1" D="1" E="L"/></DVC></ISO11783_TaskData>';

async function serveDocuments(documents) {
  const bytesById = Object.fromEntries(documents.map(doc => [doc.id, Buffer.from(doc.content)]));
  const catalogDocuments = documents.map(({ content, ...doc }) => doc);
  const server = createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/taskdata') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 1, documents: catalogDocuments }));
      return;
    }
    const doc = documents.find(item => item.href === pathname);
    if (!doc) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'not delivered' })); return;
    }
    const bytes = bytesById[doc.id];
    const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304); res.end(); return;
    }
    res.writeHead(200, { etag, 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  };
}

async function withRepo(run) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-recovery-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('conflict: an unsupported DDI is isolated as a conflict, never zeroed or silently merged', async () => {
  const source = await serveDocuments([
    { id: 'tasks', path: 'TASKDATA.XML', href: '/raw/TASKDATA.XML', format: 'xml',
      task: 'task-1', revision: 1, content: taskXml },
    { id: 'device', path: 'devices/DEVICE.XML', href: '/raw/devices/DEVICE.XML', format: 'xml',
      task: 'task-1', revision: 1, content: conflictDeviceXml }
  ]);
  await withRepo(async directory => {
    try {
      const repository = await new Repository(directory).open();
      const summary = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(summary.conflicts, 1);
      assert.equal(summary.complete, false);
      const record = repository.workRecords()[0];
      assert.equal(record.status, 'conflict');
      assert.equal(record.reason, 'ddi-not-supported-by-element');
      assert.equal(record.value, null);
      assert.equal(record.readings[0].rawValue, 200);
      const note = repository.snapshot().notes.find(n => n.kind === 'unresolved-reading');
      assert.ok(note);
      assert.ok(note.locations[0].includes('DLV'));
    } finally { await source.close(); }
  });
});

test('matrix 5: termination after raw retention but before interpretation resumes and completes', async () => {
  await withRepo(async directory => {
    const source = await createSource({ scenario: 'feature' });
    try {
      const crashing = await new Repository(directory).open();
      // Simulate the process dying immediately after the first document's
      // bytes were retained: no work interpretation has been committed yet.
      await assert.rejects(
        collect({
          base: source.base, repository: crashing, mode: 'managed',
          crashAfterRetain: 'tasks'
        }),
        /simulated termination/
      );
      const partial = new Repository(directory);
      await partial.open();
      assert.equal(partial.workRecords().length, 0, 'no interpretation may be committed');
      assert.ok(Object.keys(partial.snapshot().evidence).length >= 1, 'raw evidence survives');

      // A fresh process using only the persisted state finishes the job.
      const reopened = await new Repository(directory).open();
      const summary = await collect({ base: source.base, repository: reopened, mode: 'managed' });
      assert.equal(summary.complete, true);
      assert.equal(reopened.workRecords().length, 2);
      const retainedDigests = new Set(Object.keys(reopened.snapshot().evidence));
      assert.ok(reopened.workRecords().every(record =>
        retainedDigests.has(record.evidence.task) &&
        record.evidence.devices.every(digest => retainedDigests.has(digest))));
    } finally { await source.close(); }
  });
});

test('matrix 2: repeated redelivery after reopen neither inflates identities nor duplicates evidence', async () => {
  await withRepo(async directory => {
    const source = await createSource({ scenario: 'feature' });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const repository = await new Repository(directory).open();
        const summary = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(summary.imported, attempt === 0 ? 2 : 0);
        assert.equal(summary.unchanged, attempt === 0 ? 0 : 2);
      }
      const reopened = await new Repository(directory);
      await reopened.open();
      assert.equal(reopened.workRecords().length, 2);
      const device = reopened.documents().find(doc => doc.id === 'device');
      assert.equal(device.versions.length, 1);
      const tasks = reopened.documents().find(doc => doc.id === 'tasks');
      assert.equal(tasks.versions.length, 1);
    } finally { await source.close(); }
  });
});

test('catalog outage preserves confirmed records and is reported as resumable', async () => {
  await withRepo(async directory => {
    const source = await createSource({ scenario: 'feature' });
    try {
      const repository = await new Repository(directory).open();
      await collect({ base: source.base, repository, mode: 'managed' });
      await source.close();
      const summary = await collect({ base: 'http://127.0.0.1:1', repository, mode: 'managed' });
      assert.equal(summary.resumable, true);
      assert.equal(summary.complete, false);
      assert.equal(repository.workRecords().length, 2);
      assert.ok(repository.workRecords().every(r => r.status === 'resolved'));
      assert.ok(repository.snapshot().notes.some(n => n.kind === 'catalog-unavailable'));
    } finally { /* source already closed */ }
  });
});
