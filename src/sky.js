/* ============================================================
   Sky — deling mellem to telefoner via Supabase.
   Rå fetch, ingen biblioteker: appen skal kunne ligge som én fil
   og stadig virke uden net.
   ============================================================ */
const Sky = (function(){
  const NØGLE_CFG = 'toget.sky.cfg';
  const NØGLE_SES = 'toget.sky.session';
  const NØGLE_HUS = 'toget.sky.husstand';

  let cfg = null, session = null, husstandId = null;
  let lytter = null, timer = null, sidsteVersion = 0;

  const læs = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } };
  const skriv = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

  cfg = læs(NØGLE_CFG);
  session = læs(NØGLE_SES);
  husstandId = læs(NØGLE_HUS);

  const opsat = () => !!(cfg && cfg.url && cfg.key);
  const loggetInd = () => !!(session && session.access_token);

  function fejlTekst(data, res){
    const m = (data && (data.error_description || data.msg || data.message || data.error)) || '';
    if (/Invalid login credentials/i.test(m)) return 'Forkert mail eller adgangskode';
    if (/Email not confirmed/i.test(m)) return 'Bekræft din mail først — tjek indbakken';
    if (/User already registered/i.test(m)) return 'Der findes allerede en bruger med den mail — log ind i stedet';
    if (/Password should be/i.test(m)) return 'Adgangskoden skal være mindst 6 tegn';
    if (/kun være to personer/i.test(m)) return 'Der er allerede to personer i den husstand';
    if (/duplicate key/i.test(m)) return 'Du er allerede med i den husstand';
    if (m) return m;
    return 'Noget gik galt (' + (res ? res.status : '?') + ')';
  }

  async function kald(sti, {metode = 'GET', krop, auth = true, headers = {}} = {}){
    if (!opsat()) throw new Error('Skyen er ikke sat op endnu');
    const h = Object.assign({
      'apikey': cfg.key,
      'content-type': 'application/json'
    }, headers);
    if (auth && session && session.access_token) h['authorization'] = 'Bearer ' + session.access_token;

    const res = await fetch(cfg.url.replace(/\/$/, '') + sti, {
      method: metode,
      headers: h,
      body: krop === undefined ? undefined : JSON.stringify(krop)
    });
    const tekst = await res.text();
    let data = null;
    try { data = tekst ? JSON.parse(tekst) : null; } catch(e){ data = tekst; }
    if (!res.ok){
      // Udløbet token: forny én gang og prøv igen.
      if (res.status === 401 && auth && session && session.refresh_token && !sti.includes('/auth/v1/token')){
        const fornyet = await forny();
        if (fornyet) return kald(sti, {metode, krop, auth, headers});
      }
      const e = new Error(fejlTekst(data, res));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  async function forny(){
    try {
      const data = await kald('/auth/v1/token?grant_type=refresh_token',
        {metode:'POST', krop:{refresh_token: session.refresh_token}, auth:false});
      gemSession(data);
      return true;
    } catch(e){
      gemSession(null);
      return false;
    }
  }

  function gemSession(data){
    session = data && data.access_token ? data : null;
    skriv(NØGLE_SES, session);
  }

  /* ---------------- opsætning og login ---------------- */
  function konfigurer(url, key){
    if (!/^https:\/\/.+\.supabase\.co\/?$/.test(url.trim()))
      throw new Error('URL\'en skal se ud som https://xxxx.supabase.co');
    if (!key.trim() || key.trim().length < 30) throw new Error('Nøglen ser ikke rigtig ud');
    cfg = {url: url.trim().replace(/\/$/, ''), key: key.trim()};
    skriv(NØGLE_CFG, cfg);
  }

  async function opret(email, kode){
    const data = await kald('/auth/v1/signup', {metode:'POST', krop:{email, password: kode}, auth:false});
    if (data && data.access_token) gemSession(data);
    // Uden access_token kræver projektet mailbekræftelse.
    return {bekræftKrævet: !(data && data.access_token)};
  }

  async function login(email, kode){
    const data = await kald('/auth/v1/token?grant_type=password',
      {metode:'POST', krop:{email, password: kode}, auth:false});
    gemSession(data);
    return data;
  }

  function logUd(){
    gemSession(null);
    husstandId = null; skriv(NØGLE_HUS, null);
    stopLytning();
  }

  const brugerId = () => (session && session.user && session.user.id) || null;
  const brugerMail = () => (session && session.user && session.user.email) || null;

  /* ---------------- husstand ---------------- */
  const ORD1 = ['GROEN','BLAA','ROED','GUL','HVID','SORT','VARM','KOLD','STOR','LILLE'];
  const ORD2 = ['HAVRE','KANEL','PORRE','SALVIE','TIMIAN','HYLDE','MYNTE','LAKRIDS','ANIS','PEBER'];
  function nyKode(){
    const t = (n) => n[Math.floor(Math.random() * n.length)];
    return t(ORD1) + '-' + t(ORD2) + '-' + (10 + Math.floor(Math.random() * 90));
  }

  async function opretHusstand(navn, mitNavn, doc){
    let sidsteFejl = null;
    for (let forsøg = 0; forsøg < 5; forsøg++){
      const kode = nyKode();
      try {
        const rows = await kald('/rest/v1/husstande', {
          metode:'POST',
          krop:{navn: navn || 'Vores husstand', kode, doc: doc || {}, version: 1},
          headers:{'prefer':'return=representation'}
        });
        const h = rows[0];
        await kald('/rest/v1/medlemmer', {
          metode:'POST',
          krop:{husstand_id: h.id, bruger_id: brugerId(), navn: mitNavn || 'Mig', rolle:'ejer'},
          headers:{'prefer':'return=representation'}
        });
        husstandId = h.id; skriv(NØGLE_HUS, husstandId);
        sidsteVersion = h.version;
        return h;
      } catch(e){
        sidsteFejl = e;
        if (!/duplicate key|kode/i.test(e.message)) throw e;   // kun kodesammenstød prøves igen
      }
    }
    throw sidsteFejl || new Error('Kunne ikke oprette husstanden');
  }

  async function tilslut(kode, mitNavn){
    const fundet = await kald('/rest/v1/rpc/find_husstand', {metode:'POST', krop:{p_kode: kode}});
    const h = Array.isArray(fundet) ? fundet[0] : fundet;
    if (!h) throw new Error('Den kode findes ikke');
    if (h.antal >= 2) throw new Error('Der er allerede to personer i den husstand');
    await kald('/rest/v1/medlemmer', {
      metode:'POST',
      krop:{husstand_id: h.id, bruger_id: brugerId(), navn: mitNavn || 'Mig', rolle:'medlem'},
      headers:{'prefer':'return=representation'}
    });
    husstandId = h.id; skriv(NØGLE_HUS, husstandId);
    return h;
  }

  async function minHusstand(){
    const rows = await kald('/rest/v1/medlemmer?select=husstand_id,navn,rolle&bruger_id=eq.' + brugerId());
    if (!rows || !rows.length) return null;
    husstandId = rows[0].husstand_id; skriv(NØGLE_HUS, husstandId);
    return husstandId;
  }

  async function medlemmer(){
    if (!husstandId) return [];
    return await kald('/rest/v1/medlemmer?select=bruger_id,navn,rolle&husstand_id=eq.' + husstandId) || [];
  }

  async function saetMitNavn(navn){
    await kald('/rest/v1/medlemmer?husstand_id=eq.' + husstandId + '&bruger_id=eq.' + brugerId(),
      {metode:'PATCH', krop:{navn}});
  }

  async function forlad(){
    await kald('/rest/v1/medlemmer?husstand_id=eq.' + husstandId + '&bruger_id=eq.' + brugerId(), {metode:'DELETE'});
    husstandId = null; skriv(NØGLE_HUS, null);
    stopLytning();
  }

  /* ---------------- dokumentet ---------------- */
  async function hent(){
    if (!husstandId) return null;
    const rows = await kald('/rest/v1/husstande?select=id,navn,kode,doc,version,opdateret&id=eq.' + husstandId);
    if (!rows || !rows.length) return null;
    sidsteVersion = rows[0].version;
    return rows[0];
  }

  /**
   * Gemmer kun hvis ingen andre har gemt i mellemtiden.
   * Er der sket noget, får kalderen den nye udgave og kan flette.
   */
  async function gem(doc, forventetVersion){
    const v = forventetVersion == null ? sidsteVersion : forventetVersion;
    const rows = await kald(
      '/rest/v1/husstande?id=eq.' + husstandId + '&version=eq.' + v,
      {metode:'PATCH', krop:{doc, version: v + 1}, headers:{'prefer':'return=representation'}});
    if (!rows || !rows.length){
      const frisk = await hent();
      return {konflikt:true, frisk};
    }
    sidsteVersion = rows[0].version;
    return {konflikt:false, version: sidsteVersion};
  }

  /* ---------------- hold øje med den anden telefon ---------------- */
  function startLytning(kald_tilbage, sekunder){
    stopLytning();
    lytter = kald_tilbage;
    const tjek = async () => {
      if (document.hidden || !husstandId || !loggetInd()) return;
      try {
        const rows = await kald('/rest/v1/husstande?select=version&id=eq.' + husstandId);
        const v = rows && rows[0] ? rows[0].version : 0;
        if (v > sidsteVersion){
          const frisk = await hent();
          if (frisk && lytter) lytter(frisk);
        }
      } catch(e){ /* uden net prøver vi igen næste gang */ }
    };
    timer = setInterval(tjek, (sekunder || 8) * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tjek(); });
    tjek();
  }
  function stopLytning(){ if (timer) clearInterval(timer); timer = null; lytter = null; }

  return {
    opsat, loggetInd, konfigurer, glemOpsætning: () => { skriv(NØGLE_CFG, null); cfg = null; },
    opret, login, logUd, brugerId, brugerMail,
    opretHusstand, tilslut, minHusstand, medlemmer, saetMitNavn, forlad,
    harHusstand: () => !!husstandId, husstandsId: () => husstandId,
    hent, gem, startLytning, stopLytning,
    get version(){ return sidsteVersion; }
  };
})();
