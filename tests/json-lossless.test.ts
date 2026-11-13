import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asIdString,
  decodeUtf8Strict,
  getObjectProp,
  LosslessJsonError,
  parseLosslessJson,
  serializeLosslessJson
} from '../src/json-lossless.js';

test('preserves integers larger than Number.MAX_SAFE_INTEGER verbatim', () => {
  const input = `{
    "statusCode": 0,
    "data": {
      "steamIdNum": 76561199437647584,
      "unsafePlusOne": 9007199254740993,
      "floatVal": 0.9800,
      "negZero": -0,
      "sci": 1e5,
      "emptyArr": [],
      "emptyObj": {},
      "unknownKey": null
    }
  }`;

  const root = parseLosslessJson(input);
  const dataNode = getObjectProp(root, 'data');
  assert.ok(dataNode);

  const out = serializeLosslessJson(dataNode, 2);
  assert.match(out, /"steamIdNum": 76561199437647584/);
  assert.match(out, /"unsafePlusOne": 9007199254740993/);
  assert.match(out, /"floatVal": 0\.9800/);
  assert.match(out, /"negZero": -0/);
  assert.match(out, /"sci": 1e5/);
  assert.doesNotMatch(out, /"statusCode"/);

  assert.equal(asIdString(getObjectProp(dataNode, 'steamIdNum'), 'steamIdNum'), '76561199437647584');
  assert.equal(asIdString(getObjectProp(dataNode, 'unsafePlusOne'), 'unsafePlusOne'), '9007199254740993');
});

test('rejects invalid UTF-8 and malformed JSON', () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.throws(() => decodeUtf8Strict(invalidUtf8), LosslessJsonError);

  assert.throws(() => parseLosslessJson('{"a": 01}'), LosslessJsonError);
  assert.throws(() => parseLosslessJson('{"a": 1} trailing'), LosslessJsonError);
  assert.throws(() => parseLosslessJson('{"a": "unterminated'), LosslessJsonError);
});
