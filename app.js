// Oxford Palliative Medicine — Main App (with Import/Export, Fixed Due Study, Clickable Tags)
// Set this to your Cloudflare Worker URL after deploying worker/worker.js
const API_PROXY_URL = 'https://oxfordpal-api.hello-henryhe.workers.dev';
console.log("AUTO DEPLOY TEST — IMPORT/EXPORT VERSION");

// Constants
const FREE_WINDOW_ESTIMATE = 25;
const BATCH_SIZE_DEFAULT   = 7;
const SIMILARITY_THRESHOLD = 0.55;
const MAX_CARDS_PER_CHUNK = 15;
const CACHE_TTL_DAYS = 7;
const API_MIN_INTERVAL_MS = 2000;

// API Throttling
const APIThrottle = {
    lastCall: 0,
    queue: [],
    
    async call(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    },
    
    async process() {
        if (this.processing) return;
        this.processing = true;
        
        while (this.queue.length > 0) {
            const now = Date.now();
            const wait = this.lastCall + API_MIN_INTERVAL_MS - now;
            if (wait > 0) {
                await new Promise(r => setTimeout(r, wait));
            }
            
            const { fn, resolve, reject } = this.queue.shift();
            this.lastCall = Date.now();
            try {
                const result = await fn();
                resolve(result);
            } catch (e) {
                reject(e);
            }
        }
        
        this.processing = false;
    }
};

// Cache with TTL
const QuestionCache = {
    getKey(chunkId) { return `oxpal_qcache_${chunkId}`; },
    
    set(chunkId, questions) {
        const cacheEntry = {
            data: questions,
            timestamp: Date.now(),
            ttl: CACHE_TTL_DAYS * 24 * 60 * 60 * 1000,
            chunkId: chunkId
        };
        try {
            localStorage.setItem(this.getKey(chunkId), JSON.stringify(cacheEntry));
        } catch(e) { console.warn('Cache save failed', e); }
    },
    
    get(chunkId) {
        try {
            const raw = localStorage.getItem(this.getKey(chunkId));
            if (!raw) return null;
            
            const entry = JSON.parse(raw);
            if (Date.now() - entry.timestamp > entry.ttl) {
                localStorage.removeItem(this.getKey(chunkId));
                return null;
            }
            return entry.data;
        } catch(e) { return null; }
    },
    
    clear() {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('oxpal_qcache_')) localStorage.removeItem(key);
        });
    },
    
    all() {
        const cache = {};
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('oxpal_qcache_')) {
                try {
                    const entry = JSON.parse(localStorage.getItem(key));
                    if (entry.data) cache[entry.chunkId || key.replace('oxpal_qcache_', '')] = entry.data;
                } catch(e) {}
            }
        });
        return cache;
    }
};

