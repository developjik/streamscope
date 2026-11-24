// Production-only package smoke test. Deliberately does not import Vitest.
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd();const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const temp=mkdtempSync(join(tmpdir(),'runtime-package-'));
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,encoding:'utf8',env:process.env});if(result.status!==0)throw new Error(`${command} failed (${result.status}): ${result.stderr} ${result.stdout}`);return result.stdout;}
try{
 const tar=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temp]))[0].filename;
 run('npm',['install','--omit=dev','--no-audit','--no-fund',join(temp,tar)],temp);
 console.log(run('npm',['ls','--omit=dev','--depth=1'],temp));
 const installed=join(temp,'node_modules',pkg.name);
 const bins=typeof pkg.bin==='string'?{[pkg.name]:pkg.bin}:pkg.bin??{};
 if(Object.keys(bins).length){for(const bin of Object.values(bins))run(process.execPath,[resolve(installed,bin),'--help'],temp);}
 if(pkg.exports || pkg.main)run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pkg.name)});`],temp);
 console.log(`${pkg.name}: production install and built runtime smoke passed on ${process.version}`);
}finally{rmSync(temp,{recursive:true,force:true});}
