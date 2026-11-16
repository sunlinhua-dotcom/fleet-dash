import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import cfg from '../site.config.mjs';
import C from '../content/zh.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DIST=path.resolve(ROOT,process.env.DIST||'dist');
if(DIST===ROOT||ROOT.startsWith(DIST+path.sep)||['src','content','assets','vendor','tools','mock','api'].some(d=>DIST===path.join(ROOT,d)))throw Error('Unsafe build destination');
const v=process.env.V||Date.now().toString(36);
let html=fs.readFileSync(path.join(ROOT,'src/index.html'),'utf8').replaceAll('__BUILD__',v).replaceAll('__TITLE__',C.meta.title);
fs.rmSync(DIST,{recursive:true,force:true});fs.mkdirSync(DIST,{recursive:true});fs.writeFileSync(path.join(DIST,'index.html'),html);
for(const [from,to] of [['src/js','js'],['src/css','css'],['vendor','vendor'],['assets','assets'],['mock','mock'],['api','api']])if(fs.existsSync(path.join(ROOT,from)))fs.cpSync(path.join(ROOT,from),path.join(DIST,to),{recursive:true});
// JS 模块之间的 import 也带构建号，避免新版本部署后浏览器拿旧模块
const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
for(const f of walk(path.join(DIST,'js')))if(f.endsWith('.js')){const s=fs.readFileSync(f,'utf8');if(s.includes('__BUILD__'))fs.writeFileSync(f,s.replaceAll('__BUILD__',v));}
fs.writeFileSync(path.join(DIST,'robots.txt'),'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(DIST,'build.json'),JSON.stringify({v,langs:cfg.langs,at:new Date().toISOString()}));
console.log('built',v,'zh →',DIST);
