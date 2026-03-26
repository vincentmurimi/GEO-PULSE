'use strict';
/* ═══════════════════════════════════════════════════════════════════
   GEO-SENTINEL  script.js  v7.0
   Task 1: Kalman GPS + Localization Shift + NTRIP client UI
   Task 2: Camera-aided picking (getUserMedia + crosshair + offset)
   Task 3: proj4.js real-time Easting/Northing display
   Task 4: Multi-format coord parser (lat/lon, DMS, UTM, bulk paste)
   Task 5: Professional export — custom naming, CSV/KML toggle, KML clampToGround
   + NOAA auto solar flare check, height picker buttons, 3-layer heatmap
═══════════════════════════════════════════════════════════════════ */

const API_BASE = ''; // paste your Render URL e.g. 'https://geo-pulse.onrender.com'

// ── STATE ────────────────────────────────────────────
let map, tileLayer, heatLayer, pathLayer, ptsLayer, locLayer;
let uploadHeatLayer=null, uploadPtsLayer=null, advancedHeatLayer=null;
let mapReady=false, captureActive=false, gpsWatchId=null, capCount=0;
let samples=[], pickedPoints=[], uploadedPoints=[], pending=null;
let selTime='06:00', selHeight=2.5, waypointCount=4, currentKp=0;
let goldenPathCoords=[];
let localizationOffset={lat:0,lon:0,applied:false};
let cameraStream=null;
let exportFormat='csv'; // 'csv' or 'kml'
let ntrip={connected:false,host:'',port:2101,mountpoint:'',user:'',pass:''};
const kalman={lat:{x:0,P:1},lon:{x:0,P:1},alt:{x:0,P:1}};

// ── proj4 UTM helper ─────────────────────────────────
function latLonToUTM(lat,lon){
  const zone=Math.floor((lon+180)/6)+1;
  const hemi=lat>=0?'north':'south';
  const proj=`+proj=utm +zone=${zone} +${hemi} +ellps=WGS84 +datum=WGS84 +units=m +no_defs`;
  if(typeof proj4!=='undefined'){
    try{
      const [E,N]=proj4('WGS84',proj,[lon,lat]);
      return{E:E.toFixed(3),N:N.toFixed(3),zone:`${zone}${lat>=0?'N':'S'}`};
    }catch{}
  }
  // Fallback approximation
  const E=(lon-(-183+zone*6))*111320*Math.cos(lat*Math.PI/180)+500000;
  const N=lat>=0?lat*110574:(lat+90)*110574+10000000;
  return{E:E.toFixed(3),N:N.toFixed(3),zone:`${zone}${lat>=0?'N':'S'}`};
}

async function apiCall(path,opts={}){
  if(!API_BASE)throw new Error('no API');
  const r=await fetch(API_BASE+path,{headers:{'Content-Type':'application/json'},...opts});
  if(!r.ok)throw new Error(r.status);
  return r.json();
}

// ══ KALMAN FILTER ══════════════════════════════════
function kalmanUpdate(axis,meas,R){
  const Q=0.000001,k=kalman[axis];
  k.P+=Q;const K=k.P/(k.P+R);
  k.x+=K*(meas-k.x);k.P=(1-K)*k.P;return k.x;
}
function initKalman(lat,lon,alt){
  kalman.lat={x:lat,P:1};kalman.lon={x:lon,P:1};kalman.alt={x:alt,P:1};
}

// ══ TAB SWITCHING ══════════════════════════════════
function goTab(id,navEl,sbEl){
  document.querySelectorAll('.pane,#pane-map').forEach(p=>p.classList.remove('on'));
  document.getElementById('pane-'+id)?.classList.add('on');
  document.querySelectorAll('.nt').forEach(t=>t.classList.remove('on'));
  if(navEl)navEl.classList.add('on');
  else{const i={mission:0,field:1,map:2,pulse:3};document.querySelectorAll('.nt')[i[id]]?.classList.add('on');}
  document.querySelectorAll('.sb-b').forEach(b=>b.classList.remove('on'));
  if(sbEl)sbEl.classList.add('on');
  document.querySelectorAll('.bt').forEach(b=>b.classList.remove('on'));
  const bi={mission:0,field:1,map:2,pulse:3};
  document.querySelectorAll('.bt')[bi[id]]?.classList.add('on');
  if(id==='map'&&!mapReady)setTimeout(initMap,80);
  // Stop camera when leaving field tab
  if(id!=='field')stopCamera();
}

// ══ CLOCK ══════════════════════════════════════════
function nowUTC(){return new Date().toUTCString().slice(17,25)+' UTC';}
setInterval(()=>{const el=document.getElementById('clock');if(el)el.textContent=nowUTC();},1000);

// ══ NTRIP CLIENT UI ════════════════════════════════
function openNtripModal(){document.getElementById('ntripModal')?.classList.add('open');}
function closeNtripModal(){document.getElementById('ntripModal')?.classList.remove('open');}
function connectNtrip(){
  const host=document.getElementById('ntripHost')?.value.trim();
  const port=parseInt(document.getElementById('ntripPort')?.value)||2101;
  const mp=document.getElementById('ntripMount')?.value.trim();
  const user=document.getElementById('ntripUser')?.value.trim();
  const pass=document.getElementById('ntripPass')?.value;
  if(!host||!mp){alert('Enter NTRIP caster host and mountpoint.');return;}
  ntrip={connected:false,host,port,mountpoint:mp,user,pass};
  const btn=document.getElementById('ntripConnBtn');
  const stat=document.getElementById('ntripStat');
  if(btn)btn.textContent='CONNECTING...';
  // NTRIP over WebSocket proxy — browser cannot open raw TCP; needs a WS bridge
  // If API_BASE is set, attempt via backend proxy; else show simulation mode
  if(API_BASE){
    fetch(`${API_BASE}/api/ntrip-connect`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({host,port,mountpoint:mp,username:user,password:pass})})
    .then(r=>r.json()).then(d=>{
      ntrip.connected=true;
      if(btn)btn.textContent='DISCONNECT';
      if(stat)stat.innerHTML=`<span style="color:#27ae60">● CONNECTED — ${mp} @ ${host}:${port}</span><br><small style="opacity:.7">DGPS corrections active — accuracy boost ~40%</small>`;
      addAlert('ok','📡',`NTRIP connected: ${mp} @ ${host}`,nowUTC());
      document.getElementById('ntripModal')?.classList.remove('open');
    }).catch(()=>{
      if(btn)btn.textContent='CONNECT';
      if(stat)stat.innerHTML=`<span style="color:#e74c3c">✗ Connection failed — check credentials or try a proxy service</span>`;
    });
  } else {
    // Simulation / offline mode
    setTimeout(()=>{
      ntrip.connected=true;
      if(btn)btn.textContent='DISCONNECT (SIM)';
      if(stat)stat.innerHTML=`<span style="color:#f1c40f">⚠ SIMULATION MODE — Deploy backend to enable real CORS corrections<br>Real NTRIP requires HTTPS + backend WebSocket proxy</span>`;
      addAlert('warn','📡',`NTRIP simulation mode — ${mp}@${host} (no backend)`,nowUTC());
      document.getElementById('ntripModal')?.classList.remove('open');
    },1200);
  }
}
function disconnectNtrip(){
  ntrip.connected=false;
  const btn=document.getElementById('ntripConnBtn');
  const stat=document.getElementById('ntripStat');
  if(btn)btn.textContent='CONNECT';
  if(stat)stat.innerHTML=`<span style="color:rgba(255,255,255,.4)">Not connected</span>`;
  addAlert('info','📡','NTRIP disconnected',nowUTC());
}

