import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runJavaScript,benchmarkCommands} from '../scripts/parity.mjs';
test('complete root loop reproduces the cold depth-5 starting-position baseline', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/start-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(['ucinewgame','position startpos'],5),expected);
});
test('complete benchmark root sequence matches all captured Python iterations', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/bench-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(benchmarkCommands(),5),expected);
});
test('warm searches, new games, MultiPV and terminal roots match Python lifecycle behavior', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/lifecycle-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(expected.commands,5),expected.results);
});
