// Managed structured intake for ISOXML task deliveries.
//
// Responsibilities:
//   - fetch the source catalog and retain every available document's bytes
//   - re-interpret readings through task -> device element -> process data ->
//     value presentation, keeping raw values and the explanation trace
//   - distinguish supplements (previously unresolved readings become
//     explained), revisions (the same identity is re-explained by a new source
//     revision) and conflicts (incompatible source content)
//   - never turn unidentified data into zero: pending readings stay pending
//   - persist enough state to resume after a process stop

import { createHash } from 'node:crypto';
import { json, request } from './http.mjs';
import {
  classifyIsoxml, parseDeviceFile, parseTaskFile, resolveReadings, workRecords
} from './isoxml.mjs';

const CATALOG_CURSOR = 'managed:catalog';
const LATEST_CURSOR = 'managed:latest';
const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameDigestSet(left, right) {
  if (left.size !== right.size) return false;
  for (const digest of left) if (!right.has(digest)) return false;
  return true;
}

// Fetch one catalog entry. 304 means retained bytes are still current;
// transient failures are recorded for retry; 404 is an explicit missing
// document, never a zero-value reading.
async function obtainDocument(base, entry, repository, crashAfterRetain) {
  const indexed = repository.documents().find(doc => doc.id === entry.id);
  const headers = {};
  if (indexed?.currentDigest) headers['if-none-match'] = `"${indexed.currentDigest}"`;

  let response;
  try {
    response = await request(base, entry.href, { headers });
  } catch (error) {
    await repository.note({ kind: 'fetch-error', document: entry.id, path: entry.href,
      reason: error.message, retryable: true });
    await repository.indexUnavailable(entry, 'fetch-failed', error.message);
    return { outcome: 'fetch-failed', entry };
  }

  if (response.status === 304) {
    if (!indexed?.currentDigest) {
      await repository.note({ kind: 'unexpected-304', document: entry.id, path: entry.href });
      return { outcome: 'error', entry, status: 304 };
    }
    await repository.markDocumentStatus(entry.id, 'retained');
    return { outcome: 'unchanged', entry, digest: indexed.currentDigest };
  }
  if (RETRYABLE_STATUS.has(response.status)) {
    await repository.note({ kind: 'source-unavailable', document: entry.id,
      status: response.status, path: entry.href, retryable: true });
    await repository.indexUnavailable(entry, 'unavailable', `status ${response.status}`);
    return { outcome: 'unavailable', entry, status: response.status };
  }
  if (response.status === 404) {
    await repository.note({ kind: 'missing-document', document: entry.id,
      status: 404, path: entry.href, reason: 'source returned 404' });
    await repository.indexUnavailable(entry, 'missing-at-source', 'status 404');
    return { outcome: 'missing', entry, status: 404 };
  }
  if (!response.ok) {
    await repository.note({ kind: 'source-error', document: entry.id,
      status: response.status, path: entry.href, retryable: false });
    await repository.indexUnavailable(entry, 'error', `status ${response.status}`);
    return { outcome: 'error', entry, status: response.status };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const etag = response.headers.get('etag');
  const digest = digestOf(bytes);
  if (etag && etag.replace(/^"|"$/g, '') !== digest) {
    await repository.note({ kind: 'etag-mismatch', document: entry.id,
      etag: etag.replace(/^"|"$/g, ''), computed: digest });
  }
  if (!repository.hasEvidence(digest)) {
    await repository.retain(entry.href, bytes, {
      etag, revision: entry.revision, documentId: entry.id, path: entry.path
    });
  }
  // Test seam: emulate process termination after raw bytes are durable but
  // before the document index and any interpretation are committed.
  if (crashAfterRetain === entry.id) {
    throw new Error('simulated termination after evidence retention');
  }
  const isNewVersion = await repository.putDocument({
    id: entry.id, path: entry.path, format: entry.format, task: entry.task,
    revision: entry.revision, etag, digest, status: 'retained',
    observedAt: new Date().toISOString(), origin: entry.href
  });
  return { outcome: isNewVersion ? 'retained' : 'indexed', entry, digest, bytes };
}

// Parse every currently indexed document from its retained raw bytes.
async function buildModels(repository) {
  const taskModels = [];
  const deviceModels = [];
  const problems = [];
  for (const doc of repository.documents()) {
    if (!doc.currentDigest) continue; // placeholder for a not-yet-delivered document
    const version = doc.versions.find(item => item.digest === doc.currentDigest);
    if (!version) {
      problems.push({ document: doc.id, reason: 'no-current-version' });
      continue;
    }
    let bytes;
    try {
      bytes = await repository.readEvidence(version.digest);
    } catch (error) {
      problems.push({ document: doc.id, reason: 'evidence-unreadable', detail: error.message });
      continue;
    }
    const raw = bytes.toString('utf8');
    let kind;
    try {
      kind = classifyIsoxml(raw, version.path);
    } catch (error) {
      problems.push({ document: doc.id, reason: 'parse-failed', detail: error.message,
        location: version.path, digest: version.digest });
      continue;
    }
    try {
      if (kind.kind === 'task') taskModels.push({ doc, model: parseTaskFile(raw, version.path) });
      else if (kind.kind === 'device') deviceModels.push({ doc, model: parseDeviceFile(raw, version.path) });
      else problems.push({ document: doc.id, reason: 'unsupported-document', detail: kind });
    } catch (error) {
      problems.push({ document: doc.id, reason: 'parse-failed', detail: error.message,
        location: version.path, digest: version.digest });
    }
  }
  return { taskModels, deviceModels, problems };
}

function explanationSignature(record) {
  return JSON.stringify({
    status: record.status,
    reason: record.reason ?? null,
    value: record.value ?? null,
    unit: record.unit ?? null,
    readings: record.readings.map(reading => ({
      rawValue: reading.rawValue, value: reading.value, basis: reading.basis
    }))
  });
}

async function interpretAll(repository) {
  const { taskModels, deviceModels, problems } = await buildModels(repository);
  for (const problem of problems) await repository.note({ kind: problem.reason, ...problem });

  const priorByKey = new Map(repository.workRecords().map(record => [record.key, record]));
  const nextKeys = new Set();
  let supplements = 0;
  let revisions = 0;

  for (const { doc, model: taskModel } of taskModels) {
    const scopedDeviceDocs = deviceModels.filter(item =>
      item.doc.task === doc.task || item.doc.task == null);
    const devices = scopedDeviceDocs.flatMap(item => item.model.devices);
    const resolved = resolveReadings(taskModel, devices);
    const groups = workRecords(resolved);

    for (const group of groups) {
      nextKeys.add(group.key);
      const previous = priorByKey.get(group.key);
      const record = {
        key: group.key,
        id: group.id,
        status: group.status,
        reason: group.reason ?? null,
        taskId: group.taskId,
        ddi: group.ddi,
        elementRef: group.elementRef,
        unit: group.unit ?? null,
        value: group.status === 'resolved' ? group.value : null,
        readings: group.readings,
        evidence: {
          task: doc.currentDigest,
          devices: [...new Set(scopedDeviceDocs.map(item => item.doc.currentDigest))]
        },
        interpretedAt: new Date().toISOString(),
        revisions: previous?.revisions ?? []
      };

      if (previous) {
        if (explanationSignature(previous) !== explanationSignature(record)) {
          let trigger = 'revision';
          if (previous.status !== 'resolved' && record.status === 'resolved') {
            trigger = 'supplement';
            supplements += 1;
          } else {
            revisions += 1;
          }
          record.revisions.push({
            changedAt: record.interpretedAt,
            trigger,
            from: { status: previous.status, reason: previous.reason ?? null,
              value: previous.value, unit: previous.unit, evidence: previous.evidence },
            to: { status: record.status, reason: record.reason ?? null,
              value: record.value, unit: record.unit, evidence: record.evidence }
          });
          await repository.note({ kind: trigger, key: record.key, id: record.id,
            from: record.revisions.at(-1).from, to: record.revisions.at(-1).to });
        }
      } else if (record.status !== 'resolved') {
        await repository.note({ kind: 'unresolved-reading', key: record.key, id: record.id,
          reason: record.reason, taskId: record.taskId, ddi: record.ddi,
          elementRef: record.elementRef,
          locations: record.readings.map(reading => reading.location) });
      }
      await repository.putWork(record);
    }
  }

  // Records that disappear from the current catalog are flagged, not deleted:
  // confirmed content must not vanish because of a source-side hiccup.
  for (const [key, previous] of priorByKey) {
    if (nextKeys.has(key) || previous.flag) continue;
    const evidenceMissing = !repository.hasEvidence(previous.evidence?.task);
    const flag = evidenceMissing ? 'evidence-missing' : 'absent-from-current-catalog';
    await repository.putWork({ ...previous, flag, flaggedAt: new Date().toISOString() });
    await repository.note({ kind: 'work-record-not-in-catalog', key, id: previous.id, flag });
  }

  return { supplements, revisions, problems };
}

export async function runManagedIntake({ base, repository, crashAfterRetain = null }) {
  let catalog;
  try {
    catalog = await json(base, '/taskdata');
  } catch (error) {
    await repository.note({ kind: 'catalog-unavailable', reason: error.message,
      status: error.status ?? null, retryable: true });
    const work = repository.workRecords();
    return {
      mode: 'managed', imported: 0, unchanged: 0,
      documents: repository.documents().length, workRecords: work.length,
      pending: work.filter(record => record.status !== 'resolved').length,
      conflicts: work.filter(record => record.status === 'conflict').length,
      supplements: 0, revisions: 0,
      documentComplete: false, interpretationComplete: false, complete: false,
      pendingFetches: [{ id: 'catalog', outcome: 'unavailable' }], resumable: true
    };
  }

  await repository.cursor(CATALOG_CURSOR, {
    revision: catalog.revision, observedAt: new Date().toISOString(),
    documentCount: catalog.documents.length
  });
  const beforeDigests = new Set(repository.documents().map(doc => doc.currentDigest));

  const fetchOutcomes = [];
  for (const entry of catalog.documents) {
    fetchOutcomes.push(await obtainDocument(base, entry, repository, crashAfterRetain));
  }
  const imported = fetchOutcomes.filter(result => result.outcome === 'retained').length;
  const unchanged = fetchOutcomes.filter(result => result.outcome === 'unchanged').length;
  const pendingFetches = fetchOutcomes
    .filter(result => !['retained', 'indexed', 'unchanged'].includes(result.outcome))
    .map(result => ({ id: result.entry.id, outcome: result.outcome,
      status: result.status ?? null }));

  const { supplements, revisions, problems } = await interpretAll(repository);

  const indexed = repository.documents();
  const blockedStatus = new Set(['missing-at-source', 'unavailable', 'fetch-failed', 'error']);
  const documentsComplete = catalog.documents.every(entry =>
    indexed.some(doc => doc.id === entry.id && !blockedStatus.has(doc.lastStatus)));

  const work = repository.workRecords();
  const pending = work.filter(record => record.status !== 'resolved');
  const conflicts = work.filter(record =>
    record.status === 'conflict' || record.flag === 'conflict');
  const interpretationComplete = pending.length === 0 && conflicts.length === 0 && problems.length === 0;

  await repository.cursor(LATEST_CURSOR, {
    revision: catalog.revision, observedAt: new Date().toISOString(),
    evidenceChanged: !sameDigestSet(beforeDigests,
      new Set(repository.documents().map(doc => doc.currentDigest))),
    complete: documentsComplete && interpretationComplete,
    interpretationComplete
  });

  return {
    mode: 'managed', imported, unchanged, documents: indexed.length,
    workRecords: work.length, pending: pending.length, conflicts: conflicts.length,
    supplements, revisions,
    documentComplete: documentsComplete, interpretationComplete,
    complete: documentsComplete && interpretationComplete,
    pendingFetches, catalogRevision: catalog.revision
  };
}
