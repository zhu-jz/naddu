import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {root} from '../scripts/reference.mjs';

test('supplied Python reference matches its pinned source manifest', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'tests/reference-manifest.json')));
  const directory = path.join(root, 'minifish-python');
  const actual = {};
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.py')).sort()) {
    actual[name] = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
  }
  assert.deepEqual(actual, expected);
});

test('cold starting-position reference has the audited five iterations', () => {
  const records = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/start-depth5.json')));
  assert.equal(records[0].depth, 5);
  assert.equal(records[0].score, 126);
  assert.equal(records[0].nodes_after_reporting, 431);
  assert.equal(records[0].output[2], 'info depth 3 seldepth 3 multipv 1 score mate 1 nodes 103 pv e2e4');
  assert.equal(records[0].output[4], 'info depth 5 seldepth 5 multipv 1 score cp 60 nodes 431 pv g2g3 d7d6 d2d4');
});
