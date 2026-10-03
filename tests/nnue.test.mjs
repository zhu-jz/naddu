import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {NNUE, nnue_evaluate} from '../src/nnue.mjs';
import {evaluate} from '../src/evaluate.mjs';
import {NETWORK_BASE64, NETWORK_SHA256} from '../src/generated/nnue.mjs';
import {bundle} from '../scripts/build.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/positions.json', import.meta.url)));

test('network export has the exact integer count, bytes and signed weights', () => {
  const bytes = Buffer.from(NETWORK_BASE64, 'base64');
  assert.equal(bytes.length, 98690);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), NETWORK_SHA256);
  assert.equal(Math.min(...NNUE.weights), -200);
  assert.equal(Math.max(...NNUE.weights), 132);
  assert.equal(NNUE.outputBias, 2132);
  assert.equal(NNUE.featureTransformerBiases.length, 64);
});

test('raw and scaled evaluations match Python across all fixture transitions', () => {
  for (const fixture of fixtures) for (const state of [fixture.state, ...fixture.children.map(c => c.state), ...fixture.null ? [fixture.null] : []]) {
    const accumulator = {colors: state.accumulator};
    assert.equal(nnue_evaluate(accumulator, state.side), state.raw_nnue, state.fen);
    const pos = {st: {accumulator, nonPawn: state.nonPawn, rule50: state.rule50},
      optimism: [0,0], sideToMove: state.side, pieceCount: state.pieceCount};
    assert.equal(evaluate(pos), state.eval, state.fen);
  }
});

test('embedded network and inference work without Node APIs in a classic Worker context', () => {
  const source = bundle(['constants.mjs','generated/magics.mjs','bitboard.mjs','generated/nnue.mjs','nnue.mjs'], ['nnue_evaluate']);
  const sandbox = {atob};
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.NadduCore.nnue_evaluate({colors: fixtures[0].state.accumulator}, 0), 54);
});
