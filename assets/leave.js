/* Account-specific leave ledger. All writes are also authorized by the server. */
const OwnerLeave = (() => {
  const eligible = () => Number(currentUser?.id) === 29 && currentUser?.is_active === true;
  const el = id => document.getElementById(id);
  const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const excluded = r => r.request_kind === 'support' || /정수|지원|청원휴가|건강검진휴가/.test((r.reason || '').replace(/\s/g,''));
  function calculate(rows, year, reset, total, now = today()) {
    const start = `${year}-${reset}`, end = `${year+1}-${reset}`;
    const valid = rows.filter(r => !excluded(r));
    const count = (kind, from, to, planned=false) => valid.filter(r => (r.leave_kind || 'annual') === kind && r.shift_date >= from && r.shift_date < to && (planned ? r.shift_date > now : r.shift_date <= now)).length;
    const prior = count('annual',`${year-1}-01-01`,`${year}-01-01`);
    const reward = Math.min(4, Math.floor(prior/5));
    const annualUsed = count('annual',start,end), rewardUsed = count('reward',`${year}-01-01`,`${year+1}-01-01`);
    const rewardExpired=now > `${year}-12-31`;
    return {start,end,prior,reward,annualUsed,rewardUsed,rewardExpired,rewardUnused:reward-rewardUsed,annualPlanned:count('annual',start,end,true),rewardPlanned:count('reward',`${year}-01-01`,`${year+1}-01-01`,true),annualRemaining:total == null ? null : total-annualUsed,rewardRemaining:rewardExpired?0:reward-rewardUsed};
  }
  let version=0, rows=[];
  function refresh() { el('ownerLeaveTools').hidden=!eligible(); if(!eligible()) clear(); }
  function clear() { ++version; rows=[]; el('ownerLeaveTools').hidden=true; el('leaveResults').replaceChildren(); el('leaveStatus').textContent=''; if(el('leaveDialog').open)el('leaveDialog').close(); if(el('leaveKindDialog').open)el('leaveKindDialog').close(); }
  async function open() {
    if(!eligible())return;
    el('leaveYear').value=Number(today().slice(0,4)); el('leaveDialog').showModal(); await load();
  }
  async function load() {
    if(!eligible())return;
    const year=Number(el('leaveYear').value), seq=++version, token=currentSessionToken;
    el('leaveStatus').textContent='연차 기록을 불러오는 중…'; el('leaveResults').replaceChildren();
    const result=await callSessionRegistration({action:'leave_read',year});
    if(seq!==version || token!==currentSessionToken || !eligible() || !el('leaveDialog').open)return;
    if(!result.success){ el('leaveStatus').textContent=result.message || '조회하지 못했습니다.'; return; }
    rows=result.rows || [];
    el('leaveReset').value=result.settings?.reset || '01-01';
    el('leaveTotal').value=result.settings?.total ?? '';
    render(year,result.settings?.total ?? null);
  }
  function render(year,total) {
    const reset=el('leaveReset').value;
    const s=calculate(rows,year,reset,total);
    const box=el('leaveResults'); box.replaceChildren();
    const p=document.createElement('p');
    p.textContent=`일반 연차 (${s.start}부터 다음 리셋일 전날까지)\n총 ${total ?? '미설정'}일 · 사용 ${s.annualUsed}일 · 예정 ${s.annualPlanned}일 · 잔여 ${s.annualRemaining ?? '미설정'}일\n\n보상 연차 (${year}-01-01 ~ ${year}-12-31)\n총 ${s.reward}일 · 사용 ${s.rewardUsed}일 · 예정 ${s.rewardPlanned}일 · 잔여 ${s.rewardRemaining}일${s.rewardExpired?' (사용 기간 종료 · 미사용 '+Math.max(0,s.rewardUnused)+'일 만료)':''}\n전년도 일반 연차 사용 ${s.prior}일 기준 · 5일당 1일, 최대 4일`;
    p.style.whiteSpace='pre-line'; box.append(p);
    const unclassified=rows.filter(r=>!excluded(r)&&!r.leave_kind).length;
    el('leaveStatus').textContent=unclassified ? `종류가 없는 기존 기록 ${unclassified}건은 일반 연차로 잠정 계산합니다. 아래 목록에서 보상 연차 사용 기록을 정정해 주세요. 과거 기록이 누락되면 보상 연차도 달라질 수 있습니다.` : '예정분은 잔여에서 차감하지 않습니다. 오늘 날짜의 휴무는 사용으로 계산합니다. 과거 기록이 모두 등록됐는지 확인해 주세요.';
    for(const r of rows) {
      const line=document.createElement('div');line.className='leave-record';
      const label=document.createElement('span');label.textContent=`${r.shift_date} · ${r.reason || '사유 없음'}${excluded(r)?' (집계 제외)':''}`;line.append(label);
      if(!excluded(r)) {
        const select=document.createElement('select');select.setAttribute('aria-label',`${r.shift_date} 연차 종류`);
        for(const [value,text] of [['annual',r.leave_kind?'일반 연차':'일반 연차 (기존 기록)'],['reward','보상 연차']]){const o=new Option(text,value);select.add(o);}
        select.value=r.leave_kind || 'annual';
        select.onchange=async()=>{
          const token=currentSessionToken;select.disabled=true;
          const result=await callSessionRegistration({action:'leave_classify',request_id:r.id,leave_kind:select.value});
          if(token!==currentSessionToken||!eligible())return;
          if(!result.success){alert(result.message || '저장하지 못했습니다.');select.value=r.leave_kind || 'annual';select.disabled=false;}else await load();
        };
        line.append(select);
      }
      box.append(line);
    }
  }
  async function save() {
    if(!eligible())return;
    if(!el('leaveSettings').reportValidity())return;
    const token=currentSessionToken, button=el('leaveSave');button.disabled=true;
    try {
      const result=await callSessionRegistration({action:'leave_settings',year:Number(el('leaveYear').value),reset:el('leaveReset').value,total:Number(el('leaveTotal').value)});
      if(token!==currentSessionToken||!eligible())return;
      if(!result.success)alert(result.message || '저장하지 못했습니다.');else await load();
    } finally {button.disabled=false;}
  }
  function choose() {
    if(!eligible())return Promise.resolve(null);
    return new Promise(resolve=>{
      const dialog=el('leaveKindDialog');dialog.returnValue='';
      dialog.addEventListener('close',()=>resolve(['annual','reward'].includes(dialog.returnValue)?dialog.returnValue:null),{once:true});dialog.showModal();
    });
  }
  return {eligible,refresh,clear,open,load,save,choose,calculate};
})();
