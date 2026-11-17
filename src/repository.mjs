import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const STATE_VERSION = 2;

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { version: STATE_VERSION, records: {}, cursors: {}, evidence: {}, notes: [],
      documents: {}, work: {} };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      const stored = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      // Legacy state files predate managed intake; keep every legacy field readable.
      this.state = {
        version: stored.version ?? 1,
        records: stored.records ?? {},
        cursors: stored.cursors ?? {},
        evidence: stored.evidence ?? {},
        notes: stored.notes ?? [],
        documents: stored.documents ?? {},
        work: stored.work ?? {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  // Legacy single-document preview record API (unchanged semantics).
  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
    await this.save();
    return digest;
  }

  hasEvidence(digest) {
    return Boolean(this.state.evidence[digest]);
  }

  async readEvidence(digest) {
    if (!this.state.evidence[digest]) throw new Error(`unknown evidence digest ${digest}`);
    return readFile(join(this.directory, 'raw', digest));
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push({ at: new Date().toISOString(), ...structuredClone(value) });
    await this.save();
  }

  // Managed intake: source document index with every observed revision.
  async putDocument(document) {
    if (!document.id) throw new Error('document id required');
    const previous = this.state.documents[document.id];
    const versions = previous?.versions ?? [];
    const versionsById = new Map(versions.map(version => [version.digest, version]));
    const known = versionsById.get(document.digest);
    if (known) {
      known.lastSeenAt = document.observedAt;
    } else {
      versions.push({
        revision: document.revision,
        etag: document.etag,
        digest: document.digest,
        format: document.format,
        path: document.path,
        task: document.task ?? null,
        observedAt: document.observedAt,
        origin: document.origin
      });
    }
    this.state.documents[document.id] = {
      id: document.id,
      path: document.path,
      task: document.task ?? previous?.task ?? null,
      currentDigest: document.digest,
      currentRevision: document.revision,
      lastStatus: document.status ?? previous?.lastStatus ?? 'retained',
      lastObservedAt: document.observedAt,
      versions
    };
    await this.save();
    return !known;
  }

  async markDocumentStatus(id, status, detail) {
    const document = this.state.documents[id];
    if (!document) throw new Error(`unknown document ${id}`);
    document.lastStatus = status;
    document.lastDetail = detail ?? null;
    document.lastObservedAt = new Date().toISOString();
    await this.save();
  }

  // Catalog entry that could not be fetched: record the gap itself so the
  // document index still explains why completeness is false.
  async indexUnavailable(document, status, detail) {
    const previous = this.state.documents[document.id];
    if (previous) {
      await this.markDocumentStatus(document.id, status, detail);
      return false;
    }
    this.state.documents[document.id] = {
      id: document.id,
      path: document.path,
      task: document.task ?? null,
      currentDigest: null,
      currentRevision: document.revision ?? null,
      lastStatus: status,
      lastDetail: detail ?? null,
      lastObservedAt: new Date().toISOString(),
      versions: []
    };
    await this.save();
    return true;
  }

  documents() {
    return structuredClone(Object.values(this.state.documents));
  }

  // Managed intake: normalized business work records keyed by a stable key so
  // re-delivery and reopen never inflate identities.
  async putWork(record) {
    if (!record.key) throw new Error('work record key required');
    this.state.work[record.key] = structuredClone(record);
    await this.save();
  }

  workRecords() {
    return structuredClone(Object.values(this.state.work));
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
