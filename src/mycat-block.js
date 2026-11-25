const MYCAT_I18N={zh:{pinned:'置顶',all:'全部',ungrouped:'未分组',emptyPinned:'这个状态下暂时没有会话',emptyPinnedWait:'暂时没有等我处理的会话，点「全部」看其他置顶会话'},en:{pinned:'Pinned',all:'All',ungrouped:'Ungrouped',emptyPinned:'No sessions in this state',emptyPinnedWait:'No sessions are waiting for you right now. Tap “All” to see the other pinned sessions.'}};
let mycatLang='zh';
const mycatT=(key)=>{const table=MYCAT_I18N[mycatLang]||MYCAT_I18N.zh;return table[key]??MYCAT_I18N.zh[key]??key};
const mycatSetLang=(id)=>{mycatLang=String(id||'').toLowerCase().startsWith('en')?'en':'zh'};
// 置顶会话四状态：未进行默认；进行中 / 等我处理由 Host 按运行状态自动设；卡点只能手动
const MYCAT_SESSION=[
  {key:'todo',label:'未进行',c:'#a3a3a3',i:'dashed'},
  {key:'doing',label:'进行中',c:'#3b82f6',i:'half'},
  {key:'wait',label:'等我处理',c:'#f59e0b',i:'ringdot'},
  {key:'blocked',label:'卡点',c:'#ef4444',i:'alert'}];
const MYCAT_SESSION_KEYS=new Set(MYCAT_SESSION.map(s=>s.key));
const MYCAT_RING='<circle cx="7" cy="7" r="5.25" stroke="currentColor" stroke-width="1.5"/>';
const MYCAT_DISC='<circle cx="7" cy="7" r="6" fill="currentColor"/>';
const MYCAT_GLYPH='var(--myc-glyph, #fff)';
const MYCAT_ICONS={
  dashed:'<circle cx="7" cy="7" r="5.25" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 1.8"/>',
  half:MYCAT_RING+'<path d="M7 3.2A3.8 3.8 0 0 1 7 10.8Z" fill="currentColor"/>',
  ringdot:MYCAT_RING+'<circle cx="7" cy="7" r="2" fill="currentColor"/>',
  alert:MYCAT_DISC+'<rect x="6.3" y="3.5" width="1.4" height="4.6" rx=".6" fill="'+MYCAT_GLYPH+'"/><circle cx="7" cy="10.1" r=".9" fill="'+MYCAT_GLYPH+'"/>'};
function MycatSvg({icon,color,size=14}){return (0,react_jsx_runtime.jsx)('svg',{viewBox:'0 0 14 14',fill:'none',width:size,height:size,'aria-hidden':true,style:color?{color}:void 0,dangerouslySetInnerHTML:{__html:MYCAT_ICONS[icon]||MYCAT_DISC}})}
function mycatTagOf(title){
  const text=String(title||'').trim();
  // 带项目字母的工作区：123-A 某项目… → 123-A；普通工作区 900-某工作区 / 100-另一工作区 → 只显示 3 位编号
  const project=/^(\d{3})-([A-Za-z])(?=\s|$)/.exec(text);
  if(project)return project[1]+'-'+project[2];
  const code=/^(\d{3})/.exec(text);
  return code?code[1]:null;
}
function mycatSessionKey(node,entry){
  const saved=entry?.status;
  if(saved==='blocked')return 'blocked';
  if(node.pendingInteraction!==void 0)return 'wait';
  if(node.running)return 'doing';
  return MYCAT_SESSION_KEYS.has(saved)?saved:'todo';
}

/* 状态名悬停提示：比原生 title 快（约 150ms），只显示状态名/含义。 */
let mycatTipEl=null,mycatTipTimer=0;
function mycatTipHide(){clearTimeout(mycatTipTimer);if(mycatTipEl)mycatTipEl.style.display='none'}
function mycatTipShow(text,el){
  clearTimeout(mycatTipTimer);
  mycatTipTimer=setTimeout(()=>{
    if(!document||!document.body)return;
    if(!mycatTipEl){mycatTipEl=document.createElement('div');mycatTipEl.className='myc-tip';document.body.appendChild(mycatTipEl)}
    mycatTipEl.textContent=text;
    mycatTipEl.style.display='block';
    if(!el||typeof el.getBoundingClientRect!=='function')return;
    const r=el.getBoundingClientRect();
    const w=mycatTipEl.offsetWidth||70;
    let left=r.right+8;
    if(left+w>window.innerWidth-8)left=Math.max(8,r.left-w-8);
    mycatTipEl.style.left=Math.round(left)+'px';
    mycatTipEl.style.top=Math.round(r.top+r.height/2)+'px';
  },150);
}
/* 委托一次性挂到 document：图标被 React 重渲染替换也不影响。
   注意：这里绝不引用模块后面才声明的 const（TDZ 会让整个模块工厂抛错、侧栏变空白）。 */
if(typeof document!=='undefined'&&!mycatTipBound){
  var mycatTipBound=true;
  try{
    const resolveTarget=(node)=>{
      try{
        if(!node||typeof node.closest!=='function')return null;
        return node.closest('[data-tip]');
      }catch(_){}
      return null;
    };
    document.addEventListener('mouseover',(event)=>{const t=resolveTarget(event.target);if(t)mycatTipShow(t.getAttribute('data-tip'),t);else mycatTipHide()},true);
    document.addEventListener('mouseout',(event)=>{const t=resolveTarget(event.target);if(t)mycatTipHide()},true);
    document.addEventListener('scroll',mycatTipHide,true);
  }catch(_){}
}

/* 回收站数字容错：state / trash 接口缺字段时按 0 处理，避免界面出现 NaN。 */
function mycatTrashOf(value){
  const count=Number(value&&value.count),bytes=Number(value&&value.bytes);
  return {count:Number.isFinite(count)&&count>0?Math.floor(count):0,bytes:Number.isFinite(bytes)&&bytes>0?Math.floor(bytes):0};
}
function mycatBytes(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)return '0 KB';
  if(n<1024)return n+' B';
  if(n<1048576)return String(Math.round(n/1024*10)/10).replace(/\.0$/,'')+' KB';
  return String(Math.round(n/1048576*10)/10).replace(/\.0$/,'')+' MB';
}
function mycatPrefsOf(value){
  const v=value!==null&&typeof value==='object'?value:{};
  const review=typeof v.requireReview==='boolean'?v.requireReview:true;
  const days=Number(v.trashKeepDays),mb=Number(v.trashMaxMB);
  // notifyWait 默认开：Host 还没升级到带这个字段的版本时，行为保持「发通知」。
  const notify=typeof v.notifyWait==='boolean'?v.notifyWait:true;
  return {
    requireReview:review,
    notifyWait:notify,
    trashKeepDays:Number.isFinite(days)&&days>=1?Math.round(days):30,
    trashMaxMB:Number.isFinite(mb)&&mb>=1?Math.round(mb):200,
  };
}
async function mycatRequestJson(url,init){
  const response=await fetch(url,init===void 0?{credentials:'same-origin'}:{credentials:'same-origin',...init});
  const data=await response.json().catch(()=>({ok:false,error:'HTTP '+response.status}));
  if(!response.ok&&data.ok!==false)throw new Error('HTTP '+response.status);
  return data;
}
/* 设置页「会话管理」：一次最多提交多少条动作，Host 单次调用不宜过大。 */
const MYCAT_SESSIONS_CHUNK=50;
const MYCAT_SESSION_TABS=[
  {key:'all',label:'全部会话'},
  {key:'pinned',label:'置顶'},
  {key:'archived',label:'归档'},
  {key:'trash',label:'回收站'}];