const App = (() => {

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
    if (typeof SECTIONS !== 'undefined') {
      SECTIONS.forEach(s => {
        const sec = s.chapter.split('.')[0];
        const tags = [domainMap[sec]||'palliative-care',`section-${sec}`,`ch-${s.chapter}`];
        if (extra[s.chapter]) tags.push(...extra[s.chapter]);
        map[s.id] = tags;
      });
    }
    return map;
  })();

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

  function longestCommonSubstring(str1, str2) {
    if (!str1 || !str2) return 0;
    let max = 0;
    for (let i = 0; i < str1.length; i++) {
      for (let j = 0; j < str2.length; j++) {
        let len = 0;
        while (i + len < str1.length && j + len < str2.length && str1[i+len] === str2[j+len]) len++;
        if (len > max) max = len;
        if (max > 40) return max;
      }
    }
    return max;
  }

  function isDuplicate(newQ, existingCards) {
    if (!existingCards || existingCards.length === 0) return false;
    if (!newQ || !newQ.question) return false;
    
    const newText = newQ.question.toLowerCase();
    const newWords = newText.split(/\s+/).filter(w => w.length > 4);
    const newWordSet = new Set(newWords);
    
    for (const card of existingCards) {
      if (!card.question) continue;
      if (card.question.toLowerCase() === newText) return true;
      
      const oldText = card.question.toLowerCase();
      const oldWords = oldText.split(/\s+/).filter(w => w.length > 4);
      const oldWordSet = new Set(oldWords);
      
      let overlap = 0;
      for (const word of newWordSet) {
        if (oldWordSet.has(word)) overlap++;
      }
      const similarity = newWordSet.size && oldWordSet.size ? overlap / Math.min(newWordSet.size, oldWordSet.size) : 0;
      
      if (similarity > 0.6) {
        const lcs = longestCommonSubstring(newText, oldText);
        if (lcs > 40) return true;
      }
    }
    return false;
  }

  function parseResponse(text) {
    if (!text || typeof text !== 'string') {
      console.error('Invalid response text:', text);
      return [];
    }
    
    const questions = [];
    const blocks = text.split(/(?=Q\d+:|QUESTION\s*\d+:)/i);
    
    for (const block of blocks) {
      if (!block || block.trim().length < 50) continue;
      
      try {
        let questionMatch = block.match(/(?:Q\d+:|QUESTION\s*\d+:)\s*([^\n]+)/i);
        if (!questionMatch) continue;
        
        const questionText = questionMatch[1].trim();
        const optionsMatch = block.match(/OPTIONS:\s*([\s\S]*?)(?=ANSWER:|EXPLANATION:|TAGS:|SOURCE:|PAGE:|$)/i);
        let options = [];
        if (optionsMatch) {
          const optionsText = optionsMatch[1];
          const optionLines = optionsText.split('\n');
          for (const line of optionLines) {
            const optMatch = line.match(/^([A-E])[.)]\s*(.+)/i);
            if (optMatch) {
              options.push(`${optMatch[1]}. ${optMatch[2].trim()}`);
            }
          }
        }
        
        if (options.length < 2) continue;
        
        const answerMatch = block.match(/ANSWER:\s*([A-E])/i);
        if (!answerMatch) continue;
        const answer = answerMatch[1].toUpperCase();
        
        const explanationMatch = block.match(/EXPLANATION:\s*([\s\S]*?)(?=TAGS:|SOURCE:|PAGE:|$)/i);
        const explanation = explanationMatch ? explanationMatch[1].trim() : 'No explanation provided.';
        
        const tagsMatch = block.match(/TAGS:\s*([\s\S]*?)(?=SOURCE:|PAGE:|$)/i);
        let tags = [];
        if (tagsMatch) {
          tags = tagsMatch[1].split(/[,;]/).map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
        }
        
        const sourceMatch = block.match(/SOURCE:\s*([^\n]+)/i);
        const source = sourceMatch ? sourceMatch[1].trim() : 'Oxford Textbook of Palliative Medicine, 6th Ed.';
        
        const pagesMatch = block.match(/PAGE:\s*([^\n]+)/i);
        const pages = pagesMatch ? pagesMatch[1].trim() : '';
        
        questions.push({
          question: questionText,
          options: options,
          answer: answer,
          explanation: explanation,
          tags: tags,
          source: source,
          pages: pages
        });
        
      } catch (blockError) {
        console.warn('Error parsing block:', blockError);
        continue;
      }
    }
    
    return questions.filter(q => q.question && q.options.length >= 2 && q.answer);
  }

  async function callAPI(chunk) {
    if (!chunk || !chunk.id) {
      throw new Error('Invalid chunk provided');
    }
    
    const cached = QuestionCache.get(chunk.id);
    if (cached && cached.length > 0) {
      console.log(`Using cached questions for chunk ${chunk.id}`);
      return { questions: cached, fromCache: true };
    }

    const existingCards = Store.cards.forChunk(chunk.id);
    if (existingCards.length >= MAX_CARDS_PER_CHUNK) {
      throw new Error(`This topic already has ${existingCards.length} cards. Practice due cards instead.`);
    }

    if (!API_PROXY_URL || API_PROXY_URL.includes('YOUR-SUBDOMAIN')) {
      throw new Error('Proxy not configured. Set API_PROXY_URL in app.js');
    }

    const existingQuestions = existingCards.map(c => c.question).filter(Boolean);
    const avoidNote = existingQuestions.length
      ? `\n⚠️ CRITICAL: The following ${existingQuestions.length} question(s) already exist. DO NOT generate duplicates:\n` + 
        existingQuestions.slice(0, 8).map((q, i) => `${i+1}. ${q.slice(0, 100)}`).join('\n') +
        `\nGenerate COMPLETELY NEW questions on different subtopics.\n`
      : '';

    const prompt = `You are an expert medical educator creating high-quality multiple-choice questions for palliative medicine.

Using ONLY the information in the passage below, generate ${BATCH_SIZE_DEFAULT} single-best-answer exam questions.

Passage (Ch. ${chunk.chapter}: ${chunk.title}, pp.${chunk.start}\u2013${chunk.end}):
${chunk.text}

${avoidNote}
Format each question EXACTLY like this:

Q1: [clinical scenario or knowledge question]
OPTIONS:
A. [option]
B. [option]
C. [option]
D. [option]
E. [option]
ANSWER: [single letter]
EXPLANATION: [1-2 sentences]
TAGS: [3-6 comma-separated keywords]
PAGE: ${chunk.start}-${chunk.end}

Now generate ${BATCH_SIZE_DEFAULT} questions following this EXACT format.`;

    const result = await APIThrottle.call(async () => {
      const res = await fetch(API_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3500,
          temperature: 0.7,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data;
    });
    
    let text = '';
    if (result.content) {
      if (Array.isArray(result.content)) {
        text = result.content.map(item => item.text || '').join('');
      } else if (typeof result.content === 'string') {
        text = result.content;
      } else if (result.content.text) {
        text = result.content.text;
      }
    } else if (result.text) {
      text = result.text;
    } else if (result.response) {
      text = result.response;
    }
    
    if (!text || text.trim().length === 0) {
      throw new Error('Empty response from API');
    }
    
    const questions = parseResponse(text);
    
    if (!questions || questions.length === 0) {
      throw new Error(`Failed to parse any valid questions from API response.`);
    }
    
    const uniqueQuestions = [];
    for (const q of questions) {
      if (q && q.question && !isDuplicate(q, existingCards) && 
          !uniqueQuestions.some(uq => uq.question === q.question)) {
        uniqueQuestions.push(q);
      }
    }
    
    if (uniqueQuestions.length === 0) {
      throw new Error(`All generated questions were duplicates. Try a different topic.`);
    }
    
    const chunkTags = CHUNK_TAGS[chunk.id] || [];
    uniqueQuestions.forEach(q => { 
      if (q.tags) {
        q.tags = [...new Set([...q.tags, ...chunkTags])];
      } else {
        q.tags = [...chunkTags];
      }
    });
    
    QuestionCache.set(chunk.id, uniqueQuestions);
    
    return { questions: uniqueQuestions, fromCache: false };
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
      const toggle = document.getElementById('theme-toggle');
      if (toggle) {
        toggle.addEventListener('click', ()=>{
          const next = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
          Store.settings.set({theme:next});
          document.querySelectorAll('input[name="theme"]').forEach(r=>r.checked=r.value===next);
          this.apply(next);
        });
      }
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
      const view = document.getElementById('view-'+name);
      if (view) view.classList.add('active');
      const btn = document.querySelector(`.nav-btn[data-view="${name}"]`);
      if (btn) btn.classList.add('active');
      if (name==='history') History.render();
      if (name==='due') DueStudy.start();
    },
  };

  // REMOVED: ApiBadge - No longer tracking API credits

  // Topic Grid
  const TopicGrid = {
    activeFilter: 'all',
    init() {
      this.buildFilterBar(); this.render();
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.addEventListener('input',()=>this.render());
      const randomBtn = document.getElementById('random-btn');
      if (randomBtn) randomBtn.addEventListener('click',()=>Quiz.generate());
      const studyBtn = document.getElementById('study-due-btn');
      if (studyBtn) studyBtn.addEventListener('click',()=>Nav.show('due'));
    },
    buildFilterBar() {
      const bar = document.getElementById('filter-bar');
      if (!bar) return;
      const groups = {};
      if (typeof SECTIONS !== 'undefined') {
        SECTIONS.forEach(s=>{ if (!groups[s.section]) groups[s.section]=[]; groups[s.section].push(s); });
      }
      bar.appendChild(this._chip('All', null, true));
      Object.entries(groups).forEach(([sec,items])=>bar.appendChild(this._chip(`§${sec} ${items[0].sectionLabel}`, sec, false)));
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
      const q = document.getElementById('search-input')?.value.toLowerCase() || '';
      const filtered = typeof SECTIONS !== 'undefined' ? SECTIONS.filter(s=>{
        const matchSec = this.activeFilter==='all'||s.section===this.activeFilter;
        const matchQ = !q||s.title.toLowerCase().includes(q)||s.chapter.includes(q)||s.sectionLabel.toLowerCase().includes(q);
        return matchSec&&matchQ;
      }) : [];
      const grid = document.getElementById('topic-grid');
      if (!grid) return;
      grid.innerHTML = '';
      if (!filtered.length) { grid.innerHTML='<p class="empty-hint" style="grid-column:1/-1">No topics match.</p>'; return; }
      filtered.forEach(s=>{
        const saved = Store.cards.forChunk(s.id).length;
        const due = saved>0 ? Store.srs.dueCards().filter(c=>c.chunkId===s.id).length : 0;
        const cached = QuestionCache.get(s.id)?.length||0;
        const card = document.createElement('div');
        card.className = 'topic-card';
        card.innerHTML = `<div class="topic-ch">Ch. ${s.chapter} · pp.${s.start}\u2013${s.end}</div>
          <div class="topic-title">${s.title}</div>
          <div class="topic-meta">
            ${saved>0?`${saved} saved`:''}
            ${due>0?`<span class="due-dot"> · ${due} due</span>`:''}
            ${cached>0&&saved===0?`<span class="cached-dot"> · ${cached} cached</span>`:''}
            ${saved >= MAX_CARDS_PER_CHUNK ? `<span class="full-dot"> · ✓ complete</span>` : ''}
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
      if (typeof SECTIONS === 'undefined') {
        console.error('SECTIONS not defined');
        return;
      }
      const chunk = pickChunk(chunkId);
      this.currentChunk = chunk;
      Nav.show('quiz');
      this._showState('loading');
      const loadingEl = document.getElementById('loading-chapter');
      if (loadingEl) loadingEl.textContent = `Ch. ${chunk.chapter}: ${chunk.title}`;
      try {
        const cached = QuestionCache.get(chunk.id)||[];
        const savedQs = new Set(Store.cards.forChunk(chunk.id).map(c=>c.question));
        const unseen = cached.filter(q=>!savedQs.has(q.question));
        
        if (unseen.length > 0) {
          this.pendingQueue = unseen.slice(1);
          this._present(unseen[0], chunk, true);
        } else {
          const {questions,fromCache} = await callAPI(chunk);
          const existing = Store.cards.forChunk(chunk.id);
          
          let fresh;
          if (!existing.length) {
            fresh = questions;
          } else {
            fresh = questions.filter(q => !isDuplicate(q, existing));
          }

          if (!fresh || !fresh.length) throw new Error('All generated questions were duplicates. Try another topic.');
          
          this.pendingQueue = fresh.slice(1);
          this._present(fresh[0], chunk, fromCache);
        }
      } catch(e) {
        this._showState('error');
        const errorEl = document.getElementById('error-msg');
        if (errorEl) errorEl.textContent = e.message;
        console.error('Quiz generation error:', e);
      }
    },

    _present(q, chunk, fromCache) {
      if (!q || !chunk) return;
      this._showState('content');
      const ansCard = document.getElementById('ans-card');
      const savedNote = document.getElementById('saved-note');
      if (ansCard) ansCard.style.display = 'none';
      if (savedNote) savedNote.style.display = 'none';
      const qHint = document.getElementById('q-hint');
      if (qHint) qHint.style.display = 'block';
      const srButtons = document.getElementById('sr-buttons');
      if (srButtons) srButtons.style.display = 'none';
      const cacheLabel = fromCache?' · ⚡ cached':'';
      const qTag = document.getElementById('q-tag');
      if (qTag) {
        qTag.textContent = `📖 Ch. ${chunk.chapter} · ${chunk.title} · pp.${chunk.start}\u2013${chunk.end}${cacheLabel}`;
        if (q.tags?.length) qTag.title = 'Tags: '+q.tags.join(', ');
      }
      const qText = document.getElementById('q-text');
      if (qText) qText.textContent = q.question;
      const optsDiv = document.getElementById('q-options');
      if (optsDiv) {
        optsDiv.innerHTML = '';
        q.options.forEach(opt=>{
          const letter=opt[0], txt=opt.slice(2).trim();
          const btn=document.createElement('button');
          btn.className='opt-btn'; btn.dataset.letter=letter;
          btn.innerHTML=`<span class="opt-ltr">${letter}.</span><span>${txt}</span><span class="opt-mark"></span>`;
          btn.addEventListener('click',()=>this._answer(letter,q,chunk));
          optsDiv.appendChild(btn);
        });
      }
      const nextBtn = document.getElementById('next-btn');
      if (nextBtn) {
        nextBtn.onclick = ()=>{
          if (this.pendingQueue.length>0) {
            const existing = Store.cards.forChunk(chunk.id);
            const next = this.pendingQueue.find(q=>!isDuplicate(q,existing));
            if (next) { this.pendingQueue=this.pendingQueue.filter(q2=>q2!==next); this._present(next,chunk,true); return; }
          }
          this.generate();
        };
      }
      const sameTopicBtn = document.getElementById('same-topic-btn');
      if (sameTopicBtn) sameTopicBtn.onclick = ()=>this.generate(chunk.id);
    },

    _answer(letter, q, chunk) {
      const isCorrect = letter===q.answer;
      document.querySelectorAll('#q-options .opt-btn').forEach(btn=>{
        btn.disabled=true;
        const l=btn.dataset.letter;
        if (l===q.answer){btn.classList.add('correct');const mark = btn.querySelector('.opt-mark'); if(mark) mark.textContent=' ✓';}
        else if (l===letter){btn.classList.add('wrong');const mark = btn.querySelector('.opt-mark'); if(mark) mark.textContent=' ✗';}
      });
      const qHint = document.getElementById('q-hint');
      if (qHint) qHint.style.display='none';
      const ansCard = document.getElementById('ans-card');
      if (ansCard) ansCard.style.display='block';
      const title = document.getElementById('ans-title');
      if (title) {
        title.textContent = isCorrect?'✓ Correct!':`✗ Incorrect — Correct: ${q.answer}`;
        title.className = 'ans-title '+(isCorrect?'ok':'bad');
      }
      const explanation = document.getElementById('ans-explanation');
      if (explanation) explanation.textContent = q.explanation;
      let srcHtml=`📚 ${q.source}<br>📄 Pages: ${q.pages}`;
      if (q.tags?.length) srcHtml+=`<br>🏷 ${q.tags.slice(0,6).join(' · ')}`;
      const source = document.getElementById('ans-source');
      if (source) source.innerHTML = srcHtml;
      const cardId = this._save(q, chunk);
      const intervals = SM2.previewIntervals(Store.srs.get(cardId));
      const hardDays = document.getElementById('sr-hard-days');
      const goodDays = document.getElementById('sr-good-days');
      const easyDays = document.getElementById('sr-easy-days');
      if (hardDays) hardDays.textContent = SM2.intervalLabel(intervals[2]);
      if (goodDays) goodDays.textContent = SM2.intervalLabel(intervals[3]);
      if (easyDays) easyDays.textContent = SM2.intervalLabel(intervals[4]);
      const srButtons = document.getElementById('sr-buttons');
      if (srButtons) srButtons.style.display='flex';
      document.querySelectorAll('#sr-buttons .sr-btn').forEach(btn=>{
        btn.onclick=()=>{ Store.srs.review(cardId,parseInt(btn.dataset.rating)); if(srButtons) srButtons.style.display='none'; };
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
      const savedNote = document.getElementById('saved-note');
      if (savedNote) savedNote.style.display='block';
      return id;
    },

    _showState(state) {
      const loading = document.getElementById('quiz-loading');
      const error = document.getElementById('quiz-error');
      const content = document.getElementById('quiz-content');
      if (loading) loading.style.display = state==='loading'?'block':'none';
      if (error) error.style.display = state==='error'?'block':'none';
      if (content) content.style.display = state==='content'?'block':'none';
    },

    _updateStreak() {
      const s = Store.sessionStats.streak;
      const badge = document.getElementById('streak-badge');
      if (badge) badge.style.display = s>1?'flex':'none';
      const num = document.getElementById('streak-num');
      if (num) num.textContent = s;
    },

    initActions() {
      const backBtn = document.getElementById('back-btn');
      if (backBtn) backBtn.addEventListener('click',()=>Nav.show('home'));
      const retryBtn = document.getElementById('retry-btn');
      if (retryBtn) retryBtn.addEventListener('click',()=>this.generate(this.currentChunk?.id));
    },
  };

  // FIXED: Due Study Mode
  const DueStudy = {
    queue: [], 
    index: 0,
    
    start() {
      this.queue = Store.srs.dueCards();
      this.index = 0;
      const hasCards = this.queue && this.queue.length > 0;
      
      const emptyDiv = document.getElementById('due-empty');
      const contentDiv = document.getElementById('due-content');
      
      if (emptyDiv) emptyDiv.style.display = hasCards ? 'none' : 'block';
      if (contentDiv) contentDiv.style.display = hasCards ? 'block' : 'none';
      
      if (hasCards) {
        this._show();
      }
    },
    
    _show() {
      if (!this.queue || this.index >= this.queue.length) {
        this.start();
        return;
      }
      
      const card = this.queue[this.index];
      if (!card) {
        this.start();
        return;
      }
      
      // Update progress
      const pct = this.queue.length > 0 ? Math.round((this.index + 1) / this.queue.length * 100) : 0;
      const progressFill = document.getElementById('due-progress-fill');
      const progressTxt = document.getElementById('due-progress-txt');
      
      if (progressFill) progressFill.style.width = pct + '%';
      if (progressTxt) progressTxt.textContent = `${this.index + 1} / ${this.queue.length}`;
      
      // Hide answer card, show question
      const ansCard = document.getElementById('due-ans-card');
      const hint = document.getElementById('due-hint');
      if (ansCard) ansCard.style.display = 'none';
      if (hint) hint.style.display = 'block';
      
      // Display question
      const tagEl = document.getElementById('due-tag');
      if (tagEl) tagEl.textContent = `📖 Ch. ${card.chapter} · ${card.chapterTitle} · pp.${card.pages}`;
      
      const qTextEl = document.getElementById('due-q-text');
      if (qTextEl) qTextEl.textContent = card.question;
      
      // Display options
      const optsDiv = document.getElementById('due-options');
      if (optsDiv) {
        optsDiv.innerHTML = '';
        if (card.options && card.options.length > 0) {
          card.options.forEach(opt => {
            if (!opt) return;
            const letter = opt[0];
            const btn = document.createElement('button');
            btn.className = 'opt-btn';
            btn.dataset.letter = letter;
            btn.innerHTML = `<span class="opt-ltr">${letter}.</span><span>${opt.slice(2).trim()}</span><span class="opt-mark"></span>`;
            btn.addEventListener('click', () => this._answer(letter, card));
            optsDiv.appendChild(btn);
          });
        }
      }
    },
    
    _answer(letter, card) {
      const isCorrect = (letter === card.answer);
      
      // Mark answers
      document.querySelectorAll('#due-options .opt-btn').forEach(btn => {
        btn.disabled = true;
        const l = btn.dataset.letter;
        if (l === card.answer) {
          btn.classList.add('correct');
          const mark = btn.querySelector('.opt-mark');
          if (mark) mark.textContent = ' ✓';
        } else if (l === letter) {
          btn.classList.add('wrong');
          const mark = btn.querySelector('.opt-mark');
          if (mark) mark.textContent = ' ✗';
        }
      });
      
      // Show answer card
      const hint = document.getElementById('due-hint');
      const ansCard = document.getElementById('due-ans-card');
      if (hint) hint.style.display = 'none';
      if (ansCard) ansCard.style.display = 'block';
      
      // Set answer title
      const title = document.getElementById('due-ans-title');
      if (title) {
        title.textContent = isCorrect ? '✓ Correct!' : `✗ Incorrect — Correct: ${card.answer}`;
        title.className = 'ans-title ' + (isCorrect ? 'ok' : 'bad');
      }
      
      // Set explanation
      const explanation = document.getElementById('due-explanation');
      if (explanation) explanation.textContent = card.explanation || 'No explanation provided.';
      
      // Set source
      let srcHtml = `📚 ${card.source || 'Oxford Textbook'}<br>📄 Pages: ${card.pages || 'N/A'}`;
      if (card.tags && card.tags.length) {
        srcHtml += `<br>🏷 ${card.tags.slice(0, 5).join(' · ')}`;
      }
      const sourceEl = document.getElementById('due-source');
      if (sourceEl) sourceEl.innerHTML = srcHtml;
      
      // Show interval buttons
      const intervals = SM2.previewIntervals(Store.srs.get(card.id));
      const hardDays = document.getElementById('due-hard-days');
      const goodDays = document.getElementById('due-good-days');
      const easyDays = document.getElementById('due-easy-days');
      if (hardDays) hardDays.textContent = SM2.intervalLabel(intervals[2]);
      if (goodDays) goodDays.textContent = SM2.intervalLabel(intervals[3]);
      if (easyDays) easyDays.textContent = SM2.intervalLabel(intervals[4]);
      
      // Record stats
      Store.sessionStats.record(isCorrect, {
        chunkId: card.chunkId,
        chapterTitle: card.chapterTitle,
        question: card.question,
        correct: isCorrect,
        answer: card.answer,
        selected: letter
      });
      Store.stats.record(card.chunkId, isCorrect);
      
      // Setup rating buttons
      const advance = (rating) => {
        Store.srs.review(card.id, rating);
        this.index++;
        if (this.index >= this.queue.length) {
          this.start();
        } else {
          this._show();
        }
        TopicGrid.updateDueBadge();
      };
      
      const sr1 = document.getElementById('due-sr-1');
      const sr2 = document.getElementById('due-sr-2');
      const sr3 = document.getElementById('due-sr-3');
      const sr4 = document.getElementById('due-sr-4');
      
      if (sr1) sr1.onclick = () => advance(1);
      if (sr2) sr2.onclick = () => advance(2);
      if (sr3) sr3.onclick = () => advance(3);
      if (sr4) sr4.onclick = () => advance(4);
    }
  };

  // History with Import/Export and Clickable Tags
  const History = {
    activeTab: 'session',
    
    init() {
      // Tab switching
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
          btn.classList.add('active');
          const tabContent = document.getElementById('tab-' + btn.dataset.tab);
          if (tabContent) tabContent.classList.add('active');
          this.activeTab = btn.dataset.tab;
          this.render();
        });
      });
      
      // Export button
      const exportBtn = document.getElementById('export-btn');
      if (exportBtn) exportBtn.addEventListener('click', () => this._export());
      
      // Import button
      const importBtn = document.getElementById('import-btn');
      const importFile = document.getElementById('import-file');
      if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', (e) => this._import(e));
      }
      
      // Clear saved button
      const clearBtn = document.getElementById('clear-saved-btn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (confirm('Delete all saved cards?')) {
            Store.cards.clear();
            this.render();
            TopicGrid.render();
          }
        });
      }
      
      // Search input
      const savedSearch = document.getElementById('saved-search');
      if (savedSearch) savedSearch.addEventListener('input', () => this._renderSaved());
    },
    
    render() {
      const savedCount = document.getElementById('saved-count');
      if (savedCount) savedCount.textContent = Store.cards.list().length;
      if (this.activeTab === 'session') this._renderSession();
      if (this.activeTab === 'saved') this._renderSaved();
      if (this.activeTab === 'stats') this._renderStats();
    },
    
    _export() {
      const data = {
        version: 2,
        exportDate: new Date().toISOString(),
        cards: Store.cards.list(),
        srsStates: Store.srs.all(),
        questionCache: QuestionCache.all(),
        stats: Store.stats.get()
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `oxford-pallcare-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    
    _import(event) {
      const file = event.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          let importCount = 0;
          
          if (data.cards && Array.isArray(data.cards)) {
            data.cards.forEach(card => {
              // Check if card already exists
              const existing = Store.cards.list().find(c => c.question === card.question);
              if (!existing) {
                Store.cards.save(card);
                importCount++;
              }
            });
          }
          
          if (data.srsStates) {
            Object.entries(data.srsStates).forEach(([id, state]) => {
              Store.srs.save(id, state);
            });
          }
          
          alert(`Imported ${importCount} new cards!`);
          this.render();
          TopicGrid.render();
          TopicGrid.updateDueBadge();
        } catch (err) {
          alert('Error importing file: ' + err.message);
        }
      };
      reader.readAsText(file);
      event.target.value = ''; // Reset file input
    },
    
    _renderSession() {
      const h = Store.sessionStats;
      const bar = document.getElementById('score-bar');
      const list = document.getElementById('session-list');
      
      if (!h.history || !h.history.length) {
        if (bar) bar.style.display = 'none';
        if (list) list.innerHTML = '<div class="empty-hint">No questions answered yet this session.</div>';
        return;
      }
      
      if (bar) bar.style.display = 'flex';
      const pctEl = document.getElementById('score-pct');
      const fillEl = document.getElementById('score-fill');
      const tallyEl = document.getElementById('score-tally');
      
      if (pctEl) pctEl.textContent = h.pct() + '%';
      if (fillEl) fillEl.style.width = h.pct() + '%';
      if (tallyEl) tallyEl.textContent = `${h.correct}/${h.answered}`;
      
      if (list) {
        list.innerHTML = h.history.map(item => `
          <div class="hist-item ${item.correct ? 'ok' : 'bad'}">
            <div class="hist-ch">${item.chapterTitle}</div>
            <div class="hist-result ${item.correct ? 'ok' : 'bad'}">
              ${item.correct ? '✓ Correct' : `✗ Incorrect — Ans: ${item.answer}${item.selected !== item.answer ? ` (you: ${item.selected})` : ''}`}
            </div>
            <div class="hist-q">${item.question.slice(0, 90)}…</div>
          </div>
        `).join('');
      }
    },
    
    _renderSaved() {
      const searchTerm = (document.getElementById('saved-search')?.value || '').toLowerCase();
      let cards = Store.cards.list();
      
      if (searchTerm) {
        cards = cards.filter(c => 
          c.question.toLowerCase().includes(searchTerm) ||
          c.chapterTitle?.toLowerCase().includes(searchTerm) ||
          (c.tags || []).some(tag => tag.toLowerCase().includes(searchTerm))
        );
      }
      
      cards.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      const savedCount = document.getElementById('saved-count');
      if (savedCount) savedCount.textContent = Store.cards.list().length;
      
      const list = document.getElementById('saved-list');
      if (!list) return;
      
      if (!cards.length) {
        list.innerHTML = '<div class="empty-hint">No saved cards yet.</div>';
        return;
      }
      
      list.innerHTML = cards.map(card => {
        const srs = Store.srs.get(card.id);
        const due = SM2.isDue(srs);
        const nxt = srs.dueDate ? SM2.intervalLabel(Math.max(0, Math.round((new Date(srs.dueDate) - new Date()) / 86400000))) : 'New';
        
        return `
          <div class="saved-card" data-card-id="${card.id}">
            <div class="saved-card-header">
              <span class="topic-ch">Ch. ${card.chapter} · ${card.chapterTitle}</span>
              <span class="srs-chip ${due ? 'due' : ''}">${due ? '⚡ Due' : `Next: ${nxt}`}</span>
              <button class="delete-card" data-id="${card.id}" title="Delete">✕</button>
            </div>
            ${card.tags && card.tags.length ? `
              <div class="tag-row">
                ${card.tags.slice(0, 8).map(tag => `
                  <span class="tag-pill clickable-tag" data-tag="${tag}">${tag}</span>
                `).join('')}
              </div>
            ` : ''}
            <div class="saved-q">${card.question}</div>
            <details class="saved-details">
              <summary>Answer: ${card.answer}</summary>
              <div class="saved-opts">${(card.options || []).join('<br>')}</div>
              <div class="saved-expl">${card.explanation}</div>
              <div class="saved-source">📄 ${card.source} · Pages ${card.pages}</div>
            </details>
          </div>
        `;
      }).join('');
      
      // Add click handlers for delete buttons
      list.querySelectorAll('.delete-card').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          Store.cards.delete(btn.dataset.id);
          this._renderSaved();
          TopicGrid.render();
        });
      });
      
      // Add click handlers for clickable tags
      list.querySelectorAll('.clickable-tag').forEach(tagEl => {
        tagEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const tag = tagEl.dataset.tag;
          const searchInput = document.getElementById('saved-search');
          if (searchInput) {
            searchInput.value = tag;
            this._renderSaved();
          }
        });
      });
    },
    
    _renderStats() {
      const s = Store.stats.get();
      const totalCards = Store.cards.list().length;
      const dueCount = Store.srs.dueCards().length;
      const cachedChunks = Object.keys(QuestionCache.all()).length;
      const pct = s.totalAnswered ? Math.round(s.totalCorrect / s.totalAnswered * 100) : 0;
      const by = s.byChapter || {};
      const weakest = Object.entries(by).filter(([, d]) => d.answered >= 3)
        .sort((a, b) => (a[1].correct / a[1].answered) - (b[1].correct / b[1].answered)).slice(0, 6);
      
      const statsGrid = document.getElementById('stats-grid');
      if (statsGrid) {
        statsGrid.innerHTML = `
          <div class="stat-card"><div class="stat-num">${s.totalAnswered || 0}</div><div class="stat-lbl">Total answered</div></div>
          <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-lbl">Overall accuracy</div></div>
          <div class="stat-card"><div class="stat-num">${totalCards}</div><div class="stat-lbl">Cards saved</div></div>
          <div class="stat-card"><div class="stat-num">${dueCount}</div><div class="stat-lbl">Due for review</div></div>
          <div class="stat-card"><div class="stat-num">${cachedChunks}/120</div><div class="stat-lbl">Chunks cached</div></div>
          ${weakest.length ? `<div class="stat-card wide"><div class="stat-lbl" style="margin-bottom:8px;font-weight:500">Weakest chapters (≥3 attempts)</div>
            ${weakest.map(([id, d]) => {
              const sec = SECTIONS?.find(s => s.id === id);
              return `<div class="weak-row"><span>${sec?.title || id}</span><span class="weak-pct">${Math.round(d.correct / d.answered * 100)}% (${d.correct}/${d.answered})</span></div>`;
            }).join('')}
          </div>` : ''}
        `;
      }
    }
  };

  // Settings
  const Settings = {
    init() {
      const s = Store.settings.get();
      const dailyNewLimit = document.getElementById('daily-new-limit');
      const dailyReviewLimit = document.getElementById('daily-review-limit');
      
      if (dailyNewLimit) {
        dailyNewLimit.value = s.dailyNewLimit;
        dailyNewLimit.addEventListener('change', e => Store.settings.set({ dailyNewLimit: +e.target.value }));
      }
      if (dailyReviewLimit) {
        dailyReviewLimit.value = s.dailyReviewLimit;
        dailyReviewLimit.addEventListener('change', e => Store.settings.set({ dailyReviewLimit: +e.target.value }));
      }
      
      const clearCacheBtn = document.getElementById('clear-cache-btn');
      if (clearCacheBtn) {
        clearCacheBtn.addEventListener('click', () => {
          if (confirm('Clear question cache? This will force fresh API calls for cached topics.')) {
            QuestionCache.clear();
            TopicGrid.render();
          }
        });
      }
      
      const nukeBtn = document.getElementById('nuke-btn');
      if (nukeBtn) {
        nukeBtn.addEventListener('click', () => {
          if (confirm('Reset ALL data? Cards, SRS, cache, and stats will be deleted.')) {
            ['cards', 'srs', 'settings', 'stats'].forEach(k => localStorage.removeItem('oxpal_' + k));
            QuestionCache.clear();
            location.reload();
          }
        });
      }
    }
  };

  function init() {
    if (typeof SECTIONS === 'undefined') {
      console.error('SECTIONS data not loaded!');
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;text-align:center;z-index:9999';
      errorDiv.textContent = 'Error: sections.js not loaded. Please check your HTML file.';
      document.body.prepend(errorDiv);
      return;
    }
    
    Theme.init();
    Nav.init();
    TopicGrid.init();
    Quiz.initActions();
    History.init();
    Settings.init();
    
    setInterval(() => TopicGrid.updateDueBadge(), 60000);
    TopicGrid.updateDueBadge();
    
    console.log('✅ App loaded with Import/Export, fixed Due Study, and clickable tags');
  }

  return { init };
})();

// Wait for DOM and SECTIONS data
if (typeof SECTIONS !== 'undefined') {
  document.addEventListener('DOMContentLoaded', App.init);
} else {
  console.error('SECTIONS not defined. Make sure sections.js loads first.');
  window.addEventListener('load', () => {
    if (typeof SECTIONS !== 'undefined') {
      document.addEventListener('DOMContentLoaded', App.init);
    }
  });
}