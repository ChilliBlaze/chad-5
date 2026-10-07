const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const PRIMARY_ACCOUNT_FILE=process.env.ACCOUNT_FILE||path.join(__dirname,'accounts.json');
const FALLBACK_ACCOUNT_FILE=path.join(__dirname,'accounts.json');
let ACCOUNT_FILE=PRIMARY_ACCOUNT_FILE;
function ensureAccountFile(file){
 try{
   const dir=path.dirname(file);
   if(!fs.existsSync(dir))return false;
   fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK);
   if(!fs.existsSync(file))fs.writeFileSync(file,'{}\n','utf8');
   fs.accessSync(file,fs.constants.R_OK|fs.constants.W_OK);
   return true;
 }catch(e){
   console.error('Account storage unavailable:',file,e.message);
   return false;
 }
}
if(!ensureAccountFile(ACCOUNT_FILE)&&ACCOUNT_FILE!==FALLBACK_ACCOUNT_FILE){
 console.warn('Configured ACCOUNT_FILE is unavailable; falling back to:',FALLBACK_ACCOUNT_FILE);
 ACCOUNT_FILE=FALLBACK_ACCOUNT_FILE;
}
if(!ensureAccountFile(ACCOUNT_FILE)){
 console.error('No writable account storage is available. Account creation will return a visible error.');
}
let accounts={};
try{
 const raw=fs.readFileSync(ACCOUNT_FILE,'utf8').trim();
 accounts=raw?JSON.parse(raw):{};
 if(!accounts||typeof accounts!=='object'||Array.isArray(accounts))accounts={};
}catch(e){
 console.error('Could not read account database:',e.message);accounts={};
}
function saveAccounts(){
 try{
   if(!ensureAccountFile(ACCOUNT_FILE))return{ok:false,error:'Account storage is not writable.'};
   const tmp=ACCOUNT_FILE+'.tmp';
   fs.writeFileSync(tmp,JSON.stringify(accounts,null,2),'utf8');
   fs.renameSync(tmp,ACCOUNT_FILE);
   return{ok:true};
 }catch(e){
   console.error('Account save failed:',e.message);
   return{ok:false,error:'The server could not save the account database. Check the Render disk / ACCOUNT_FILE setting.'};
 }
}
function hashPassword(password,salt){return crypto.pbkdf2Sync(password,salt,120000,32,'sha256').toString('hex')}
function publicAccount(a){return{name:a.name,trophies:a.trophies||0,allTimeWon:a.allTimeWon??a.totalWon??0,owned:a.owned||[],equipped:a.equipped||{}}}
const SHOP={};
const SHOP_COLORS=['Crimson','Ocean','Forest','Gold','Violet','Ice','Orange','White','Black','Lime'];
for(const cat of ['top','hair','trousers']){for(let i=1;i<=10;i++)SHOP[cat+i]={category:cat,cost:10};SHOP['pink_'+cat]={category:cat,cost:100}}


const PORT=process.env.PORT||8080,ROOT=__dirname,WORLD_R=25;
const players=new Map(),clients=new Map(),rooms=new Map();
const damageByWeapon={rifle:24,machinegun:3,sniper:72,pistol:9,flintlock:58,knife:46,bat:38,lightsaber:58,sword:52,fists:10,lifesteal:20};
const meleeWeapons=new Set(['knife','bat','lightsaber','sword','fists','lifesteal']);
let nextId=1,soloSeq=1;

