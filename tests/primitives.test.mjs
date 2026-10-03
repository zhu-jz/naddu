import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import * as C from '../src/constants.mjs';
import * as B from '../src/bitboard.mjs';
import {bundle} from '../scripts/build.mjs';
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/primitives.json', import.meta.url)));

test('integer operations and 64-bit mixed keys match Python', () => {
  for (const [a,b,v] of expected.division) assert.equal(C.c_div(a,b), v);
  for (const [s,v] of expected.keys) assert.equal(String(C.make_key(s)), v);
  for (let s = 0; s < 64; s++) assert.equal(B.lsb(B.sq_bb(s)), s);
  assert.equal(B.lsb(0n), -1);
  assert.equal(B.sq_bb(64), 0n);
});

test('all attack, line and between tables match the Python oracle', () => {
  for (const [name, table] of Object.entries(expected.tables)) {
    assert.deepEqual(B[name].map(row => row.map(String)), table, name);
  }
});

test('all relevant sliding occupancies match Python and independent ray attacks', () => {
  for (const kind of ['Rook','Bishop']) {
    const digest = createHash('sha256');
    const attack = kind === 'Rook' ? B.attacks_bb_rook : B.attacks_bb_bishop;
    const dirs = kind === 'Rook' ? B.RookDirs : B.BishopDirs;
    let count = 0;
    for (let s = 0; s < 64; s++) {
      const mask = B[kind+'Masks'][s];
      let occ = 0n;
      do {
        const value = attack(s,occ);
        assert.equal(value, B.sliding_attack(dirs,s,occ));
        digest.update(`${s}:${occ}:${value}\n`);
        count++;
        occ = (occ-mask)&mask;
      } while (occ);
    }
    assert.deepEqual({count, sha256: digest.digest('hex')}, expected.sliding[kind]);
  }
});

test('single-file build runs in a classic Worker-like context with no imports', () => {
  const source = bundle(['constants.mjs','generated/magics.mjs','bitboard.mjs'],
    ['MAX_PLY','make_key','attacks_bb_rook']);
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.NadduCore.MAX_PLY, 128);
  assert.equal(sandbox.NadduCore.make_key(65), C.make_key(65));
  assert.equal(sandbox.NadduCore.attacks_bb_rook(0, 0n), B.attacks_bb_rook(0,0n));
  assert.equal(source, bundle(['constants.mjs','generated/magics.mjs','bitboard.mjs'],
    ['MAX_PLY','make_key','attacks_bb_rook']));
});
