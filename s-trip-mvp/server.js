// S Trip MVP: zero-dependency Node 18+ server (API + SSE + moderation + hotspots + agency)
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const E=process.env,PORT=+E.PORT||3000,KEY=E.GOOGLE_MAPS_API_KEY||'',TOKEN=E.AGENCY_TOKEN||'demo-agency',HOOK=E.WEBHOOK_URL||'';
const DB=path.join(__dirname,'data','db.json'),PUB=path.join(__dirname,'public');
// type: [ttl hours, sensitivity tier]
const TYPES={road_crash:[12,'public'],broken_down_vehicle:[6,'public'],road_blocked_or_checkpoint:[3,'public'],bad_road_section:[720,'public'],fuel_tanker_incident:[12,'public'],robbery:[72,'delayed'],armed_attack:[72,'delayed'],protest_unrest:[24,'delayed'],kidnapping_suspected:[168,'agency_only'],other:[24,'delayed']};
let db={incidents:[],watches:{},rep:{}};try{db=JSON.parse(fs.readFileSync(DB))}catch{}
db.salt=db.salt||crypto.randomBytes(8).toString('hex');
let tm;const save=()=>{clearTimeout(tm);tm=setTimeout(()=>{fs.mkdirSync(path.dirname(DB),{recursive:true});fs.writeFileSync(DB,JSON.stringify(db))},300)};
// ---- geo + corridor
const rad=x=>x*Math.PI/180;
const km=(a,b,c,d)=>{const h=Math.sin(rad(c-a)/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(rad(d-b)/2)**2;return 12742*Math.asin(Math.sqrt(h))};
const SEG=(()=>{const w=JSON.parse(fs.readFileSync(path.join(__dirname,'data','corridor.json'))).waypoints,o=[];
 for(let i=0;i<w.length-1;i++){const a=w[i],b=w[i+1],n=Math.max(1,Math.round(km(a[0],a[1],b[0],b[1])));
  for(let k=0;k<n;k++){const f=k/n,g=(k+1)/n,p=[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f],q=[a[0]+(b[0]-a[0])*g,a[1]+(b[1]-a[1])*g];o.push({id:o.length,from:p,to:q,mid:[(p[0]+q[0])/2,(p[1]+q[1])/2]})}}return o})();
const hourOf=t=>new Date(t+36e5).getUTCHours(),night=h=>h>=18||h<5; // Nigeria = UTC+1
// ---- step 7: hotspot scoring (recency decay x severity x confidence, night x1.5, optional hour-of-day affinity)
function weight(i,now,hr){const age=(now-i.created)/864e5;if(age>30||i.status==='hidden'||i.status==='disputed')return 0;
 const h=hourOf(i.created);let w=i.severity*(.4+.6*i.confidence)*Math.exp(-age/14)*(night(h)?1.5:1);
 if(hr!=null){const d=Math.min(Math.abs(h-hr),24-Math.abs(h-hr));w*=d<=3?1:.35}return w}
// ---- step 8: visibility tiers + moderation
const view=(i,r)=>({id:i.id,type:i.type,severity:i.severity,desc:i.desc,lat:r?+i.lat.toFixed(2):i.lat,lng:r?+i.lng.toFixed(2):i.lng,status:i.status,confidence:+i.confidence.toFixed(2),created:i.created,expires:i.expires,approx:!!r,synthetic:!!i.synthetic});
function pub(i){if(i.tier==='agency_only'||i.status==='hidden'||i.status==='flagged')return null;
 if(i.tier==='delayed'){if(i.status!=='verified'&&Date.now()-i.created<12e5)return null;return view(i,1)} // delayed: 20 min hold, ~1 km blur
 return view(i)}
const aview=i=>({...i,reporter:undefined,alerted:undefined,confirms:i.confirms.length,disputes:i.disputes.length,flags:i.flags.length});
const active=(i,n)=>i.expires>n&&i.work!=='resolved';
function recompute(i){const r=db.rep[i.reporter]||0;
 i.confidence=Math.max(0,Math.min(1,.3+(r>=3?.1:r<=-3?-.1:0)+.2*i.confirms.length-.25*i.disputes.length));
 if(i.status==='hidden')return;
 i.status=i.agencyVerified?'verified':i.flags.length>=3?'flagged':i.confidence>=.7?'verified':i.confidence<=.1?'disputed':'unverified';
 if(i.status==='verified'&&!i.rv){i.rv=1;db.rep[i.reporter]=(db.rep[i.reporter]||0)+1}
 if(i.status==='disputed'&&!i.rd){i.rd=1;db.rep[i.reporter]=(db.rep[i.reporter]||0)-1}}
const visible=role=>db.incidents.flatMap(i=>{if(role==='agency')return[i];const v=pub(i);return v?[{...i,lat:v.lat,lng:v.lng}]:[]});
function hotspots(role,hr){const now=Date.now(),c={},s=SEG.map(x=>({...x,score:0}));
 for(const i of visible(role)){const w=weight(i,now,hr);if(!w)continue;
  const k=Math.floor(i.lat/.01)+','+Math.floor(i.lng/.01);c[k]=(c[k]||0)+w;
  let b=null,bd=2;for(const x of s){const d=km(i.lat,i.lng,x.mid[0],x.mid[1]);if(d<bd){bd=d;b=x}}if(b)b.score+=w}
 const lv=v=>v>=8?'high':v>=3?'medium':'low';
 return{cells:Object.entries(c).filter(([,v])=>v>=1).map(([k,v])=>{const[a,b]=k.split(',').map(Number);return{s:[a*.01,b*.01],n:[(a+1)*.01,(b+1)*.01],score:+v.toFixed(1),level:lv(v)}}),
  segments:s.map(x=>({id:x.id,from:x.from,to:x.to,score:+x.score.toFixed(1),level:lv(x.score)}))}}
// ---- rate limits
const rate={};const limited=(k,max)=>{const n=Date.now(),a=rate[k]=(rate[k]||[]).filter(t=>n-t<36e5);if(a.length>=max)return true;a.push(n);return false};
// ---- step 6/9: SSE hub + geofenced alerts
const subs=new Set(),send=(s,ev,d)=>s.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
function push(i){const v=i.work==='resolved'?null:pub(i);for(const s of subs){if(s.ag)send(s,'incident',aview(i));else v?send(s,'incident',v):send(s,'remove',{id:i.id})}}
function alerts(i){const v=pub(i);if(!v)return;for(const s of subs){if(s.ag)continue;for(const w of db.watches[s.cid]||[]){
 if(v.severity>=w.minSev&&km(v.lat,v.lng,w.lat,w.lng)<=w.radius&&!i.alerted.includes(s.cid)){i.alerted.push(s.cid);send(s,'alert',v)}}}}
const hook=i=>HOOK&&fetch(HOOK,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(aview(i)),signal:AbortSignal.timeout(5000)}).catch(()=>{});
function changed(i,isNew){if(pub(i))i.shown=1;save();push(i);if(i.work!=='resolved')alerts(i);if(isNew)hook(i)}
setInterval(()=>{for(const i of db.incidents)if(i.tier==='delayed'&&!i.shown&&pub(i)){i.shown=1;changed(i)}},3e4);
// ---- http helpers
const body=req=>new Promise(ok=>{let b='';req.on('data',d=>{b+=d;if(b.length>1e5)req.destroy()});req.on('end',()=>{try{ok(JSON.parse(b||'{}'))}catch{ok({})}})});
const json=(res,c,d)=>{res.writeHead(c,{'content-type':'application/json','x-content-type-options':'nosniff'});res.end(JSON.stringify(d))};
const auth=(req,u)=>{const a=Buffer.from(req.headers['x-token']||u.searchParams.get('token')||''),b=Buffer.from(TOKEN);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const csvc=v=>{v=String(v??'');if(/^[=+\-@]/.test(v))v="'"+v;return'"'+v.replace(/"/g,'""')+'"'};
const inNG=(a,b)=>a>=4&&a<=14&&b>=2.5&&b<=15;
if(process.argv.includes('--seed')){ // synthetic demo data, flagged synthetic:true
 const T=Object.keys(TYPES),n=Date.now();db.incidents=db.incidents.filter(i=>!i.synthetic);
 for(let k=0;k<150;k++){const s=SEG[Math.floor(Math.random()**1.5*SEG.length)],type=T[Math.floor(Math.random()*T.length)],hr=Math.random()<.6?[19,21,22,23,0,2,4][Math.floor(Math.random()*7)]:Math.floor(Math.random()*24);
  const d=new Date(n-Math.random()*25*864e5);d.setUTCHours((hr+23)%24,Math.floor(Math.random()*60));const created=Math.min(d.getTime(),n-6e4);
  const i={id:crypto.randomUUID(),type,tier:TYPES[type][1],severity:1+Math.floor(Math.random()*5),lat:s.mid[0]+(Math.random()-.5)*.01,lng:s.mid[1]+(Math.random()-.5)*.01,desc:'Synthetic demo incident',reporter:'seed',created,expires:created+TYPES[type][0]*36e5,confirms:Array(Math.floor(Math.random()*4)).fill('seed'),disputes:[],flags:[],status:'unverified',confidence:.3,work:'new',notes:[],alerted:[],synthetic:true};
  recompute(i);db.incidents.push(i)}
 fs.mkdirSync(path.dirname(DB),{recursive:true});fs.writeFileSync(DB,JSON.stringify(db));console.log('Seeded 150 synthetic incidents');process.exit()}
http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://x'),p=u.pathname,m=req.method,ip=req.socket.remoteAddress,cid=req.headers['x-cid']||u.searchParams.get('cid')||'';
 const okc=/^[\w-]{8,64}$/.test(cid),rep=okc?crypto.createHash('sha256').update(cid+db.salt).digest('hex').slice(0,16):'';let r;
 if(p==='/api/config')return json(res,200,{key:KEY,types:Object.keys(TYPES),demo:db.incidents.some(i=>i.synthetic)});
 if(p==='/api/incidents'&&m==='GET'){const n=Date.now();return json(res,200,db.incidents.filter(i=>active(i,n)).map(i=>pub(i)).filter(Boolean))}
 if(p==='/api/incidents'&&m==='POST'){if(!okc)return json(res,400,{error:'Missing client id'});
  if(limited('c'+rep,10)||limited('i'+ip,30))return json(res,429,{error:'Too many reports. Try again later.'});
  const b=await body(req),t=TYPES[b.type],lat=+b.lat,lng=+b.lng,sev=Math.round(+b.severity);
  if(!t||!(sev>=1&&sev<=5)||!inNG(lat,lng))return json(res,400,{error:'Invalid report (type, severity 1-5, location in Nigeria)'});
  const n=Date.now(),i={id:crypto.randomUUID(),type:b.type,tier:t[1],severity:sev,lat,lng,desc:String(b.desc||'').slice(0,280),reporter:rep,created:n,expires:n+t[0]*36e5,confirms:[],disputes:[],flags:[],status:'unverified',confidence:.3,work:'new',notes:[],alerted:[]};
  recompute(i);db.incidents.push(i);changed(i,true);return json(res,201,{id:i.id})}
 if((r=p.match(/^\/api\/incidents\/([\w-]+)\/vote$/))&&m==='POST'){if(!okc||limited('v'+rep,60))return json(res,429,{error:'Too many actions'});
  const i=db.incidents.find(x=>x.id===r[1]),v=(await body(req)).v,k={confirm:'confirms',dispute:'disputes',flag:'flags'}[v];
  if(!i||!pub(i)||!k)return json(res,404,{error:'Not found'});
  if(i.reporter===rep||[...i.confirms,...i.disputes,...i.flags].includes(rep))return json(res,409,{error:'Already voted or your own report'});
  i[k].push(rep);if(k==='confirms')i.expires=Math.max(i.expires,Date.now()+TYPES[i.type][0]*36e5); // re-confirm resets timer
  recompute(i);changed(i);return json(res,200,pub(i)||{ok:1})}
 if(p==='/api/watch'&&m==='PUT'){if(!okc)return json(res,400,{error:'Missing client id'});const b=await body(req),w={lat:+b.lat,lng:+b.lng,radius:Math.min(100,Math.max(1,+b.radius||10)),minSev:Math.min(5,Math.max(1,+b.minSev||3))};
  if(!inNG(w.lat,w.lng))return json(res,400,{error:'Bad location'});db.watches[cid]=[w];save();return json(res,200,w)}
 if(p==='/api/hotspots'){const h=u.searchParams.get('hour');return json(res,200,hotspots('public',h===null||h===''?null:+h))}
 if(p==='/api/stream'||p==='/api/agency/stream'){const ag=p!=='/api/stream';if(ag?!auth(req,u):!okc)return json(res,401,{error:'unauthorized'});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});res.write(': ok\n\n');
  const s={res,ag,cid},ka=setInterval(()=>res.write(': ka\n\n'),25000);subs.add(s);req.on('close',()=>{subs.delete(s);clearInterval(ka)});return}
 // ---- step 10: agency API
 if(p.startsWith('/api/agency/')){if(!auth(req,u))return json(res,401,{error:'unauthorized'});
  if(p==='/api/agency/incidents'&&m==='GET')return json(res,200,db.incidents.slice(-500).reverse().map(aview));
  if(p==='/api/agency/hotspots')return json(res,200,hotspots('agency',null));
  if(p==='/api/agency/export.csv'){res.writeHead(200,{'content-type':'text/csv','content-disposition':'attachment; filename=incidents.csv'});
   return res.end(['id,created,type,tier,severity,lat,lng,status,confidence,work,desc',...db.incidents.map(i=>[i.id,new Date(i.created).toISOString(),i.type,i.tier,i.severity,i.lat,i.lng,i.status,i.confidence.toFixed(2),i.work,i.desc].map(csvc).join(','))].join('\n'))}
  if((r=p.match(/^\/api\/agency\/incidents\/([\w-]+)$/))&&m==='POST'){const i=db.incidents.find(x=>x.id===r[1]),b=await body(req);if(!i)return json(res,404,{error:'Not found'});
   if(['new','acknowledged','dispatched','resolved'].includes(b.work))i.work=b.work;
   if(b.action==='verify'){i.agencyVerified=1;if(i.status==='hidden')i.status='unverified'}
   if(b.action==='hide')i.status='hidden';
   if(b.action==='restore'){i.status='unverified';delete i.agencyVerified;i.flags=[]}
   if(b.note)i.notes.push({t:Date.now(),text:String(b.note).slice(0,300)});
   recompute(i);changed(i);return json(res,200,aview(i))}
  return json(res,404,{error:'Not found'})}
 const fp=path.join(PUB,path.normalize(p==='/'?'/index.html':p));
 if(!fp.startsWith(PUB+path.sep)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(fp)]||'application/octet-stream','x-content-type-options':'nosniff'});fs.createReadStream(fp).pipe(res)
}catch(e){json(res,500,{error:'Server error'})}}).listen(PORT,()=>console.log('S Trip MVP on http://localhost:'+PORT));