function encodeFrame(text){const payload=Buffer.from(text);let h;if(payload.length<126)h=Buffer.from([0x81,payload.length]);else if(payload.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(payload.length,2)}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(payload.length),2)}return Buffer.concat([h,payload])}
function send(ws,obj){if(ws&&!ws.destroyed)ws.write(encodeFrame(JSON.stringify(obj)))}
function roomMembers(code){return [...players.entries()].filter(([,p])=>p.room===code)}
function broadcastRoom(code,obj,except=null){const f=encodeFrame(JSON.stringify(obj));for(const [id,p] of roomMembers(code)){const ws=clients.get(id);if(ws&&ws!==except&&!ws.destroyed)ws.write(f)}}
function cleanName(v,id){const x=String(v??'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,20);return x||id}
function randomCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let c='';do{c='';for(let i=0;i<6;i++)c+=chars[Math.floor(Math.random()*chars.length)]}while(rooms.has(c));return c}
function randomPoint(rad=27.65){let x,y,z,l;do{x=Math.random()*2-1;y=Math.random()*2-1;z=Math.random()*2-1;l=Math.hypot(x,y,z)}while(l<.15);return[x/l*rad,y/l*rad,z/l*rad]}
const BLUE_BASE=[27.65,0,0],RED_BASE=[-27.65,0,0],BLUE_CAPTURE=[27.65,0,0],RED_CAPTURE=[-27.65,0,0],CTF_CAPTURE_RADIUS=3.5,CTF_PICKUP_RADIUS=3.0,HOTZONE=[0,0,25.05],HOTZONE_RADIUS=5;
function spreadPoints(count,rad){const out=[];const ga=Math.PI*(3-Math.sqrt(5));for(let i=0;i<count;i++){const y=1-(i/(Math.max(1,count-1)))*2,r=Math.sqrt(Math.max(0,1-y*y)),a=i*ga;out.push([Math.cos(a)*r*rad,y*rad,Math.sin(a)*r*rad])}return out}
const BR_MAIN_RADIUS=51.25,BR_SMALL_RADIUS=7,BR_ORBIT_RADIUS=78;
function brStartingPoints(){return spreadPoints(12,BR_ORBIT_RADIUS).map(c=>{const m=Math.hypot(...c)||1;return[c[0]+c[0]/m*(BR_SMALL_RADIUS+2.65),c[1]+c[1]/m*(BR_SMALL_RADIUS+2.65),c[2]+c[2]/m*(BR_SMALL_RADIUS+2.65)]})}
function nearBase(base,index=0){const b=base.slice(),up=[b[0]/27.65,b[1]/27.65,b[2]/27.65],j=((index%3)-1)*.7;const p=[b[0],b[1]+j,b[2]+((index%2)*2-1)*.45],m=Math.hypot(...p);return p.map(v=>v/m*27.65)}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])}
function playerState(id,p){return{id,name:p.name,kills:p.kills,p:p.p,f:p.f,u:p.u,weapon:p.weapon,aiming:p.aiming,crouch:p.crouch,sprint:p.sprint,move:p.move,thirdPerson:p.thirdPerson,health:p.health,shield:p.shield||0,protected:Date.now()<(p.invulnUntil||0),emote:p.emote||null,invisible:!!p.invisible,team:p.team||null,teamLocked:!!p.teamLocked,flagCarry:p.flagCarry||null,cosmetics:p.cosmetics||{},alive:p.alive!==false}}
function scoreboard(code){return roomMembers(code).map(([id,p])=>({id,name:p.name,kills:p.kills,health:p.health,team:p.team||null,teamLocked:!!p.teamLocked,flagCarry:p.flagCarry||null,cosmetics:p.cosmetics||{},alive:p.alive!==false})).sort((a,b)=>b.kills-a.kills||a.name.localeCompare(b.name))}
function sendScoreboard(code){broadcastRoom(code,{type:'scoreboard',players:scoreboard(code)})}
function lobbyState(room){return{code:room.code,hostId:room.hostId,mode:room.mode,started:room.started,players:roomMembers(room.code).map(([id,p])=>({id,name:p.name,team:p.team||null,teamLocked:!!p.teamLocked}))}}
function sendLobby(room){broadcastRoom(room.code,{type:'lobbyState',lobby:lobbyState(room)})}
function roomModeState(room){
 if(room.mode==='hotzone')return{type:'modeState',mode:'hotzone',blue:room.blue||0,red:room.red||0,contested:!!room.contested,zone:HOTZONE,radius:HOTZONE_RADIUS,owner:room.zoneOwner||null};
 if(room.mode==='ctf')return{type:'modeState',mode:'ctf',blue:room.blue||0,red:room.red||0,blueBase:BLUE_BASE,redBase:RED_BASE,blueCapture:BLUE_CAPTURE,redCapture:RED_CAPTURE,captureRadius:CTF_CAPTURE_RADIUS,blueCarrier:room.flags?.blueCarrier||null,redCarrier:room.flags?.redCarrier||null};
 if(room.mode==='br')return{type:'modeState',mode:'br',alive:roomMembers(room.code).filter(([,p])=>p.alive!==false).length};
 return{type:'modeState',mode:'solo'}
}
function sendWelcome(id,p){const room=rooms.get(p.room),ws=clients.get(id);send(ws,{type:'welcome',id,health:p.health,shield:p.shield,players:roomMembers(p.room).filter(([pid])=>pid!==id).map(([pid,pp])=>playerState(pid,pp)),totems:roomMembers(p.room).filter(([pid,pp])=>pid!==id&&pp.totem).map(([pid,pp])=>({id:pid,p:pp.totem})),scoreboard:scoreboard(p.room)});if(room?.started)send(ws,{type:'matchStart',mode:room.mode,team:p.team,blue:room.blue||0,red:room.red||0,alive:roomMembers(p.room).filter(([,q])=>q.alive!==false).length})}
function assignTeams(room){}
function sendVitals(pid,p){broadcastRoom(p.room,{type:'health',id:pid,health:p.health,shield:p.shield||0})}
function damagePlayer(pid,t,amount,killerId,heavy=false){if(Date.now()<(t.invulnUntil||0)){send(clients.get(killerId),{type:'forcefieldBlocked',target:pid});return false;}if(t.health<=0||t.alive===false)return false;let dmg=Math.max(0,amount);if((t.shield||0)>0){const take=Math.min(t.shield,dmg);t.shield-=take;dmg-=take}const before=t.health;t.health=Math.max(0,t.health-dmg);sendVitals(pid,t);broadcastRoom(t.room,{type:'hitFx',id:pid,heavy});if(before>0&&t.health<=0)registerDeath(pid,killerId,heavy?8:5);return true}
function registerDeath(victimId,killerId,force=5){const v=players.get(victimId);if(!v)return;const room=rooms.get(v.room);if(!room)return;v.kills=0;if(room.mode==='ctf'&&v.flagCarry){if(v.flagCarry==='blue')room.flags.blueCarrier=null;else room.flags.redCarrier=null;v.flagCarry=null;broadcastRoom(room.code,roomModeState(room));}if(killerId&&killerId!==victimId&&players.has(killerId)){const k=players.get(killerId);k.kills++;}if(room.mode==='br'){
 v.alive=false;
 const aliveNow=roomMembers(room.code).filter(([,q])=>q.alive!==false).length,placement=aliveNow+1;
 if(v.accountKey&&accounts[v.accountKey]&&!v.brRewarded){const a=accounts[v.accountKey],delta=trophyDelta(placement);a.trophies=Math.max(0,(a.trophies||0)+delta);if(delta>0){a.allTimeWon=(a.allTimeWon??a.totalWon??0)+delta;a.totalWon=a.allTimeWon;}v.brRewarded=true;saveAccounts();send(clients.get(victimId),{type:'trophyResult',placement,delta,account:publicAccount(a)});}
 }broadcastRoom(room.code,{type:'deathFx',id:victimId,killer:killerId||null,force});sendScoreboard(room.code);broadcastRoom(room.code,roomModeState(room));checkWin(room)}