const MYCAT_ACTION_LABEL={pin:'置顶',unpin:'取消置顶',archive:'归档',unarchive:'取消归档',delete:'删除',restore:'恢复'};
/* 相对时间：只做设置页会话列表用的简版，无 createdAt 时不渲染。 */
function mycatRelTime(value){
  const n=typeof value==='number'?value:Date.parse(String(value??''));
  if(!Number.isFinite(n)||n<=0)return '';
  const diff=Date.now()-n;
  if(diff<60000)return '刚刚';
  const minutes=Math.floor(diff/60000);
  if(minutes<60)return minutes+' 分钟前';
  const hours=Math.floor(minutes/60);
  if(hours<24)return hours+' 小时前';
  const days=Math.floor(hours/24);
  if(days<30)return days+' 天前';
  const months=Math.floor(days/30);
  if(months<12)return months+' 个月前';
  return Math.floor(months/12)+' 年前';
}
function mycatStatusLabel(key){const found=MYCAT_SESSION.find(session=>session.key===key);return found?found.label:''}
/* Host 返回的数据一律容错：缺字段就按空/0 处理，界面不出现 undefined/NaN。 */
function mycatSessionListOf(value){
  const list=value&&Array.isArray(value.sessions)?value.sessions:[];
  const out=[];
  for(const row of list){
    if(row===null||typeof row!=='object')continue;
    const sessionId=typeof row.sessionId==='string'?row.sessionId:'';
    if(sessionId==='')continue;
    const created=Number(row.createdAt);
    out.push({
      sessionId,
      title:typeof row.title==='string'?row.title:'',
      workspaceId:typeof row.workspaceId==='string'?row.workspaceId:'',
      workspace:typeof row.workspace==='string'?row.workspace:'',
      live:row.live===true,
      pinned:row.pinned===true,
      archived:row.archived===true,
      createdAt:Number.isFinite(created)&&created>0?created:0,
      status:MYCAT_SESSION_KEYS.has(row.status)?row.status:'',
      running:row.running===true,
    });
  }
  return out;
}
function mycatTrashEntriesOf(value){
  const list=value&&Array.isArray(value.entries)?value.entries:[];
  const out=[];
  for(const row of list){
    if(row===null||typeof row!=='object')continue;
    const sessionId=typeof row.sessionId==='string'?row.sessionId:'';
    if(sessionId==='')continue;
    const deletedAt=Date.parse(String(row.deletedAt??''));
    const size=Number(row.sizeBytes);
    out.push({
      sessionId,
      title:typeof row.title==='string'?row.title:'',
      deletedAt:Number.isFinite(deletedAt)?deletedAt:0,
      sizeBytes:Number.isFinite(size)&&size>0?size:0,
    });
  }
  return out;
}
function mycatStatsOf(value){
  const v=value!==null&&typeof value==='object'?value:{};
  const count=key=>{const n=Number(v[key]);return Number.isFinite(n)&&n>0?Math.floor(n):0};
  const workspaces=[];
  if(Array.isArray(v.workspaces))for(const row of v.workspaces){
    if(row===null||typeof row!=='object')continue;
    const n=Number(row.count);
    const workspaceId=String(row.workspaceId??'');
    workspaces.push({
      workspaceId,
      title:typeof row.title==='string'&&row.title!==''?row.title:(workspaceId!==''?workspaceId:'未分组'),
      count:Number.isFinite(n)&&n>0?Math.floor(n):0,
    });
  }
  return {
    total:count('total'),live:count('live'),pinned:count('pinned'),archived:count('archived'),
    trashCount:count('trashCount'),trashBytes:count('trashBytes'),pendingDeletes:count('pendingDeletes'),
    last7daysNew:count('last7daysNew'),waitAuto:count('waitAuto'),blocked:count('blocked'),workspaces};
}
function mycatMatchesQuery(parts,term){
  if(term==='')return true;
  for(const part of parts){
    if(String(part??'').toLowerCase().includes(term))return true;
  }
  return false;
}
function createMycatStore(){
  let snap={sessions:{},sessionFilter:'wait',notice:null,pinnedFailed:false,ui:{theme:'mono'},trash:{count:0,bytes:0},pendingDeletes:0,trashBusy:false,prefs:mycatPrefsOf(null),prefsBusy:false,restored:null};
  let refreshSessions=null,lastRestoredAt=0;
  const bindSessionRefresh=fn=>{refreshSessions=fn};
  const listeners=new Set();
  const emit=()=>{for(const l of listeners)l()};
  const set=(patch)=>{snap={...snap,...patch};emit()};
  const accept=d=>{
    const parsed=d!==null&&typeof d==='object'?d:{};
    const pending=Number(parsed.pendingDeletes);
    // session_restore 之后 Host 会在 state 里给 restored.at；客户端据此主动刷新一次会话列表，
    // 不用等用户手动刷新/重启。
    let restored=null;
    const restoredAt=Number(parsed.restored&&parsed.restored.at);
    if(Number.isFinite(restoredAt)&&restoredAt>0&&restoredAt!==lastRestoredAt){
      lastRestoredAt=restoredAt;
      restored={sessionId:String((parsed.restored&&parsed.restored.sessionId)||''),at:restoredAt};
      try{refreshSessions?.()}catch(_){}
    }
    set({
      sessions:parsed.sessions!==null&&typeof parsed.sessions==='object'?parsed.sessions:{},
      ui:parsed.ui!==null&&typeof parsed.ui==='object'?parsed.ui:snap.ui,
      prefs:mycatPrefsOf(parsed.prefs),
      trash:mycatTrashOf(parsed.trash),
      pendingDeletes:Number.isFinite(pending)&&pending>0?Math.floor(pending):0,
      ...(restored?{restored}:{}),
    });
  };
  const readJson=async r=>{const d=await r.json().catch(()=>({ok:false,error:'HTTP '+r.status}));if(!r.ok&&d.ok!==false)throw new Error('HTTP '+r.status);return d};
  let inflight=null,poll=0,soon=0,noticeTimer=0;
  const notify=text=>{clearTimeout(noticeTimer);set({notice:text});noticeTimer=setTimeout(()=>set({notice:null}),5000)};
  const load=()=>{
    if(inflight!==null)return inflight;
    inflight=fetch('/api/mycat/state',{credentials:'same-origin'}).then(readJson).then(accept).catch(e=>notify('状态读取失败：'+String(e&&e.message||e))).finally(()=>{inflight=null});
    return inflight;
  };
  const refreshSoon=()=>{clearTimeout(soon);soon=setTimeout(load,800)};
  const loadTrash=async()=>{
    try{
      const d=await readJson(await fetch('/api/mycat/trash',{credentials:'same-origin'}));
      if(!d.ok)throw new Error(d.error||'读取失败');
      set({trash:mycatTrashOf(d)});
    }catch(e){notify('回收站读取失败：'+String(e&&e.message||e))}
  };
  const emptyTrash=async()=>{
    if(snap.trashBusy)return;
    set({trashBusy:true});
    try{
      const d=await readJson(await fetch('/api/mycat/trash',{method:'DELETE',credentials:'same-origin'}));
      if(!d.ok)throw new Error(d.error||'清空失败');
      set({trash:{count:0,bytes:0},trashBusy:false});
      const removed=Number(d.removed);
      notify('回收站已清空'+(Number.isFinite(removed)?`（移除 ${removed} 个会话）`:''));
      loadTrash();load();
    }catch(e){set({trashBusy:false});notify('清空回收站失败：'+String(e&&e.message||e))}
  };
  const setSessionStatus=async(id,status)=>{
    const before=snap.sessions;
    const next={...before};
    if(status===null)delete next[id];else next[id]={status,auto:false,updatedAt:new Date().toISOString()};
    set({sessions:next});
    try{
      const d=await readJson(await fetch('/api/mycat/session-status',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:id,status})}));
      if(!d.ok)throw new Error(d.error||'保存失败');
      set({sessions:d.sessions||{}});
    }catch(e){set({sessions:before});notify('会话状态没保存：'+String(e&&e.message||e))}
  };
  const savePrefs=async(patch)=>{
    if(snap.prefsBusy)return false;
    set({prefsBusy:true});
    try{
      const d=await readJson(await fetch('/api/mycat/prefs',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)}));
      if(!d.ok)throw new Error(d.error||'保存失败');
      set({prefs:mycatPrefsOf(d.prefs),prefsBusy:false});
      notify('设置已保存');
      return true;
    }catch(e){set({prefsBusy:false});notify('设置保存失败：'+String(e&&e.message||e));return false}
  };
  const setTheme=async(theme)=>{
    const before=snap.ui;
    set({ui:{...(snap.ui||{}),theme}});
    try{
      const d=await readJson(await fetch('/api/mycat/ui',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({theme})}));
      if(!d.ok)throw new Error(d.error||'保存失败');
      set({ui:d.ui||{theme}});
    }catch(e){set({ui:before});notify('配色没保存：'+String(e&&e.message||e))}
  };
  return {getSnapshot:()=>snap,
    subscribe:(l)=>{listeners.add(l);if(listeners.size===1){load();poll=setInterval(()=>{if(!document.hidden)load()},60000)}return()=>{listeners.delete(l);if(listeners.size===0){clearInterval(poll);poll=0}}},
    load,refreshSoon,setSessionStatus,notify,setTheme,loadTrash,emptyTrash,savePrefs,bindSessionRefresh,
    // 设置页批量动作后主动让官方会话列表刷新；没绑到 sessions service 就静默跳过。
    refreshSessionList:()=>{try{refreshSessions?.()}catch(_){}},
    setSessionFilter:(f)=>set({sessionFilter:f}),
    markPinnedFailed:()=>set({pinnedFailed:true})};
}
const MYCAT=createMycatStore();
/* 状态配色：形状永远不变，只换颜色。mono=中性灰（默认）、multi=按状态多彩、blue=品牌蓝。 */
const MYCAT_THEME_LIST=[
  {key:'mono',label:'中性灰',desc:'所有状态同一种灰，靠形状区分（推荐）'},
  {key:'multi',label:'多彩',desc:'按状态着色，色相多但一眼分得清'},
  {key:'blue',label:'品牌蓝',desc:'所有状态用品牌蓝，比多彩安静'},
];
const MYCAT_THEME_COLOR={mono:'var(--dsw-alias-label-secondary,#6b7280)',blue:'var(--dsw-alias-state-business-primary,#3b82f6)'};
/* 悬停只说状态名；含义集中放在设置页的图例里。 */
const MYCAT_MEANING={
  未进行:'置顶了，还没开工',
  进行中:'这一轮正在运行',
  等我处理:'这一轮跑完了，等我拍板',
  卡点:'遇到阻塞，需要我介入',
};
function mycatTheme(){try{return (MYCAT.getSnapshot().ui||{}).theme||'mono'}catch(_){return 'mono'}}
function mycColor(base){return MYCAT_THEME_COLOR[mycatTheme()]||base}
if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{if(!document.hidden)MYCAT.load()});
function useMycat(select){const get=()=>select(MYCAT.getSnapshot());return (0,react.useSyncExternalStore)(MYCAT.subscribe,get,get)}
const MYCAT_ROW=Rows_module_css_default;
const MYCAT_WB=WorkspaceBrowser_module_css_default;
const MYCAT_CSS=[
  // 分段筛选控件（置顶会话用）：只有「全部」显示文字，其余只显示图标和数字
  '.myc-tabs{display:grid;gap:2px;padding:0;border-radius:12px;background:transparent;box-shadow:none;color:var(--dsw-alias-label-tertiary)}',
  '.myc-tab{all:unset;box-sizing:border-box;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:22px;padding:0 4px;overflow:hidden;border-radius:9px;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums;transition:background .12s,color .12s}',
  '.myc-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.myc-tab:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,currentColor 35%,transparent)}',
  '.myc-tab[data-zero]:not([aria-pressed="true"]){opacity:.4}',
  '.myc-tab .lbl{display:none}.myc-tab[data-all] .lbl{display:inline}',
  '.myc-tab[aria-pressed="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px rgba(0,0,0,.06)}',
  '.myc-tab svg{flex:none}',
  '.myc-tab:active{transform:scale(.97)}',
  // 置顶会话区：在「工作区」上方
  '.myc-pinned{flex:none;display:flex;flex-direction:column;max-height:60%;min-height:0;margin-bottom:8px}',
  '.myc-pinned-head{flex:none;display:flex;align-items:center;gap:6px;height:var(--workspace-toolbar-height,28px);padding-left:0;color:var(--dsw-alias-label-tertiary)}',
  '.myc-pinned-count{font-size:11px;font-variant-numeric:tabular-nums}',
  '.myc-pinned-notice{margin-left:auto;margin-right:8px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#d97706);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.myc-pinned .myc-tabs{flex:none;margin:0 0 6px}',
  '.myc-pinned-list{min-height:0;overflow-y:auto}',
  '.myc-empty{padding:4px var(--dsh-sidebar-row-padding,8px);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.myc-wtag{flex:none;margin-right:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.myc-sicon-wrap{display:inline-flex}',
  '.myc-sicon{all:unset;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:-1px;border-radius:5px;color:var(--myc-c);cursor:pointer;transition:background .12s}',
  '.myc-sicon:hover,.myc-sicon:focus-visible{background:color-mix(in srgb,var(--myc-c) 16%,transparent)}',
  '.myc-sicon svg{width:14px;height:14px;display:block}',
  '.myc-sicon.spin svg{animation:myc-spin 1.4s linear infinite}',
  '@keyframes myc-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion:reduce){.myc-sicon.spin svg{animation:none}}',
  // 分隔线：置顶区与工作区之间
  '.myc-divider{flex:none;height:1px;margin:7px var(--dsh-sidebar-row-padding,8px) 7px;background:color-mix(in srgb,currentColor 7%,transparent)}',
  '.myc-divider{transition:opacity .22s ease}',
  '.myc-scrolled .myc-divider{opacity:.42}',
  // 行高：主行 36、置顶会话 36、组内会话 30
  `.${Rows_module_css_default.projectRow}{height:36px}`,
  `.myc-pinned .${Rows_module_css_default.sessionRow}{height:36px}`,
  `.${WorkspaceBrowser_module_css_default.groupSection} .${Rows_module_css_default.sessionRow}{height:30px}`,
  // 工作区之间更松一点
  `.${WorkspaceBrowser_module_css_default.groupSection}+.${WorkspaceBrowser_module_css_default.groupSection}{margin-top:6px}`,
  '.myc-pinned{padding-bottom:4px}',
  // 展开/收起动画
  '.myc-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .24s cubic-bezier(.2,.7,.2,1)}',
  '.myc-body[data-phase="open"]{grid-template-rows:1fr}',
  '.myc-body[data-phase="closing"]{grid-template-rows:0fr}',
  '.myc-body>.myc-body-in{min-height:0;overflow:hidden}',
  '@media (prefers-reduced-motion:reduce){.myc-body{transition:none}}',
  // 设置页：状态配色 + 状态图例 + 回收站
  '.myc-set{padding:4px 2px 24px;font-size:13px}',
  '.myc-set h3{margin:18px 0 6px;font-size:13px;font-weight:600}',
  '.myc-set .hint{margin:0 0 10px;font-size:12px;opacity:.72}',
  '.myc-set .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}',
  '.myc-set .card{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:12px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .12s,background .12s}',
  '.myc-set .card:hover{background:color-mix(in srgb,currentColor 5%,transparent)}',
  '.myc-set .card[data-on]{border-color:var(--dsw-alias-state-business-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 7%,transparent)}',
  '.myc-set .card b{font-weight:600;font-size:13px}',
  '.myc-set .card span{font-size:12px;opacity:.72;line-height:1.45}',
  '.myc-set .icons{display:flex;gap:8px;align-items:center;margin-bottom:2px}',
  '.myc-set .legend{list-style:none;margin:0;padding:0;display:grid;gap:7px}',
  '.myc-set .legend li{display:flex;align-items:center;gap:8px}',
  '.myc-set .legend b{font-weight:600;font-size:13px;min-width:64px}',
  '.myc-set .legend em{font-style:normal;font-size:12px;opacity:.72}',
  '.myc-set .prefs{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent)}',
  '.myc-set .pref{display:flex;align-items:center;gap:8px;font-size:12px}',
  '.myc-set .pref input[type=number]{width:76px;padding:3px 6px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px}',
  '.myc-set .pref input[type=checkbox]{margin:0}',
  '.myc-set .prefs button{align-self:flex-start;padding:4px 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.myc-set .prefs button:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
  '.myc-set .prefs button:disabled{opacity:.5;cursor:default}',
  '.myc-set .trash{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent)}',
  '.myc-set .trash .meta{display:flex;flex-direction:column;gap:3px;margin-right:auto;min-width:0}',
  '.myc-set .trash .meta b{font-weight:600;font-size:13px}',
  '.myc-set .trash .meta span{font-size:12px;opacity:.72}',
  '.myc-set .trash button{all:unset;box-sizing:border-box;flex:none;height:28px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);font-size:12px;cursor:pointer;transition:background .12s}',
  '.myc-set .trash button:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}',
  '.myc-set .trash button:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 40%,transparent)}',
  '.myc-set .trash button:disabled{opacity:.45;cursor:not-allowed}',
  // v18 设置页：会话管理 + 统计。（全部用 currentColor / --dsw-alias-*，深色模式自动适配）
  '.myc-mgr{display:flex;flex-direction:column;gap:8px}',
  '.myc-mgr-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.myc-mgr-search{flex:1;min-width:150px;box-sizing:border-box;height:28px;padding:0 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px}',
  '.myc-mgr-search:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 40%,transparent)}',
  '.myc-mgr-tabs{display:flex;gap:4px;flex-wrap:wrap}',
  '.myc-mgr-tab{all:unset;box-sizing:border-box;height:24px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);font-size:12px;line-height:22px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font-variant-numeric:tabular-nums;transition:background .12s,color .12s}',
  '.myc-mgr-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.myc-mgr-tab:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 40%,transparent)}',
  '.myc-mgr-tab[aria-pressed="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:color-mix(in srgb,currentColor 8%,transparent);border-color:color-mix(in srgb,currentColor 32%,transparent)}',
  '.myc-mgr-acts{display:flex;gap:6px;flex-wrap:wrap}',
  '.myc-mgr-acts button{all:unset;box-sizing:border-box;height:26px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);font-size:12px;line-height:24px;cursor:pointer;transition:background .12s}',
  '.myc-mgr-acts button:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}',
  '.myc-mgr-acts button:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 40%,transparent)}',
  '.myc-mgr-acts button:disabled{opacity:.45;cursor:not-allowed}',
  '.myc-mgr-acts button[data-danger]{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 45%,transparent)}',
  '.myc-mgr-acts button[data-armed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent);font-weight:600}',
  '.myc-mgr-list{display:flex;flex-direction:column;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;overflow:hidden}',
  '.myc-mgr-head{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)}',
  '.myc-mgr-head input[type=checkbox]{margin:0;flex:none}',
  '.myc-mgr-rows{display:flex;flex-direction:column;max-height:320px;overflow-y:auto}',
  '.myc-mgr-row{display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:12px;cursor:pointer}',
  '.myc-mgr-row:hover{background:color-mix(in srgb,currentColor 5%,transparent)}',
  '.myc-mgr-row input[type=checkbox]{margin:0;flex:none}',
  '.myc-mgr-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
  '.myc-mgr-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.myc-mgr-badges{display:flex;gap:4px;flex-wrap:wrap;align-items:center}',
  '.myc-mgr-badge{font-size:10px;line-height:14px;padding:0 5px;border-radius:5px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.myc-mgr-badge[data-kind="archived"]{opacity:.72}',
  '.myc-mgr-badge[data-kind="running"],.myc-mgr-badge[data-kind="status-wait"]{color:var(--dsw-alias-state-business-primary,#3b82f6);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 42%,transparent)}',
  '.myc-mgr-badge[data-kind="status-blocked"]{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 42%,transparent)}',
  '.myc-mgr-ws{flex:none;max-width:180px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.myc-mgr-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.myc-mgr-empty{padding:12px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.myc-mgr-error{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#d97706)}',
  '.myc-mgr-error button{all:unset;box-sizing:border-box;height:22px;padding:0 9px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);font-size:11px;cursor:pointer;color:inherit}',
  '.myc-mgr-summary{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.myc-mgr-summary b{font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.myc-mgr-reasons{color:var(--dsw-alias-state-warn-primary,#d97706)}',
  '.myc-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}',
  '.myc-stat{display:flex;flex-direction:column;gap:2px;padding:10px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent)}',
  '.myc-stat b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}',
  '.myc-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.35}',
  '.myc-stat-sub{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
  '.myc-stat-ws-title{margin:12px 0 6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.myc-stat-ws{display:flex;flex-direction:column;gap:4px;font-size:12px}',
  '.myc-stat-ws-row{display:flex;justify-content:space-between;gap:8px}',
  '.myc-stat-ws-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.myc-stat-ws-row b{flex:none;font-weight:600;font-variant-numeric:tabular-nums}',
  '.myc-tip{position:fixed;display:none;transform:translateY(-50%);z-index:99999;max-width:280px;padding:6px 9px;border-radius:7px;background:rgba(24,26,31,.95);color:#fff;font-size:12px;line-height:1.5;white-space:pre-line;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.24)}'
].join('')+
'@keyframes myc-unread-breathe{0%,100%{opacity:.55;transform:scale(.86)}50%{opacity:1;transform:scale(1.14)}}'+
'@keyframes myc-unread-ripple{0%{transform:scale(.6);opacity:.85}70%{opacity:.15}100%{transform:scale(2.6);opacity:0}}'+
'.myc-unread{position:relative;flex:none;width:14px;height:14px;margin:0 -1px 0 2px;background:radial-gradient(circle,var(--dsw-alias-state-business-primary,#3b82f6) 0 3.5px,transparent 3.6px);animation:myc-unread-breathe 2.4s ease-in-out infinite}'+
'.myc-unread i{display:none}'+
'.myc-unread::after{content:"";position:absolute;inset:0;background:radial-gradient(circle,transparent 0 3.3px,color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 60%,transparent) 3.3px 4.9px,transparent 5px);animation:myc-unread-ripple 2.4s ease-out infinite}'+
'.'+MYCAT_ROW.sessionRow+':has(.myc-unread) .myc-wtag{display:none}'+
'.'+MYCAT_ROW.sessionRow+':has(.myc-unread) .'+MYCAT_ROW.time+'{display:none}';
const MycatStyle=()=>(0,react_jsx_runtime.jsx)('style',{dangerouslySetInnerHTML:{__html:MYCAT_CSS}});
function MycatTabs({items,active,onPick,columns}){
  const box=react.useRef(null);
  const prevRect=react.useRef(null);
  (0,react.useEffect)(()=>{
    const node=box.current&&box.current.querySelector('.myc-tab[aria-pressed="true"]');
    if(!node)return;
    const rect=node.getBoundingClientRect();
    const before=prevRect.current;
    prevRect.current=rect;
    if(!before||(before.left===rect.left&&before.top===rect.top))return;
    if(typeof node.animate!=='function')return;
    node.animate([{transform:`translate(${before.left-rect.left}px,${before.top-rect.top}px)`},{transform:'none'}],{duration:200,easing:'cubic-bezier(.2,.8,.2,1)'});
  },[active,items.length]);
  return (0,react_jsx_runtime.jsx)('div',{ref:box,className:'myc-tabs',role:'group',style:{gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`},children:items.map(it=>{
    const on=it.key===null?active===null:active===it.key;
    const tip=it.tip||(it.key===null?'显示全部':`${it.label} ${it.count}`);
    return (0,react_jsx_runtime.jsxs)('button',{type:'button',className:'myc-tab','data-all':it.key===null?'':void 0,'data-zero':it.key!==null&&it.count===0?'':void 0,'aria-pressed':on,
      title:tip,'data-tip':tip,
      onMouseEnter:e=>mycatTipShow(tip,e.currentTarget),onFocus:e=>mycatTipShow(tip,e.currentTarget),onMouseLeave:mycatTipHide,onBlur:mycatTipHide,
      onClick:()=>onPick(it.key===null||on?null:it.key),
      children:[it.icon?(0,react_jsx_runtime.jsx)(MycatSvg,{icon:it.icon,color:it.color,size:12}):null,(0,react_jsx_runtime.jsx)('span',{className:'lbl',children:it.label}),(0,react_jsx_runtime.jsx)('span',{children:String(it.count)})]},it.key??'all');
  })});
}
function MycatCollapse({open,children}){
  const [phase,setPhase]=react.useState(open?'open':'closed');
  const [frozen,setFrozen]=react.useState(null);
  const last=react.useRef(children);
  const first=react.useRef(true);
  if(open)last.current=children;
  (0,react.useLayoutEffect)(()=>{
    if(first.current){first.current=false;return}
    if(open){setFrozen(null);setPhase('open');return}
    setFrozen(last.current);setPhase('closing');
    const timer=setTimeout(()=>{setPhase('closed');setFrozen(null)},270);
    return ()=>clearTimeout(timer);
  },[open]);
  const body=open?children:frozen;
  return (0,react_jsx_runtime.jsx)('div',{className:'myc-body','data-phase':phase,children:(0,react_jsx_runtime.jsx)('div',{className:'myc-body-in',children:body})});
}
function MycatSessionIcon({node,statusKey,entry}){
  const [open,setOpen]=(0,react.useState)(false);
  const meta=MYCAT_SESSION.find(s=>s.key===statusKey)||MYCAT_SESSION[0];
  const spin=node.running&&node.pendingInteraction===void 0;
  const items=[{type:'label',id:'h',text:'会话状态'},...MYCAT_SESSION.map(s=>({id:s.key,label:s.label,icon:(0,react_jsx_runtime.jsx)(MycatSvg,{icon:s.i,color:mycColor(s.c)})})),...(entry?[{type:'separator',id:'sep'},{id:'__clear',label:'清除状态'}]:[])];
  const stop=e=>e.stopPropagation();
  const tip=[meta.label,MYCAT_MEANING[meta.label]||''].join('\n');
  return (0,react_jsx_runtime.jsx)('span',{className:'myc-sicon-wrap',onClick:stop,onDoubleClick:stop,onKeyDown:stop,onMouseDown:stop,children:(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu,{open,onClose:()=>setOpen(false),items,selectedIds:[statusKey],
    onSelect:id=>{setOpen(false);MYCAT.setSessionStatus(node.id,id==='__clear'?null:id)},portal:true,dense:true,align:'start',
    anchor:(0,react_jsx_runtime.jsx)('button',{type:'button',className:'myc-sicon'+(spin?' spin':''),style:{'--myc-c':mycColor(meta.c)},'data-tip':tip,title:tip,'aria-label':'会话状态：'+meta.label,onMouseEnter:e=>mycatTipShow(tip,e.currentTarget),onFocus:e=>mycatTipShow(tip,e.currentTarget),onMouseLeave:mycatTipHide,onBlur:mycatTipHide,onClick:()=>setOpen(v=>!v),children:(0,react_jsx_runtime.jsx)(MycatSvg,{icon:meta.i})})})});
}
function MycatPinned({list,pinnedSessionIds,archivedSessionIds,workspaces,useSessionStatus,usePanelInfo,open,onSessionRenameRequest,renderSlot,renderFactorySlot,useContextMenu,useContextMenuTarget,home,useSessionAccess,t}){
  const statuses=useSessionStatus(s=>s);
  useMycat(s=>(s.ui||{}).theme);
  const panelActive=usePanelInfo(info=>info.activePanelId!==null);
  const saved=useMycat(s=>s.sessions);
  const filter=useMycat(s=>s.sessionFilter);
  const notice=useMycat(s=>s.notice);
  const nodes=(0,react.useMemo)(()=>{
    const pinned=new Set(pinnedSessionIds),archived=new Set(archivedSessionIds);
    return pinnedSessionIds.filter(id=>{const s=list.byId[id];return s!==void 0&&!archived.has(id)&&s.origin!==`subagent`&&!s.blank}).map(id=>sessionNode(list.byId[id],list,statuses,pinned,archived));
  },[list,statuses,pinnedSessionIds,archivedSessionIds]);
  const runningSig=nodes.map(n=>n.id+(n.running?'+':'-')+(n.pendingInteraction?'p':'')).join('|');
  (0,react.useEffect)(()=>{if(runningSig!=='')MYCAT.refreshSoon()},[runningSig]);
  // v18：置顶会话「首次」进入等我处理时发系统通知；notifyWait=false 或没有权限时静默。
  const waitSig=nodes.map(n=>n.id+':'+mycatSessionKey(n,saved?.[n.id])).join('|');
  const prevWaitRef=(0,react.useRef)(null);
  (0,react.useEffect)(()=>{
    const previous=prevWaitRef.current;
    const next=new Map();
    for(const node of nodes){
      const statusKey=mycatSessionKey(node,saved?.[node.id]);
      next.set(node.id,statusKey);
      if(previous===null||statusKey!=='wait')continue;
      // 只对「上一次渲染里就存在的置顶会话」发通知：刚被置顶时就等我的会话不补发。
      if(!previous.has(node.id))continue;
      if(previous.get(node.id)==='wait')continue;
      try{
        const prefsNow=MYCAT.getSnapshot().prefs||{};
        if(prefsNow.notifyWait===false)continue;
        if(typeof Notification==='undefined'||Notification.permission!=='granted')continue;
        const titleText=(list.byId[node.id]&&list.byId[node.id].title)||node.id;
        const owner=(workspaces||[]).find(group=>Array.isArray(group.sessionIds)&&group.sessionIds.includes(node.id));
        const body=[titleText,owner?owner.title:''].filter(Boolean).join(' · ');
        const note=new Notification('会话完成，等你处理',{body,tag:'mycat-'+node.id});
        note.onclick=()=>{try{open(node.id)}catch(_){};try{window.focus?.()}catch(_){}};
      }catch(_){}
    }
    prevWaitRef.current=next;
  },[waitSig]);
  if(nodes.length===0)return null;
  const current=panelActive?void 0:Object.values(list.byId).find(s=>(s.retainedBy.mainView??0)>0)?.id;
  const keyOf=node=>mycatSessionKey(node,saved?.[node.id]);
  const counts={todo:0,doing:0,wait:0,blocked:0};
  for(const n of nodes)counts[keyOf(n)]++;
  const visible=filter===null?nodes:nodes.filter(n=>keyOf(n)===filter);
  const tagOf=node=>{const owner=(workspaces||[]).find(w=>w.sessionIds.includes(node.id));return owner?mycatTagOf(owner.title)??owner.title:mycatT('ungrouped')};
  const now=Date.now();
  return (0,react_jsx_runtime.jsxs)('div',{className:'myc-pinned','data-mycat-pinned':'',children:[
    (0,react_jsx_runtime.jsx)(MycatStyle,{}),
    (0,react_jsx_runtime.jsxs)('div',{className:'myc-pinned-head',children:[(0,react_jsx_runtime.jsx)('span',{children:mycatT('pinned')}),(0,react_jsx_runtime.jsx)('span',{className:'myc-pinned-count',children:String(nodes.length)}),notice?(0,react_jsx_runtime.jsx)('span',{className:'myc-pinned-notice',title:notice,children:notice}):null]}),
    (0,react_jsx_runtime.jsx)(MycatTabs,{items:[{key:null,label:mycatT('all'),count:nodes.length,tip:`显示全部 ${nodes.length} 个置顶会话`},...MYCAT_SESSION.map(s=>({key:s.key,label:s.label,count:counts[s.key],icon:s.i,color:mycColor(s.c),tip:`${s.label} · ${MYCAT_MEANING[s.label]||''}（${counts[s.key]||0} 个）`}))],active:filter,onPick:k=>MYCAT.setSessionFilter(k),columns:5}),
    (0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCardGroup,{className:'myc-pinned-list',children:visible.length===0?(0,react_jsx_runtime.jsx)('div',{className:'myc-empty',children:filter==='wait'?mycatT('emptyPinnedWait'):mycatT('emptyPinned')}):visible.map(node=>(0,react_jsx_runtime.jsx)(SessionNodeItem,{node,currentId:current,now,onOpen:open,onRenameRequest:onSessionRenameRequest,renderSlot,renderFactorySlot,useContextMenu,useContextMenuTarget,home,useSessionAccess,t,
      mycatLead:(0,react_jsx_runtime.jsx)(MycatSessionIcon,{node,statusKey:keyOf(node),entry:saved?.[node.id]}),mycatTag:tagOf(node)},node.id))})
  ]});
}
var MycatSafe=class extends react.Component{constructor(props){super(props);this.state={failed:false}}static getDerivedStateFromError(){return{failed:true}}componentDidCatch(error){this.props.onFail?.();try{fetch('/api/mycat/log',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({message:'render failed ('+(this.props.part||'?')+'): '+String(error&&error.stack||error)})})}catch(_){}}render(){return this.state.failed?(this.props.fallback??null):this.props.children}};
const mycatSafe=(part,element,fallback,onFail)=>(0,react_jsx_runtime.jsx)(MycatSafe,{part,fallback,onFail,children:element});

/* v18 设置页「会话管理」：列表 + 搜索 + 分 tab + 批量动作（每批 <=50，删除两步确认）。 */
function MycatSessionsPanel(){
  const [tab,setTab]=(0,react.useState)('all');
  const [query,setQuery]=(0,react.useState)('');
  const [rows,setRows]=(0,react.useState)(null);
  const [trashRows,setTrashRows]=(0,react.useState)(null);
  const [selected,setSelected]=(0,react.useState)(()=>[]);
  const [busy,setBusy]=(0,react.useState)(false);
  const [armedDelete,setArmedDelete]=(0,react.useState)(false);
  const [summary,setSummary]=(0,react.useState)(null);
  const [error,setError]=(0,react.useState)(null);
  const loadSessions=async()=>{
    try{
      const data=await mycatRequestJson('/api/mycat/sessions');
      if(!data.ok)throw new Error(data.error||'读取失败');
      setRows(mycatSessionListOf(data));
      setError(null);
    }catch(e){
      setRows(prev=>prev===null?[]:prev);
      setError(String(e&&e.message||e));
    }
  };
  const loadTrashRows=async()=>{
    try{
      const data=await mycatRequestJson('/api/mycat/trash');
      if(!data.ok)throw new Error(data.error||'读取失败');
      setTrashRows(mycatTrashEntriesOf(data));
    }catch(e){
      setTrashRows(prev=>prev===null?[]:prev);
    }
  };
  const reloadAll=()=>{loadSessions();loadTrashRows()};
  (0,react.useEffect)(()=>{reloadAll()},[]);
  const sessionRows=rows||[];
  const trashList=trashRows||[];
  const selectedSet=new Set(selected);
  const pickTab=key=>{setTab(key);setSelected([]);setArmedDelete(false);setSummary(null)};
  const togglePick=id=>{setArmedDelete(false);setSelected(prev=>prev.includes(id)?prev.filter(item=>item!==id):[...prev,id])};
  const term=query.trim().toLowerCase();
  const visibleRows=(0,react.useMemo)(()=>{
    if(tab==='trash')return trashList.filter(item=>mycatMatchesQuery([item.title,item.sessionId],term));
    const filtered=term===''?sessionRows:sessionRows.filter(item=>mycatMatchesQuery([item.title,item.sessionId,item.workspace,item.workspaceId],term));
    if(tab==='pinned')return filtered.filter(item=>item.pinned);
    if(tab==='archived')return filtered.filter(item=>item.archived);
    return filtered;
  },[tab,term,sessionRows,trashList]);
  const allPicked=visibleRows.length>0&&visibleRows.every(item=>selectedSet.has(item.sessionId));
  const togglePickAll=()=>{
    setArmedDelete(false);
    setSelected(prev=>{
      const next=new Set(prev);
      if(allPicked){for(const item of visibleRows)next.delete(item.sessionId)}
      else{for(const item of visibleRows)next.add(item.sessionId)}
      return [...next];
    });
  };
  const runAction=async(action)=>{
    if(busy)return;
    const ids=selected.slice();
    if(ids.length===0)return;
    setBusy(true);setArmedDelete(false);setSummary(null);
    let succeeded=0,failed=0;
    const reasons=new Map();
    for(let start=0;start<ids.length;start+=MYCAT_SESSIONS_CHUNK){
      const chunk=ids.slice(start,start+MYCAT_SESSIONS_CHUNK);
      try{
        const data=await mycatRequestJson('/api/mycat/sessions/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,sessionIds:chunk})});
        if(!data.ok)throw new Error(data.error||'操作失败');
        const results=Array.isArray(data.results)?data.results:[];
        if(results.length===0){
          const okCount=Number(data.succeeded),failCount=Number(data.failed);
          if(Number.isFinite(okCount)||Number.isFinite(failCount)){succeeded+=Number.isFinite(okCount)?okCount:0;failed+=Number.isFinite(failCount)?failCount:0}
          else succeeded+=chunk.length;
        }else{
          for(const result of results){
            if(result&&result.ok===true)succeeded++;
            else{
              failed++;
              const reason=String((result&&result.error)||'未知错误');
              reasons.set(reason,(reasons.get(reason)||0)+1);
            }
          }
        }
      }catch(e){
        failed+=chunk.length;
        const reason=String(e&&e.message||e);
        reasons.set(reason,(reasons.get(reason)||0)+chunk.length);
      }
    }
    setSummary({action,succeeded,failed,reasons:[...reasons.entries()].slice(0,3).map(entry=>({text:entry[0],count:entry[1]}))});
    setSelected([]);
    await Promise.all([loadSessions(),loadTrashRows()]);
    // 官方会话列表与 MYCAT 状态一起刷新；拿不到 sessions service 时 store 里会静默跳过。
    try{MYCAT.load()}catch(_){}
    try{MYCAT.loadTrash()}catch(_){}
    try{MYCAT.refreshSessionList()}catch(_){}
    setBusy(false);
  };
  const countOf=item=>{
    if(item.key==='trash')return trashRows===null?'…':trashList.length;
    if(rows===null)return '…';
    if(item.key==='all')return sessionRows.length;
    if(item.key==='pinned')return sessionRows.filter(row=>row.pinned).length;
    return sessionRows.filter(row=>row.archived).length;
  };
  const buttons=tab==='trash'
    ?[{action:'restore',label:'恢复'}]
    :[{action:'pin',label:'置顶'},{action:'unpin',label:'取消置顶'},{action:'archive',label:'归档'},{action:'unarchive',label:'取消归档'}];
  const actionsDisabled=selected.length===0||busy;
  const rowTime=item=>{
    const value=tab==='trash'?item.deletedAt:item.createdAt;
    return value>0?mycatRelTime(value):'';
  };
  const rowBadges=item=>{
    if(tab==='trash')return [{kind:'trash',text:'回收站'}];
    const badges=[];
    if(item.pinned)badges.push({kind:'pinned',text:'置顶'});
    if(item.archived)badges.push({kind:'archived',text:'归档'});
    if(item.running)badges.push({kind:'running',text:'运行中'});
    if(item.status!=='')badges.push({kind:'status-'+item.status,text:mycatStatusLabel(item.status)});
    return badges;
  };
  const emptyHint=tab==='trash'
    ?(trashRows===null?'加载中…':(query.trim()!==''?'回收站里没有匹配的会话':'回收站是空的'))
    :(rows===null?'加载中…':(query.trim()!==''?'没有匹配的会话':(tab==='pinned'?'没有置顶会话':tab==='archived'?'没有归档会话':'还没有会话')));
  const rowOf=item=>{
    const title=item.title!==''?item.title:item.sessionId;
    const badges=rowBadges(item);
    const wsText=tab==='trash'?'':(item.workspace!==''?item.workspace:item.workspaceId);
    const timeText=rowTime(item);
    const sizeText=tab==='trash'&&item.sizeBytes>0?mycatBytes(item.sizeBytes):'';
    return (0,react_jsx_runtime.jsxs)('label',{className:'myc-mgr-row','data-mycat-row':item.sessionId,children:[
      (0,react_jsx_runtime.jsx)('input',{type:'checkbox','data-mycat-pick':item.sessionId,checked:selectedSet.has(item.sessionId),disabled:busy,onChange:()=>togglePick(item.sessionId)}),
      (0,react_jsx_runtime.jsxs)('span',{className:'myc-mgr-main',children:[
        (0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-title',title:title,children:title}),
        badges.length>0?(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-badges',children:badges.map(badge=>(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-badge','data-kind':badge.kind,children:badge.text},badge.kind))}):null,
      ]}),
      sizeText!==''?(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-ws',children:sizeText}):null,
      wsText!==''?(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-ws',title:wsText,children:wsText}):null,
      timeText!==''?(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-time',children:timeText}):null,
    ]},item.sessionId);
  };
  return (0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr','data-mycat-sessions':'',children:[
    (0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-bar',children:(0,react_jsx_runtime.jsx)('input',{type:'search',id:'mycat-mgr-search',className:'myc-mgr-search',placeholder:'搜索标题 / 工作区 / 会话 ID','aria-label':'搜索会话',value:query,onChange:e=>{setQuery(e.target.value);setArmedDelete(false)}})}),
    (0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-tabs',children:MYCAT_SESSION_TABS.map(item=>(0,react_jsx_runtime.jsxs)('button',{type:'button',className:'myc-mgr-tab','data-mycat-tab':item.key,'aria-pressed':tab===item.key,onClick:()=>pickTab(item.key),children:[item.label,' ',String(countOf(item))]},item.key))}),
    (0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-acts',children:[
      buttons.map(item=>(0,react_jsx_runtime.jsx)('button',{type:'button','data-mycat-action':item.action,disabled:actionsDisabled,onClick:()=>runAction(item.action),children:item.label},item.action)),
      tab==='trash'?null:(0,react_jsx_runtime.jsx)('button',{type:'button','data-mycat-action':'delete','data-danger':'','data-armed':armedDelete?'':void 0,disabled:actionsDisabled,onClick:()=>{if(armedDelete)runAction('delete');else setArmedDelete(true)},children:armedDelete?`确认删除 ${selected.length} 个`:'删除'}),
    ]}),
    summary!==null?(0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-summary','data-mycat-mgr-summary':'',children:[
      (0,react_jsx_runtime.jsx)('span',{children:(MYCAT_ACTION_LABEL[summary.action]||summary.action)+'：成功 '+summary.succeeded+' / 失败 '+summary.failed}),
      summary.reasons.length>0?(0,react_jsx_runtime.jsx)('span',{className:'myc-mgr-reasons',children:'失败原因：'+summary.reasons.map(reason=>reason.text+'（'+reason.count+' 个）').join('；')}):null,
    ]}):null,
    error!==null?(0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-error',children:['会话列表读取失败：'+error,(0,react_jsx_runtime.jsx)('button',{type:'button','data-mycat-mgr-retry':'',onClick:reloadAll,children:'重试'})]}):null,
    (0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-list',children:[
      (0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-head',children:[
        (0,react_jsx_runtime.jsx)('input',{type:'checkbox','data-mycat-pick-all':'',checked:allPicked,disabled:visibleRows.length===0||busy,onChange:togglePickAll,'aria-label':'全选当前列表'}),
        (0,react_jsx_runtime.jsxs)('span',{children:['共 ',String(visibleRows.length),' 个 · 已选 ',String(selected.length),' 个']}),
        busy?(0,react_jsx_runtime.jsx)('span',{children:'执行中…'}):null,
      ]}),
      visibleRows.length===0
        ?(0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-empty',children:emptyHint})
        :(0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-rows',children:visibleRows.map(rowOf)}),
    ]}),
  ]});
}
/* v18 设置页「统计」：GET /api/mycat/stats，加载失败只显示提示，不抛给外层错误边界。 */
function MycatStatsPanel(){
  const [state,setState]=(0,react.useState)({status:'loading',stats:null,error:null});
  const loadStats=async()=>{
    setState({status:'loading',stats:null,error:null});
    try{
      const data=await mycatRequestJson('/api/mycat/stats');
      if(!data.ok)throw new Error(data.error||'读取失败');
      setState({status:'ready',stats:mycatStatsOf(data),error:null});
    }catch(e){
      setState({status:'error',stats:null,error:String(e&&e.message||e)});
    }
  };
  (0,react.useEffect)(()=>{loadStats()},[]);
  const stats=state.stats;
  const items=stats===null?[]:[
    {key:'total',label:'会话总数',value:stats.total},
    {key:'live',label:'运行中',value:stats.live},
    {key:'pinned',label:'置顶',value:stats.pinned},
    {key:'archived',label:'归档',value:stats.archived},
    {key:'trash',label:'回收站',value:stats.trashCount,sub:mycatBytes(stats.trashBytes)},
    {key:'pendingDeletes',label:'待删队列',value:stats.pendingDeletes},
    {key:'last7daysNew',label:'近 7 天新建',value:stats.last7daysNew},
    {key:'waitAuto',label:'等我处理',value:stats.waitAuto},
    {key:'blocked',label:'卡点',value:stats.blocked},
  ];
  const top=stats===null?[]:stats.workspaces.slice(0,5);
  return (0,react_jsx_runtime.jsxs)('div',{className:'myc-stats','data-mycat-stats':'',children:[
    state.status==='loading'?(0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-empty',children:'统计加载中…'}):null,
    state.status==='error'?(0,react_jsx_runtime.jsxs)('div',{className:'myc-mgr-error',children:['统计读取失败：'+state.error,(0,react_jsx_runtime.jsx)('button',{type:'button','data-mycat-stats-retry':'',onClick:()=>loadStats(),children:'重试'})]}):null,
    state.status==='ready'?(0,react_jsx_runtime.jsx)('div',{className:'myc-stat-grid',children:items.map(item=>(0,react_jsx_runtime.jsxs)('div',{className:'myc-stat','data-mycat-stat':item.key,children:[
      (0,react_jsx_runtime.jsx)('b',{children:String(item.value)}),
      (0,react_jsx_runtime.jsx)('span',{children:item.label}),
      item.sub?(0,react_jsx_runtime.jsx)('span',{className:'myc-stat-sub',children:item.sub}):null,
    ]},item.key))}):null,
    state.status==='ready'&&top.length>0?(0,react_jsx_runtime.jsxs)('div',{children:[
      (0,react_jsx_runtime.jsx)('div',{className:'myc-stat-ws-title',children:'工作区分布（前 5）'}),
      (0,react_jsx_runtime.jsx)('div',{className:'myc-stat-ws',role:'list',children:top.map(workspace=>(0,react_jsx_runtime.jsxs)('div',{className:'myc-stat-ws-row',role:'listitem','data-mycat-stat-ws':workspace.workspaceId||workspace.title,children:[
        (0,react_jsx_runtime.jsx)('span',{title:workspace.title,children:workspace.title}),
        (0,react_jsx_runtime.jsx)('b',{children:workspace.count+' 个'}),
      ]},workspace.workspaceId||workspace.title))}),
    ]}):null,
    state.status==='ready'&&top.length===0?(0,react_jsx_runtime.jsx)('div',{className:'myc-mgr-empty',children:'还没有工作区数据'}):null,
  ]});
}
/* 设置页：状态配色 + 状态图例 + 回收站（settings.section 插槽） */
function MycatSettings(){
  const theme=useMycat(s=>(s.ui||{}).theme||'mono');
  const trash=useMycat(s=>s.trash)||{count:0,bytes:0};
  const pendingDeletes=useMycat(s=>s.pendingDeletes)||0;
  const trashBusy=useMycat(s=>s.trashBusy);
  const prefs=useMycat(s=>s.prefs)||mycatPrefsOf(null);
  const prefsBusy=useMycat(s=>s.prefsBusy)===true;
  const [prefDraft,setPrefDraft]=(0,react.useState)(null);
  (0,react.useEffect)(()=>{setPrefDraft(prefs)},[prefs.requireReview,prefs.notifyWait,prefs.trashKeepDays,prefs.trashMaxMB]);
  const prefsNow=prefDraft===null?prefs:prefDraft;
  const savePrefsNow=()=>{MYCAT.savePrefs({requireReview:prefsNow.requireReview===true,notifyWait:prefsNow.notifyWait===true,trashKeepDays:prefsNow.trashKeepDays,trashMaxMB:prefsNow.trashMaxMB}).then(ok=>{if(ok)setPrefDraft(null)})};
  (0,react.useEffect)(()=>{MYCAT.loadTrash()},[]);
  const preview=MYCAT_SESSION.map(session=>({i:session.i,c:session.c}));
  return (0,react_jsx_runtime.jsxs)('div',{className:'myc-set',children:[
    (0,react_jsx_runtime.jsx)('h3',{children:'状态配色'}),
    (0,react_jsx_runtime.jsx)('p',{className:'hint',children:'只换颜色，形状不变；切换立即生效，不需要重启。'}),
    (0,react_jsx_runtime.jsx)('div',{className:'cards',children:MYCAT_THEME_LIST.map(option=>{
      return (0,react_jsx_runtime.jsxs)('button',{type:'button',className:'card','data-on':option.key===theme?'':void 0,onClick:()=>MYCAT.setTheme(option.key),children:[
        (0,react_jsx_runtime.jsx)('span',{className:'icons',children:preview.map((item,index)=>(0,react_jsx_runtime.jsx)(MycatSvg,{icon:item.i,color:MYCAT_THEME_COLOR[option.key]||item.c},option.key+index))}),
        (0,react_jsx_runtime.jsx)('b',{children:option.label}),
        (0,react_jsx_runtime.jsx)('span',{children:option.desc}),
      ]},option.key)
    })}),
    (0,react_jsx_runtime.jsx)('h3',{children:'状态图例'}),
    (0,react_jsx_runtime.jsx)('ul',{className:'legend',children:MYCAT_SESSION.map(session=>{
      return (0,react_jsx_runtime.jsxs)('li',{children:[
        (0,react_jsx_runtime.jsx)(MycatSvg,{icon:session.i,color:mycColor(session.c)}),
        (0,react_jsx_runtime.jsx)('b',{children:session.label}),
        (0,react_jsx_runtime.jsx)('em',{children:MYCAT_MEANING[session.label]||''}),
      ]},session.key)
    })}),
    (0,react_jsx_runtime.jsx)('h3',{children:'通用设置'}),
    (0,react_jsx_runtime.jsx)('p',{className:'hint',children:'保存在 ~/.dsh/mycat/prefs.json，改完即生效，不需要改配置或重装。'}),
    (0,react_jsx_runtime.jsxs)('div',{className:'prefs',children:[
      (0,react_jsx_runtime.jsxs)('label',{className:'pref',children:[(0,react_jsx_runtime.jsx)('input',{type:'checkbox',id:'mycat-pref-review',checked:prefsNow.requireReview===true,onChange:e=>setPrefDraft(prev=>({...((prev===null||prev===undefined)?prefs:prev),requireReview:e.target.checked}))}),'新建会话前需要用户审核（requireReview）']}),
      (0,react_jsx_runtime.jsxs)('label',{className:'pref',children:[(0,react_jsx_runtime.jsx)('input',{type:'checkbox',id:'mycat-pref-notify-wait',checked:prefsNow.notifyWait===true,onChange:e=>setPrefDraft(prev=>({...((prev===null||prev===undefined)?prefs:prev),notifyWait:e.target.checked}))}),'会话完成、等我处理时发系统通知（notifyWait）']}),
      (0,react_jsx_runtime.jsxs)('label',{className:'pref',children:['回收站保留',(0,react_jsx_runtime.jsx)('input',{type:'number',id:'mycat-pref-days',min:1,max:3650,value:String(prefsNow.trashKeepDays),onChange:e=>setPrefDraft(prev=>({...((prev===null||prev===undefined)?prefs:prev),trashKeepDays:Number(e.target.value)}))}),'天']}),
      (0,react_jsx_runtime.jsxs)('label',{className:'pref',children:['回收站上限',(0,react_jsx_runtime.jsx)('input',{type:'number',id:'mycat-pref-mb',min:1,max:102400,value:String(prefsNow.trashMaxMB),onChange:e=>setPrefDraft(prev=>({...((prev===null||prev===undefined)?prefs:prev),trashMaxMB:Number(e.target.value)}))}),'MB']}),
      (0,react_jsx_runtime.jsx)('button',{type:'button',id:'mycat-prefs-save',disabled:prefsBusy,onClick:savePrefsNow,children:prefsBusy?'保存中…':'保存设置'}),
    ]}),
    (0,react_jsx_runtime.jsx)('h3',{children:'会话管理'}),
    (0,react_jsx_runtime.jsx)('p',{className:'hint',children:'搜索、批量置顶/归档/删除；删除先进回收站，可在「回收站」tab 恢复。'}),
    (0,react_jsx_runtime.jsx)(MycatSessionsPanel,{}),
    (0,react_jsx_runtime.jsx)('h3',{children:'回收站'}),
    (0,react_jsx_runtime.jsx)('p',{className:'hint',children:'删除的会话会先进回收站，会话目录可恢复；清空后不可撤销。'}),
    (0,react_jsx_runtime.jsxs)('div',{className:'trash',children:[
      (0,react_jsx_runtime.jsxs)('div',{className:'meta',children:[
        (0,react_jsx_runtime.jsx)('b',{children:`回收站：${trash.count} 个会话 · ${mycatBytes(trash.bytes)}`}),
        (0,react_jsx_runtime.jsx)('span',{children:`待删队列：${pendingDeletes} 个会话`}),
      ]}),
      (0,react_jsx_runtime.jsx)('button',{type:'button',id:'mycat-trash-empty',disabled:trashBusy||trash.count===0,onClick:()=>MYCAT.emptyTrash(),children:trashBusy?'清空中…':'清空回收站'}),
    ]}),
    (0,react_jsx_runtime.jsx)('h3',{children:'统计'}),
    (0,react_jsx_runtime.jsx)('p',{className:'hint',children:'MYCAT 当前会话概览，打开设置时读取一次。'}),
    (0,react_jsx_runtime.jsx)(MycatStatsPanel,{}),
  ]});
}
function MycatSettingsSafe(){return mycatSafe('settings',(0,react_jsx_runtime.jsx)(MycatSettings,{}))}
