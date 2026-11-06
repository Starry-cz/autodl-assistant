import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
async function scan(dir){const result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await scan(p));else if(/\.(mjs|cjs|js)$/.test(e.name))result.push(p);}return result;}
const files=[...await scan('src'),...await scan('tests'),...await scan('public'),...await scan('scripts'),...await scan('desktop')];
for(const file of files){const run=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(run.status!==0){console.error(file,run.stderr);process.exitCode=1;}}
if(!process.exitCode)console.log(`语法检查通过：${files.length} 个 JavaScript 文件`);