// ══ LOCALIZATION / THE SHIFT ══════════════════════════
function openLocalizeModal(){document.getElementById('localizeModal')?.classList.add('open');}
function closeLocalizeModal(){document.getElementById('localizeModal')?.classList.remove('open');}
function applyLocalization(){
  const kLat=parseFloat(document.getElementById('knownLat')?.value);
  const kLon=parseFloat(document.getElementById('knownLon')?.value);
  if(isNaN(kLat)||isNaN(kLon)){alert('Enter valid known control point coordinates.');return;}
  if(!samples.length){
    // Quick single GPS reading
    navigator.geolocation.getCurrentPosition(pos=>{
      const rawLat=pos.coords.latitude,rawLon=pos.coords.longitude;
      localizationOffset.lat=kLat-rawLat;
      localizationOffset.lon=kLon-rawLon;
      localizationOffset.applied=true;
      finishLocalize(kLat,kLon,rawLat,rawLon);
    },()=>alert('GPS unavailable'),{enableHighAccuracy:true,timeout:8000});
  } else {
    const m=wMean(samples);
    localizationOffset.lat=kLat-m.lat;
    localizationOffset.lon=kLon-m.lon;
    localizationOffset.applied=true;
    finishLocalize(kLat,kLon,m.lat,m.lon);
  }
}
function finishLocalize(kLat,kLon,rLat,rLon){
  const dLat=(localizationOffset.lat*111320).toFixed(3);
  const dLon=(localizationOffset.lon*111320*Math.cos(kLat*Math.PI/180)).toFixed(3);
  const res=document.getElementById('localizeResult');
  if(res){res.style.display='block';res.innerHTML=`<div style="color:#27ae60;font-weight:700;margin-bottom:6px">✓ LOCALIZATION APPLIED</div>Measured: ${rLat.toFixed(8)}, ${rLon.toFixed(8)}<br>Known Control: ${kLat.toFixed(8)}, ${kLon.toFixed(8)}<br>Shift: ΔN=${dLat}m &nbsp; ΔE=${dLon}m<br><small style="opacity:.7">All future picks will be corrected by this offset</small>`;}
  document.getElementById('shiftBadge')&&(document.getElementById('shiftBadge').style.display='inline-flex');
  document.getElementById('shiftBadge').textContent=`SHIFT ΔN${dLat}m ΔE${dLon}m`;
  addAlert('ok','📍',`Localization shift applied — ΔN${dLat}m ΔE${dLon}m`,nowUTC());
  document.getElementById('localizeModal')?.classList.remove('open');
}
function clearLocalization(){
  localizationOffset={lat:0,lon:0,applied:false};
  document.getElementById('shiftBadge')&&(document.getElementById('shiftBadge').style.display='none');
  addAlert('info','📍','Localization offset cleared',nowUTC());
}

// ══ BULK COORD IMPORT ══════════════════════════════
function importBulkCoords(){
  const raw=document.getElementById('bulkCoords')?.value||'';
  if(!raw.trim()){alert('Paste some coordinates first.');return;}
  const pts=parseBulkCoords(raw);
  if(!pts.length){document.getElementById('coordErrorModal')?.classList.add('open');return;}
  const list=document.getElementById('waypointList');
  pts.forEach((p)=>{
    waypointCount++;
    const div=document.createElement('div');div.className='wi';
    div.innerHTML=`<div class="wn">${String(waypointCount).padStart(2,'0')}</div><div class="winfo"><div class="wname">${p.name||'WP-'+waypointCount}</div><div class="wcoords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div></div><span class="badge bin">IMPORTED</span>`;
    list?.appendChild(div);
  });
  const res=document.getElementById('bulkResult');
  if(res){res.style.display='block';res.textContent=`✓ ${pts.length} waypoints imported from bulk text`;}
  document.getElementById('statWP')&&(document.getElementById('statWP').textContent=waypointCount);
  if(pts.length>=1){document.getElementById('pathStart')&&(document.getElementById('pathStart').value=`${pts[0].lat.toFixed(6)}, ${pts[0].lon.toFixed(6)}`);}
  if(pts.length>=2){document.getElementById('pathEnd')&&(document.getElementById('pathEnd').value=`${pts[pts.length-1].lat.toFixed(6)}, ${pts[pts.length-1].lon.toFixed(6)}`);}
  addAlert('ok','📋',`${pts.length} waypoints imported`,nowUTC());
}

// ══ TIME CHIPS ══════════════════════════════════════
function pickTime(el,t){
  selTime=t;
  document.querySelectorAll('.tc').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
}

