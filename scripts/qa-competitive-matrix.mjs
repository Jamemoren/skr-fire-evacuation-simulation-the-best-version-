// Complete no-fire evacuation, 1,500/3,000 people × all three behaviours.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=join(root,'qa-output/competitive');mkdirSync(out,{recursive:true});
const hash=()=>createHash('sha256').update(readFileSync(join(root,'src/simulation/runtime.ts'))).digest('hex');
const sourceHash=hash(),jobs=[1500,3000].flatMap(n=>['orderly','grouped','surge'].map(b=>({n,b}))),results=[];
async function worker(){
 while(jobs.length){const job=jobs.shift();await new Promise(done=>{
  let log='';console.log('START',job.b,job.n);
  const child=spawn(process.execPath,['scripts/qa-competitive-crowd.mjs',`--n=${job.n}`,`--b=${job.b}`],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',data=>{log+=data;process.stdout.write(data);});child.stderr.on('data',data=>{log+=data;process.stdout.write(data);});
  child.on('error',error=>{log+=error;});
  child.on('close',code=>{writeFileSync(join(out,`${job.b}-${job.n}.log`),log);results.push({...job,code});console.log('END',job.b,job.n,code);done();});
 });}
}
await Promise.all([worker(),worker()]);
assert.equal(hash(),sourceHash,'Runtime changed while the matrix was running; repeat against one source version');
writeFileSync(join(out,'matrix.json'),JSON.stringify({sourceHash,results},null,2));
assert(results.every(result=>result.code===0),'Every matrix run must pass');
console.log('PASS complete 6-run matrix',sourceHash);
