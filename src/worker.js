const MAX_BODY=8000000;
const CHUNK=400000;
const MODES=['private','view','edit'];
const enc=new TextEncoder();

const reply=(body,status=200)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});

const rand=n=>{
  const a=crypto.getRandomValues(new Uint8Array(n));
  let s='';
  for(const x of a)s+=String.fromCharCode(x);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};

async function sha(s){
  const d=await crypto.subtle.digest('SHA-256',enc.encode(s));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

const same=(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let r=0;
  for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);
  return r===0;
};

const split=s=>{
  const a=[];
  for(let i=0;i<s.length;i+=CHUNK)a.push(s.slice(i,i+CHUNK));
  return a;
};

const checkBody=b=>{
  if(b.length>MAX_BODY)return 'too_large';
  if(b.length<2||b[0]!=='{'||b[b.length-1]!=='}')return 'bad_body';
  return null;
};

function originAllowed(origin,env){
  if(!origin)return true;
  const list=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(list.includes(origin))return true;
  try{
    const u=new URL(origin);
    if(u.protocol==='https:'&&u.hostname.endsWith('.github.io'))return true;
    if(u.hostname==='localhost'||u.hostname==='127.0.0.1')return true;
  }catch(e){}
  return false;
}

async function route(req,env){
  const url=new URL(req.url);
  const m=/^\/api\/d(?:\/([A-Za-z0-9_-]{12})(\/(?:rev|ws))?)?\/?$/.exec(url.pathname);
  if(!m)return reply({error:'not_found'},404);
  const len=Number(req.headers.get('content-length')||0);
  if(len>MAX_BODY*3)return reply({error:'too_large'},413);
  const id=m[1],sub=m[2];
  if(!id){
    if(req.method!=='POST')return reply({error:'method'},405);
    const nid=rand(9);
    const stub=env.DRAWINGS.get(env.DRAWINGS.idFromName(nid));
    const r=await stub.fetch('https://do/init'+url.search,{method:'POST',body:req.body});
    if(!r.ok)return r;
    const j=await r.json();
    j.id=nid;
    return reply(j,201);
  }
  const stub=env.DRAWINGS.get(env.DRAWINGS.idFromName(id));
  if(sub==='/ws')return stub.fetch(new Request('https://do/ws',req));
  const hasBody=req.method!=='GET'&&req.method!=='HEAD';
  return stub.fetch('https://do'+(sub?'/rev':'/data')+url.search,{
    method:req.method,
    headers:{authorization:req.headers.get('authorization')||''},
    body:hasBody?req.body:undefined
  });
}

export default{
  async fetch(req,env){
    const origin=req.headers.get('origin')||'';
    const withCors=res=>{
      if(res.status===101)return res;
      const r=new Response(res.body,res);
      if(origin){
        r.headers.set('access-control-allow-origin',origin);
        r.headers.append('vary','Origin');
      }
      return r;
    };
    if(!originAllowed(origin,env))return reply({error:'origin'},403);
    if(req.method==='OPTIONS'){
      return withCors(new Response(null,{status:204,headers:{
        'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers':'authorization,content-type',
        'access-control-max-age':'86400'
      }}));
    }
    try{
      return withCors(await route(req,env));
    }catch(e){
      return withCors(reply({error:'server'},500));
    }
  }
};

async function roleOf(meta,key){
  if(!key)return null;
  return roleOfHash(meta,await sha(key));
}

function roleOfHash(meta,h){
  if(!h)return null;
  if(same(h,meta.ownerHash))return 'owner';
  const isEdit=same(h,meta.editHash),isView=same(h,meta.viewHash);
  if(!isEdit&&!isView)return null;
  if(meta.mode==='private')return 'private';
  if(isEdit)return meta.mode==='edit'?'edit':'view';
  return 'view';
}

export class Drawing{
  constructor(ctx){
    this.ctx=ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }

  broadcast(msg){
    const t=JSON.stringify(msg);
    for(const ws of this.ctx.getWebSockets()){
      try{ws.send(t)}catch(e){}
    }
  }

  refresh(meta){
    for(const ws of this.ctx.getWebSockets()){
      const a=ws.deserializeAttachment()||{};
      const role=roleOfHash(meta,a.hash);
      try{
        if(!role||role==='private')ws.close(4403,'revoked');
        else ws.send(JSON.stringify({t:'role',role,mode:role==='owner'?meta.mode:undefined,rev:meta.rev}));
      }catch(e){}
    }
  }

  async connect(req,meta){
    if(req.headers.get('upgrade')!=='websocket')return reply({error:'upgrade'},426);
    const key=(req.headers.get('sec-websocket-protocol')||'').split(',').map(s=>s.trim())[1]||'';
    const hash=key?await sha(key):'';
    const role=roleOfHash(meta,hash);
    if(!role)return reply({error:'forbidden'},403);
    if(role==='private')return reply({error:'private'},403);
    const pair=new WebSocketPair();
    const client=pair[0],server=pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({hash});
    server.send(JSON.stringify({t:'hello',role,rev:meta.rev}));
    return new Response(null,{status:101,webSocket:client,headers:{'sec-websocket-protocol':'paint'}});
  }