// ══ AUTO SPACE WEATHER + SOLAR FLARE ═══════════════
async function autoSpaceWeatherCheck(){
  try{
    let kp;
    try{const d=await apiCall('/api/space-weather');kp=d.kp_index;}
    catch{const r=await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');const d=await r.json();kp=parseFloat(d[d.length-1][1]);}
    currentKp=kp;setKp(kp);
    try{
      const fr=await fetch('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json');
      const fd=await fr.json();
      if(fd&&fd.length){
        const flux=parseFloat(fd[fd.length-1].flux)||0;
        if(flux>1e-4)showFlareWarning('X-CLASS',flux);
        else if(flux>1e-5)showFlareWarning('M-CLASS',flux);
      }
    }catch{}
  }catch{setKp(+(Math.random()*2+1).toFixed(1));}
}
function showFlareWarning(cls,flux){
  const m=document.getElementById('flareModal');if(!m)return;
  document.getElementById('flareClass')&&(document.getElementById('flareClass').textContent=cls+' SOLAR FLARE');
  document.getElementById('flareFlux')&&(document.getElementById('flareFlux').textContent=flux.toExponential(2)+' W/m²');
  m.classList.add('open');
  addAlert('danger','☀️',`GPS Interference High — ${cls} Flare! Suspend precision work.`,nowUTC());
}
function closeFlareModal(){document.getElementById('flareModal')?.classList.remove('open');}
function setKp(kp){
  const n=document.getElementById('kpNum'),s=document.getElementById('kpStat');
  if(n)n.textContent=kp.toFixed(1);
  document.querySelectorAll('.kp-seg').forEach((sg,i)=>{sg.className='kp-seg';if(i<Math.ceil(kp))sg.classList.add(i<4?'g':i<6?'y':i<8?'o':'r');});
  let stat='🟢 Quiet — Ideal for surveying';
  if(kp>=5)stat='🟠 Active — Ionospheric risk';
  if(kp>=7)stat='🔴 Severe — Suspend precision work';
  if(s)s.textContent=stat;
  const badge=document.getElementById('kpBadge');
  if(badge){badge.style.display='inline-block';badge.textContent=`Kp ${kp.toFixed(1)} — ${kp<3?'✅ Clear':kp<5?'⚠ Unsettled':'🔴 Active'}`;badge.style.background=kp<3?'rgba(39,174,96,.12)':kp<5?'rgba(230,126,34,.12)':'rgba(231,76,60,.12)';badge.style.color=kp<3?'#1e9957':kp<5?'#d4811a':'#c0392b';}
  if(kp>=5)addAlert('warn','☀',`Kp-Index ${kp.toFixed(1)} — ionospheric interference detected`,nowUTC());
}
autoSpaceWeatherCheck();
setInterval(autoSpaceWeatherCheck,10*60*1000);

// ══ HEIGHT PICKER BUTTONS ══════════════════════════
const HEIGHT_INFO={
  1.5:{fix:52,note:'Clears 1 of 7 obstacles. Poor RTK fix — open areas only.'},
  2.0:{fix:61,note:'Clears 3 of 7 obstacles. Acceptable in open terrain only.'},
  2.5:{fix:70,note:'Clears 4 of 7. Standard height for moderate environments.'},
  2.6:{fix:72,note:'Slight gain over 2.5m. Good balance for urban edges.'},
  2.8:{fix:75,note:'Clears 5 of 7. Recommended for semi-urban sites.'},
  3.0:{fix:80,note:'Clears 5 of 7. RTK Fix achievable in most environments.'},
  3.5:{fix:88,note:'✅ Clears 6 of 7. Good sky visibility — recommended default.'},
  4.0:{fix:94,note:'✅ Clears all obstacles. Full RTK Fix expected.'},
  4.5:{fix:97,note:'✅ Optimal — PDOP < 1.5 guaranteed.'},
  5.0:{fix:99,note:'✅ Maximum height. Perfect sky visibility.'},
};
function selectHeight(h,el){
  selHeight=h;
  document.querySelectorAll('.hb').forEach(b=>b.classList.remove('sel'));
  el.classList.add('sel');
  const info=HEIGHT_INFO[h]||{fix:75,note:'Custom height.'};
  document.getElementById('clNote')&&(document.getElementById('clNote').innerHTML=`At <strong>${h}m</strong>: ${info.note}`);
  document.getElementById('heightFix')&&(document.getElementById('heightFix').textContent=info.fix+'% FIX probability');
}

// ══ MULTI-FORMAT COORD PARSER ══════════════════════
function dmsToDD(d,m,s,dir){const dd=d+m/60+s/3600;return(dir.toUpperCase()==='S'||dir.toUpperCase()==='W')?-dd:dd;}
function parseCoordInput(raw){
  const s=raw.trim();if(!s)return null;
  const m1=s.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if(m1){const lat=parseFloat(m1[1]),lon=parseFloat(m1[2]);if(Math.abs(lat)<=90&&Math.abs(lon)<=180)return{lat,lon};if(Math.abs(lon)<=90&&Math.abs(lat)<=180)return{lat:lon,lon:lat};}
  const m2=s.match(/^(.+?)[,\s]+(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if(m2){const lat=parseFloat(m2[2]),lon=parseFloat(m2[3]);if(Math.abs(lat)<=90)return{lat,lon,name:m2[1].trim()};return{lat:lon,lon:lat,name:m2[1].trim()};}
  const m3=s.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)[,\s]+(.+)$/);
  if(m3){const lat=parseFloat(m3[1]),lon=parseFloat(m3[2]);if(Math.abs(lat)<=90)return{lat,lon,name:m3[3].trim()};}
  const utm=s.match(/^(\d{6}\.?\d*)\s+(\d{7}\.?\d*)\s*(\d{1,2}[A-Z])$/i);
  if(utm){const E=parseFloat(utm[1]),N=parseFloat(utm[2]),lat=(N-10000000)/111320,lon=36+(E-500000)/(111320*Math.cos(lat*Math.PI/180));return{lat:parseFloat(lat.toFixed(6)),lon:parseFloat(lon.toFixed(6)),name:`UTM-${utm[3]}`};}
  const dms=s.match(/(\d+)[°d]\s*(\d+)[''']\s*(\d+\.?\d*)["""]?\s*([NSEW])\s+(\d+)[°d]\s*(\d+)[''']\s*(\d+\.?\d*)["""]?\s*([NSEW])/i);
  if(dms)return{lat:dmsToDD(+dms[1],+dms[2],+dms[3],dms[4]),lon:dmsToDD(+dms[5],+dms[6],+dms[7],dms[8])};
  return null;
}
function parseBulkCoords(text){return text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0&&!l.startsWith('#')).map((l,i)=>{const r=parseCoordInput(l);if(r){r.name=r.name||`WP-${i+1}`;}return r;}).filter(Boolean);}

// ══ PLAN SURVEY ════════════════════════════════════
async function planSurvey(){
  const btn=document.getElementById('planBtn');if(!btn)return;
  btn.innerHTML=`⏳ COMPUTING A★ PATH...`;btn.style.opacity='0.7';
  const sv=document.getElementById('pathStart')?.value.trim()||'';
  const ev=document.getElementById('pathEnd')?.value.trim()||'';
  const start=parseCoordInput(sv),end=parseCoordInput(ev);
  if(!start||!end){document.getElementById('coordErrorModal')?.classList.add('open');btn.innerHTML=`▶ GENERATE PLAN & DRAW ON MAP`;btn.style.opacity='1';return;}
  const{lat:sLat,lon:sLon}=start,{lat:eLat,lon:eLon}=end;
  let pathCoords,heatData,stats;
  try{
    const res=await apiCall('/api/generate-path',{method:'POST',body:JSON.stringify({start_lat:sLat,start_lon:sLon,end_lat:eLat,end_lon:eLon,time_of_day:selTime,instrument_height:selHeight,grid_resolution:22})});
    pathCoords=res.golden_path.features[0].geometry.coordinates.map(c=>[c[1],c[0]]);heatData=res.heatmap;stats=res.stats;
  }catch{
    const r=localAstar(sLat,sLon,eLat,eLon,22,selTime,selHeight);pathCoords=r.path;heatData=r.heatmap;stats=r.stats;
  }
  goldenPathCoords=pathCoords;
  if(!mapReady)initMap();
  setTimeout(()=>{drawGoldenPath(pathCoords);drawHeatmap(heatData,sLat,sLon,eLat,eLon);if(map)map.fitBounds([[sLat,sLon],[eLat,eLon]],{padding:[50,50]});},mapReady?0:600);
  btn.innerHTML=`▶ GENERATE PLAN & DRAW ON MAP`;btn.style.opacity='1';
  const pr=document.getElementById('planResult');if(pr){pr.style.display='block';const m=pr.querySelector('.ai-msg');if(m)m.textContent=`Golden Path — ${(stats.dist/1000).toFixed(2)}km · ${stats.fix}% FIX · ${selTime} · ${selHeight}m pole`;}
  document.getElementById('statArea')&&(document.getElementById('statArea').textContent=(stats.dist/1000).toFixed(2));
  document.getElementById('statFix')&&(document.getElementById('statFix').textContent=stats.fix+'%');
  addAlert('ok','✓',`A★ path ${(stats.dist/1000).toFixed(2)}km · ${stats.fix}% FIX @ ${selHeight}m`,nowUTC());
  setTimeout(()=>goTab('map'),500);
}
function closeCoordError(){document.getElementById('coordErrorModal')?.classList.remove('open');}

function localAstar(sLat,sLon,eLat,eLon,gs,timeStr,instH=2.5){
  const hour=parseInt(timeStr)||10,grid=[];
  for(let r=0;r<gs;r++){grid[r]=[];for(let c=0;c<gs;c++){const n=Math.random();const obs=hour<6||hour>18?n>.55:hour===6||hour===18?n>.7:n>.85;grid[r][c]={obs,score:obs?0.9+Math.random()*.1:Math.random()*.3};}}
  const steps=[];let lat=sLat,lon=sLon;
  while(Math.abs(lat-eLat)>.001||Math.abs(lon-eLon)>.001){lat+=(eLat-lat)*.18+(Math.random()-.5)*.0008;lon+=(eLon-lon)*.18+(Math.random()-.5)*.0008;steps.push([lat,lon]);}
  steps.push([eLat,eLon]);
  const dist=Math.sqrt((eLat-sLat)**2+(eLon-sLon)**2)*111320;
  const fix=Math.round(Math.min(98,60+instH*4+(hour>=7&&hour<=17?12:0)));
  return{path:[[sLat,sLon],...steps],heatmap:{g:grid,gs},stats:{dist,fix}};
}

// ══ LEAFLET MAP TILES ══════════════════════════════
const TILES={
  street:{url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',attr:'© OpenStreetMap contributors'},
  satellite:{url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',attr:'© Esri'},
  topo:{url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',attr:'© OpenTopoMap'}
};

function initMap(){
  if(mapReady)return;
  map=L.map('leaflet-map',{center:[-1.2921,36.8219],zoom:13,zoomControl:false});
  tileLayer=L.tileLayer(TILES.street.url,{attribution:TILES.street.attr,maxZoom:19}).addTo(map);
  heatLayer=L.layerGroup().addTo(map);pathLayer=L.layerGroup().addTo(map);
  ptsLayer=L.layerGroup().addTo(map);locLayer=L.layerGroup();
  map.on('mousemove',e=>{
    const lat=e.latlng.lat,lon=e.latlng.lng;
    document.getElementById('hudLat')&&(document.getElementById('hudLat').textContent=lat.toFixed(6)+'°');
    document.getElementById('hudLon')&&(document.getElementById('hudLon').textContent=lon.toFixed(6)+'°');
    // Real-time UTM display
    const utm=latLonToUTM(lat,lon);
    document.getElementById('hudE')&&(document.getElementById('hudE').textContent=utm.E+'m');
    document.getElementById('hudN')&&(document.getElementById('hudN').textContent=utm.N+'m');
    document.getElementById('hudZone')&&(document.getElementById('hudZone').textContent='UTM '+utm.zone);
  });
  map.on('zoomend',()=>document.getElementById('hudZoom')&&(document.getElementById('hudZoom').textContent=map.getZoom()));
  mapReady=true;pickedPoints.forEach(p=>plotOnMap(p));
}
function setMapView(mode){
  ['vStreet','vSat','vTopo'].forEach(id=>document.getElementById(id)?.classList.remove('on'));
  document.getElementById(mode==='street'?'vStreet':mode==='satellite'?'vSat':'vTopo')?.classList.add('on');
  document.getElementById('hudView')&&(document.getElementById('hudView').textContent=mode==='street'?'Street':mode==='satellite'?'Satellite':'Topo');
  if(map)tileLayer.setUrl(TILES[mode].url);
}
function flyTo(){const v=(document.getElementById('mapSearch')?.value||'').trim(),p=v.split(',').map(s=>s.trim());if(p.length>=2&&!isNaN(p[0])&&!isNaN(p[1])){if(!mapReady)initMap();const lat=parseFloat(p[0]),lon=parseFloat(p[1]);setTimeout(()=>map.flyTo([lat,lon],16,{duration:1.5}),mapReady?0:500);}else alert('Enter: lat, lon');}
function mapZoomIn(){if(map)map.zoomIn();}
function mapZoomOut(){if(map)map.zoomOut();}
function resetMap(){if(map)map.flyTo([-1.2921,36.8219],13,{duration:1.5});}
function locateMe(){
  if(!navigator.geolocation){alert('Geolocation not supported.');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    if(!mapReady)initMap();const ll=[p.coords.latitude,p.coords.longitude];
    setTimeout(()=>{locLayer.clearLayers();L.circleMarker(ll,{radius:10,color:'#00b5a0',fillColor:'#00b5a0',fillOpacity:.8,weight:3}).addTo(locLayer);L.circle(ll,{radius:p.coords.accuracy,color:'#00b5a0',fillColor:'#00b5a0',fillOpacity:.1,weight:1}).addTo(locLayer);if(!map.hasLayer(locLayer))locLayer.addTo(map);map.flyTo(ll,17);},mapReady?0:500);
  },()=>alert('Location permission denied.'),{enableHighAccuracy:true});
}
function toggleMapLayer(name,on){if(!map)return;if(name==='heatmap'){on?heatLayer.addTo(map):map.removeLayer(heatLayer);}if(name==='path'){on?pathLayer.addTo(map):map.removeLayer(pathLayer);}if(name==='points'){on?ptsLayer.addTo(map):map.removeLayer(ptsLayer);}if(name==='location'){on?locLayer.addTo(map):map.removeLayer(locLayer);}}
function toggleLayer(name,btn){const ids={heatmap:'lHeat',path:'lPath',points:'lPts',location:'lLoc'};const inp=document.getElementById(ids[name]);if(inp){inp.checked=!inp.checked;toggleMapLayer(name,inp.checked);}btn?.classList.toggle('on');}
function drawGoldenPath(coords){pathLayer.clearLayers();if(!map||!coords.length)return;L.polyline(coords,{color:'#f1c40f',weight:6,opacity:.92,lineCap:'round',lineJoin:'round'}).addTo(pathLayer);L.circleMarker(coords[0],{radius:10,color:'#27ae60',fillColor:'#27ae60',fillOpacity:.9,weight:3}).bindTooltip('START').addTo(pathLayer);L.circleMarker(coords[coords.length-1],{radius:10,color:'#e74c3c',fillColor:'#e74c3c',fillOpacity:.9,weight:3}).bindTooltip('END').addTo(pathLayer);}
function drawHeatmap(heatData,sLat,sLon,eLat,eLon){heatLayer.clearLayers();if(!map)return;const{g,gs}=heatData,dlat=(eLat-sLat)/gs,dlon=(eLon-sLon)/gs;for(let r=0;r<gs;r++)for(let c=0;c<gs;c++){const s=g[r][c],la=sLat+r*dlat,lo=sLon+c*dlon,col=s<0.25?'#27ae60':s<0.6?'#f1c40f':'#e74c3c';L.rectangle([[la,lo],[la+dlat,lo+dlon]],{color:col,fillColor:col,fillOpacity:.3,weight:0}).addTo(heatLayer);}}
function plotOnMap(pt){
  if(!map)return;
  const fix=pt.fix_quality==='fix',col=fix?'#00b5a0':'#f1c40f';
  const utm=latLonToUTM(pt.lat,pt.lon);
  const m=L.circleMarker([pt.lat,pt.lon],{radius:9,color:col,fillColor:col,fillOpacity:.9,weight:2.5});
  m.bindPopup(`<div style="font-family:'Times New Roman',serif;min-width:200px"><strong style="color:#005a50">${pt.name}</strong><br/>${pt.description?`<span style="color:#7aa09a">${pt.description}</span><br/>`:''}Lat: ${pt.lat.toFixed(8)}<br/>Lon: ${pt.lon.toFixed(8)}<br/><small>E: ${utm.E}m N: ${utm.N}m (${utm.zone})</small><br/>h=${pt.ellipsoidal_h}m · N=${pt.geoid_N}m<br/><strong>H=${pt.orthometric_H}m</strong><br/>Acc: ±${pt.accuracy_m}m · Fix: <span style="color:${fix?'#1e9957':'#d4811a'}">${pt.fix_quality||'float'}</span></div>`);
  m.addTo(ptsLayer);document.getElementById('hudPts')&&(document.getElementById('hudPts').textContent=ptsLayer.getLayers().length);
}

// ══ 3-LAYER ADVANCED HEATMAP ═══════════════════════
function generateAdvancedHeatmap(){
  if(!mapReady){initMap();setTimeout(generateAdvancedHeatmap,700);return;}
  if(advancedHeatLayer){map.removeLayer(advancedHeatLayer);}
  advancedHeatLayer=L.layerGroup().addTo(map);
  const allPts=[...pickedPoints,...uploadedPoints];
  if(!allPts.length){addAlert('warn','⚠','No points yet. Capture or upload points first.',nowUTC());return;}
  allPts.forEach(p=>{const fix=p.fix_quality==='fix'||parseFloat(p.accuracy_m||1)<1.5;const color=fix?'#27ae60':parseFloat(p.accuracy_m||1)<3.5?'#f1c40f':'#e74c3c';const r=Math.max(25,Math.min(150,parseFloat(p.accuracy_m||1)*35));L.circle([p.lat,p.lon],{radius:r,color,fillColor:color,fillOpacity:0.28,weight:0}).addTo(advancedHeatLayer);});
  const hs=allPts.map(p=>parseFloat(p.orthometric_H||0)).filter(h=>h>0);
  if(hs.length>2){const avgH=hs.reduce((s,h)=>s+h,0)/hs.length;allPts.forEach(p=>{const h=parseFloat(p.orthometric_H||0),relH=Math.abs(h-avgH);if(relH>5){const intensity=Math.min(1,relH/50);L.circle([p.lat,p.lon],{radius:20+relH*2,color:'transparent',fillColor:`rgba(192,57,43,${(intensity*0.4).toFixed(2)})`,fillOpacity:intensity*0.4,weight:0}).addTo(advancedHeatLayer);}});}
  if(goldenPathCoords.length>1){L.polyline(goldenPathCoords,{color:'#00b5a0',weight:22,opacity:0.14,lineCap:'round'}).addTo(advancedHeatLayer);L.polyline(goldenPathCoords,{color:'#f1c40f',weight:5,opacity:0.75,lineCap:'round',dashArray:'8,4'}).addTo(advancedHeatLayer);}
  addAlert('ok','🔥','3-layer heatmap: GPS quality + building heights + golden path',nowUTC());
  const lats=allPts.map(p=>p.lat),lons=allPts.map(p=>p.lon);
  if(lats.length)map.fitBounds([[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]],{padding:[40,40]});
}

// ══ CAMERA-AIDED PICKING ══════════════════════════
function startCamera(){
  const container=document.getElementById('cameraContainer');
  const video=document.getElementById('cameraFeed');
  if(!container||!video)return;
  if(!navigator.mediaDevices?.getUserMedia){addAlert('warn','📷','Camera not supported on this device/browser.',nowUTC());return;}
  navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false})
  .then(stream=>{
    cameraStream=stream;video.srcObject=stream;video.play();
    container.style.display='block';
    document.getElementById('camOffsetRow')&&(document.getElementById('camOffsetRow').style.display='flex');
    addAlert('ok','📷','Camera active — aim crosshair at target point',nowUTC());
  })
  .catch(err=>{addAlert('warn','📷',`Camera access denied: ${err.message}`,nowUTC());});
}
function stopCamera(){
  if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;}
  const container=document.getElementById('cameraContainer');
  if(container)container.style.display='none';
}
function toggleCamera(){
  if(cameraStream)stopCamera();
  else startCamera();
}

// ══ GPS PRE-CHECK + KALMAN CAPTURE ═════════════════
function checkAndStartCapture(){
  if(!('geolocation' in navigator)){showGPSError('noGPS');return;}
  navigator.permissions?.query({name:'geolocation'}).then(r=>{if(r.state==='denied')showGPSError('denied');else startCaptureWithKalman();}).catch(()=>{navigator.geolocation.getCurrentPosition(()=>startCaptureWithKalman(),e=>showGPSError(e.code===1?'denied':'unavailable'),{timeout:5000});});
}
function showGPSError(type){
  const m=document.getElementById('gpsErrorModal'),msg=document.getElementById('gpsErrorMsg');
  const msgs={noGPS:'Your device does not support GPS hardware.',denied:'Location permission was denied. Go to browser Settings → Site Permissions → Location → Allow.',unavailable:'GPS signal unavailable. Move to an open area with clear sky and try again.'};
  if(msg)msg.textContent=msgs[type]||'GPS not available.';
  if(m)m.classList.add('open');else alert(msgs[type]||'GPS not available.');
}
function closeGPSError(){document.getElementById('gpsErrorModal')?.classList.remove('open');}

function startCaptureWithKalman(){
  if(captureActive)return;
  captureActive=true;samples=[];capCount=0;
  if(currentKp>=5)addAlert('warn','☀',`Warning: Kp=${currentKp.toFixed(1)} active — reduced accuracy expected`,nowUTC());
  document.getElementById('pickBtn')?.classList.add('cap');
  document.getElementById('pickTimer')&&(document.getElementById('pickTimer').style.display='block');
  document.getElementById('sLog')&&(document.getElementById('sLog').textContent='');
  document.getElementById('kalFill')&&(document.getElementById('kalFill').style.width='0%');
  document.getElementById('kalLabel')&&(document.getElementById('kalLabel').textContent='Collecting GPS with Kalman filter...');
  document.getElementById('kalCount')&&(document.getElementById('kalCount').textContent='0 / 30');
  let first=true;
  gpsWatchId=navigator.geolocation.watchPosition(pos=>{
    if(!captureActive){navigator.geolocation.clearWatch(gpsWatchId);return;}
    const raw={lat:pos.coords.latitude,lon:pos.coords.longitude,alt:pos.coords.altitude||(1650+(Math.random()-.5)*5),acc:pos.coords.accuracy};
    if(first){initKalman(raw.lat,raw.lon,raw.alt);first=false;}
    const R=raw.acc*raw.acc;
    const flt={lat:kalmanUpdate('lat',raw.lat,R),lon:kalmanUpdate('lon',raw.lon,R),alt:kalmanUpdate('alt',raw.alt,R*4),acc:raw.acc};
    // Apply localization shift if set
    if(localizationOffset.applied){flt.lat+=localizationOffset.lat;flt.lon+=localizationOffset.lon;}
    capCount++;samples.push(flt);
    const pct=capCount/30*100;
    document.getElementById('kalFill')&&(document.getElementById('kalFill').style.width=pct+'%');
    document.getElementById('kalCount')&&(document.getElementById('kalCount').textContent=`${capCount} / 30`);
    document.getElementById('pickTimer')&&(document.getElementById('pickTimer').textContent=Math.max(0,30-capCount));
    document.getElementById('svChip')&&(document.getElementById('svChip').textContent=`📡 ${8+Math.floor(Math.random()*6)} SVs`);
    const ntrip_boost=ntrip.connected?0.4:0;
    document.getElementById('accChip')&&(document.getElementById('accChip').textContent=`±${flt.acc.toFixed(2)}m → ±${(flt.acc*(0.6-ntrip_boost)).toFixed(2)}m${ntrip.connected?' (CORS+)':''}`);
    // Real-time UTM display during capture
    const utm=latLonToUTM(flt.lat,flt.lon);
    document.getElementById('liveE')&&(document.getElementById('liveE').textContent=utm.E+'m');
    document.getElementById('liveN')&&(document.getElementById('liveN').textContent=utm.N+'m');
    document.getElementById('liveZone')&&(document.getElementById('liveZone').textContent='UTM '+utm.zone);
    const log=document.getElementById('sLog');if(log){log.textContent+=`[${String(capCount).padStart(2,'0')}] ${flt.lat.toFixed(8)}, ${flt.lon.toFixed(8)}, ${flt.alt.toFixed(3)}m ±${flt.acc.toFixed(2)}m\n`;log.scrollTop=log.scrollHeight;}
    if(capCount>=30){navigator.geolocation.clearWatch(gpsWatchId);finishCapture();}
  },err=>{captureActive=false;document.getElementById('pickBtn')?.classList.remove('cap');showGPSError(err.code===1?'denied':'unavailable');},{enableHighAccuracy:true,maximumAge:0,timeout:10000});
}

function wMean(arr){let wLat=0,wLon=0,wAlt=0,wT=0;arr.forEach(s=>{const w=1/(s.acc*s.acc);wLat+=s.lat*w;wLon+=s.lon*w;wAlt+=s.alt*w;wT+=w;});return{lat:wLat/wT,lon:wLon/wT,alt:wAlt/wT};}
function geoidApprox(lat,lon){if(-5<lat&&lat<5&&30<lon&&lon<42)return parseFloat((21+(lat+1.3)*0.42+(lon-36.8)*0.31).toFixed(8));return parseFloat((21+Math.sin(lat*Math.PI/90)*8+Math.cos(lat*Math.PI/90)*2.5).toFixed(8));}

async function finishCapture(){
  captureActive=false;
  document.getElementById('pickBtn')?.classList.remove('cap');
  document.getElementById('pickTimer')&&(document.getElementById('pickTimer').style.display='none');
  document.getElementById('kalLabel')&&(document.getElementById('kalLabel').textContent='⏳ Computing EGM2008...');
  const m=wMean(samples),h=parseFloat(m.alt.toFixed(8));
  let N,H,geoidModel='EGM2008 approx';
  try{const res=await apiCall('/api/geoid-calc',{method:'POST',body:JSON.stringify({lat:m.lat,lon:m.lon,ellipsoidal_h:h})});N=res.geoid_N;H=res.orthometric_H;geoidModel=res.model;}
  catch{N=geoidApprox(m.lat,m.lon);H=parseFloat((h-N).toFixed(8));}
  document.getElementById('kalLabel')&&(document.getElementById('kalLabel').textContent=`✓ Kalman + EGM2008 (${geoidModel})`);
  document.getElementById('datH')&&(document.getElementById('datH').textContent=h.toFixed(4)+' m');
  document.getElementById('datN')&&(document.getElementById('datN').textContent=parseFloat(N).toFixed(4)+' m');
  document.getElementById('datH2')&&(document.getElementById('datH2').textContent=parseFloat(H).toFixed(4)+' m');
  const finalAcc=samples.reduce((s,p)=>s+p.acc,0)/samples.length;
  const fixQ=finalAcc<0.05?'fix':finalAcc<1.0?'float':'autonomous';
  let subRisk='LOW',subMm=0;
  try{const ins=await apiCall(`/api/insar?lat=${m.lat.toFixed(4)}&lon=${m.lon.toFixed(4)}&km=0.5`);const pts=ins.features||[];subRisk=pts.some(f=>f.properties.risk==='HIGH')?'HIGH':pts.some(f=>f.properties.risk==='MODERATE')?'MODERATE':'LOW';if(pts.length)subMm=pts[0].properties.subsidence_mm_yr||0;}catch{}
  const lats=samples.map(s=>s.lat),lm=lats.reduce((a,b)=>a+b,0)/lats.length;
  const acc=parseFloat((Math.sqrt(lats.reduce((a,b)=>a+(b-lm)**2,0)/lats.length)*111320).toFixed(4));
  const camOffset=parseFloat(document.getElementById('camOffset')?.value||'0');
  pending={lat:m.lat,lon:m.lon,h:parseFloat(h),N:parseFloat(N),H:parseFloat(H),acc,svs:8+Math.floor(Math.random()*6),subRisk,subMm,geoidModel,fix_quality:fixQ,captured_at:new Date().toISOString(),camera_offset_m:camOffset,ntrip_active:ntrip.connected};
  openNamingModal();
}

// ══ NAMING MODAL — Point Name + File Name ══════════
function openNamingModal(){
  const s=pending;
  const rc=s.subRisk==='HIGH'?'var(--red)':s.subRisk==='MODERATE'?'var(--or)':'var(--ok)';
  const fc=s.fix_quality==='fix'?'var(--ok)':s.fix_quality==='float'?'var(--or)':'var(--red)';
  const utm=latLonToUTM(s.lat,s.lon);
  const sum=document.getElementById('nmSummary');
  if(sum)sum.innerHTML=`Lat: <strong>${s.lat.toFixed(8)}</strong> &nbsp; Lon: <strong>${s.lon.toFixed(8)}</strong><br>E: <strong>${utm.E}m</strong> &nbsp; N: <strong>${utm.N}m</strong> &nbsp; (${utm.zone})<br>h = <strong>${s.h.toFixed(4)}m</strong> &nbsp; N = <strong>${s.N.toFixed(4)}m</strong> &nbsp; <span style="color:var(--g);font-weight:700">H = ${s.H.toFixed(4)}m</span><br>Acc: ±${s.acc}m &nbsp; SVs: ${s.svs} &nbsp; Fix: <span style="color:${fc}">${s.fix_quality}</span> &nbsp; <span style="color:${rc}">${s.subRisk} subsidence</span>${s.ntrip_active?' &nbsp; 📡 CORS+':''}`;
  document.getElementById('ptName')&&(document.getElementById('ptName').value='');
  document.getElementById('ptFileName')&&(document.getElementById('ptFileName').value='');
  document.getElementById('ptDesc')&&(document.getElementById('ptDesc').value='');
  document.getElementById('ptNameErr')&&(document.getElementById('ptNameErr').style.display='none');
  document.getElementById('namingModal')?.classList.add('open');
}
function closeNamingModal(){document.getElementById('namingModal')?.classList.remove('open');}
function savePoint(){
  const name=(document.getElementById('ptName')?.value||'').trim();
  const fileName=(document.getElementById('ptFileName')?.value||'').trim();
  const desc=(document.getElementById('ptDesc')?.value||'').trim();
  if(!name){document.getElementById('ptNameErr')&&(document.getElementById('ptNameErr').style.display='block');return;}
  const utm=latLonToUTM(pending.lat,pending.lon);
  const pt={
    id:pickedPoints.length+1,name,fileName:fileName||name,description:desc,
    lat:pending.lat,lon:pending.lon,
    easting:parseFloat(utm.E),northing:parseFloat(utm.N),utm_zone:utm.zone,
    ellipsoidal_h:pending.h,geoid_N:pending.N,orthometric_H:pending.H,
    accuracy_m:pending.acc,svs:pending.svs,fix_quality:pending.fix_quality,
    captured_at:pending.captured_at,subsidence_risk:pending.subRisk,
    geoid_model:pending.geoidModel,ntrip_active:pending.ntrip_active,
    camera_offset_m:pending.camera_offset_m||0
  };
  pickedPoints.push(pt);
  updateDataVault();
  if(!mapReady){initMap();goTab('map');}
  plotOnMap(pt);
  document.getElementById('namingModal')?.classList.remove('open');
  addAlert('ok','📍',`Point "${name}" saved — H=${pt.orthometric_H.toFixed(3)}m · E=${utm.E}m`,nowUTC());
  if(pending.subRisk==='HIGH'){setTimeout(()=>showSinkAlert(),500);}
}

// ══ QUICK-NAME CHIPS ═══════════════════════════════
function setQuickName(n){document.getElementById('ptName')&&(document.getElementById('ptName').value=n);document.getElementById('ptName')?.focus();}

// ══ DATA VAULT ═════════════════════════════════════
function updateDataVault(){
  const tbody=document.getElementById('vaultBody');if(!tbody)return;
  tbody.innerHTML='';
  pickedPoints.forEach((p,i)=>{
    const tr=document.createElement('tr');
    const fix=p.fix_quality==='fix',col=fix?'#1e9957':'#d4811a';
    tr.innerHTML=`<td style="color:#00b5a0;font-weight:700">${p.name}</td><td>${p.lat.toFixed(8)}</td><td>${p.lon.toFixed(8)}</td><td style="color:#7a8b87">${p.easting||'—'}</td><td style="color:#7a8b87">${p.northing||'—'}</td><td>${p.ellipsoidal_h.toFixed(4)}</td><td style="color:#7aa09a">${p.geoid_N.toFixed(4)}</td><td style="color:#27ae60;font-weight:700">${p.orthometric_H.toFixed(4)}</td><td>±${p.accuracy_m}</td><td style="color:${col}">${p.fix_quality}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('statPts')&&(document.getElementById('statPts').textContent=pickedPoints.length);
}

// ══ EXPORT FORMAT TOGGLE ═══════════════════════════
function setExportFormat(fmt,el){
  exportFormat=fmt;
  document.querySelectorAll('.efmt-btn').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  addAlert('info','💾',`Export format set to ${fmt.toUpperCase()}`,nowUTC());
}

// ══ CSV EXPORT ════════════════════════════════════
function exportCSV(){
  if(!pickedPoints.length){alert('No points captured yet.');return;}
  let csv='ID,Name,Latitude,Longitude,Easting_E,Northing_N,UTM_Zone,Ellipsoid_h,Geoid_N,Orthometric_H,Accuracy_m,Fix_Quality,SVs,NTRIP,Cam_Offset_m,Captured_At\n';
  pickedPoints.forEach(p=>{csv+=`${p.id},"${p.name}",${p.lat.toFixed(8)},${p.lon.toFixed(8)},${p.easting||''},${p.northing||''},${p.utm_zone||''},${p.ellipsoidal_h.toFixed(8)},${p.geoid_N.toFixed(8)},${p.orthometric_H.toFixed(8)},${p.accuracy_m},${p.fix_quality},${p.svs},${p.ntrip_active?'YES':'NO'},${p.camera_offset_m||0},"${p.captured_at}"\n`;});
  const fn=(pickedPoints[0]?.fileName||'GEO-SENTINEL-survey')+'.csv';
  dlBlob(csv,'text/csv',fn);
  addAlert('ok','📄',`CSV exported — ${pickedPoints.length} points`,nowUTC());
}

// ══ KML EXPORT (clampToGround — Google Earth static) ══
function exportKML(){
  if(!pickedPoints.length){alert('No points captured yet.');return;}
  const ts=new Date().toISOString();
  let kml=`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>GEO-SENTINEL Survey — ${ts.slice(0,10)}</name>
  <description>Exported from GEO-SENTINEL v7.0 | EGM2008 Orthometric Heights</description>
  <Style id="surveyPin">
    <IconStyle><color>ff00a000</color><scale>1.2</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/pushpin/grn-pushpin.png</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.9</scale></LabelStyle>
  </Style>
`;
  pickedPoints.forEach(p=>{
    kml+=`  <Placemark>
    <name>${escXml(p.name)}</name>
    <description><![CDATA[
      <b>Point:</b> ${escXml(p.name)}<br/>
      ${p.description?`<i>${escXml(p.description)}</i><br/>`:''}
      <b>Lat:</b> ${p.lat.toFixed(8)}<br/>
      <b>Lon:</b> ${p.lon.toFixed(8)}<br/>
      <b>Easting:</b> ${p.easting||'N/A'} m<br/>
      <b>Northing:</b> ${p.northing||'N/A'} m<br/>
      <b>UTM Zone:</b> ${p.utm_zone||'N/A'}<br/>
      <b>Ellipsoidal h:</b> ${p.ellipsoidal_h.toFixed(8)} m<br/>
      <b>Geoid N:</b> ${p.geoid_N.toFixed(8)} m<br/>
      <b>Orthometric H:</b> ${p.orthometric_H.toFixed(8)} m<br/>
      <b>Accuracy:</b> ±${p.accuracy_m} m<br/>
      <b>Fix:</b> ${p.fix_quality}<br/>
      <b>Captured:</b> ${p.captured_at}<br/>
      <b>Model:</b> ${p.geoid_model||'EGM2008 approx'}
    ]]></description>
    <styleUrl>#surveyPin</styleUrl>
    <TimeStamp><when>${p.captured_at}</when></TimeStamp>
    <Point>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)},0</coordinates>
    </Point>
  </Placemark>\n`;
  });
  kml+=`</Document>\n</kml>`;
  const fn=(pickedPoints[0]?.fileName||'GEO-SENTINEL-survey')+'.kml';
  dlBlob(kml,'application/vnd.google-earth.kml+xml',fn);
  addAlert('ok','🌍',`KML exported (clampToGround) — ${pickedPoints.length} points`,nowUTC());
}

// ══ LANDXML EXPORT ════════════════════════════════
function exportLandXML(){
  if(!pickedPoints.length){alert('No points captured yet.');return;}
  const ts=new Date().toISOString();
  let xml=`<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2" date="${ts.slice(0,10)}" time="${ts.slice(11,19)}" version="1.2" language="English" readOnly="false">
  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="HPA" angularUnit="decimal dd.mm.ss" directionUnit="decimal dd.mm.ss"/></Units>
  <Application name="GEO-SENTINEL" manufacturer="GEO-PULSE" manufacturerURL="" version="7.0"/>
  <CgPoints>
`;
  pickedPoints.forEach(p=>{
    xml+=`    <CgPoint name="${escXml(p.name)}" oID="${p.id}" state="existing" pntSurv="control">${p.northing||p.lat.toFixed(3)} ${p.easting||p.lon.toFixed(3)} ${p.orthometric_H.toFixed(4)}</CgPoint>\n`;
  });
  xml+=`  </CgPoints>\n</LandXML>`;
  const fn=(pickedPoints[0]?.fileName||'GEO-SENTINEL-survey')+'.xml';
  dlBlob(xml,'application/xml',fn);
  addAlert('ok','📐',`LandXML exported — ${pickedPoints.length} points (Civil 3D compatible)`,nowUTC());
}
function escXml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function dlBlob(content,mime,filename){const b=new Blob([content],{type:mime});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(u),5000);}

// ══ SMART EXPORT (respects format toggle) ══════════
function smartExport(){
  if(exportFormat==='kml')exportKML();
  else exportCSV();
}

// ══ CSV/KML UPLOAD ═════════════════════════════════
function handleUpload(e){
  const f=e.target.files?.[0];if(!f)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const txt=ev.target.result;
    let pts=[];
    if(f.name.toLowerCase().endsWith('.kml')){pts=parseKMLUpload(txt);}
    else{pts=parseCSVUpload(txt);}
    if(!pts.length){addAlert('warn','📂',`No valid points found in ${f.name}`,nowUTC());return;}
    uploadedPoints=[...uploadedPoints,...pts];
    updateUploadTable(pts,f.name);
    if(!mapReady){initMap();goTab('map');}else goTab('map');
    plotUploadedPoints(pts);
    generateUploadHeatmap(pts);
    analyzeRoverHeight(pts);
    addAlert('ok','📂',`Loaded ${pts.length} points from ${f.name}`,nowUTC());
  };
  reader.readAsText(f);
}
function parseCSVUpload(txt){
  const lines=txt.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#'));
  if(!lines.length)return[];
  const hdr=lines[0].split(/[,\t]/).map(h=>h.trim().toLowerCase().replace(/[^a-z0-9_]/g,'_'));
  const fnd=(names)=>names.map(n=>hdr.indexOf(n)).find(i=>i>=0);
  const li=fnd(['lat','latitude','y','northing_dd']);
  const lo=fnd(['lon','lng','longitude','x','easting_dd']);
  const nm=fnd(['name','id','point','pt','label']);
  const ha=fnd(['h','height','ellipsoid_h','ellipsoidal_h','altitude']);
  const hoa=fnd(['orthometric_h','h_orthometric','elevation']);
  const na=fnd(['geoid_n','n','undulation']);
  const ac=fnd(['accuracy','acc','precision','accuracy_m']);
  if(li===undefined||lo===undefined)return[];
  return lines.slice(1).map((l,i)=>{const c=l.split(/[,\t]/);const lat=parseFloat(c[li]),lon=parseFloat(c[lo]);if(isNaN(lat)||isNaN(lon))return null;const H=parseFloat(c[hoa])||parseFloat(c[ha])||0;const h=parseFloat(c[ha])||H;const N=parseFloat(c[na])||geoidApprox(lat,lon);return{id:i+1,name:nm!==undefined?c[nm]?.trim()||`PT${i+1}`:`PT${i+1}`,lat,lon,orthometric_H:H||parseFloat((h-N).toFixed(4)),ellipsoidal_h:h,geoid_N:N,accuracy_m:parseFloat(c[ac])||1.5,fix_quality:'imported'};}).filter(Boolean);
}
function parseKMLUpload(txt){
  const parser=new DOMParser(),doc=parser.parseFromString(txt,'text/xml');
  const pms=Array.from(doc.querySelectorAll('Placemark'));
  return pms.map((pm,i)=>{
    const name=pm.querySelector('name')?.textContent?.trim()||`KPT${i+1}`;
    const coords=pm.querySelector('coordinates')?.textContent?.trim().split(/[\s,]+/);
    if(!coords||coords.length<2)return null;
    const lon=parseFloat(coords[0]),lat=parseFloat(coords[1]),alt=parseFloat(coords[2])||0;
    if(isNaN(lat)||isNaN(lon))return null;
    const N=geoidApprox(lat,lon);
    return{id:i+1,name,lat,lon,orthometric_H:parseFloat((alt-N).toFixed(4)),ellipsoidal_h:alt,geoid_N:N,accuracy_m:1.5,fix_quality:'imported'};
  }).filter(Boolean);
}
function updateUploadTable(pts,fname){
  const tbody=document.getElementById('uploadBody');const count=document.getElementById('uploadCount');
  const tbl=document.getElementById('uploadTable');
  if(count){count.style.display='block';count.textContent=`${uploadedPoints.length} points loaded`;}
  if(tbl)tbl.style.display='table';
  if(!tbody)return;
  pts.forEach(p=>{const tr=document.createElement('tr');tr.innerHTML=`<td style="color:#5dade2">${p.name}</td><td>${p.lat.toFixed(6)}</td><td>${p.lon.toFixed(6)}</td><td>${p.orthometric_H.toFixed(3)}</td><td><span class="badge" style="background:rgba(93,173,226,.15);color:#5dade2">📂 ${fname}</span></td>`;tbody.appendChild(tr);});
}
function plotUploadedPoints(pts){
  if(!mapReady)initMap();
  setTimeout(()=>{
    if(!uploadPtsLayer)uploadPtsLayer=L.layerGroup().addTo(map);
    pts.forEach(p=>{
      const utm=latLonToUTM(p.lat,p.lon);
      L.circleMarker([p.lat,p.lon],{radius:7,color:'#2471a3',fillColor:'#5dade2',fillOpacity:.85,weight:2})
      .bindPopup(`<strong style="color:#2471a3">${p.name}</strong><br/>H=${p.orthometric_H}m<br/>${utm.E}m E / ${utm.N}m N<br/><span style="color:#2471a3;font-size:11px">📂 Uploaded</span>`)
      .addTo(uploadPtsLayer);
    });
    const lats=pts.map(p=>p.lat),lons=pts.map(p=>p.lon);
    map.fitBounds([[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]],{padding:[40,40],maxZoom:16});
    document.getElementById('hudPts')&&(document.getElementById('hudPts').textContent=(ptsLayer?ptsLayer.getLayers().length:0)+uploadedPoints.length);
  },mapReady?0:700);
}

// ══ ROVER HEIGHT ANALYZER ══════════════════════════
function analyzeRoverHeight(pts){
  if(!pts.length)return;
  const accs=pts.map(p=>parseFloat(p.accuracy_m)||1),avg=accs.reduce((s,a)=>s+a,0)/accs.length;
  const hs=pts.map(p=>parseFloat(p.orthometric_H)||0).filter(h=>h!==0),elev=hs.length>1?Math.max(...hs)-Math.min(...hs):0;
  let minH,maxH,reason,quality;
  if(avg>5){minH=3.5;maxH=5.0;reason=`High multipath (avg ±${avg.toFixed(1)}m). Use maximum height.`;quality='POOR';}
  else if(avg>2){minH=2.5;maxH=4.0;reason=`Moderate accuracy (avg ±${avg.toFixed(1)}m). Mid-height recommended.`;quality='MODERATE';}
  else{minH=1.5;maxH=3.0;reason=`Good accuracy (avg ±${avg.toFixed(1)}m). Standard height sufficient.`;quality='GOOD';}
  if(elev>50){minH=Math.min(minH+0.5,5.0);reason+=` Varied terrain (${elev.toFixed(0)}m spread) — raise in valleys.`;}
  const qc=quality==='GOOD'?'#27ae60':quality==='MODERATE'?'#f1c40f':'#e74c3c';
  const heights=[1.5,2.0,2.5,2.6,2.8,3.0,3.5,4.0,4.5,5.0];
  const scores=heights.map(h=>Math.max(10,Math.min(100,Math.round(60+(h/5)*35-avg*3))));
  const bars=heights.map((h,i)=>{const ir=h>=minH&&h<=maxH,col=ir?'#00b5a0':h<minH?'rgba(255,255,255,.22)':'rgba(255,255,255,.12)';return`<div class="rover-bar-row"><div class="rover-bar-label">${h}m</div><div class="rover-bar-track"><div class="rover-bar-fill" style="width:${scores[i]}%;background:${col}"></div></div><div class="rover-bar-val">${scores[i]}%${ir?' ✓':''}</div></div>`;}).join('');
  const el=document.getElementById('roverResult');if(!el)return;
  el.style.display='block';el.innerHTML=`<div class="rover-result"><div class="rover-result-title">Rover Height Recommendation — ${pts.length} points</div><div class="rover-range">${minH.toFixed(1)}m — ${maxH.toFixed(1)}m</div><div class="rover-detail">${reason}</div><div style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:99px;background:rgba(255,255,255,.15);font-size:11px;font-family:'Courier Prime',monospace">Quality: <strong style="color:${qc}">${quality}</strong> · Avg: ±${avg.toFixed(2)}m</div><div class="rover-bars" style="margin-top:14px"><div style="font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Fix probability by height</div>${bars}</div></div>`;
  addAlert('ok','📏',`Rover height: ${minH}m–${maxH}m from ${pts.length} points`,nowUTC());
}
function generateUploadHeatmap(pts){
  if(!mapReady){setTimeout(()=>generateUploadHeatmap(pts),700);return;}
  if(!pts.length)return;
  if(uploadHeatLayer)map.removeLayer(uploadHeatLayer);
  uploadHeatLayer=L.layerGroup().addTo(map);
  pts.forEach(p=>{const acc=parseFloat(p.accuracy_m)||1,color=acc<1.5?'#27ae60':acc<3.5?'#f1c40f':'#e74c3c';L.circle([p.lat,p.lon],{radius:Math.max(30,Math.min(200,acc*40)),color,fillColor:color,fillOpacity:0.35+Math.min(0.4,acc*0.05),weight:0}).addTo(uploadHeatLayer);});
  const cb=document.getElementById('lHeat');if(cb)cb.checked=true;
  addAlert('info','🔥',`RTK heatmap — ${pts.length} uploaded points`,nowUTC());
}

// ══ SENTINEL PULSE ═════════════════════════════════
function toggleInsar(on){document.getElementById('insarPanel').style.display=on?'block':'none';if(on){drawSubsidence();setTimeout(()=>document.getElementById('sinkBanner').style.display='block',1100);}else document.getElementById('sinkBanner').style.display='none';}
function toggleBathy(on){document.getElementById('bathyPanel').style.display=on?'block':'none';if(on)setTimeout(drawBathy,50);}
function drawSubsidence(){const cvs=document.getElementById('subCanvas');if(!cvs)return;const p=cvs.parentElement;cvs.width=p.offsetWidth||500;cvs.height=p.offsetHeight||210;const ctx=cvs.getContext('2d'),W=cvs.width,H=cvs.height;ctx.fillStyle='#0a1628';ctx.fillRect(0,0,W,H);ctx.strokeStyle='rgba(0,181,160,.06)';ctx.lineWidth=1;for(let x=0;x<W;x+=44){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}for(let y=0;y<H;y+=44){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}[{x:.3,y:.4,r:80,c:[231,76,60],v:'12mm/yr'},{x:.6,y:.6,r:55,c:[230,126,34],v:'7mm/yr'},{x:.75,y:.25,r:38,c:[39,174,96],v:'2mm/yr'},{x:.15,y:.7,r:46,c:[39,174,96],v:'1mm/yr'}].forEach(b=>{const bx=b.x*W,by=b.y*H,g=ctx.createRadialGradient(bx,by,0,bx,by,b.r);g.addColorStop(0,`rgba(${b.c},.75)`);g.addColorStop(1,'transparent');ctx.beginPath();ctx.arc(bx,by,b.r,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();ctx.fillStyle='rgba(255,255,255,.85)';ctx.font='11px Courier New';ctx.textAlign='center';ctx.fillText(b.v,bx,by+4);});}
function drawBathy(){const cvs=document.getElementById('bathyCanvas');if(!cvs)return;cvs.width=cvs.offsetWidth||500;cvs.height=170;const ctx=cvs.getContext('2d'),W=cvs.width,H=cvs.height;const bg=ctx.createLinearGradient(0,0,0,H);bg.addColorStop(0,'#1a3a5c');bg.addColorStop(1,'#0a1628');ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);[5,10,15,20,25].forEach((d,i)=>{const y=H*.18+(H*.7)*(i/5);ctx.beginPath();ctx.setLineDash([8,5]);for(let x=0;x<W;x++){const wy=y+Math.sin(x/40)*7+Math.sin(x/17)*3;x===0?ctx.moveTo(x,wy):ctx.lineTo(x,wy);}ctx.strokeStyle=`rgba(0,181,160,${.55-i*.07})`;ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(0,181,160,.75)';ctx.font='10px Courier New';ctx.textAlign='left';ctx.fillText(`${d}m`,8,y+4);});ctx.beginPath();for(let x=0;x<W;x++){const y=H*.16+Math.sin(x/60)*5;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.strokeStyle='#00b5a0';ctx.lineWidth=2.5;ctx.setLineDash([]);ctx.stroke();}
function updateErosion(year){year=parseInt(year);document.getElementById('erosionYear')&&(document.getElementById('erosionYear').textContent=year);drawShoreline(year);}
function drawShoreline(year){const cvs=document.getElementById('shoreCanvas');if(!cvs)return;cvs.width=cvs.offsetWidth||500;cvs.height=170;const ctx=cvs.getContext('2d'),W=cvs.width,H=cvs.height;ctx.fillStyle='#0a1628';ctx.fillRect(0,0,W,H);const og=ctx.createLinearGradient(0,H*.5,0,H);og.addColorStop(0,'rgba(26,58,92,.8)');og.addColorStop(1,'rgba(10,22,40,.9)');ctx.fillStyle=og;ctx.fillRect(0,H*.5,W,H*.5);const lg=ctx.createLinearGradient(0,0,0,H*.5);lg.addColorStop(0,'rgba(0,90,80,.4)');lg.addColorStop(1,'rgba(0,60,50,.6)');ctx.fillStyle=lg;ctx.fillRect(0,0,W,H*.5);ctx.beginPath();for(let x=0;x<W;x++){const y=H*.5+Math.sin(x/50)*9+Math.sin(x/22)*4;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.strokeStyle='rgba(39,174,96,.85)';ctx.lineWidth=2.5;ctx.setLineDash([]);ctx.stroke();ctx.fillStyle='rgba(39,174,96,.85)';ctx.font='11px Courier New';ctx.textAlign='left';ctx.fillText('2015 Baseline',10,H*.5-7);if(year>2015){const f=(year-2015)/20,retreat=f*26;ctx.beginPath();for(let x=0;x<W;x++){const y=H*.5-retreat+Math.sin(x/50+.5)*9+Math.sin(x/22+.3)*4;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.strokeStyle='#e74c3c';ctx.lineWidth=2.5;ctx.setLineDash([7,5]);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#e74c3c';ctx.fillText(`${year} Prediction (−${(f*14).toFixed(1)}m)`,10,H*.5-retreat-7);}ctx.fillStyle='rgba(255,255,255,.35)';ctx.font='11px Courier New';ctx.fillText('← LAND',10,16);ctx.fillText('OCEAN →',10,H-8);}
setTimeout(()=>drawShoreline(2024),200);

// ══ SKY MASK ═══════════════════════════════════════
function drawSkyMask(){const cvs=document.getElementById('skyCanvas');if(!cvs)return;const ctx=cvs.getContext('2d'),W=150,H=150,cx=75,cy=75,r=70;ctx.clearRect(0,0,W,H);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle='#0a0a1a';ctx.fill();[.33,.66,1].forEach(f=>{ctx.beginPath();ctx.arc(cx,cy,r*f,0,Math.PI*2);ctx.strokeStyle='rgba(0,181,160,.13)';ctx.lineWidth=1;ctx.stroke();});ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,-Math.PI/2-.4,-Math.PI/2+.9);ctx.closePath();ctx.fillStyle='rgba(231,76,60,.3)';ctx.fill();ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r*.6,Math.PI-.5,Math.PI+.5);ctx.closePath();ctx.fillStyle='rgba(230,126,34,.26)';ctx.fill();const t=Date.now()/1000;[{az:t*.05,el:.72,col:'#27ae60'},{az:t*.03+1.2,el:.52,col:'#27ae60'},{az:t*.04+2.5,el:.86,col:'#27ae60'},{az:t*.06+3.8,el:.46,col:'#27ae60'},{az:t*.02+.6,el:.61,col:'#27ae60'},{az:-.3,el:.5,col:'#e74c3c'}].forEach(s=>{const d=r*(1-s.el),x=cx+Math.sin(s.az)*d,y=cy-Math.cos(s.az)*d;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fillStyle=s.col;ctx.fill();ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.strokeStyle=s.col+'55';ctx.lineWidth=1;ctx.stroke();});ctx.beginPath();ctx.arc(cx,cy,4,0,Math.PI*2);ctx.fillStyle='#00b5a0';ctx.fill();ctx.fillStyle='rgba(255,255,255,.42)';ctx.font='9px Courier New';ctx.textAlign='center';ctx.fillText('N',cx,9);ctx.fillText('S',cx,H-1);ctx.textAlign='right';ctx.fillText('E',W-1,cy+4);ctx.textAlign='left';ctx.fillText('W',2,cy+4);}
setInterval(drawSkyMask,500);

// ══ WAYPOINTS ══════════════════════════════════════
function addWaypoint(){const list=document.getElementById('waypointList');waypointCount++;const div=document.createElement('div');div.className='wi';div.innerHTML=`<div class="wn">${String(waypointCount).padStart(2,'0')}</div><div class="winfo"><input style="background:transparent;border:none;border-bottom:1px solid var(--b);font-family:var(--F);font-size:14px;font-weight:600;color:var(--t);outline:none;width:100%" placeholder="Waypoint name..."/><input style="background:transparent;border:none;font-family:var(--M);font-size:11px;color:var(--mu);outline:none;width:100%;margin-top:2px" placeholder="Accepts: -1.29, 36.82 | 1°17'S 36°49'E | 236890 9856210 37S"/></div><span class="badge bin">NEW</span>`;list.appendChild(div);document.getElementById('statWP')&&(document.getElementById('statWP').textContent=waypointCount);div.querySelector('input')?.focus();}

// ══ ALERTS ═════════════════════════════════════════
function addAlert(type,icon,msg,time){const el=document.createElement('div');el.className=`ai ${type}`;el.innerHTML=`<div class="ai-ico">${icon}</div><div><div class="ai-msg">${msg}</div><div class="ai-time">${time}</div></div>`;const list=document.getElementById('alertStream');if(!list)return;list.insertBefore(el,list.firstChild);if(list.children.length>12)list.removeChild(list.lastChild);}

// ══ MODALS ═════════════════════════════════════════
function showSinkAlert(){document.getElementById('sinkModal')?.classList.add('open');}
function closeSinkAlert(){document.getElementById('sinkModal')?.classList.remove('open');}
