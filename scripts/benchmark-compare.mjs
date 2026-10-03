import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {root} from './reference.mjs';
import {normalized} from './parity.mjs';
const depth=Number(process.argv[2] || 13), command=depth===13 ? 'bench' : `bench 16 1 ${depth}`;
const expected=JSON.parse(fs.readFileSync(path.join(root,`tests/fixtures/bench-depth${depth}.json`)));
const python=process.env.PYTHON || 'uv', prefix=process.env.PYTHON ? [] : ['run','--offline','--no-project','python'];
const options={cwd:root,encoding:'utf8',timeout:3600000,maxBuffer:64*1024*1024,windowsHide:true};
const digest=text=>createHash('sha256').update(text).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tests/reference-manifest.json')));
for (const [name,hash] of Object.entries(manifest)) assert.equal(digest(fs.readFileSync(path.join(root,'minifish-python',name))),hash,name+' changed');
const runs=[['python',python,[...prefix,'-B',path.join(root,'minifish-python/__main__.py'),command]],
  ['javascript',process.execPath,[path.join(root,'naddu.js'),command]]];
const report={depth,positions:expected.length,command,nodes:expected.reduce((sum,r)=>sum+r.nodes_after_reporting,0),
  normalized_sha256:digest(JSON.stringify(expected.flatMap(r=>r.output))),
  reference_manifest_sha256:digest(JSON.stringify(manifest)),engine_sha256:digest(fs.readFileSync(path.join(root,'naddu.js'))),runtimes:{}};
fs.mkdirSync(path.join(root,'build'),{recursive:true});
for (const [name,executable,args] of runs) {
  console.log('Running '+name+' public benchmark…');
  const result=spawnSync(executable,args,options);
  assert.equal(result.status,0,result.error?.message || result.stderr);
  const lines=result.stdout.split(/\r?\n/).filter(s=>(s.startsWith('info depth') && s.includes(' score ')) || s.startsWith('bestmove')).map(normalized);
  assert.deepEqual(lines,expected.flatMap(r=>r.output),name+' public iterations differ');
  assert.equal(result.stdout.split(/\r?\n/).filter(s=>s.startsWith('position fen')).length,expected.length);
  const field=label=>Number(new RegExp(label+'\\s*:\\s*(\\d+)').exec(result.stderr)?.[1]);
  assert.equal(field('Nodes searched'),report.nodes,name+' public move count differs');
  report.runtimes[name]={milliseconds:field('Total time \\(ms\\)'),nps:field('Nodes/second')};
  fs.writeFileSync(path.join(root,`build/public-bench-${name}-depth${depth}.stdout`),result.stdout);
  fs.writeFileSync(path.join(root,`build/public-bench-${name}-depth${depth}.stderr`),result.stderr);
}
fs.writeFileSync(path.join(root,'build/benchmark-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Both public executables exactly match all ${report.positions} positions and ${report.nodes} counted moves at depth ${depth}.`);