function finishMatch(room,text,sub=''){
 if(!room.started)return;room.started=false;broadcastRoom(room.code,{type:'matchEnd',text,sub});
 setTimeout(()=>{if(!rooms.has(room.code))return;for(const[,p]of roomMembers(room.code)){p.alive=true;p.health=100;p.shield=0;p.flagCarry=null;p.team=null;p.teamLocked=false;p.brRewarded=false}room.blue=0;room.red=0;room.contested=false;room.zoneOwner=null;room.flags={blueCarrier:null,redCarrier:null};
 if(room.mode==='br'&&room.brQueue){broadcastRoom(room.code,{type:'returnMain'});for(const[,p]of roomMembers(room.code))p.room=null;rooms.delete(room.code);}
 else{sendLobby(room);broadcastRoom(room.code,{type:'returnLobby',lobby:lobbyState(room)});}
 },3500);
}
function checkWin(room){
 if(room.mode==='hotzone'&&Math.max(room.blue||0,room.red||0)>=100)return finishMatch(room,(room.blue>room.red?'BLUE':'RED')+' TEAM WINS','Hotzone captured');
 if(room.mode==='ctf'&&Math.max(room.blue||0,room.red||0)>=3)return finishMatch(room,(room.blue>room.red?'BLUE':'RED')+' TEAM WINS','Capture the Flag');
 if(room.mode==='br'){const alive=roomMembers(room.code).filter(([,p])=>p.alive!==false);if(room.started&&alive.length<=1&&roomMembers(room.code).length>=2){if(alive.length){const [wid,w]=alive[0];if(w.accountKey&&accounts[w.accountKey]&&!w.brRewarded){const a=accounts[w.accountKey],delta=3;a.trophies=(a.trophies||0)+delta;a.allTimeWon=(a.allTimeWon??a.totalWon??0)+delta;a.totalWon=a.allTimeWon;w.brRewarded=true;saveAccounts();send(clients.get(wid),{type:'trophyResult',placement:1,delta,account:publicAccount(a)});}}return finishMatch(room,alive.length?alive[0][1].name+' WINS':'NO WINNER','Battle Royale');}}
}
function joinRoom(id,room,name){const p=players.get(id),limit=room.mode==='br'?12:10;if(!p||roomMembers(room.code).length>=limit)return false;p.room=room.code;p.name=cleanName(name,id);p.health=100;p.shield=0;p.alive=true;p.team=null;p.teamLocked=false;p.flagCarry=null;p.p=randomPoint();sendWelcome(id,p);sendScoreboard(room.code);return true}
function leaveCurrentRoom(id){const p=players.get(id);if(!p||!p.room)return;const code=p.room,room=rooms.get(code);p.room=null;broadcastRoom(code,{type:'leave',id});if(room){const remaining=roomMembers(code);if(!remaining.length)rooms.delete(code);else{if(room.hostId===id)room.hostId=remaining[0][0];if(!room.started)sendLobby(room)}}}
function startMatch(room){
 if(room.started)return;const members=roomMembers(room.code);if(members.length<2)return;
 if((room.mode==='hotzone'||room.mode==='ctf')&&!members.every(([,p])=>p.teamLocked&&(p.team==='blue'||p.team==='red')))return;
 room.started=true;room.blue=0;room.red=0;room.contested=false;room.zoneOwner=null;room.flags={blueCarrier:null,redCarrier:null};
 const brPoints=room.mode==='br'?brStartingPoints().slice(0,members.length):null;let bi=0,ri=0;
 members.forEach(([id,p],idx)=>{p.health=100;p.shield=0;p.alive=true;p.kills=0;p.flagCarry=null;p.brRewarded=false;p.invulnUntil=Date.now()+4000;
   if(room.mode==='br')p.p=brPoints[idx];
   else if(room.mode==='hotzone'||room.mode==='ctf')p.p=nearBase(p.team==='blue'?BLUE_BASE:RED_BASE,p.team==='blue'?bi++:ri++);
   else p.p=randomPoint(27.65);
   send(clients.get(id),{type:'serverPosition',p:p.p});send(clients.get(id),{type:'matchStart',mode:room.mode,team:p.team,blue:0,red:0,alive:members.length});
 });
 sendScoreboard(room.code);broadcastRoom(room.code,roomModeState(room));
}
function quickPlayRoom(mode){
 const target=['solo','hotzone','ctf'].includes(mode)?mode:'solo';
 for(const r of rooms.values())if(r.publicQuick&&r.mode===target&&!r.started&&roomMembers(r.code).length<10)return r;
 if(target==='solo')for(const r of rooms.values())if(r.publicQuick&&r.mode==='solo'&&r.started&&roomMembers(r.code).length<10)return r;
 const code='QUICK'+soloSeq++;
 const started=target==='solo';
 const r={code,hostId:null,mode:target,started,solo:target==='solo',publicQuick:true,blue:0,red:0,createdAt:Date.now(),flags:{blueCarrier:null,redCarrier:null}};
 rooms.set(code,r);return r;
}
function soloRoom(){return quickPlayRoom('solo')}


