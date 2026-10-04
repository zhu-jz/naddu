import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {root} from './reference.mjs';
const candidates=[process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome=candidates.find(file=>fs.existsSync(file));
if (!chrome) throw new Error('Set CHROME to a Chromium executable to run browser checks');
const reports=[],requests=[]; let browser,resolve,reject,diagnostics='';
const finished=new Promise((res,rej)=>{ resolve=res; reject=rej; });
const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if (req.url==='/result') {
    let body=''; req.on('data',data=>body+=data); req.on('end',()=>{
      const report=JSON.parse(body); reports.push(report); res.end('ok');
      if (!report.passed) reject(new Error(report.error+'\n'+JSON.stringify({lines:report.lines,requests,diagnostics}))); else if (reports.length===2) resolve();
    }); return;
  }
  if (req.url==='/isolated') {
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  }
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  const file=req.url==='/naddu.js' ? 'naddu.js' : req.url==='/expected' ? 'tests/fixtures/start-depth5.json' : 'tests/browser-worker.html';
  res.setHeader('Content-Type',file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html');
  res.end(fs.readFileSync(path.join(root,file)));
});
fs.mkdirSync(path.join(root,'build'),{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'naddu-browser-'));
const timer=setTimeout(()=>reject(new Error('Browser checks timed out: '+JSON.stringify({requests,reports,diagnostics}))),30000);
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--enable-logging=stderr',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  browser.stderr.on('data',data=>diagnostics=(diagnostics+data).slice(-4000));
  browser.on('error',reject);
  browser.on('exit',code=>{ if (reports.length<2) reject(new Error('Chromium exited '+code+': '+diagnostics)); });
  await finished; assert.ok(reports.every(r=>r.passed));
  fs.writeFileSync(path.join(root,'build/browser-check.json'),JSON.stringify(reports,null,2)+'\n');
  console.log('Real Chromium Workers passed: direct and cross-origin-isolated nested search worker.');
} finally {
  clearTimeout(timer); if (browser) browser.kill(); server.closeAllConnections(); server.close();
  // This unique test-created directory cannot contain the user's browser profile.
  const resolved=fs.realpathSync(profile), tempRoot=fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved)===tempRoot && path.basename(resolved).startsWith('naddu-browser-')) {
    try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:50}); } catch {}
  }
}
