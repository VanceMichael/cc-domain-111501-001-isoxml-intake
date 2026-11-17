// ISO 11783 (ISOXML) profile domain logic for this intake service.
// The profile is the subset described in docs/protocol.md:
//   TSK task -> TIM time log -> DLV (DDI, raw value, device element reference)
//   DVC device -> DET element -> DOR object pointer -> DPD process data ->
//   DVP value presentation (offset, scale, decimals, unit).
// Every function here is pure: it never fills missing source data with
// defaults and returns unresolved references instead of invented values.

import { children, parseXml } from './xml.mjs';

export function integer(value, location) {
  if (value === undefined || value.trim() === '') throw new Error(`missing integer at ${location}`);
  if (!/^[+-]?\d+$/.test(value)) throw new Error(`invalid integer "${value}" at ${location}`);
  return Number(value);
}

export function decimal(value, location) {
  if (value === undefined || value.trim() === '') throw new Error(`missing number at ${location}`);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error(`invalid number "${value}" at ${location}`);
  }
  return Number(value);
}

export function displayValue(rawValue, offset, scale, decimals) {
  const value = (rawValue + offset) * scale;
  if (!Number.isFinite(value)) throw new Error('non-finite display value');
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Task file ---------------------------------------------------------------

export function parseTaskFile(raw, origin = 'TASKDATA.XML') {
  const root = parseXml(raw, origin);
  if (root.name !== 'ISO11783_TaskData') {
    throw new Error(`${origin}: expected ISO11783_TaskData root, got ${root.name}`);
  }
  const tasks = [];
  for (const taskNode of children(root, 'TSK')) {
    const taskId = taskNode.attributes.A;
    if (!taskId) throw new Error(`${origin}: TSK missing task identity attribute A`);
    const readings = [];
    for (const [timeIndex, timeNode] of children(taskNode, 'TIM').entries()) {
      const stamp = timeNode.attributes.A;
      for (const [dlvIndex, dlvNode] of children(timeNode, 'DLV').entries()) {
        const location = `${origin} TSK[${taskId}] TIM[${timeIndex}] DLV[${dlvIndex}]`;
        const ddi = dlvNode.attributes.A;
        const elementRef = dlvNode.attributes.C;
        if (!ddi) throw new Error(`${location}: DLV missing DDI attribute A`);
        if (!elementRef) throw new Error(`${location}: DLV missing device element reference C`);
        readings.push({
          taskId,
          ddi,
          rawValue: integer(dlvNode.attributes.B, `${location} attribute B`),
          elementRef,
          time: stamp ?? null,
          location
        });
      }
    }
    tasks.push({ id: taskId, designator: taskNode.attributes.B ?? null, readings });
  }
  return { origin, kind: 'task', tasks };
}

// Device file -------------------------------------------------------------

export function parseDeviceFile(raw, origin = 'DEVICE.XML') {
  const root = parseXml(raw, origin);
  if (root.name !== 'ISO11783_TaskData') {
    throw new Error(`${origin}: expected ISO11783_TaskData root, got ${root.name}`);
  }
  const devices = [];
  for (const deviceNode of children(root, 'DVC')) {
    const deviceId = deviceNode.attributes.A;
    if (!deviceId) throw new Error(`${origin}: DVC missing identity attribute A`);
    const elements = new Map();
    const processData = new Map();
    const presentations = new Map();

    for (const elementNode of children(deviceNode, 'DET')) {
      const objectId = elementNode.attributes.A;
      if (!objectId) throw new Error(`${origin}: DET missing object id A`);
      elements.set(objectId, {
        objectId,
        type: elementNode.attributes.B ?? null,
        designator: elementNode.attributes.C ?? null,
        number: elementNode.attributes.D ?? null,
        processDataRefs: children(elementNode, 'DOR').map(dor => dor.attributes.A).filter(Boolean)
      });
    }
    for (const dpdNode of children(deviceNode, 'DPD')) {
      const objectId = dpdNode.attributes.A;
      if (!objectId) throw new Error(`${origin}: DPD missing object id A`);
      processData.set(objectId, {
        objectId,
        ddi: dpdNode.attributes.B ?? null,
        designator: dpdNode.attributes.E ?? null,
        presentationRef: dpdNode.attributes.F ?? null
      });
    }
    for (const dvpNode of children(deviceNode, 'DVP')) {
      const objectId = dvpNode.attributes.A;
      if (!objectId) throw new Error(`${origin}: DVP missing object id A`);
      presentations.set(objectId, {
        objectId,
        offset: decimal(dvpNode.attributes.B, `${origin} DVP[${objectId}] offset B`),
        scale: decimal(dvpNode.attributes.C, `${origin} DVP[${objectId}] scale C`),
        decimals: integer(dvpNode.attributes.D, `${origin} DVP[${objectId}] decimals D`),
        unit: dvpNode.attributes.E ?? null
      });
    }
    devices.push({ deviceId, designator: deviceNode.attributes.B ?? null, elements, processData, presentations });
  }
  return { origin, kind: 'device', devices };
}

// Resolution --------------------------------------------------------------

function resolveOne(reading, deviceModel) {
  const trace = [{ step: 'reading', location: reading.location, ddi: reading.ddi,
    elementRef: reading.elementRef, rawValue: reading.rawValue }];
  const element = deviceModel.elements.get(reading.elementRef);
  if (!element) {
    return { status: 'pending', reason: 'device-element-unresolved', trace };
  }
  trace.push({ step: 'element', objectId: element.objectId, designator: element.designator });
  const pointers = element.processDataRefs;
  if (pointers.length === 0) {
    return { status: 'pending', reason: 'no-process-data-pointer', trace };
  }
  const matching = pointers
    .map(ref => deviceModel.processData.get(ref))
    .filter(dpd => dpd && dpd.ddi === reading.ddi);
  if (matching.length === 0) {
    return { status: 'conflict', reason: 'ddi-not-supported-by-element', trace: [
      ...trace, { step: 'pointers', refs: pointers, readingDdi: reading.ddi }] };
  }
  if (matching.length > 1) {
    return { status: 'conflict', reason: 'ambiguous-process-data', trace: [
      ...trace, { step: 'candidates', refs: matching.map(dpd => dpd.objectId) }] };
  }
  const dpd = matching[0];
  trace.push({ step: 'process-data', objectId: dpd.objectId, ddi: dpd.ddi, designator: dpd.designator });
  if (!dpd.presentationRef) {
    return { status: 'pending', reason: 'value-presentation-unresolved', trace };
  }
  const presentation = deviceModel.presentations.get(dpd.presentationRef);
  if (!presentation) {
    return { status: 'pending', reason: 'value-presentation-unresolved', trace: [
      ...trace, { step: 'presentation', missing: dpd.presentationRef }] };
  }
  const value = displayValue(reading.rawValue, presentation.offset, presentation.scale, presentation.decimals);
  trace.push({
    step: 'presentation', objectId: presentation.objectId,
    offset: presentation.offset, scale: presentation.scale,
    decimals: presentation.decimals, unit: presentation.unit,
    formula: `(${reading.rawValue} ${presentation.offset >= 0 ? '+' : '-'} ${Math.abs(presentation.offset)}) * ${presentation.scale}`
  });
  return {
    status: 'resolved',
    elementDesignator: element.designator ?? element.objectId,
    processDataDesignator: dpd.designator ?? dpd.objectId,
    unit: presentation.unit,
    offset: presentation.offset,
    scale: presentation.scale,
    decimals: presentation.decimals,
    value,
    trace
  };
}

// Bind every reading of a task model against the supplied device models.
// Readings that cannot be explained stay pending with their raw value; they
// are never coerced to zero.
export function resolveReadings(taskModel, deviceModels) {
  const results = [];
  for (const task of taskModel.tasks) {
    for (const reading of task.readings) {
      const candidates = [];
      for (const device of deviceModels) {
        if (device.elements.has(reading.elementRef)) candidates.push(device);
      }
      let outcome;
      if (candidates.length === 0) {
        outcome = { status: 'pending', reason: 'device-element-unresolved',
          trace: [{ step: 'reading', location: reading.location, ddi: reading.ddi,
            elementRef: reading.elementRef, rawValue: reading.rawValue }] };
      } else if (candidates.length > 1) {
        outcome = { status: 'conflict', reason: 'duplicate-device-element',
          trace: [{ step: 'reading', location: reading.location },
            { step: 'candidates', devices: candidates.map(device => device.deviceId) }] };
      } else {
        outcome = resolveOne(reading, candidates[0]);
        outcome.deviceId = candidates[0].deviceId;
        outcome.deviceDesignator = candidates[0].designator;
      }
      results.push({ ...reading, taskDesignator: task.designator, ...outcome });
    }
  }
  return results;
}

// Group readings into stable business work records.
// The storage key is structural (task, device element object id, DDI) so a
// pending reading and its later explained version are the same record.
// The business id follows the profile: task : DET designator : DPD designator,
// and only exists once the designators have actually been resolved. If readings
// sharing a key do not resolve identically, the whole record is held back as a
// conflict rather than mixing an explained value with an unexplained one.
export function workRecords(resolved) {
  const RANK = { conflict: 3, pending: 2, resolved: 1 };
  const groups = new Map();
  for (const entry of resolved) {
    const key = `${entry.taskId}|${entry.elementRef}|${entry.ddi}`;
    if (!groups.has(key)) {
      groups.set(key, { key, taskId: entry.taskId, elementRef: entry.elementRef,
        ddi: entry.ddi, status: entry.status, reason: entry.reason ?? null, entries: [] });
    }
    const group = groups.get(key);
    group.entries.push(entry);
    if (RANK[entry.status] > RANK[group.status]) {
      group.status = entry.status;
      group.reason = entry.reason ?? null;
    }
  }
  return [...groups.values()].map(group => {
    const record = {
      key: group.key,
      taskId: group.taskId,
      elementRef: group.elementRef,
      ddi: group.ddi,
      status: group.status,
      reason: group.reason,
      readings: group.entries.map(entry => ({
        rawValue: entry.rawValue,
        value: group.status === 'resolved' ? entry.value : null,
        unit: group.status === 'resolved' ? entry.unit : null,
        time: entry.time,
        location: entry.location,
        basis: entry.trace
      }))
    };
    if (group.status === 'resolved') {
      const first = group.entries[0];
      record.id = `${first.taskId}:${first.elementDesignator}:${first.processDataDesignator}`;
      record.deviceId = first.deviceId;
      record.deviceDesignator = first.deviceDesignator;
      record.unit = first.unit;
      record.offset = first.offset;
      record.scale = first.scale;
      record.decimals = first.decimals;
      record.value = record.readings.length === 1
        ? record.readings[0].value : record.readings.map(reading => reading.value);
    } else {
      record.id = `pending:${group.taskId}:${group.elementRef}:${group.ddi}`;
    }
    return record;
  });
}

// Classify a retained ISOXML document from its content, without trusting the
// catalog id to carry semantics.
export function classifyIsoxml(raw, origin) {
  const root = parseXml(raw, origin);
  if (root.name !== 'ISO11783_TaskData') return { kind: 'unknown', root: root.name };
  if (children(root, 'TSK').length > 0) return { kind: 'task' };
  if (children(root, 'DVC').length > 0) return { kind: 'device' };
  return { kind: 'unknown' };
}