function trophyDelta(place){if(place===1)return 3;if(place===2)return 2;if(place===3)return 1;if(place<=6)return 0;if(place<=9)return -1;if(place<=11)return -2;return -3}
function authPlayer(id,name,password){
 const p=players.get(id);
 const display=String(name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,20);
 const key=display.toLowerCase();
 const pass=String(password||'');
 if(!p)return{error:'Connection is not ready. Please try again.'};
 if(display.length<2)return{error:'Name must be at least 2 characters.'};
 if(pass.length<4)return{error:'Password must be at least 4 characters.'};
 let a=accounts[key],created=false;
 if(!a){
   const salt=crypto.randomBytes(16).toString('hex');
   a={name:display,salt,hash:hashPassword(pass,salt),trophies:0,allTimeWon:0,totalWon:0,owned:[],equipped:{}};
   accounts[key]=a;
   const saved=saveAccounts();
   if(!saved.ok){delete accounts[key];return{error:saved.error||'Could not save the new account.'};}
   created=true;
 }else{
   if(!a.salt||!a.hash)return{error:'This account record is damaged. Ask the server owner to reset it.'};
   const h=hashPassword(pass,a.salt),A=Buffer.from(h,'hex'),B=Buffer.from(a.hash,'hex');
   if(A.length!==B.length||!crypto.timingSafeEqual(A,B))return{error:'Incorrect password.'};
 }
 p.accountKey=key;p.name=a.name;p.cosmetics={...(a.equipped||{})};
 return{account:publicAccount(a),created};
}
function globalLeaderboard(){return Object.values(accounts).map(a=>{if(a.allTimeWon===undefined)a.allTimeWon=a.totalWon||0;return a}).sort((a,b)=>(b.allTimeWon||0)-(a.allTimeWon||0)||(b.trophies||0)-(a.trophies||0)).slice(0,100).map(a=>({name:a.name,allTimeWon:a.allTimeWon||0,currentTrophies:a.trophies||0}))}
function brQueueRoom(){
 for(const r of rooms.values())if(r.brQueue&&!r.started&&roomMembers(r.code).length<12)return r;
 const code='BR'+soloSeq++,r={code,hostId:null,mode:'br',started:false,solo:false,publicQuick:false,brQueue:true,blue:0,red:0,createdAt:Date.now(),queueEnds:0};
 rooms.set(code,r);return r;
}
function sendBRQueue(room){
 const count=roomMembers(room.code).length,seconds=room.queueEnds?Math.max(0,Math.ceil((room.queueEnds-Date.now())/1000)):6;
 broadcastRoom(room.code,{type:'brQueue',count,max:12,seconds});
}
function maybeStartBRQueue(room){
 const count=roomMembers(room.code).length;if(room.started)return;
 if(count>=12){room.queueEnds=Date.now();startMatch(room);return}
 if(count>=2&&!room.queueEnds)room.queueEnds=Date.now()+6000;
 sendBRQueue(room);
}
function handleMessage(ws,raw){const id=ws._playerId,p=players.get(id);if(!p)return;let m;try{m=JSON.parse(raw)}catch{return}
 if(m.type==='auth'){
   const requestId=String(m.requestId||'');
   const r=authPlayer(id,m.name,m.password);
   if(r.error)return send(ws,{type:'authError',requestId,message:r.error});
   return send(ws,{type:'authOk',requestId,created:!!r.created,account:r.account,storage:path.basename(ACCOUNT_FILE)});
 }
 if(m.type==='getGlobalLeaderboard')return send(ws,{type:'globalLeaderboard',rows:globalLeaderboard()});
 if(m.type==='buyCosmetic'||m.type==='equipCosmetic'){if(!p.accountKey)return;const a=accounts[p.accountKey],it=SHOP[m.item];if(!a||!it)return;
   a.owned=a.owned||[];a.equipped=a.equipped||{};
   if(m.type==='buyCosmetic'&&!a.owned.includes(m.item)){if((a.trophies||0)<it.cost)return send(ws,{type:'lobbyError',message:'Not enough trophies.'});a.trophies-=it.cost;a.owned.push(m.item);}
   if(a.owned.includes(m.item)){a.equipped[it.category]=m.item;p.cosmetics=a.equipped;saveAccounts();send(ws,{type:'accountUpdate',account:publicAccount(a)});}
   return;
 }
 if(m.type==='battleRoyaleQueue'){if(!p.accountKey)return send(ws,{type:'authError',message:'Log in first.'});leaveCurrentRoom(id);const room=brQueueRoom();if(!joinRoom(id,room,p.name))return send(ws,{type:'lobbyError',message:'Battle Royale is full.'});maybeStartBRQueue(room);return;}
 if(m.type==='lobbyAction'){
   if(!p.accountKey)return send(ws,{type:'authError',message:'Log in first.'});leaveCurrentRoom(id);const action=m.action,name=p.name;
   if(action==='create'){
     const code=randomCode(),room={code,hostId:id,mode:'hotzone',started:false,solo:false,blue:0,red:0};rooms.set(code,room);
     if(!joinRoom(id,room,name)){rooms.delete(code);return send(ws,{type:'lobbyError',message:'Could not create the game.'});}
     send(ws,{type:'lobbyState',lobby:lobbyState(room)});sendLobby(room);
   }else if(action==='join'){
     const room=rooms.get(String(m.code||'').toUpperCase());
     if(!room||room.solo||room.started)return send(ws,{type:'lobbyError',message:'That code is not available.'});
     if(roomMembers(room.code).length>=10)return send(ws,{type:'lobbyError',message:'That game is full.'});
     if(!joinRoom(id,room,name))return send(ws,{type:'lobbyError',message:'Could not join game.'});
     send(ws,{type:'lobbyState',lobby:lobbyState(room)});sendLobby(room);
   }else if(action==='quickplay'){
     const mode=['solo','hotzone','ctf'].includes(m.mode)?m.mode:'solo',room=quickPlayRoom(mode);
     if(!joinRoom(id,room,name))return send(ws,{type:'lobbyError',message:'Could not join Quick Play.'});
     if(mode==='solo'){send(ws,{type:'matchStart',mode:'solo',team:null,alive:roomMembers(room.code).length});broadcastRoom(room.code,roomModeState(room));}
     else{if(!room.hostId)room.hostId=id;send(ws,{type:'lobbyState',lobby:lobbyState(room)});sendLobby(room);}
   }else if(action==='solo'){
     const room=soloRoom();
     if(!joinRoom(id,room,name))return send(ws,{type:'lobbyError',message:'Could not create or join a Solo world.'});
     send(ws,{type:'matchStart',mode:'solo',team:null,alive:roomMembers(room.code).length});
     broadcastRoom(room.code,roomModeState(room));
   }
 }
 else if(m.type==='setMode'&&p.room){const room=rooms.get(p.room);if(room&&!room.started&&!room.publicQuick&&room.hostId===id&&['hotzone','ctf','br'].includes(m.mode)){room.mode=m.mode;
 if(m.mode==='br'){for(const[,q]of roomMembers(room.code)){q.team=null;q.teamLocked=false}}
 sendLobby(room)}}
 else if(m.type==='chooseTeam'&&p.room){const room=rooms.get(p.room);if(room&&!room.started&&(room.mode==='hotzone'||room.mode==='ctf')&&!p.teamLocked&&['blue','red'].includes(m.team)){p.team=m.team;p.teamLocked=true;sendLobby(room)}}
 else if(m.type==='startMatch'&&p.room){const room=rooms.get(p.room);if(room&&room.hostId===id&&!room.started&&roomMembers(room.code).length>=2)startMatch(room)}
 else if(!p.room)return;
 else if(m.type==='setName'){p.name=cleanName(m.name,id);sendScoreboard(p.room)}
 else if(m.type==='state'&&Array.isArray(m.p)&&Array.isArray(m.f)&&Array.isArray(m.u)){
 p.p=m.p.slice(0,3).map(Number);p.f=m.f.slice(0,3).map(Number);p.u=m.u.slice(0,3).map(Number);p.weapon=m.weapon||null;p.aiming=!!m.aiming;p.crouch=!!m.crouch;p.sprint=!!m.sprint;p.move=Number(m.move)||0;p.thirdPerson=!!m.thirdPerson;p.emote=typeof m.emote==='string'?m.emote:null;p.invisible=!!m.invisible;
 const room=rooms.get(p.room);
 if(room?.started&&room.mode==='ctf'&&p.alive!==false){
   if(!room.flags)room.flags={blueCarrier:null,redCarrier:null};
   if(!p.flagCarry){
     if(p.team==='blue'&&!room.flags.redCarrier&&dist(p.p,RED_BASE)<=CTF_PICKUP_RADIUS){
       p.flagCarry='red';room.flags.redCarrier=id;broadcastRoom(room.code,{type:'ctfNotice',text:p.name+' TOOK THE RED FLAG'});broadcastRoom(room.code,roomModeState(room));
     }else if(p.team==='red'&&!room.flags.blueCarrier&&dist(p.p,BLUE_BASE)<=CTF_PICKUP_RADIUS){
       p.flagCarry='blue';room.flags.blueCarrier=id;broadcastRoom(room.code,{type:'ctfNotice',text:p.name+' TOOK THE BLUE FLAG'});broadcastRoom(room.code,roomModeState(room));
     }
   }else{
     const capture=p.team==='blue'?BLUE_CAPTURE:RED_CAPTURE;
     if(dist(p.p,capture)<=CTF_CAPTURE_RADIUS){
       room[p.team]=(room[p.team]||0)+1;
       const carried=p.flagCarry;
       if(carried==='red')room.flags.redCarrier=null;else room.flags.blueCarrier=null;
       p.flagCarry=null;
       broadcastRoom(room.code,{type:'ctfNotice',text:p.name+' SCORED FOR '+p.team.toUpperCase()+'!'});
       broadcastRoom(room.code,roomModeState(room));checkWin(room);
     }
   }
 }
 broadcastRoom(p.room,{type:'state',player:playerState(id,p)},ws)
}
 else if(m.type==='fire')broadcastRoom(p.room,{type:'fire',id,weapon:m.weapon,start:m.start,dir:m.dir},ws)
 else if(m.type==='hit'&&players.has(m.target)){const target=players.get(m.target);if(target.room!==p.room)return;const room=rooms.get(p.room);if(room&&room.mode!=='solo'&&room.mode!=='br'&&p.team&&target.team===p.team)return;const weapon=String(m.weapon||''),dmg=damageByWeapon[weapon]||12;if(meleeWeapons.has(weapon)){if(p.weapon!==weapon)return;const now=Date.now();if(weapon!=='fists'){if(now-(p.lastMelee||0)<150)return;p.lastMelee=now}const d=Math.hypot(target.p[0]-p.p[0],target.p[1]-p.p[1],target.p[2]-p.p[2]);const reach=weapon==='knife'?2.6:weapon==='fists'?2.3:weapon==='lifesteal'?2.45:weapon==='bat'?3.1:weapon==='sword'?3.2:3.35;if(d>reach)return}if(target.health>0){const before=target.health+(target.shield||0);damagePlayer(m.target,target,dmg,id,meleeWeapons.has(weapon));const dealt=Math.max(0,before-(target.health+(target.shield||0)));if(weapon==='lifesteal'&&dealt>0){p.health=Math.min(100,p.health+dealt);sendVitals(id,p)}}}
 else if(m.type==='marker'&&Array.isArray(m.p)){const kind=String(m.kind||'');if(['airstrike','supply','nuke'].includes(kind))broadcastRoom(p.room,{type:'marker',source:id,kind,p:m.p.slice(0,3).map(Number)},ws)}
 else if(m.type==='heal'){const targetId=(m.target&&players.has(m.target))?m.target:id,target=players.get(targetId);if(!target||target.room!==p.room||target.health<=0)return;const amt=Math.max(0,Math.min(50,Number(m.amount)||0));target.health=Math.min(100,target.health+amt);sendVitals(targetId,target);broadcastRoom(p.room,{type:'healFx',id:targetId,style:m.fx==='drip'?'drip':'burst'})}
 else if(m.type==='healBomb'&&Array.isArray(m.p)){const hp=m.p.slice(0,3).map(Number),amount=Math.max(0,Math.min(50,Number(m.amount)||40)),radius=Math.max(1,Math.min(10,Number(m.radius)||6));for(const[pid,t]of roomMembers(p.room)){if(t.health<=0)continue;const room=rooms.get(p.room);if(room&&room.mode!=='solo'&&room.mode!=='br'&&p.team&&t.team!==p.team)continue;const d=Math.hypot(t.p[0]-hp[0],t.p[1]-hp[1],t.p[2]-hp[2]);if(d<radius){t.health=Math.min(100,t.health+amount);sendVitals(pid,t);broadcastRoom(p.room,{type:'healFx',id:pid,style:'burst'})}}broadcastRoom(p.room,{type:'effectExplosion',source:id,p:hp,kind:'healbomb',amount,radius},ws)}
 else if(m.type==='shockwave'&&Array.isArray(m.p)){const sp=m.p.slice(0,3).map(Number),radius=6.2;for(const[pid,t]of roomMembers(p.room)){if(pid===id||t.health<=0)continue;const room=rooms.get(p.room);if(room&&room.mode!=='solo'&&room.mode!=='br'&&p.team&&t.team===p.team)continue;const d=Math.hypot(t.p[0]-sp[0],t.p[1]-sp[1],t.p[2]-sp[2]);if(d<radius&&Date.now()>=(t.invulnUntil||0)){damagePlayer(pid,t,40,id,true);send(clients.get(pid),{type:'impulse',id:pid,vv:26})}}broadcastRoom(p.room,{type:'effectExplosion',source:id,p:sp,kind:'shockwave'},ws)}
 else if(m.type==='gravity'&&Array.isArray(m.p))broadcastRoom(p.room,{type:'gravity',source:id,p:m.p.slice(0,3).map(Number)},ws)
 else if(m.type==='setTotem'&&Array.isArray(m.p)){p.totem=m.p.slice(0,3).map(Number);broadcastRoom(p.room,{type:'totem',id,p:p.totem})}
 else if(m.type==='totemHeal'){if(p.totem&&p.health>0){const mag=Math.hypot(...p.p)||1,fx=p.p[0]/mag*WORLD_R,fy=p.p[1]/mag*WORLD_R,fz=p.p[2]/mag*WORLD_R,d=Math.hypot(fx-p.totem[0],fy-p.totem[1],fz-p.totem[2]);if(d<1.65){if(p.health<100)p.health=Math.min(100,p.health+3);else p.shield=Math.min(30,(p.shield||0)+3);sendVitals(id,p);broadcastRoom(p.room,{type:'healFx',id,style:'drip'})}}}
 else if(m.type==='emote'){const ok=new Set(['wave','dance','cheer','point']);p.emote=ok.has(m.emote)?m.emote:null;broadcastRoom(p.room,{type:'state',player:playerState(id,p)},ws)}
 else if(m.type==='explode'&&Array.isArray(m.p)){const ep=m.p.slice(0,3).map(Number),kind=String(m.kind||'grenade');if(kind==='smoke'||kind==='flashbang')broadcastRoom(p.room,{type:'effectExplosion',source:id,p:ep,kind},ws);else{const radius=kind==='nuke'?15.5:kind==='airbomb'?5:5.2,maxDamage=kind==='nuke'?520:kind==='airbomb'?115:125;for(const[pid,t]of roomMembers(p.room)){if(t.health<=0)continue;const room=rooms.get(p.room);if(room&&room.mode!=='solo'&&room.mode!=='br'&&p.team&&t.team===p.team&&pid!==id)continue;const d=Math.hypot(t.p[0]-ep[0],t.p[1]-ep[1],t.p[2]-ep[2]);if(d<radius)damagePlayer(pid,t,maxDamage*Math.pow(1-d/radius,kind==='nuke'?.72:1.25),id,true)}broadcastRoom(p.room,{type:'effectExplosion',source:id,p:ep,kind},ws)}}
 else if(m.type==='respawn'){const room=rooms.get(p.room);if(room?.mode==='br'&&p.alive===false)return;p.health=100;p.shield=0;p.invulnUntil=Date.now()+4000;p.alive=true;if(room&&(room.mode==='hotzone'||room.mode==='ctf'))p.p=nearBase(p.team==='blue'?BLUE_BASE:RED_BASE,Math.floor(Math.random()*4));else if(Array.isArray(m.p))p.p=m.p.slice(0,3).map(Number);sendVitals(id,p);send(ws,{type:'serverPosition',p:p.p})}
}

