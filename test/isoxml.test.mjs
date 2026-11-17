import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/xml.mjs';
import {
  displayValue, parseDeviceFile, parseTaskFile, resolveReadings, workRecords, classifyIsoxml
} from '../src/isoxml.mjs';

const taskXml = '<ISO11783_TaskData VersionMajor="4" VersionMinor="3"><TSK A="task-1" B="North">'
  + '<TIM A="2026-11-01T10:00:00Z" D="4">'
  + '<DLV A="0001" B="200" C="det-left"/><DLV A="0001" B="300" C="det-right"/>'
  + '</TIM></TSK></ISO11783_TaskData>';

const deviceXml = '<ISO11783_TaskData VersionMajor="4" VersionMinor="3"><DVC A="dvc-1" B="Sprayer">'
  + '<DET A="det-left" B="3" C="boom-left" D="1" E="0"><DOR A="10"/></DET>'
  + '<DET A="det-right" B="3" C="boom-right" D="2" E="0"><DOR A="11"/></DET>'
  + '<DPD A="10" B="0001" C="0" D="1" E="volume" F="20"/>'
  + '<DPD A="11" B="0001" C="0" D="1" E="volume" F="21"/>'
  + '<DVP A="20" B="0" C="0.1" D="1" E="L"/>'
  + '<DVP A="21" B="0" C="0.01" D="2" E="L"/></DVC></ISO11783_TaskData>';

test('display value applies offset and scale and rounds to decimals', () => {
  assert.equal(displayValue(300, 0, 0.01, 2), 3);
  assert.equal(displayValue(200, 5, 0.1, 1), 20.5);
  assert.equal(displayValue(200, 0, 0.1, 0), 20);
  assert.throws(() => displayValue(1, 0, Number.POSITIVE_INFINITY, 1), /non-finite/);
});

test('task parsing keeps every raw integer and its source location', () => {
  const model = parseTaskFile(taskXml);
  assert.equal(model.tasks.length, 1);
  const readings = model.tasks[0].readings;
  assert.deepEqual(readings.map(r => [r.ddi, r.rawValue, r.elementRef]),
    [['0001', 200, 'det-left'], ['0001', 300, 'det-right']]);
  assert.match(readings[0].location, /DLV\[0\]/);
  assert.equal(readings[0].time, '2026-11-01T10:00:00Z');
});

test('device parsing links DET -> DOR -> DPD -> DVP', () => {
  const model = parseDeviceFile(deviceXml);
  const device = model.devices[0];
  assert.deepEqual(device.elements.get('det-left').processDataRefs, ['10']);
  assert.equal(device.processData.get('10').presentationRef, '20');
  assert.deepEqual(
    { ...device.presentations.get('21') },
    { objectId: '21', offset: 0, scale: 0.01, decimals: 2, unit: 'L' }
  );
});

test('resolution distinguishes the two booms despite identical DDIs', () => {
  const task = parseTaskFile(taskXml);
  const device = parseDeviceFile(deviceXml);
  const resolved = resolveReadings(task, device.devices);
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every(r => r.status === 'resolved'));
  const records = workRecords(resolved);
  assert.deepEqual(records.map(r => r.id).sort(),
    ['task-1:boom-left:volume', 'task-1:boom-right:volume'].sort());
  const values = Object.fromEntries(records.map(r => [r.elementRef, r.value]));
  assert.deepEqual(values, { 'det-left': 20, 'det-right': 3 });
});

test('a missing device leaves readings pending with raw values intact', () => {
  const task = parseTaskFile(taskXml);
  const resolved = resolveReadings(task, []);
  assert.ok(resolved.every(r => r.status === 'pending' && r.reason === 'device-element-unresolved'));
  const records = workRecords(resolved);
  assert.ok(records.every(r => r.id.startsWith('pending:')));
  assert.deepEqual(records.flatMap(r => r.readings.map(x => x.rawValue)).sort(), [200, 300]);
});

test('a DDI mismatch is a conflict rather than a pending gap', () => {
  const broken = deviceXml.replace('B="0001" C="0" D="1" E="volume" F="20"',
    'B="0007" C="0" D="1" E="other" F="20"');
  const task = parseTaskFile(taskXml);
  const device = parseDeviceFile(broken);
  const [first] = resolveReadings(task, device.devices);
  assert.equal(first.status, 'conflict');
  assert.equal(first.reason, 'ddi-not-supported-by-element');
  assert.equal(first.rawValue, 200);
});

test('malformed numeric attributes are rejected instead of coerced', () => {
  assert.throws(() => parseTaskFile(taskXml.replace('B="200"', 'B="2x0"')), /invalid integer/);
  assert.throws(() => parseDeviceFile(deviceXml.replace('C="0.1"', 'C="NaN"')), /invalid number/);
});

test('classifier tells task and device files apart by content', () => {
  assert.equal(classifyIsoxml(taskXml, 't').kind, 'task');
  assert.equal(classifyIsoxml(deviceXml, 'd').kind, 'device');
});

test('the xml parser rejects doctype and undeclared entities', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), /external definitions/);
  assert.throws(() => parseXml('<x>&bogus;</x>'), /undeclared entity/);
  const root = parseXml('<x a="1" b="hi &amp; bye"><y/></x>');
  assert.equal(root.name, 'x');
  assert.equal(root.attributes.b, 'hi & bye');
  assert.equal(root.children[0].name, 'y');
});

test('the xml parser rejects malformed nesting', () => {
  assert.throws(() => parseXml('<x><y></x></y>'), /unmatched closing tag/);
  assert.throws(() => parseXml('<x><y>'), /unclosed element/);
});
