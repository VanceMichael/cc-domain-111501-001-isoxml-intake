import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';

const taskXml = '<ISO11783_TaskData VersionMajor="4" VersionMinor="3">'
  + '<TSK A="task-1" B="North"><TIM A="2026-11-01T10:00:00Z" D="4">'
  + '<DLV A="0001" B="200" C="det-left"/></TIM></TSK></ISO11783_TaskData>';

async function serveDocuments(documents) {
  const bytesById = Object.fromEntries(documents.map(doc => [doc.id, Buffer.from(doc.content)]));
  const server = createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/taskdata') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 1,
        documents: documents.map(({ content, ...doc }) => doc) }));
      return;
    }
    const doc = documents.find(item => item.href === pathname);
    if (!doc) { res.writeHead(404); res.end(); return; }
    const bytes = bytesById[doc.id];
    res.writeHead(200, { etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"',
      'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}

test('malformed device bytes are retained as evidence and reported, readings stay pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-malformed-'));
  const source = await serveDocuments([
    { id: 'tasks', path: 'TASKDATA.XML', href: '/raw/TASKDATA.XML', format: 'xml',
      task: 'task-1', revision: 1, content: taskXml },
    { id: 'device', path: 'devices/DEVICE.XML', href: '/raw/devices/DEVICE.XML', format: 'xml',
      task: 'task-1', revision: 1, content: '<ISO11783_TaskData><DVC><DET></DVC>' }
  ]);
  try {
    const repository = await new Repository(directory).open();
    const summary = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(summary.interpretationComplete, false);
    const work = repository.workRecords();
    assert.equal(work[0].status, 'pending');
    assert.equal(work[0].value, null);
    const notes = repository.snapshot().notes;
    assert.ok(notes.some(note => note.kind === 'parse-failed' && note.document === 'device'));
    // Raw bytes are still evidence-backed and could be re-parsed after a fix.
    assert.equal(Object.keys(repository.snapshot().evidence).length, 2);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed mode against a legacy single-document source keeps readings explicitly pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-legacy-source-'));
  const { createSource } = await import('../simulator/source.mjs');
  const source = await createSource({ scenario: 'legacy' });
  try {
    const repository = await new Repository(directory).open();
    const summary = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(summary.documentComplete, true);
    assert.equal(summary.interpretationComplete, false);
    assert.ok(repository.workRecords().every(r => r.status === 'pending'));
    assert.ok(repository.workRecords().every(r => r.value === null));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