function parseFrames(socket,chunk){socket._wsbuf=Buffer.concat([socket._wsbuf||Buffer.alloc(0),chunk]);while(socket._wsbuf.length>=2){const b=socket._wsbuf,b0=b[0],b1=b[1],opcode=b0&15,masked=!!(b1&128);let len=b1&127,off=2;if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4}else if(len===127){if(b.length<10)return;const n=b.readBigUInt64BE(2);if(n>BigInt(Number.MAX_SAFE_INTEGER))return socket.destroy();len=Number(n);off=10}const maskLen=masked?4:0;if(b.length<off+maskLen+len)return;let mask=null;if(masked){mask=b.subarray(off,off+4);off+=4}const payload=Buffer.from(b.subarray(off,off+len));if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];socket._wsbuf=b.subarray(off+len);if(opcode===8){socket.end();return}if(opcode===9){socket.write(Buffer.concat([Buffer.from([0x8a,payload.length]),payload]));continue}if(opcode===1)handleMessage(socket,payload.toString('utf8'))}}

setInterval(()=>{for(const room of rooms.values()){if(room.brQueue&&!room.started&&room.queueEnds){if(Date.now()>=room.queueEnds&&roomMembers(room.code).length>=2)startMatch(room);else sendBRQueue(room)}}},1000);

