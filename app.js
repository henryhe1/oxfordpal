// Oxford Palliative Medicine — Main App (Optimized for API Credits)
// Set this to your Cloudflare Worker URL after deploying worker/worker.js
const API_PROXY_URL = 'https://oxfordpal-api.hello-henryhe.workers.dev';
console.log("AUTO DEPLOY TEST — OPTIMIZED VERSION WITH DEBUGGING");

// Constants
const FREE_WINDOW_ESTIMATE = 25;
let BATCH_SIZE_DEFAULT = 5; // FIX #4: default changed to 5, now user-configurable
const SIMILARITY_THRESHOLD = 0.55;
const MAX_CARDS_PER_CHUNK = 15;
const CACHE_TTL_DAYS = 7;
const API_MIN_INTERVAL_MS = 2000;

// FIX #6: EST date helper — used everywhere instead of new Date().toISOString()
function nowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function todayEST() {
  const d = nowEST();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function nowESTISO() {
  const d = nowEST();
  return d.toISOString().replace(/\.\d{3}Z$/, '') + '-05:00';
}

// Enable debug mode to see API responses
const DEBUG_MODE = true;

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

// Enhanced Cache with TTL
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

// AUTO SAVE FEATURE
const AutoSave = {
  enabled: true,
  interval: null,
  saveIntervalMinutes: 5,
  
  init() {
    if (!this.enabled) return;
    
    this.interval = setInterval(() => {
      this.saveToLocalStorage();
      console.log(`Auto-saved ${Store.cards.list().length} cards at ${new Date().toLocaleTimeString()}`);
    }, this.saveIntervalMinutes * 60 * 1000);
    
    window.addEventListener('beforeunload', () => {
      this.saveToLocalStorage();
    });
    
    this.checkForCrashRecovery();
  },
  
  saveToLocalStorage() {
    const data = {
      timestamp: Date.now(),
      cards: Store.cards.list(),
      srsStates: Store.srs.all(),
      questionCache: QuestionCache.all()
    };
    localStorage.setItem('oxpal_autosave_backup', JSON.stringify(data));
  },
  
  checkForCrashRecovery() {
    const backup = localStorage.getItem('oxpal_autosave_backup');
    if (backup) {
      try {
        const data = JSON.parse(backup);
        const currentCards = Store.cards.list().length;
        const backupCards = data.cards?.length || 0;
        const backupAge = (Date.now() - data.timestamp) / (1000 * 60 * 60);
        
        if (backupCards > currentCards && backupAge < 24) {
          const restore = confirm(`Found backup with ${backupCards} cards from ${new Date(data.timestamp).toLocaleString()}. Current has ${currentCards}. Restore?`);
          if (restore) {
            data.cards.forEach(card => Store.cards.save(card));
            location.reload();
          }
        }
      } catch(e) {}
    }
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
    
    console.log('Raw API response length:', text.length);
    if (DEBUG_MODE) {
      console.log('First 500 chars of response:', text.substring(0, 500));
    }
    
    const questions = [];
    
    try {
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
          
          // FIX #3: parse EXPLANATION and WHY_WRONG separately
          const explanationMatch = block.match(/EXPLANATION:\s*([\s\S]*?)(?=WHY_WRONG:|TAGS:|SOURCE:|PAGE:|$)/i);
          const explanation = explanationMatch ? explanationMatch[1].trim() : 'No explanation provided.';

          const whyWrongMatch = block.match(/WHY_WRONG:\s*([\s\S]*?)(?=TAGS:|SOURCE:|PAGE:|$)/i);
          const whyWrong = whyWrongMatch ? whyWrongMatch[1].trim() : '';
          
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
            whyWrong: whyWrong,
            tags: tags,
            source: source,
            pages: pages
          });
          
        } catch (blockError) {
          console.warn('Error parsing block:', blockError);
          continue;
        }
      }
    } catch (e) {
      console.error('Strategy 1 failed:', e);
    }
    
    if (questions.length === 0) {
      console.log('Strategy 1 failed, trying Strategy 2...');
      try {
        const lines = text.split('\n');
        let currentQuestion = null;
        let currentOptions = [];
        let inOptions = false;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const numMatch = line.match(/^(\d+)[.)]\s+(.+)/);
          if (numMatch && !inOptions) {
            if (currentQuestion && currentOptions.length >= 2) {
              questions.push({
                question: currentQuestion,
                options: [...currentOptions],
                answer: '',
                explanation: '',
                whyWrong: '',
                tags: [],
                source: 'Oxford Textbook of Palliative Medicine, 6th Ed.',
                pages: ''
              });
            }
            currentQuestion = numMatch[2];
            currentOptions = [];
            inOptions = true;
          }
          else if (inOptions && line.match(/^[A-E][.)]\s+/i)) {
            currentOptions.push(line);
          }
          else if (line.match(/^answer:/i) && currentQuestion) {
            const ansMatch = line.match(/answer:\s*([A-E])/i);
            if (ansMatch && questions.length > 0) {
              questions[questions.length - 1].answer = ansMatch[1].toUpperCase();
            }
            inOptions = false;
          }
          else if (line.match(/^explanation:/i) && questions.length > 0) {
            const expText = line.replace(/^explanation:/i, '').trim();
            questions[questions.length - 1].explanation = expText;
          }
        }
      } catch (e) {
        console.error('Strategy 2 failed:', e);
      }
    }
    
    console.log(`Parsed ${questions.length} questions`);
    
    const validQuestions = questions.filter(q => 
      q.question && 
      q.options && q.options.length >= 2 && 
      q.answer && /[A-E]/.test(q.answer)
    );
    
    if (validQuestions.length === 0 && DEBUG_MODE) {
      console.error('No valid questions parsed. Full response:', text);
    }
    
    return validQuestions;
  }

  console.log("CALLING API", API_PROXY_URL);

  function debugAPIResponse(text, chunkId) {
    console.log(`=== DEBUG: API Response for ${chunkId} ===`);
    console.log('Raw response length:', text.length);
    console.log('First 1000 chars:', text.substring(0, 1000));
    console.log('Last 500 chars:', text.substring(text.length - 500));
    console.log('Contains "Q1":', text.includes('Q1'));
    console.log('Contains "QUESTION":', text.includes('QUESTION'));
    console.log('Contains "OPTIONS":', text.includes('OPTIONS'));
    localStorage.setItem('oxpal_debug_response', text);
    console.log('Full response saved to localStorage key: oxpal_debug_response');
    return text;
  }

  async function callAPI(chunk) {
    if (!chunk || !chunk.id) {
      throw new Error('Invalid chunk provided');
    }
    
    const cached = QuestionCache.get(chunk.id);
    if (cached && cached.length > 0) {
      console.log(`Using cached questions for chunk ${chunk.id}`);
      // FIX: deduplicate against saved cards even when serving from cache
      const existing = Store.cards.forChunk(chunk.id);
      const fresh = existing.length ? cached.filter(q => !isDuplicate(q, existing)) : cached;
      return { questions: fresh, fromCache: true };
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

    // FIX #4: use runtime BATCH_SIZE_DEFAULT (now user-configurable)
    const batchSize = BATCH_SIZE_DEFAULT;

    // FIX #3: updated prompt to include WHY_WRONG field
    const prompt = `You are an expert medical educator creating high-quality multiple-choice questions for palliative medicine.

Using ONLY the information in the passage below, generate ${batchSize} single-best-answer exam questions.

Passage (Ch. ${chunk.chapter}: ${chunk.title}, pp.${chunk.start}\u2013${chunk.end}):
${chunk.text}

${avoidNote}
IMPORTANT FORMATTING RULES:
- Each question MUST start with "Q1:", "Q2:", etc. on its own line
- Each question MUST be followed by "OPTIONS:" on the next line
- Options MUST be labeled A., B., C., D., E. (one per line)
- Then "ANSWER:" with a single letter (A, B, C, D, or E)
- Then "EXPLANATION:" with 1-2 sentences explaining why the correct answer is right
- Then "WHY_WRONG:" with 1 sentence each explaining why each incorrect option is wrong (format: "A: reason. B: reason." etc., skipping the correct answer)
- Then "TAGS:" with 3-6 comma-separated keywords
- Then "PAGE:" with the page range

Example format:
Q1: What is the first-line treatment for neuropathic pain in palliative care?
OPTIONS:
A. Paracetamol
B. Gabapentin
C. Morphine
D. Ibuprofen
E. Dexamethasone
ANSWER: B
EXPLANATION: Gabapentin is first-line for neuropathic pain based on RCT evidence showing superior efficacy for neuropathic mechanisms.
WHY_WRONG: A: Paracetamol acts on nociceptive pain and has no established efficacy for neuropathic mechanisms. C: Morphine is used for moderate-severe nociceptive pain and is not first-line for neuropathic pain. D: Ibuprofen is an NSAID effective for inflammatory pain, not neuropathic pain. E: Dexamethasone is used as an adjuvant for specific pain types but not first-line for neuropathic pain.
TAGS: neuropathic-pain, gabapentin, first-line-treatment
PAGE: ${chunk.start}-${chunk.end}

Now generate ${batchSize} questions following this EXACT format.`;

    if (DEBUG_MODE) {
      console.log('Sending prompt (first 500 chars):', prompt.substring(0, 500));
    }

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
      
      Store.api.recordCall();
      ApiBadge.update();
      
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      
      if (DEBUG_MODE) {
        console.log('API Response structure:', Object.keys(data));
        console.log('Content type:', typeof data.content);
        if (data.content) {
          console.log('Content length:', data.content.length);
        }
      }
      
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
      console.error('Empty response from API. Full result:', result);
      throw new Error('Empty response from API');
    }
    
    console.log(`Received response with ${text.length} characters`);
    
    const questions = parseResponse(text);
    
    if (!questions || questions.length === 0) {
      if (DEBUG_MODE) {
        const debugInfo = {
          timestamp: nowESTISO(),
          chunkId: chunk.id,
          promptLength: prompt.length,
          responseLength: text.length,
          responsePreview: text.substring(0, 1000),
          fullResponse: text.length < 5000 ? text : text.substring(0, 5000)
        };
        localStorage.setItem('oxpal_last_api_error', JSON.stringify(debugInfo));
        console.error('API Error saved to localStorage. Check "oxpal_last_api_error"');
      }
      throw new Error(`Failed to parse any valid questions from API response. Received ${text.length} chars. Check console for details.`);
    }
    
    const uniqueQuestions = [];
    for (const q of questions) {
      if (q && q.question && !isDuplicate(q, existingCards) && 
          !uniqueQuestions.some(uq => uq.question === q.question)) {
        uniqueQuestions.push(q);
      }
    }
    
    if (uniqueQuestions.length === 0) {
      throw new Error(`All ${questions.length} generated questions were duplicates. Try a different topic.`);
    }
    
    console.log(`Generated ${uniqueQuestions.length} unique questions out of ${questions.length} total`);
    
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
      } else if (resetEl) resetEl.textContent = '';
    },
  };

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
    // FIX #2: update due badge colour — green when 0, red when >0
    updateDueBadge() {
      const due = Store.srs.dueCards().length;
      const badge = document.getElementById('due-count');
      const navBtn = document.querySelector('.nav-btn[data-view="due"]');
      if (badge) {
        badge.textContent = due > 0 ? due : '0';
        badge.style.display = 'inline-flex';
        badge.className = due > 0 ? 'due-badge due-badge-red' : 'due-badge due-badge-green';
      }
      if (navBtn) {
        navBtn.classList.toggle('nav-btn-due-clear', due === 0);
      }
    },
  };

  // Quiz
  const Quiz = {
    currentChunk: null,
    currentCard: null,  // FIX #5: track current card for bad-card deletion
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
        const existing = Store.cards.forChunk(chunk.id);
        const unseen = cached.filter(q => !isDuplicate(q, existing));
        
        if (unseen.length > 0) {
          this.pendingQueue = unseen.slice(1);
          this._present(unseen[0], chunk, true);
        } else {
          const {questions,fromCache} = await callAPI(chunk);
          const existingCards = Store.cards.forChunk(chunk.id);
          
          let fresh;
          if (!existingCards.length) {
            fresh = questions;
          } else {
            fresh = questions.filter(q => !isDuplicate(q, existingCards));
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
      this.currentCard = q;  // FIX #5: track for bad-card button
      this._showState('content');
      const ansCard = document.getElementById('ans-card');
      const savedNote = document.getElementById('saved-note');
      if (ansCard) ansCard.style.display = 'none';
      if (savedNote) savedNote.style.display = 'none';
      const qHint = document.getElementById('q-hint');
      if (qHint) qHint.style.display = 'block';
      const srButtons = document.getElementById('sr-buttons');
      if (srButtons) srButtons.style.display = 'none';

      // Hide bad-card button until answer is revealed
      const badCardBtn = document.getElementById('bad-card-btn');
      if (badCardBtn) badCardBtn.style.display = 'none';

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

      // FIX #4/#1: Next Question vs Generate More buttons
      const nextBtn = document.getElementById('next-btn');
      const generateBtn = document.getElementById('generate-btn');

      const queueLen = this.pendingQueue.filter(
        pq => !isDuplicate(pq, Store.cards.forChunk(chunk.id))
      ).length;

      if (nextBtn) {
        if (queueLen > 0) {
          nextBtn.style.display = 'inline-flex';
          nextBtn.innerHTML = `Next <span class="cache-count-badge">${queueLen}</span>`;
          nextBtn.onclick = () => {
            const existingNow = Store.cards.forChunk(chunk.id);
            const next = this.pendingQueue.find(pq => !isDuplicate(pq, existingNow));
            if (next) {
              this.pendingQueue = this.pendingQueue.filter(q2 => q2 !== next);
              this._present(next, chunk, true);
            } else {
              this.generate();
            }
          };
        } else {
          nextBtn.style.display = 'none';
        }
      }

      if (generateBtn) {
        generateBtn.style.display = 'inline-flex';
        generateBtn.textContent = 'Generate More';
        generateBtn.onclick = () => this.generate(chunk.id);
      }

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
      if (explanation) {
        // FIX #3: show explanation + why wrong distractors
        let fullExpl = q.explanation || '';
        if (q.whyWrong) {
          fullExpl += `\n\n💡 Why others are wrong:\n${q.whyWrong}`;
        }
        explanation.textContent = fullExpl;
      }
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

      // FIX #5: show bad-card button after answer, wire up deletion
      const badCardBtn = document.getElementById('bad-card-btn');
      if (badCardBtn) {
        badCardBtn.style.display = 'inline-flex';
        badCardBtn.onclick = () => {
          if (confirm('Delete this card? It will be removed from your deck and cannot be recovered.')) {
            Store.cards.delete(cardId);
            Store.srs.set(cardId, undefined); // remove SRS state
            // Also remove from cache so it won't reappear
            const chunkCache = QuestionCache.get(chunk.id) || [];
            const filtered = chunkCache.filter(cq => cq.question !== q.question);
            QuestionCache.set(chunk.id, filtered);
            badCardBtn.style.display = 'none';
            const savedNote = document.getElementById('saved-note');
            if (savedNote) savedNote.style.display = 'none';
            TopicGrid.render();
            TopicGrid.updateDueBadge();
          }
        };
      }

      Store.sessionStats.record(isCorrect,{chunkId:chunk.id,chapterTitle:chunk.title,question:q.question,correct:isCorrect,answer:q.answer,selected:letter});
      Store.stats.record(chunk.id,isCorrect);
      this._updateStreak();
      TopicGrid.updateDueBadge();
    },

    _save(q, chunk) {
      const ex = Store.cards.forChunk(chunk.id).find(c=>c.question===q.question);
      if (ex) return ex.id;
      const id = 'card_'+chunk.id+'_'+Date.now();
      Store.cards.save({
        id, chunkId:chunk.id, chapterTitle:chunk.title, chapter:chunk.chapter,
        pages:q.pages||`${chunk.start}-${chunk.end}`, question:q.question,
        options:q.options, answer:q.answer, explanation:q.explanation,
        whyWrong: q.whyWrong || '',
        tags:q.tags||[], source:q.source,
        createdAt: nowESTISO()  // FIX #6: use EST
      });
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

  // Due Study Mode
  const DueStudy = {
    queue:[], index:0,
    start() {
      this.queue = Store.srs.dueCards(); this.index=0;
      const hasCards = this.queue.length>0;
      const empty = document.getElementById('due-empty');
      const content = document.getElementById('due-content');
      if (empty) empty.style.display = hasCards?'none':'block';
      if (content) content.style.display = hasCards?'block':'none';
      
      // FIX #1: wire up go-topics-btn (empty state) and due-back-topics-btn (always visible)
      const goTopicsBtn = document.getElementById('go-topics-btn');
      if (goTopicsBtn) goTopicsBtn.onclick = () => Nav.show('home');
      if (hasCards) this._show();
    },
    _show() {
      const card = this.queue[this.index];
      if (!card) { this.start(); return; }
      const pct = Math.round(this.index/this.queue.length*100);
      const progressFill = document.getElementById('due-progress-fill');
      const progressTxt = document.getElementById('due-progress-txt');
      if (progressFill) progressFill.style.width = pct+'%';
      if (progressTxt) progressTxt.textContent = `${this.index} / ${this.queue.length}`;
      const ansCard = document.getElementById('due-ans-card');
      if (ansCard) ansCard.style.display='none';
      const hint = document.getElementById('due-hint');
      if (hint) hint.style.display='block';

      // FIX #5: hide bad-card button for due study until answered
      const dueBadCardBtn = document.getElementById('due-bad-card-btn');
      if (dueBadCardBtn) dueBadCardBtn.style.display = 'none';

      const tag = document.getElementById('due-tag');
      if (tag) tag.textContent = `📖 Ch. ${card.chapter} · ${card.chapterTitle} · pp.${card.pages}`;
      const qText = document.getElementById('due-q-text');
      if (qText) qText.textContent = card.question;
      const optsDiv = document.getElementById('due-options');
      if (optsDiv) {
        optsDiv.innerHTML='';
        (card.options||[]).forEach(opt=>{
          const letter=opt[0];
          const btn=document.createElement('button');
          btn.className='opt-btn'; btn.dataset.letter=letter;
          btn.innerHTML=`<span class="opt-ltr">${letter}.</span><span>${opt.slice(2).trim()}</span><span class="opt-mark"></span>`;
          btn.addEventListener('click',()=>this._answer(letter,card));
          optsDiv.appendChild(btn);
        });
      }
    },
    _answer(letter, card) {
      const isCorrect=letter===card.answer;
      document.querySelectorAll('#due-options .opt-btn').forEach(btn=>{
        btn.disabled=true; const l=btn.dataset.letter;
        if (l===card.answer){btn.classList.add('correct');const mark=btn.querySelector('.opt-mark');if(mark)mark.textContent=' ✓';}
        else if (l===letter){btn.classList.add('wrong');const mark=btn.querySelector('.opt-mark');if(mark)mark.textContent=' ✗';}
      });
      const hint = document.getElementById('due-hint');
      if (hint) hint.style.display='none';
      const ansCard = document.getElementById('due-ans-card');
      if (ansCard) ansCard.style.display='block';
      const title = document.getElementById('due-ans-title');
      if (title) {
        title.textContent=isCorrect?'✓ Correct!':`✗ Incorrect — Correct: ${card.answer}`;
        title.className='ans-title '+(isCorrect?'ok':'bad');
      }
      const explanation = document.getElementById('due-explanation');
      if (explanation) {
        // FIX #3: show why wrong in due study too
        let fullExpl = card.explanation || '';
        if (card.whyWrong) {
          fullExpl += `\n\n💡 Why others are wrong:\n${card.whyWrong}`;
        }
        explanation.textContent = fullExpl;
      }
      let srcHtml=`📚 ${card.source}<br>📄 Pages: ${card.pages}`;
      if (card.tags?.length) srcHtml+=`<br>🏷 ${card.tags.slice(0,5).join(' · ')}`;
      const source = document.getElementById('due-source');
      if (source) source.innerHTML=srcHtml;
      const intervals=SM2.previewIntervals(Store.srs.get(card.id));
      const hardDays = document.getElementById('due-hard-days');
      const goodDays = document.getElementById('due-good-days');
      const easyDays = document.getElementById('due-easy-days');
      if (hardDays) hardDays.textContent=SM2.intervalLabel(intervals[2]);
      if (goodDays) goodDays.textContent=SM2.intervalLabel(intervals[3]);
      if (easyDays) easyDays.textContent=SM2.intervalLabel(intervals[4]);

      Store.sessionStats.record(isCorrect,{chunkId:card.chunkId,chapterTitle:card.chapterTitle,question:card.question,correct:isCorrect,answer:card.answer,selected:letter});
      Store.stats.record(card.chunkId,isCorrect);

      // FIX #5: bad-card button in due study
      const dueBadCardBtn = document.getElementById('due-bad-card-btn');
      if (dueBadCardBtn) {
        dueBadCardBtn.style.display = 'inline-flex';
        dueBadCardBtn.onclick = () => {
          if (confirm('Delete this card? It will be removed from your deck and cannot be recovered.')) {
            Store.cards.delete(card.id);
            Store.srs.set(card.id, undefined);
            // Remove from cache
            const chunkCache = QuestionCache.get(card.chunkId) || [];
            const filtered = chunkCache.filter(cq => cq.question !== card.question);
            QuestionCache.set(card.chunkId, filtered);
            dueBadCardBtn.style.display = 'none';
            // Advance to next card
            this.queue.splice(this.index, 1);
            TopicGrid.render();
            TopicGrid.updateDueBadge();
            if (this.queue.length === 0) {
              this.start();
            } else {
              if (this.index >= this.queue.length) this.index = 0;
              this._show();
            }
          }
        };
      }

      const advance=(rating)=>{
        Store.srs.review(card.id,rating);
        this.index++;
        if (this.index>=this.queue.length) {
          // FIX #2: refresh badge when deck is complete
          TopicGrid.updateDueBadge();
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
      if (sr1) sr1.onclick=()=>advance(1);
      if (sr2) sr2.onclick=()=>advance(2);
      if (sr3) sr3.onclick=()=>advance(3);
      if (sr4) sr4.onclick=()=>advance(4);
    },
  };

  // History
  const History = {
    activeTab:'session',
    init() {
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
      
      const exportBtn = document.getElementById('export-btn');
      if (exportBtn) exportBtn.addEventListener('click', () => this._export());
      
      const importBtn = document.getElementById('import-btn');
      const importFile = document.getElementById('import-file');
      if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', (e) => this._import(e));
      }
      
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
      
      const savedSearch = document.getElementById('saved-search');
      if (savedSearch) savedSearch.addEventListener('input', () => this._renderSaved());
    },
    
    render() {
      const savedCount = document.getElementById('saved-count');
      if (savedCount) savedCount.textContent=Store.cards.list().length;
      if (this.activeTab==='session') this._renderSession();
      if (this.activeTab==='saved') this._renderSaved();
      if (this.activeTab==='stats') this._renderStats();
    },
    _renderSession() {
      const h=Store.sessionStats;
      const bar=document.getElementById('score-bar');
      const list=document.getElementById('session-list');
      if (!h.history.length){ if(bar) bar.style.display='none'; if(list) list.innerHTML='<div class="empty-hint">No questions answered yet this session.</div>'; return; }
      if(bar) bar.style.display='flex';
      const pctEl = document.getElementById('score-pct');
      const fillEl = document.getElementById('score-fill');
      const tallyEl = document.getElementById('score-tally');
      if(pctEl) pctEl.textContent=h.pct()+'%';
      if(fillEl) fillEl.style.width=h.pct()+'%';
      if(tallyEl) tallyEl.textContent=`${h.correct}/${h.answered}`;
      if(list) list.innerHTML=h.history.map(item=>`<div class="hist-item ${item.correct?'ok':'bad'}">
        <div class="hist-ch">${item.chapterTitle}</div>
        <div class="hist-result ${item.correct?'ok':'bad'}">${item.correct?'✓ Correct':`✗ Incorrect — Ans: ${item.answer}${item.selected!==item.answer?` (you: ${item.selected})`:''}`}</div>
        <div class="hist-q">${item.question.slice(0,90)}…</div></div>`).join('');
    },
    _renderSaved() {
      const q=(document.getElementById('saved-search')?.value||'').toLowerCase();
      let cards=Store.cards.list();
      if (q) cards=cards.filter(c=>c.question.toLowerCase().includes(q)||c.chapterTitle?.toLowerCase().includes(q)||(c.tags||[]).some(t=>t.includes(q)));
      cards.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
      const savedCount = document.getElementById('saved-count');
      if(savedCount) savedCount.textContent=Store.cards.list().length;
      const list=document.getElementById('saved-list');
      if(!list) return;
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
            ${card.whyWrong ? `<div class="saved-expl" style="margin-top:8px;opacity:0.8">💡 ${card.whyWrong}</div>` : ''}
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
      const cachedChunks=Object.keys(QuestionCache.all()).length;
      const pct=s.totalAnswered?Math.round(s.totalCorrect/s.totalAnswered*100):0;
      const by=s.byChapter||{};
      const weakest=Object.entries(by).filter(([,d])=>d.answered>=3)
        .sort((a,b)=>(a[1].correct/a[1].answered)-(b[1].correct/b[1].answered)).slice(0,6);
      const statsGrid = document.getElementById('stats-grid');
      if(statsGrid) statsGrid.innerHTML=`
        <div class="stat-card"><div class="stat-num">${s.totalAnswered||0}</div><div class="stat-lbl">Total answered</div></div>
        <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-lbl">Overall accuracy</div></div>
        <div class="stat-card"><div class="stat-num">${totalCards}</div><div class="stat-lbl">Cards saved</div></div>
        <div class="stat-card"><div class="stat-num">${dueCount}</div><div class="stat-lbl">Due for review</div></div>
        <div class="stat-card"><div class="stat-num">${cachedChunks}/120</div><div class="stat-lbl">Chunks cached</div></div>
        ${weakest.length?`<div class="stat-card wide"><div class="stat-lbl" style="margin-bottom:8px;font-weight:500">Weakest chapters (≥3 attempts)</div>${weakest.map(([id,d])=>{const sec=SECTIONS?.find(s=>s.id===id);return`<div class="weak-row"><span>${sec?.title||id}</span><span class="weak-pct">${Math.round(d.correct/d.answered*100)}% (${d.correct}/${d.answered})</span></div>`;}).join('')}</div>`:''}`;
    },
    _export() {
      const data={version:2,exportDate:nowESTISO(),cards:Store.cards.list(),srsStates:Store.srs.all(),questionCache:QuestionCache.all()};
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download=`oxford-pallcare-${todayEST()}.json`; a.click();
    },

    _import(e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = JSON.parse(evt.target.result);

          if (!data.cards || !Array.isArray(data.cards)) {
            alert('Invalid file: no cards array found.');
            return;
          }

          // 1. IMPORT CARDS
          let importedCards = 0;
          let skippedCards = 0;
          const existingCards = Store.cards.list();

          data.cards.forEach(card => {
            const idExists = existingCards.some(c => c.id === card.id);
            if (idExists) { skippedCards++; return; }
            const isDup = isDuplicate(card, existingCards);
            if (isDup) { skippedCards++; return; }
            Store.cards.save(card);
            existingCards.push(card);
            importedCards++;
          });

          // 2. IMPORT SRS STATES
          if (data.srsStates && typeof data.srsStates === 'object') {
            Object.entries(data.srsStates).forEach(([cardId, state]) => {
              if (Store.cards.list().some(c => c.id === cardId)) {
                Store.srs.set(cardId, state);
              }
            });
          }

          // 3. MERGE QUESTION CACHE
          if (data.questionCache && typeof data.questionCache === 'object') {
            const allImportedCards = Store.cards.list();
            Object.entries(data.questionCache).forEach(([chunkId, questions]) => {
              const currentCache = QuestionCache.get(chunkId) || [];
              const newCacheQuestions = questions.filter(q => {
                const savedAsDuplicate = isDuplicate(q, allImportedCards);
                const alreadyInCache = currentCache.some(c => c.question === q.question);
                return !savedAsDuplicate && !alreadyInCache;
              });
              const merged = [...currentCache, ...newCacheQuestions];
              if (merged.length > 0) {
                QuestionCache.set(chunkId, merged);
              }
            });
          }

          // 4. REFRESH UI
          TopicGrid.render();
          TopicGrid.updateDueBadge();
          this.render();
          e.target.value = '';

          alert(
            `Import complete:\n` +
            `✓ ${importedCards} cards imported\n` +
            `⊘ ${skippedCards} duplicates skipped\n` +
            `📦 Cache merged for ${Object.keys(data.questionCache || {}).length} chunks`
          );

        } catch (err) {
          console.error('Import failed:', err);
          alert('Import failed: ' + err.message);
        }
      };

      reader.readAsText(file);
    },
  };

  // Settings
  const Settings = {
    init() {
      const s=Store.settings.get();
      const dailyNewLimit = document.getElementById('daily-new-limit');
      const dailyReviewLimit = document.getElementById('daily-review-limit');
      if(dailyNewLimit) {
        dailyNewLimit.value=s.dailyNewLimit;
        dailyNewLimit.addEventListener('change',e=>Store.settings.set({dailyNewLimit:+e.target.value}));
      }
      if(dailyReviewLimit) {
        dailyReviewLimit.value=s.dailyReviewLimit;
        dailyReviewLimit.addEventListener('change',e=>Store.settings.set({dailyReviewLimit:+e.target.value}));
      }

      // FIX #4: batch size setting
      const batchSizeInput = document.getElementById('batch-size-input');
      if (batchSizeInput) {
        batchSizeInput.value = s.batchSize || BATCH_SIZE_DEFAULT;
        batchSizeInput.addEventListener('change', e => {
          const val = Math.min(10, Math.max(1, +e.target.value));
          batchSizeInput.value = val;
          BATCH_SIZE_DEFAULT = val;
          Store.settings.set({ batchSize: val });
        });
        // Apply saved setting on load
        if (s.batchSize) BATCH_SIZE_DEFAULT = s.batchSize;
      }

      // FIX #1: Clear cache button - COMPLETELY REWRITTEN
      const clearCacheBtn = document.getElementById('clear-cache-btn');
      if(clearCacheBtn) {
        clearCacheBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const cacheSize = Object.keys(QuestionCache.all()).length;
          if (confirm(`Clear ${cacheSize} cached question sets? This will NOT delete your saved cards, but will require fresh API calls for topics you've generated before.`)) {
            // Clear the question cache
            QuestionCache.clear();
            
            // Also clear any pending queues in Quiz
            if (Quiz && Quiz.pendingQueue) {
              Quiz.pendingQueue = [];
            }
            
            // Show success message
            const clearMsg = document.createElement('div');
            clearMsg.textContent = `✅ Cleared ${cacheSize} cached question sets!`;
            clearMsg.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#28a745;color:white;padding:12px 20px;border-radius:8px;z-index:9999;animation:fadeOut 2s forwards;box-shadow:0 2px 10px rgba(0,0,0,0.2);';
            document.body.appendChild(clearMsg);
            setTimeout(() => clearMsg.remove(), 2000);
            
            // Refresh the topic grid to update cached indicators
            TopicGrid.render();
            
            console.log('Cache cleared. Remaining cached chunks:', QuestionCache.all());
          }
        });
      }

      const nukeBtn = document.getElementById('nuke-btn');
      if(nukeBtn) nukeBtn.addEventListener('click',()=>{
        if (confirm('Reset ALL data? Cards, SRS, cache, and stats will be deleted.')){
          ['cards','srs','api','settings','stats'].forEach(k=>localStorage.removeItem('oxpal_'+k));
          QuestionCache.clear();
          location.reload();
        }
      });
    },
  };

  function init() {
    if (typeof SECTIONS === 'undefined') {
      console.error('SECTIONS data not loaded! Make sure sections.js is loaded before app.js');
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;text-align:center;z-index:9999';
      errorDiv.textContent = 'Error: sections.js not loaded. Please check your HTML file.';
      document.body.prepend(errorDiv);
      return;
    }
    Theme.init(); Nav.init(); TopicGrid.init(); Quiz.initActions();
    History.init(); Settings.init(); ApiBadge.update();
    AutoSave.init();
    setInterval(ApiBadge.update.bind(ApiBadge),60000);
    TopicGrid.updateDueBadge();
    console.log('✅ App loaded with auto-save enabled');
  }

  return { init };
})();

if (typeof SECTIONS !== 'undefined') {
  document.addEventListener('DOMContentLoaded', App.init);
} else {
  console.error('SECTIONS not defined. Make sure sections.js loads first.');
  window.addEventListener('load', () => {
    if (typeof SECTIONS !== 'undefined') {
      document.addEventListener('DOMContentLoaded', App.init);
    } else {
      console.error('SECTIONS still not defined after page load');
    }
  });
}
