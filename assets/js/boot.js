(function(){
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
  const persistIds=['toggle-traffic','toggle-frames','toggle-hgv-allowed','toggle-hgv-conditional','toggle-federal'];
  document.addEventListener('DOMContentLoaded',()=>{
    persistIds.forEach(id=>{
      const el=document.getElementById(id);
      if(!el) return;
      const key='TT_'+id;
      const saved=localStorage.getItem(key);
      if(saved!==null) el.checked=saved==='1';
      el.addEventListener('change',()=>localStorage.setItem(key,el.checked?'1':'0'));
    });
    const t=document.getElementById('toggle-traffic');
    const applyTraffic=()=>window.__tt_setTraffic?.(t.checked);
    if(t){
      t.addEventListener('change',applyTraffic);
      if(window.ymaps&&ymaps.ready) ymaps.ready(applyTraffic); else window.addEventListener('load',applyTraffic);
    }
    const btn=document.getElementById('shareRouteBtn');
    if(btn){
      btn.addEventListener('click',()=>{
        const h=window.__tt_makeShareHash?.();
        if(!h) return (window.toast?.('Укажи A и B')||alert('Укажи A и B'));
        const url=location.origin+location.pathname+location.search+h;
        if(navigator.clipboard?.writeText) navigator.clipboard.writeText(url).catch(()=>{}); else {
          const ta=document.createElement('textarea');
          ta.value=url; ta.style.position='fixed'; ta.style.opacity='0';
          document.body.appendChild(ta); ta.focus(); ta.select();
          try{document.execCommand('copy');}catch{}
          document.body.removeChild(ta);
        }
        (window.toast?.('Ссылка скопирована')||alert('Ссылка скопирована'));
        history.replaceState(null,'',h);
      });
    }
  });
  function b64EncodeUnicodeObj(obj){
    const str=JSON.stringify(obj);
    if(window.TextEncoder){
      const bytes=new TextEncoder().encode(str);
      let bin='';
      for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64DecodeUnicodeToObj(b64){
    try{
      const bin=atob(b64);
      if(window.TextDecoder){
        const bytes=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
      }
      return JSON.parse(decodeURIComponent(escape(bin)));
    }catch{return null}
  }
  window.__tt_makeShareHash=function(){
    const from=document.getElementById('from')?.value?.trim()||'';
    const to=document.getElementById('to')?.value?.trim()||'';
    const veh=(document.querySelector('input[name="veh"]:checked')||{}).value||'';
    if(!from||!to) return '';
    const payload={from,to,veh};
    const enc=b64EncodeUnicodeObj(payload);
    return enc?'#share='+encodeURIComponent(enc):'';
  };
  let __tt_lastShare=null;
  async function applyShare(){
    const m=location.hash.match(/^#share=([^&]+)/);
    if(!m) return;
    const raw=m[1];
    if(raw===__tt_lastShare) return;
    __tt_lastShare=raw;
    const payload=b64DecodeUnicodeToObj(decodeURIComponent(raw));
    if(!payload) return (window.toast?.('Некорректная ссылка')||alert('Некорректная ссылка'));
    const fromEl=document.getElementById('from');
    const toEl=document.getElementById('to');
    if(fromEl) fromEl.value=payload.from||'';
    if(toEl) toEl.value=payload.to||'';
    if(payload.veh){
      document.querySelectorAll('input[name="veh"]').forEach(r=>{
        r.checked=(r.value===payload.veh);
        r.dispatchEvent(new Event('change'));
      });
    }
    if(!payload.from||!payload.to) return;
    try{
      if(typeof window.onBuild==='function') await window.onBuild();
      else if(typeof window.buildRoute==='function') await window.buildRoute();
      else document.getElementById('buildBtn')?.click();
    }catch{}
  }
  window.addEventListener('hashchange',applyShare);
  window.addEventListener('DOMContentLoaded',applyShare);
  (function(){
    const tryInit=()=>{
      if(!window.ymaps||!document.getElementById('from')) return;
      try{ new ymaps.SuggestView('from'); new ymaps.SuggestView('to'); }catch{}
    };
    if(window.ymaps&&ymaps.ready) ymaps.ready(tryInit); else window.addEventListener('load',tryInit);
  })();
})();
