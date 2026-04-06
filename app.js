// Oxford Palliative Medicine — Main App
// Set this to your Cloudflare Worker URL after deploying worker/worker.js
const API_PROXY_URL = 'https://oxfordpal-api.hello-henryhe.workers.dev';
console.log("AUTO DEPLOY TEST");

// Constants
const FREE_WINDOW_ESTIMATE = 25;
const BATCH_SIZE_DEFAULT   = 7;
const SIMILARITY_THRESHOLD = 0.55;

const App = (() => {

  // Tag taxonomy — maps chunk IDs to clinical tags for dedup + sampling
  const CHUNK_TAGS = (() => {
    const map = {};
    const domainMap = {
      '1':'palliative-care-global','2':'palliative-care-principles','3':'service-delivery',
      '4':'multidisciplinary-team','5':'communication','6':'family-caregivers',
      '7':'pain-management','8':'gastrointestinal','9':'respiratory',
      '10':'skin-wound-oral','11':'genitourinary','12':'constitutional-symptoms',
      '13':'psychiatric-psychological','14':'oncology','15':'non-cancer-disease',
      '16':'paediatrics-elderly','17':'spiritual-care','18':'end-of-life',
      '19':'ethics','20':'assessment-tools','21':'education','22':'research',
    };
    const extra = {
      '7.1':['pain-assessment'],'7.2':['nociception','neurophysiology'],
      '7.3':['breakthrough-pain','incident-pain'],'7.4':['cancer-pain-syndromes'],
      '7.5':['analgesic-ladder','WHO-ladder'],'7.6a':['opioids','morphine','pharmacology'],
      '7.6b':['opioid-rotation','opioid-side-effects','tolerance'],
      '7.7':['opioid-misuse','addiction'],'7.8':['NSAIDs','paracetamol','non-opioid'],
      '7.9':['adjuvants','corticosteroids','antidepressants-pain'],
      '7.10':['nerve-block','intrathecal'],'7.11':['TENS','neurostimulation'],
      '7.14':['bone-metastases','bisphosphonates'],'7.15':['neuropathic-pain','gabapentin'],
      '7.16':['visceral-pain'],'7.18':['paediatric-pain'],
      '8.2':['nausea','antiemetics','CTZ'],'8.3':['constipation','laxatives','opioid-constipation'],
      '8.4':['ascites','jaundice','hepatic-encephalopathy'],
      '8.5':['cachexia','anorexia','weight-loss'],'8.6':['parenteral-nutrition','TPN'],
      '9.1':['dyspnoea','opioids-breathlessness','fan-therapy'],'9.2':['cough','haemoptysis'],
      '10.4':['xerostomia','oral-mucositis','dry-mouth'],
      '12.1':['fatigue','CRF','methylphenidate'],'12.3':['insomnia','sleep'],
      '12.4':['DVT','PE','thrombosis','anticoagulation'],
      '13.2':['depression','antidepressants','demoralisation'],
      '13.3':['anxiety','benzodiazepines','adjustment-disorder'],
      '13.4':['delirium','haloperidol','terminal-restlessness'],'13.5':['bereavement','grief'],
      '14.3a':['radiotherapy','palliative-RT'],'14.3b':['bone-RT','spinal-cord-compression'],
      '14.9':['hypercalcaemia','SIADH'],'14.10':['bowel-obstruction','octreotide'],
      '15.3':['heart-failure','ICD-deactivation'],'15.4':['dementia','Alzheimers','feeding-tubes'],
      '15.7':['renal-failure','dialysis-withdrawal','uraemia'],
      '18.2':['signs-of-dying','mottling','Cheyne-Stokes'],
      '18.3':['terminal-care','syringe-driver','death-rattle','CSCI'],
      '19.1':['bioethics','autonomy','capacity'],'19.6':['euthanasia','assisted-dying'],
      '19.7':['withdrawal-treatment','DNAR'],'19.8':['palliative-sedation','midazolam'],
      '5.1':['SPIKES','breaking-bad-news'],'5.3':['ACP','advance-directive','POLST'],
      '18.1':['prognosis','PPS','PPI','survival-prediction'],
    };
    SECTIONS.forEach(s => {
      const sec = s.chapter.split('.')[0];
      const tags = [domainMap[sec]||'palliative-care',`section-${sec}`,`ch-${s.chapter}`];
      if (extra[s.chapter]) tags.push(...extra[s.chapter]);
      map[s.id] = tags;
    });
    return map;
  })();

  // Weighted random chunk selection — under-represented chunks get higher odds
  function pickChunk(forceId) {
    if (forceId) return SECTIONS.find(s => s.id === forceId) || SECTIONS[0];
    const allCards = Store.cards.list();
    const countByChunk = {};
    allCards.forEach(c => { countByChunk[c.chunkId] = (countByChunk[c.chunkId]||0)+1; });
    const maxCount = Math.max(1, ...Object.values(countByChunk));
    const weights = SECTIONS.map(s => {
      const saturation = (countByChunk[s.id]||0) / (maxCount+1);
      return Math.max(0.01, s.weight * (1 - saturation * 0.7));
    });
    const total = weights.reduce((a,b)=>a+b,0);
    let rand = Math.random() * total;
    for (let i=0; i<SECTIONS.length; i++) { rand -= weights[i]; if (rand<=0) return SECTIONS[i]; }
    return SECTIONS[Math.floor(Math.random()*SECTIONS.length)];
  }

  // Duplicate detection via tag overlap + substring match
  function isDuplicate(newQ, existingCards) {
  if (!existingCards || existingCards.length === 0) return false;  // first run: nothing is a duplicate
  const newText = newQ.question.toLowerCase();
  for (const card of existingCards) {
    if (card.question.toLowerCase() === newText) return true;
    const newTags = new Set(newQ.tags||[]);
    const oldTags = new Set(card.tags||[]);
    if (newTags.size && oldTags.size) {
      const inter = [...newTags].filter(t=>oldTags.has(t)).length;
      const union = new Set([...newTags,...oldTags]).size;
      if (inter/union > SIMILARITY_THRESHOLD) {
        let max=0, a=newText, b=card.question.toLowerCase();
        for (let i=0;i<a.length;i++) for (let j=0;j<b.length;j++) {
          let len=0;
          while (i+len<a.length&&j+len<b.length&&a[i+len]===b[j+len]) len++;
          if (len>max) max=len;
        }
        if (max > 40) return true;
      }
    }
  }
  return false;
}

  // Parse batch response with Q1:...Q7: format
  function parseResponse(text) {
    const blocks = text.split(/(?=Q\d+:|QUESTION\s*\d+:)/i).filter(b=>b.trim().length>50);
    return blocks.map(block => {
      const get = (key, next) => {
        const r = new RegExp(key+'[:\\s]+([\\s\\S]*?)(?='+next+'|$)','i');
        const m = block.match(r);
        return m ? m[1].trim() : '';
      };
      const qRaw = get('Q\\d+|QUESTION\\s*\\d*','A\\.|OPTIONS|ANSWER');
      const optStr = get('OPTIONS','ANSWER|EXPLANATION|TAGS|SOURCE|PAGE');
      const opts = optStr.split('\n').map(l=>l.trim()).filter(l=>/^[A-E][.)]/i.test(l));
      const tagsRaw = get('TAGS','SOURCE|PAGE|EXPLANATION|$');
      const tags = tagsRaw ? tagsRaw.split(/[,;]/).map(t=>t.trim().toLowerCase().replace(/\s+/g,'-')).filter(Boolean) : [];
      return {
        question: qRaw,
        options: opts,
        answer: get('ANSWER','EXPLANATION|TAGS|SOURCE|PAGE').slice(0,1).toUpperCase(),
        explanation: get('EXPLANATION','TAGS|SOURCE|PAGE'),
        tags,
        source: get('SOURCE','TAGS|PAGE')||'Oxford Textbook of Palliative Medicine, 6th Ed.',
        pages: get('PAGE','ZZZZ'),
      };
    }).filter(q=>q.question&&q.options.length>=2&&q.answer);
  }

  console.log("CALLING API", API_PROXY_URL);

  // API call with cache check
  async function callAPI(chunk) {
    const cached = Store.questionCache.get(chunk.id);
    if (cached && cached.length > 0) return { questions: cached, fromCache: true };

    if (!API_PROXY_URL || API_PROXY_URL.includes('YOUR-SUBDOMAIN'))
      throw new Error('Proxy not configured. Set API_PROXY_URL in app.js');

    const existingQs = Store.cards.forChunk(chunk.id).map(c=>c.question);
    const avoidNote = existingQs.length
      ? '\nAVOID duplicating these existing questions:\n'+existingQs.slice(0,5).map((q,i)=>`${i+1}. ${q.slice(0,80)}`).join('\n')+'\n'
      : '';

    const prompt = `Use ONLY the information in the passage below. Focus on key testable concepts, not trivial details.${avoidNote}
Generate ${BATCH_SIZE_DEFAULT} high-quality single-best-answer exam questions from this Oxford Textbook of Palliative Medicine excerpt (Ch. ${chunk.chapter}: ${chunk.title}, pp.${chunk.start}\u2013${chunk.end}):

${chunk.text}

Format each question EXACTLY like this (repeat ${BATCH_SIZE_DEFAULT} times):

Q1: [clinical scenario or knowledge question]
OPTIONS:
A. [option]
B. [option]
C. [option]
D. [option]
E. [option]
ANSWER: [single letter]
EXPLANATION: [1-2 sentences: why correct, why key distractors wrong]
TAGS: [3-6 comma-separated clinical keywords]
PAGE: ${chunk.start}-${chunk.end}

Q2: ...

Rules: all answerable from passage; vary question types; plausible but clearly wrong distractors.`;

    const res = await fetch(API_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2800,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    Store.api.recordCall();
    ApiBadge.update();
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content.map(b=>b.text||'').join('');
    const questions = parseResponse(text);
    const chunkTags = CHUNK_TAGS[chunk.id]||[];
    questions.forEach(q => { q.tags = [...new Set([...q.tags,...chunkTags])]; });
    Store.questionCache.set(chunk.id, questions);
    return { questions, fromCache: false };
  }

  // Theme
  const Theme = {
    apply(pref) {
      const root = document.documentElement;
      if (pref==='auto') root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
      else root.setAttribute('data-theme', pref);
      const icon = document.querySelector('.theme-icon');
      if (icon) icon.textContent = root.getAttribute('data-theme')==='dark'?'☀️':'🌙';
    },
    init() {
      const s = Store.settings.get();
      this.apply(s.theme);
      document.querySelectorAll('input[name="theme"]').forEach(r => {
        r.checked = r.value===s.theme;
        r.addEventListener('change', ()=>{ Store.settings.set({theme:r.value}); this.apply(r.value); });
      });
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
        if (Store.settings.get().theme==='auto') this.apply('auto');
      });
      document.getElementById('theme-toggle').addEventListener('click', ()=>{
        const next = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
        Store.settings.set({theme:next});
        document.querySelectorAll('input[name="theme"]').forEach(r=>r.checked=r.value===next);
        this.apply(next);
      });
    },
  };

  // Navigation
  const Nav = {
    init() {
      document.querySelectorAll('.nav-btn').forEach(btn=>{
        btn.addEventListener('click',()=>this.show(btn.dataset.view));
      });
    },
    show(name) {
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      document.getElementById('view-'+name)?.classList.add('active');
      document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add('active');
      if (name==='history') History.render();
      if (name==='due') DueStudy.start();
    },
  };

  // API Badge
  const ApiBadge = {
    update() {
      const rem = Store.api.remaining();
      const el = document.getElementById('api-count');
      const badge = document.getElementById('api-badge');
      if (el) el.textContent = rem;
      if (badge) badge.className = 'api-badge'+(rem<=5?' api-low':rem<=12?' api-med':'');
      const reset = Store.api.nextReset();
      const resetEl = document.getElementById('api-reset');
      if (resetEl && reset) {
        const diff = reset - Date.now();
        resetEl.textContent = `resets ${Math.floor(diff/3600000)}h${Math.floor((diff%3600000)/60000)}m`;
      } else if (resetEl) resetEl.textContent='';
    },
  };

  // Topic Grid
  const TopicGrid = {
    activeFilter: 'all',
    init() {
      this.buildFilterBar(); this.render();
      document.getElementById('search-input').addEventListener('input',()=>this.render());
      document.getElementById('random-btn').addEventListener('click',()=>Quiz.generate());
      document.getElementById('study-due-btn').addEventListener('click',()=>Nav.show('due'));
    },
    buildFilterBar() {
      const bar = document.getElementById('filter-bar');
      const groups = {};
      SECTIONS.forEach(s=>{ if (!groups[s.section]) groups[s.section]=[]; groups[s.section].push(s); });
      bar.appendChild(this._chip('All',null,true));
      Object.entries(groups).forEach(([sec,items])=>bar.appendChild(this._chip(`§${sec} ${items[0].sectionLabel}`,sec,false)));
    },
    _chip(label,sec,active) {
      const b = document.createElement('button');
      b.className = 'filter-chip'+(active?' active':'');
      b.textContent = label; b.dataset.section = sec||'all';
      b.addEventListener('click',()=>{
        this.activeFilter = sec||'all';
        document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
        b.classList.add('active'); this.render();
      });
      return b;
    },
    render() {
      const q = document.getElementById('search-input').value.toLowerCase();
      const filtered = SECTIONS.filter(s=>{
        const matchSec = this.activeFilter==='all'||s.section===this.activeFilter;
        const matchQ = !q||s.title.toLowerCase().includes(q)||s.chapter.includes(q)||s.sectionLabel.toLowerCase().includes(q);
        return matchSec&&matchQ;
      });
      const grid = document.getElementById('topic-grid');
      grid.innerHTML = '';
      if (!filtered.length) { grid.innerHTML='<p class="empty-hint" style="grid-column:1/-1">No topics match.</p>'; return; }
      filtered.forEach(s=>{
        const saved = Store.cards.forChunk(s.id).length;
        const due = saved>0 ? Store.srs.dueCards().filter(c=>c.chunkId===s.id).length : 0;
        const cached = Store.questionCache.get(s.id)?.length||0;
        const card = document.createElement('div');
        card.className = 'topic-card';
        card.innerHTML = `<div class="topic-ch">Ch. ${s.chapter} · pp.${s.start}\u2013${s.end}</div>
          <div class="topic-title">${s.title}</div>
          <div class="topic-meta">
            ${saved>0?`${saved} saved`:''}
            ${due>0?`<span class="due-dot"> · ${due} due</span>`:''}
            ${cached>0&&saved===0?`<span class="cached-dot"> · ${cached} cached</span>`:''}
          </div>`;
        card.addEventListener('click',()=>Quiz.generate(s.id));
        grid.appendChild(card);
      });
    },
    updateDueBadge() {
      const due = Store.srs.dueCards().length;
      const badge = document.getElementById('due-count');
      if (badge) badge.textContent = due>0?due:'';
    },
  };

  // Quiz
  const Quiz = {
    currentChunk: null,
    pendingQueue: [],

    async generate(chunkId) {
      const chunk = pickChunk(chunkId);
      this.currentChunk = chunk;
      Nav.show('quiz');
      this._showState('loading');
      document.getElementById('loading-chapter').textContent = `Ch. ${chunk.chapter}: ${chunk.title}`;
      try {
        const cached = Store.questionCache.get(chunk.id)||[];
        const savedQs = new Set(Store.cards.forChunk(chunk.id).map(c=>c.question));
        const unseen = cached.filter(q=>!savedQs.has(q.question));
        if (unseen.length>0) {
          this.pendingQueue = unseen.slice(1);
          this._present(unseen[0], chunk, true);
        } else {
          const {questions,fromCache} = await callAPI(chunk);
          const existing = Store.cards.forChunk(chunk.id);
          const fresh = questions.filter(q=>!isDuplicate(q,existing));
          if (!fresh.length) throw new Error('All generated questions were duplicates. Try another topic.');
          this.pendingQueue = fresh.slice(1);
          this._present(fresh[0], chunk, fromCache);
        }
      } catch(e) {
        this._showState('error');
        document.getElementById('error-msg').textContent = e.message;
      }
    },

    _present(q, chunk, fromCache) {
      this._showState('content');
      ['ans-card','saved-note'].forEach(id=>document.getElementById(id).style.display='none');
      document.getElementById('q-hint').style.display='block';
      document.getElementById('sr-buttons').style.display='none';
      const cacheLabel = fromCache?' · ⚡ cached':'';
      document.getElementById('q-tag').textContent = `📖 Ch. ${chunk.chapter} · ${chunk.title} · pp.${chunk.start}\u2013${chunk.end}${cacheLabel}`;
      if (q.tags?.length) document.getElementById('q-tag').title = 'Tags: '+q.tags.join(', ');
      document.getElementById('q-text').textContent = q.question;
      const optsDiv = document.getElementById('q-options');
      optsDiv.innerHTML = '';
      q.options.forEach(opt=>{
        const letter=opt[0], txt=opt.slice(2).trim();
        const btn=document.createElement('button');
        btn.className='opt-btn'; btn.dataset.letter=letter;
        btn.innerHTML=`<span class="opt-ltr">${letter}.</span><span>${txt}</span><span class="opt-mark"></span>`;
        btn.addEventListener('click',()=>this._answer(letter,q,chunk));
        optsDiv.appendChild(btn);
      });
      document.getElementById('next-btn').onclick = ()=>{
        if (this.pendingQueue.length>0) {
          const existing = Store.cards.forChunk(chunk.id);
          const next = this.pendingQueue.find(q=>!isDuplicate(q,existing));
          if (next) { this.pendingQueue=this.pendingQueue.filter(q2=>q2!==next); this._present(next,chunk,true); return; }
        }
        this.generate();
      };
      document.getElementById('same-topic-btn').onclick = ()=>this.generate(chunk.id);
    },

    _answer(letter, q, chunk) {
      const isCorrect = letter===q.answer;
      document.querySelectorAll('#q-options .opt-btn').forEach(btn=>{
        btn.disabled=true;
        const l=btn.dataset.letter;
        if (l===q.answer){btn.classList.add('correct');btn.querySelector('.opt-mark').textContent=' ✓';}
        else if (l===letter){btn.classList.add('wrong');btn.querySelector('.opt-mark').textContent=' ✗';}
      });
      document.getElementById('q-hint').style.display='none';
      document.getElementById('ans-card').style.display='block';
      const title=document.getElementById('ans-title');
      title.textContent = isCorrect?'✓ Correct!':`✗ Incorrect — Correct: ${q.answer}`;
      title.className = 'ans-title '+(isCorrect?'ok':'bad');
      document.getElementById('ans-explanation').textContent = q.explanation;
      let srcHtml=`📚 ${q.source}<br>📄 Pages: ${q.pages}`;
      if (q.tags?.length) srcHtml+=`<br>🏷 ${q.tags.slice(0,6).join(' · ')}`;
      document.getElementById('ans-source').innerHTML = srcHtml;
      const cardId = this._save(q, chunk);
      const intervals = SM2.previewIntervals(Store.srs.get(cardId));
      document.getElementById('sr-hard-days').textContent = SM2.intervalLabel(intervals[2]);
      document.getElementById('sr-good-days').textContent = SM2.intervalLabel(intervals[3]);
      document.getElementById('sr-easy-days').textContent = SM2.intervalLabel(intervals[4]);
      document.getElementById('sr-buttons').style.display='flex';
      document.querySelectorAll('#sr-buttons .sr-btn').forEach(btn=>{
        btn.onclick=()=>{ Store.srs.review(cardId,parseInt(btn.dataset.rating)); document.getElementById('sr-buttons').style.display='none'; };
      });
      Store.sessionStats.record(isCorrect,{chunkId:chunk.id,chapterTitle:chunk.title,question:q.question,correct:isCorrect,answer:q.answer,selected:letter});
      Store.stats.record(chunk.id,isCorrect);
      this._updateStreak();
      TopicGrid.updateDueBadge();
    },

    _save(q, chunk) {
      const ex = Store.cards.forChunk(chunk.id).find(c=>c.question===q.question);
      if (ex) return ex.id;
      const id = 'card_'+chunk.id+'_'+Date.now();
      Store.cards.save({id,chunkId:chunk.id,chapterTitle:chunk.title,chapter:chunk.chapter,
        pages:q.pages||`${chunk.start}-${chunk.end}`,question:q.question,options:q.options,
        answer:q.answer,explanation:q.explanation,tags:q.tags||[],source:q.source,
        createdAt:new Date().toISOString()});
      document.getElementById('saved-note').style.display='block';
      return id;
    },

    _showState(state) {
      document.getElementById('quiz-loading').style.display = state==='loading'?'block':'none';
      document.getElementById('quiz-error').style.display  = state==='error'?'block':'none';
      document.getElementById('quiz-content').style.display = state==='content'?'block':'none';
    },

    _updateStreak() {
      const s = Store.sessionStats.streak;
      const badge = document.getElementById('streak-badge');
      if (badge) badge.style.display = s>1?'flex':'none';
      const num = document.getElementById('streak-num');
      if (num) num.textContent = s;
    },

    initActions() {
      document.getElementById('back-btn').addEventListener('click',()=>Nav.show('home'));
      document.getElementById('retry-btn').addEventListener('click',()=>this.generate(this.currentChunk?.id));
    },
  };

  // Due Study Mode
  const DueStudy = {
    queue:[], index:0,
    start() {
      this.queue = Store.srs.dueCards(); this.index=0;
      const hasCards = this.queue.length>0;
      document.getElementById('due-empty').style.display = hasCards?'none':'block';
      document.getElementById('due-content').style.display = hasCards?'block':'none';
      if (hasCards) this._show();
    },
    _show() {
      const card = this.queue[this.index];
      if (!card) { this.start(); return; }
      const pct = Math.round(this.index/this.queue.length*100);
      document.getElementById('due-progress-fill').style.width = pct+'%';
      document.getElementById('due-progress-txt').textContent = `${this.index} / ${this.queue.length}`;
      document.getElementById('due-ans-card').style.display='none';
      document.getElementById('due-hint').style.display='block';
      document.getElementById('due-tag').textContent = `📖 Ch. ${card.chapter} · ${card.chapterTitle} · pp.${card.pages}`;
      document.getElementById('due-q-text').textContent = card.question;
      const optsDiv = document.getElementById('due-options');
      optsDiv.innerHTML='';
      (card.options||[]).forEach(opt=>{
        const letter=opt[0];
        const btn=document.createElement('button');
        btn.className='opt-btn'; btn.dataset.letter=letter;
        btn.innerHTML=`<span class="opt-ltr">${letter}.</span><span>${opt.slice(2).trim()}</span><span class="opt-mark"></span>`;
        btn.addEventListener('click',()=>this._answer(letter,card));
        optsDiv.appendChild(btn);
      });
    },
    _answer(letter, card) {
      const isCorrect=letter===card.answer;
      document.querySelectorAll('#due-options .opt-btn').forEach(btn=>{
        btn.disabled=true; const l=btn.dataset.letter;
        if (l===card.answer){btn.classList.add('correct');btn.querySelector('.opt-mark').textContent=' ✓';}
        else if (l===letter){btn.classList.add('wrong');btn.querySelector('.opt-mark').textContent=' ✗';}
      });
      document.getElementById('due-hint').style.display='none';
      document.getElementById('due-ans-card').style.display='block';
      const title=document.getElementById('due-ans-title');
      title.textContent=isCorrect?'✓ Correct!':`✗ Incorrect — Correct: ${card.answer}`;
      title.className='ans-title '+(isCorrect?'ok':'bad');
      document.getElementById('due-explanation').textContent=card.explanation;
      let srcHtml=`📚 ${card.source}<br>📄 Pages: ${card.pages}`;
      if (card.tags?.length) srcHtml+=`<br>🏷 ${card.tags.slice(0,5).join(' · ')}`;
      document.getElementById('due-source').innerHTML=srcHtml;
      const intervals=SM2.previewIntervals(Store.srs.get(card.id));
      document.getElementById('due-hard-days').textContent=SM2.intervalLabel(intervals[2]);
      document.getElementById('due-good-days').textContent=SM2.intervalLabel(intervals[3]);
      document.getElementById('due-easy-days').textContent=SM2.intervalLabel(intervals[4]);
      Store.sessionStats.record(isCorrect,{chunkId:card.chunkId,chapterTitle:card.chapterTitle,question:card.question,correct:isCorrect,answer:card.answer,selected:letter});
      Store.stats.record(card.chunkId,isCorrect);
      const advance=(rating)=>{
        Store.srs.review(card.id,rating);
        this.index++;
        if (this.index>=this.queue.length) this.start(); else this._show();
        TopicGrid.updateDueBadge();
      };
      document.getElementById('due-sr-1').onclick=()=>advance(1);
      document.getElementById('due-sr-2').onclick=()=>advance(2);
      document.getElementById('due-sr-3').onclick=()=>advance(3);
      document.getElementById('due-sr-4').onclick=()=>advance(4);
    },
  };

  // History
  const History = {
    activeTab:'session',
    init() {
      document.querySelectorAll('.tab-btn').forEach(btn=>{
        btn.addEventListener('click',()=>{
          document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
          this.activeTab=btn.dataset.tab; this.render();
        });
      });
      document.getElementById('export-btn').addEventListener('click',this._export);
      document.getElementById('clear-saved-btn').addEventListener('click',()=>{
        if (confirm('Delete all saved cards?')){ Store.cards.clear(); this.render(); TopicGrid.render(); }
      });
      document.getElementById('saved-search').addEventListener('input',()=>this._renderSaved());
    },
    render() {
      document.getElementById('saved-count').textContent=Store.cards.list().length;
      if (this.activeTab==='session') this._renderSession();
      if (this.activeTab==='saved') this._renderSaved();
      if (this.activeTab==='stats') this._renderStats();
    },
    _renderSession() {
      const h=Store.sessionStats;
      const bar=document.getElementById('score-bar');
      const list=document.getElementById('session-list');
      if (!h.history.length){ bar.style.display='none'; list.innerHTML='<div class="empty-hint">No questions answered yet this session.</div>'; return; }
      bar.style.display='flex';
      document.getElementById('score-pct').textContent=h.pct()+'%';
      document.getElementById('score-fill').style.width=h.pct()+'%';
      document.getElementById('score-tally').textContent=`${h.correct}/${h.answered}`;
      list.innerHTML=h.history.map(item=>`<div class="hist-item ${item.correct?'ok':'bad'}">
        <div class="hist-ch">${item.chapterTitle}</div>
        <div class="hist-result ${item.correct?'ok':'bad'}">${item.correct?'✓ Correct':`✗ Incorrect — Ans: ${item.answer}${item.selected!==item.answer?` (you: ${item.selected})`:''}`}</div>
        <div class="hist-q">${item.question.slice(0,90)}…</div></div>`).join('');
    },
    _renderSaved() {
      const q=(document.getElementById('saved-search').value||'').toLowerCase();
      let cards=Store.cards.list();
      if (q) cards=cards.filter(c=>c.question.toLowerCase().includes(q)||c.chapterTitle?.toLowerCase().includes(q)||(c.tags||[]).some(t=>t.includes(q)));
      cards.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
      document.getElementById('saved-count').textContent=Store.cards.list().length;
      const list=document.getElementById('saved-list');
      if (!cards.length){ list.innerHTML='<div class="empty-hint">No saved cards yet.</div>'; return; }
      list.innerHTML=cards.map(card=>{
        const srs=Store.srs.get(card.id);
        const due=SM2.isDue(srs);
        const nxt=srs.dueDate?SM2.intervalLabel(Math.max(0,Math.round((new Date(srs.dueDate)-new Date())/86400000))):'New';
        return `<div class="saved-card">
          <div class="saved-card-header">
            <span class="topic-ch">Ch. ${card.chapter} · ${card.chapterTitle}</span>
            <span class="srs-chip ${due?'due':''}">${due?'⚡ Due':`Next: ${nxt}`}</span>
            <button class="delete-card" data-id="${card.id}" title="Delete">✕</button>
          </div>
          ${card.tags?.length?`<div class="tag-row">${card.tags.slice(0,5).map(t=>`<span class="tag-pill">${t}</span>`).join('')}</div>`:''}
          <div class="saved-q">${card.question}</div>
          <details class="saved-details">
            <summary>Answer: ${card.answer}</summary>
            <div class="saved-opts">${(card.options||[]).join('<br>')}</div>
            <div class="saved-expl">${card.explanation}</div>
            <div class="saved-source">📄 ${card.source} · Pages ${card.pages}</div>
          </details></div>`;
      }).join('');
      list.querySelectorAll('.delete-card').forEach(btn=>{
        btn.addEventListener('click',()=>{ Store.cards.delete(btn.dataset.id); this._renderSaved(); TopicGrid.render(); });
      });
    },
    _renderStats() {
      const s=Store.stats.get();
      const totalCards=Store.cards.list().length;
      const dueCount=Store.srs.dueCards().length;
      const cachedChunks=Object.keys(Store.questionCache.all()).length;
      const pct=s.totalAnswered?Math.round(s.totalCorrect/s.totalAnswered*100):0;
      const by=s.byChapter||{};
      const weakest=Object.entries(by).filter(([,d])=>d.answered>=3)
        .sort((a,b)=>(a[1].correct/a[1].answered)-(b[1].correct/b[1].answered)).slice(0,6);
      document.getElementById('stats-grid').innerHTML=`
        <div class="stat-card"><div class="stat-num">${s.totalAnswered||0}</div><div class="stat-lbl">Total answered</div></div>
        <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-lbl">Overall accuracy</div></div>
        <div class="stat-card"><div class="stat-num">${totalCards}</div><div class="stat-lbl">Cards saved</div></div>
        <div class="stat-card"><div class="stat-num">${dueCount}</div><div class="stat-lbl">Due for review</div></div>
        <div class="stat-card"><div class="stat-num">${cachedChunks}/120</div><div class="stat-lbl">Chunks cached</div></div>
        ${weakest.length?`<div class="stat-card wide"><div class="stat-lbl" style="margin-bottom:8px;font-weight:500">Weakest chapters (≥3 attempts)</div>${weakest.map(([id,d])=>{const sec=SECTIONS.find(s=>s.id===id);return`<div class="weak-row"><span>${sec?.title||id}</span><span class="weak-pct">${Math.round(d.correct/d.answered*100)}% (${d.correct}/${d.answered})</span></div>`;}).join('')}</div>`:''}`;
    },
    _export() {
      const data={version:2,exportDate:new Date().toISOString(),cards:Store.cards.list(),srsStates:Store.srs.all(),questionCache:Store.questionCache.all()};
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download=`oxford-pallcare-${new Date().toISOString().slice(0,10)}.json`; a.click();
    },
  };

  // Settings
  const Settings = {
    init() {
      const s=Store.settings.get();
      document.getElementById('daily-new-limit').value=s.dailyNewLimit;
      document.getElementById('daily-review-limit').value=s.dailyReviewLimit;
      document.getElementById('daily-new-limit').addEventListener('change',e=>Store.settings.set({dailyNewLimit:+e.target.value}));
      document.getElementById('daily-review-limit').addEventListener('change',e=>Store.settings.set({dailyReviewLimit:+e.target.value}));
      document.getElementById('reset-api-btn').addEventListener('click',()=>{ Store.api.reset(); ApiBadge.update(); });
      document.getElementById('clear-cache-btn')?.addEventListener('click',()=>{
        if (confirm('Clear question cache?')){ Store.questionCache.clear(); TopicGrid.render(); }
      });
      document.getElementById('nuke-btn').addEventListener('click',()=>{
        if (confirm('Reset ALL data? Cards, SRS, cache, and stats will be deleted.')){
          ['cards','srs','api','settings','stats','qcache'].forEach(k=>localStorage.removeItem('oxpal_'+k));
          location.reload();
        }
      });
    },
  };

  function init() {
    Theme.init(); Nav.init(); TopicGrid.init(); Quiz.initActions();
    History.init(); Settings.init(); ApiBadge.update();
    setInterval(ApiBadge.update.bind(ApiBadge),60000);
    TopicGrid.updateDueBadge();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
