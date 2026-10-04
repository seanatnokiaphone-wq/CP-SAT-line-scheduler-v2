import { generatePlant } from './engine.mjs';
const K={1:4,2:4,3:5,4:5}; const fam=(p)=>p==='1000L'?'IBC':(p==='220L'||p==='110L')?'DRUM':p==='20L'?'PAIL':'F7'; const NL={IBC:2,DRUM:2,PAIL:2,F7:1};
for (const n of [20,30,60,100,200]) { const p=generatePlant(42,n); let bin=0, cont=0, cons=0;
 for (const s of [1,2,3,4]) { const m=p.batches.filter(b=>b.system===s).length; bin+= m*(m-1)+m*K[s]; bin+= m*(m-1)/2; cons+= 2*m*(m-1)+ m*(m-1) + 4*m; cont+=4*m; }
 const fs={}; p.fills.forEach(f=>(fs[fam(f.pack)]=(fs[fam(f.pack)]||0)+1));
 for (const [k,m] of Object.entries(fs)) { bin+= m*(m-1)+m*NL[k]+ (NL[k]>1?m:0) + m*3*NL[k]*2; cons+= 3*m*(m-1)+ m*3*NL[k]*4 + 4*m; cont+=4*m; }
 const pf=(fs.PAIL||0)*(fs.F7||0); bin+=pf; cons+=2*pf; bin+=2*p.batches.length; cons+=4*p.fills.length;
 console.log(n, 'bin',bin,'cont',cont,'vars',bin+cont,'cons~',cons); }