setInterval(()=>{for(const room of rooms.values()){
 if(!room.started||room.mode!=='hotzone')continue;let blue=0,red=0;
 for(const[,p]of roomMembers(room.code)){if(p.health<=0||p.alive===false)continue;if(dist(p.p,HOTZONE)<HOTZONE_RADIUS){if(p.team==='blue')blue++;if(p.team==='red')red++;}}
 room.contested=blue>0&&red>0;room.zoneOwner=null;
 if(blue>0&&red===0){room.blue=Math.min(100,(room.blue||0)+1);room.zoneOwner='blue'}
 else if(red>0&&blue===0){room.red=Math.min(100,(room.red||0)+1);room.zoneOwner='red'}
 broadcastRoom(room.code,roomModeState(room));checkWin(room);
}},1000);

const server=http.createServer((req,res)=>{
 if(req.url==='/health'||req.url==='/version'){
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
   return res.end(JSON.stringify({ok:true,build:'account-v4',accountFile:path.basename(ACCOUNT_FILE),accounts:Object.keys(accounts).length}));
 }
 let url=req.url.split('?')[0];if(url==='/'||url==='/index.html')url='/game.html';const rel=path.normalize(url).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/,'');const file=path.join(ROOT,rel);if(!file.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden')}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}const ext=path.extname(file),types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.txt':'text/plain'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)})});

server.on('upgrade',(req,socket)=>{const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return}const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const id='P'+nextId++,p={name:id,room:null,kills:0,p:randomPoint(),f:[0,0,-1],u:[0,1,0],weapon:null,aiming:false,crouch:false,sprint:false,move:0,thirdPerson:false,health:100,shield:0,invulnUntil:Date.now()+4000,totem:null,emote:null,invisible:false,lastMelee:0,team:null,teamLocked:false,flagCarry:null,cosmetics:{},accountKey:null,brRewarded:false,alive:true};socket._playerId=id;socket._wsbuf=Buffer.alloc(0);players.set(id,p);clients.set(id,socket);send(socket,{type:'connected',id,protocol:'account-v4'});const cleanup=()=>{if(clients.get(id)!==socket)return;const code=p.room;leaveCurrentRoom(id);players.delete(id);clients.delete(id);if(code&&rooms.has(code)){const room=rooms.get(code);if(room&&!room.started)sendLobby(room)}};socket.on('data',c=>parseFrames(socket,c));socket.on('close',cleanup);socket.on('end',cleanup);socket.on('error',cleanup)});

server.listen(PORT,'0.0.0.0',()=>console.log(`Spherical Battlefield lobby server running on http://localhost:${PORT}`));
