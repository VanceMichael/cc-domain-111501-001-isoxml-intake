import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-managed-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('document index keeps every retained version and survives reopen', async () => {
  await withDirectory(async directory => {
    const repository = await new Repository(directory).open();
    const first = await repository.putDocument({
      id: 'device', path: 'DEVICE.XML', format: 'xml', task: 'task-1',
      revision: 1, etag: '"a"', digest: 'digest-a', observedAt: '2026-11-01T00:00:00Z'
    });
    const second = await repository.putDocument({
      id: 'device', path: 'DEVICE.XML', format: 'xml', task: 'task-1',
      revision: 2, etag: '"b"', digest: 'digest-b', observedAt: '2026-11-02T00:00:00Z'
    });
    assert.equal(first, true);
    assert.equal(second, true);
    // Re-seeing the same digest does not add another version.
    const again = await repository.putDocument({
      id: 'device', path: 'DEVICE.XML', format: 'xml', task: 'task-1',
      revision: 2, etag: '"b"', digest: 'digest-b', observedAt: '2026-11-03T00:00:00Z'
    });
    assert.equal(again, false);

    const reopened = await new Repository(directory).open();
    const doc = reopened.documents().find(item => item.id === 'device');
    assert.equal(doc.currentDigest, 'digest-b');
    assert.equal(doc.currentRevision, 2);
    assert.deepEqual(doc.versions.map(v => v.digest), ['digest-a', 'digest-b']);
  });
});

test('retained evidence can be read back and unknown digests are rejected', async () => {
  await withDirectory(async directory => {
    const repository = await new Repository(directory).open();
    const digest = await repository.retain('/raw/x', 'original bytes');
    const bytes = await repository.readEvidence(digest);
    assert.equal(bytes.toString('utf8'), 'original bytes');
    await assert.rejects(repository.readEvidence('nope'), /unknown evidence/);
  });
});

test('legacy state files without managed fields still open with empty indexes', async () => {
  await withDirectory(async directory => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      records: { tasks: { id: 'tasks' } }, cursors: {}, evidence: {}, notes: []
    }));
    const repository = await new Repository(directory).open();
    assert.equal(repository.records()[0].id, 'tasks');
    assert.deepEqual(repository.documents(), []);
    assert.deepEqual(repository.workRecords(), []);
    await repository.putWork({ key: 'k', status: 'resolved' });
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.workRecords()[0].key, 'k');
  });
});

test('work records require a storage key', async () => {
  const repository = new Repository('/unused');
  await assert.rejects(repository.putWork({ status: 'resolved' }), /work record key required/);
});

test('an unavailable catalog entry is indexed as a gap and upgraded on delivery', async () => {
  await withDirectory(async directory => {
    const repository = await new Repository(directory).open();
    const created = await repository.indexUnavailable(
      { id: 'device', path: 'DEVICE.XML', task: 'task-1', revision: 1 },
      'missing-at-source', 'status 404');
    assert.equal(created, true);
    let doc = repository.documents().find(item => item.id === 'device');
    assert.equal(doc.currentDigest, null);
    assert.equal(doc.lastStatus, 'missing-at-source');
    assert.deepEqual(doc.versions, []);

    // Re-reporting the same gap does not create a second entry.
    assert.equal(await repository.indexUnavailable(
      { id: 'device', path: 'DEVICE.XML', task: 'task-1', revision: 1 },
      'unavailable', 'status 503'), false);

    await repository.putDocument({
      id: 'device', path: 'DEVICE.XML', format: 'xml', task: 'task-1',
      revision: 2, etag: '"b"', digest: 'digest-b', status: 'retained',
      observedAt: '2026-11-02T00:00:00Z'
    });
    doc = repository.documents().find(item => item.id === 'device');
    assert.equal(doc.currentDigest, 'digest-b');
    assert.equal(doc.lastStatus, 'retained');
    assert.deepEqual(doc.versions.map(v => v.digest), ['digest-b']);
  });
});
