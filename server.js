// BREW server: zero dependencies. Run: node server.js   (Node 18 or newer)
// Serves index.html and a small JSON API. Data lives in ./data (back this folder up).
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000,INVITE=process.env.INVITE||"";
const DIR=process.env.DATA_DIR||path.join(__dirname,"data"),RDIR=path.join(DIR,"receipts"),FILE=path.join(DIR,"brew.json");
fs.mkdirSync(RDIR,{recursive:true});
let db={shops:{},tokens:{}};try{db=JSON.parse(fs.readFileSync(FILE,"utf8"))}catch(e){}
let tm=null;const flush=()=>{clearTimeout(tm);tm=null;fs.writeFileSync(FILE+".tmp",JSON.stringify(db));fs.renameSync(FILE+".tmp",FILE)};
const save=()=>{if(!tm)tm=setTimeout(flush,200)};
process.on("SIGINT",()=>{flush();process.exit()});process.on("SIGTERM",()=>{flush();process.exit()});

const MENU={H01:[28,1,0],H02:[36,0,0],H03:[36,0,0],H04:[36,0,0],H05:[40,0,0],C01:[32,1,0],C02:[40,0,0],C03:[40,0,0],C04:[44,0,0],S01:[40,0,1],S02:[42,1,1]};
const calc=b=>{const[p0,bl,sp]=MENU[b.drink];let p=p0;if(!sp)p+=b.size==="L"?4:b.size==="S"?-4:0;if(!bl&&b.milk==="OM")p+=4;if(b.bean==="soe")p+=5;return p*b.qty};
const str=(v,n)=>String(v==null?"":v).replace(/[\u0000-\u001f]/g," ").slice(0,n);
const rid=n=>Array.from(crypto.randomBytes(n),b=>"abcdefghjkmnpqrstuvwxyz23456789"[b%31]).join("");
const hash=(pin,salt)=>crypto.scryptSync(pin,salt,32).toString("hex");
const NEXT={unpaid:["cancel"],paid:["making","cancel"],making:["ready"],ready:["done"]};
const fails={},hits={};