  webSocketMessage(){}

  webSocketClose(ws){
    try{ws.close(1000)}catch(e){}
  }

  webSocketError(){}

  async fetch(req){
    const url=new URL(req.url),q=url.searchParams,st=this.ctx.storage;
    if(url.pathname==='/init')return this.init(req,q);
    const meta=await st.get('meta');
    if(!meta)return reply({error:'not_found'},404);
    if(url.pathname==='/ws')return this.connect(req,meta);
    const key=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
    const role=await roleOf(meta,key);
    if(!role)return reply({error:'forbidden'},403);
    if(role==='private')return reply({error:'private'},403);
    if(url.pathname==='/rev'){
      if(req.method!=='GET')return reply({error:'method'},405);
      return reply({role,rev:meta.rev,updated:meta.updated,mode:role==='owner'?meta.mode:undefined});
    }
    if(req.method==='GET')return this.read(meta,role);
    if(req.method==='PUT')return this.write(role,req,q);
    if(req.method==='PATCH')return this.patch(role,req);
    if(req.method==='DELETE'){
      if(role!=='owner')return reply({error:'forbidden'},403);
      for(const ws of this.ctx.getWebSockets()){try{ws.close(4404,'deleted')}catch(e){}}
      await st.deleteAll();
      return reply({ok:true});
    }
    return reply({error:'method'},405);
  }

  async init(req,q){
    const st=this.ctx.storage;
    if(await st.get('meta'))return reply({error:'exists'},409);
    const mode=MODES.includes(q.get('mode'))?q.get('mode'):'private';
    const body=await req.text();
    const bad=checkBody(body);
    if(bad)return reply({error:bad},bad==='too_large'?413:400);
    const ok=rand(18),vk=rand(18),ek=rand(18);
    const [ownerHash,viewHash,editHash]=await Promise.all([sha(ok),sha(vk),sha(ek)]);
    if(await st.get('meta'))return reply({error:'exists'},409);
    const chunks=split(body),now=Date.now();
    const meta={ownerHash,viewHash,editHash,mode,title:(q.get('title')||'').slice(0,40),rev:1,created:now,updated:now,chunks:chunks.length};
    const entries={meta};
    chunks.forEach((s,i)=>{entries['c:'+i]=s});
    await st.put(entries);
    return reply({ownerKey:ok,viewKey:vk,editKey:ek,mode,rev:1});
  }

  async read(meta,role){
    const keys=Array.from({length:meta.chunks},(_,i)=>'c:'+i);
    const got=keys.length?await this.ctx.storage.get(keys):new Map();
    const body=keys.map(k=>got.get(k)||'').join('')||'null';
    return reply('{"role":"'+role+'","mode":"'+meta.mode+'","title":'+JSON.stringify(meta.title||'')+',"rev":'+meta.rev+',"updated":'+meta.updated+',"data":'+body+'}');
  }

  async write(role,req,q){
    if(role!=='owner'&&role!=='edit')return reply({error:'forbidden'},403);
    const st=this.ctx.storage;
    const base=Number(q.get('rev')),force=q.get('force')==='1';
    const body=await req.text();
    const bad=checkBody(body);
    if(bad)return reply({error:bad},bad==='too_large'?413:400);
    const cur=await st.get('meta');
    if(!cur)return reply({error:'not_found'},404);
    if(!force&&base!==cur.rev)return reply({error:'conflict',rev:cur.rev},409);
    const chunks=split(body);
    const next={...cur,rev:cur.rev+1,updated:Date.now(),chunks:chunks.length};
    if(q.has('title'))next.title=q.get('title').slice(0,40);
    const entries={meta:next};
    chunks.forEach((s,i)=>{entries['c:'+i]=s});
    await st.put(entries);
    if(cur.chunks>chunks.length){
      await st.delete(Array.from({length:cur.chunks-chunks.length},(_,i)=>'c:'+(chunks.length+i)));
    }
    this.broadcast({t:'rev',rev:next.rev,by:q.get('cid')||''});
    return reply({rev:next.rev});
  }

  async patch(role,req){
    if(role!=='owner')return reply({error:'forbidden'},403);
    let b;
    try{b=JSON.parse(await req.text())}catch(e){return reply({error:'bad_body'},400)}
    if(!b||typeof b!=='object')return reply({error:'bad_body'},400);
    if(b.mode!==undefined&&!MODES.includes(b.mode))return reply({error:'bad_mode'},400);
    const out={};
    let viewHash,editHash;
    if(b.rotate){
      const vk=rand(18),ek=rand(18);
      viewHash=await sha(vk);
      editHash=await sha(ek);
      out.viewKey=vk;
      out.editKey=ek;
    }
    const st=this.ctx.storage;
    const cur=await st.get('meta');
    if(!cur)return reply({error:'not_found'},404);
    const next={...cur};
    if(b.mode!==undefined)next.mode=b.mode;
    if(b.rotate){next.viewHash=viewHash;next.editHash=editHash}
    await st.put('meta',next);
    this.refresh(next);
    return reply({mode:next.mode,rev:next.rev,...out});
  }
}
