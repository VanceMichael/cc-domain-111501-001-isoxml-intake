import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();

  const first = await collect({ base: source.base, repository, mode: 'managed' });
  console.log('--- first managed intake ---');
  console.log(JSON.stringify({ summary: first, workRecords: repository.workRecords() }, null, 2));

  // The equipment description is revised after the logs were already delivered.
  source.state.round = 2;
  const second = await collect({ base: source.base, repository, mode: 'managed' });
  console.log('--- intake after source revision (round=2) ---');
  console.log(JSON.stringify({
    summary: second,
    current: repository.workRecords().map(record => ({
      id: record.id, raw: record.readings.map(r => r.rawValue), value: record.value, unit: record.unit
    })),
    auditTrail: repository.workRecords().map(record => ({
      id: record.id, revisions: record.revisions
    })),
    retainedVersions: repository.documents().map(doc => ({
      id: doc.id, versions: doc.versions.map(version => ({ revision: version.revision, digest: version.digest }))
    })),
    notes: repository.snapshot().notes.map(({ at, ...note }) => note)
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