const send=(res,c,o)=>{const b=JSON.stringify(o);res.writeHead(c,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(b)};
const body=(req,max)=>new Promise((ok,bad)=>{let n=0,a=[],over=false;req.on("data",d=>{n+=d.length;if(over)return;if(n>max){over=true;a=[]}else a.push(d)});req.on("end",()=>{if(over)return bad(Object.assign(new Error("big"),{c:413}));try{ok(a.length?JSON.parse(Buffer.concat(a)):{})}catch(e){bad(Object.assign(new Error("json"),{c:400}))}});req.on("error",bad)});
const authed=(req,code)=>{const t=(req.headers.authorization||"").replace(/^Bearer /,"");const x=db.tokens[t];return !!x&&x.code===code};
const ip=req=>String(req.headers["x-forwarded-for"]||req.socket.remoteAddress).split(",")[0].trim();

async function api(req,res,u){
  const k=u.pathname.slice(5).split("/").filter(Boolean),m=req.method;
  if(k[0]==="ping")return send(res,200,{ok:1});
  if(k[0]==="register"&&m==="POST"){
    const b=await body(req,4e3);
    if(INVITE&&b.invite!==INVITE)return send(res,403,{error:"invite"});
    const name=str(b.name,40).trim(),fps=String(b.fps||"").replace(/\D/g,"").slice(0,12),pin=String(b.pin||"");
    if(!name||fps.length<8||!/^\d{6}$/.test(pin))return send(res,400,{error:"bad"});
    let code;do code=rid(8);while(db.shops[code]);
    const salt=crypto.randomBytes(16).toString("hex"),token=crypto.randomBytes(24).toString("hex");
    db.shops[code]={shop:{name,fps,open:false,soe:""},salt,ph:hash(pin,salt),ver:1,o:{}};db.tokens[token]={code,ts:Date.now()};save();
    return send(res,200,{code,token});
  }
  if(k[0]==="login"&&m==="POST"){
    const b=await body(req,4e3),code=String(b.code||"").toLowerCase(),s=db.shops[code],f=fails[code]||{n:0,ts:Date.now()};
    if(Date.now()-f.ts>9e5){f.n=0;f.ts=Date.now()}
    if(f.n>=8)return send(res,429,{error:"rate"});
    const ok=s&&crypto.timingSafeEqual(Buffer.from(hash(String(b.pin||""),s.salt),"hex"),Buffer.from(s.ph,"hex"));
    if(!ok){f.n++;fails[code]=f;return send(res,401,{error:"login"})}
    delete fails[code];const token=crypto.randomBytes(24).toString("hex");db.tokens[token]={code,ts:Date.now()};save();
    return send(res,200,{code,token});
  }
  if(k[0]!=="s"||!/^[a-z0-9]{8}$/.test(k[1]||""))return send(res,404,{error:"nf"});
  const code=k[1],S=db.shops[code];if(!S)return send(res,404,{error:"nf"});
  const A=authed(req,code),bump=()=>{S.ver++;save()};
  if(k[2]==="logout"&&m==="POST"){const t=(req.headers.authorization||"").replace(/^Bearer /,"");delete db.tokens[t];save();return send(res,200,{ok:1})}
  if(k[2]==="shop"){
    if(m==="GET")return send(res,200,S.shop);
    if(m==="PATCH"){if(!A)return send(res,401,{error:"auth"});const b=await body(req,4e3);if(b.open!==undefined)S.shop.open=!!b.open;if(b.soe!==undefined)S.shop.soe=str(b.soe,40);save();return send(res,200,S.shop)}
  }
  if(k[2]==="o"&&!k[3]){
    if(m==="GET"){if(!A)return send(res,401,{error:"auth"});if(String(S.ver)===u.searchParams.get("v"))return send(res,200,{same:1,v:S.ver});return send(res,200,{v:S.ver,orders:Object.entries(S.o).map(([id,o])=>({id,...o}))})}
    if(m==="POST"){
      const h=hits[ip(req)]||{n:0,ts:Date.now()};if(Date.now()-h.ts>6e4){h.n=0;h.ts=Date.now()}if(++h.n>20){hits[ip(req)]=h;return send(res,429,{error:"rate"})}hits[ip(req)]=h;
      const b=await body(req,4e3),qty=Math.floor(+b.qty);
      if(!MENU[b.drink]||!(qty>=1&&qty<=10))return send(res,400,{error:"bad"});
      const o={bean:b.bean==="soe"?"soe":"house",drink:b.drink,size:["S","M","L"].includes(b.size)?b.size:"M",milk:["FM","SM","OM"].includes(b.milk)?b.milk:"FM",qty,name:str(b.name,30),phone:str(b.phone,20),note:str(b.note,60)};
      o.bn=o.bean==="soe"?S.shop.soe:"";o.tot=calc(o);o.ts=Date.now();o.n=100+crypto.randomInt(900);o.s="unpaid";
      let id;do id=Date.now().toString(36)+rid(4);while(S.o[id]);
      S.o[id]=o;bump();return send(res,200,{id,...o});
    }
  }
  if(k[2]==="o"&&k[3]&&/^[a-z0-9]+$/.test(k[3])){
    const id=k[3],o=S.o[id];if(!o)return send(res,404,{error:"nf"});
    if(k[4]==="receipt"){
      if(m==="PUT"){
        if(o.s!=="unpaid"||o.rc)return send(res,409,{error:"state"});
        const b=await body(req,2e5),d=String(b.d||"");
        if(d.length>150000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d))return send(res,400,{error:"bad"});
        fs.writeFileSync(path.join(RDIR,code+"_"+id),d);o.s="paid";o.rc=1;o.pt=Date.now();bump();return send(res,200,{ok:1});
      }
      if(m==="GET"){if(!A)return send(res,401,{error:"auth"});let d="";try{d=fs.readFileSync(path.join(RDIR,code+"_"+id),"utf8")}catch(e){}return send(res,200,{d})}
    }
    if(!k[4]){
      if(m==="GET")return send(res,200,{id,...o});
      if(m==="DELETE"){if(!A&&o.s!=="unpaid")return send(res,401,{error:"auth"});delete S.o[id];bump();return send(res,200,{ok:1})}
      if(m==="PATCH"){
        if(!A)return send(res,401,{error:"auth"});const b=await body(req,4e3);
        if(b.s!==undefined){if(!(NEXT[o.s]||[]).includes(b.s))return send(res,409,{error:"state"});o.s=b.s}
        if(b.chk!==undefined){if(b.chk)o.chk=1;else delete o.chk}
        bump();return send(res,200,{id,...o});
      }
    }
  }
  send(res,404,{error:"nf"});
}
const srv=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,"http://x");
    if(u.pathname.startsWith("/api/"))return await api(req,res,u);
    if(u.pathname==="/"||u.pathname==="/index.html"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});return res.end(fs.readFileSync(path.join(__dirname,"index.html")))}
    send(res,404,{error:"nf"});
  }catch(e){send(res,e.c||500,{error:e.message})}
});srv.requestTimeout=20000;srv.listen(PORT,()=>console.log("BREW running on http://localhost:"+PORT));
