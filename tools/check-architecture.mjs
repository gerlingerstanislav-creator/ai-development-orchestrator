import {readdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scanRoots=[
 'apps/api/src/modules',
 'apps/api/src/database',
 'apps/web/src/features',
 'apps/web/src/api',
 'apps/codex-runner'
];
const supported=/\.(?:ts|tsx|mjs)$/;
const toPosix=value=>value.split(path.sep).join('/');

async function sourceFiles(folder){
 if(!existsSync(folder))return [];
 const files=[];
 for(const item of await readdir(folder,{withFileTypes:true})){
  const full=path.join(folder,item.name);
  if(item.isDirectory())files.push(...await sourceFiles(full));
  else if(item.isFile()&&supported.test(item.name)&&!item.name.endsWith('.test.mjs'))files.push(full);
 }
 return files;
}

function references(source){
 const result=[];
 const from=/\b(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
 const dynamic=/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
 for(const pattern of [from,dynamic]){
  for(const match of source.matchAll(pattern))result.push(match[1]);
 }
 return result;
}

function resolvedFile(file,specifier,known){
 if(!specifier.startsWith('.'))return null;
 const full=path.resolve(path.dirname(file),specifier);
 const options=[full,full.replace(/\.js$/,'.ts'),full.replace(/\.js$/,'.tsx'),
  full+'.ts',full+'.tsx',full+'.mjs',path.join(full,'index.ts'),path.join(full,'index.tsx')];
 return options.find(candidate=>known.has(candidate))??null;
}

/**
 * Baseline guard for newly modularized areas; legacy monoliths remain outside
 * the cycle gate until they are decomposed. No external AST/toolchain needed.
 */
export async function checkArchitecture(root){
 const files=(await Promise.all(scanRoots.map(dir=>sourceFiles(path.join(root,dir))))).flat().sort();
 const known=new Set(files);
 const graph=new Map();
 const errors=[];
 for(const file of files){
  const relative=toPosix(path.relative(root,file));
  const imports=references(await readFile(file,'utf8'));
  const edges=[];
  for(const specifier of imports){
   const target=resolvedFile(file,specifier,known);
   if(target)edges.push(target);
   const external=/^(?:pg|fastify|@temporalio(?:\/|$))/.test(specifier);
   if(/apps\/api\/src\/modules\/[^/]+\/(?:domain|application)\//.test(relative)&&external)
    errors.push(relative+': application/domain cannot import '+specifier);
   if(/apps\/api\/src\/modules\/[^/]+\/domain\//.test(relative)&&specifier.includes('infrastructure'))
    errors.push(relative+': domain cannot depend on infrastructure');
   if(relative.startsWith('apps/api/src/modules/')&&
     path.resolve(path.dirname(file),specifier).startsWith(path.join(root,'apps/api/src/index')))
    errors.push(relative+': domain module cannot import the API entrypoint');
   if(relative.startsWith('apps/web/src/features/')&&
     path.resolve(path.dirname(file),specifier).startsWith(path.join(root,'apps/web/src/main')))
    errors.push(relative+': frontend feature cannot import the root App');
   if(relative.startsWith('apps/codex-runner/')&&file!==path.join(root,'apps/codex-runner/server.mjs')&&
     path.resolve(path.dirname(file),specifier)===path.join(root,'apps/codex-runner/server.mjs'))
    errors.push(relative+': runner component cannot depend on the HTTP server');
  }
  graph.set(file,edges);
 }
 const visiting=new Set(),visited=new Set(),stack=[];
 function visit(file){
  if(visiting.has(file)){
   const at=stack.indexOf(file);
   errors.push('Circular import: '+[...stack.slice(at),file].map(f=>toPosix(path.relative(root,f))).join(' -> '));
   return;
  }
  if(visited.has(file))return;
  visiting.add(file);stack.push(file);
  for(const next of graph.get(file)||[])visit(next);
  stack.pop();visiting.delete(file);visited.add(file);
 }
 for(const file of graph.keys())visit(file);
 return [...new Set(errors)];
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const errors=await checkArchitecture(root);
 if(errors.length){
  process.stderr.write(errors.join('\n')+'\n');
  process.exitCode=1;
 }else process.stdout.write('Architecture module boundary and cycle checks passed\n');
}
