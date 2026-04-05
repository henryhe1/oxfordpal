// ── Oxford Palliative Medicine — Main App ──────────────────────────────────

const App = (() => {
  let currentSection = null;
  let currentQData = null;
  let dueQueue = [];
  let dueIndex = 0;
  let dueAnswered = false;

  // ── Theme ──────────────────────────────────────────────────────────────────
  const Theme = {
    apply(pref) {
      const root = document.documentElement;
      if (pref === 'auto') {
        const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', sysDark ? 'dark' : 'light');
      } else {
        root.setAttribute('data-theme', pref);
      }
      const icon = document.querySelector('.theme-icon');
      if (icon) icon.textContent = root.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
    },
    init() {
      const s = Store.settings.get();
      this.apply(s.theme);
      document.querySelectorAll('input[name="theme"]').forEach(r => {
        r.checked = r.value === s.theme;
        r.addEventListener('change', () => {
          Store.settings.set({ theme: r.value });
          this.apply(r.value);
        });
      });
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (Store.settings.get().theme === 'auto') this.apply('auto');
      });
      document.getElementById('theme-toggle').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        Store.settings.set({ theme: next });
        document.querySelectorAll('input[name="theme"]').forEach(r => r.checked = r.value === next);
        this.apply(next);
      });
    },
  };

  // ── Navigation ─────────────────────────────────────────────────────────────
  const Nav = {
    init() {
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => this.show(btn.dataset.view));
      });
    },
    show(viewName) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('view-' + viewName).classList.add('active');
      document.querySelector(`.nav-btn[data-view="${viewName}"]`)?.classList.add('active');
      if (viewName === 'history') History.render();
      if (viewName === 'due') DueStudy.start();
      if (viewName === 'home') TopicGrid.render();
    },
  };

  // ── API Badge ──────────────────────────────────────────────────────────────
  const ApiBadge = {
    update() {
      const rem = Store.api.remaining();
      const el = document.getElementById('api-count');
      const badge = document.getElementById('api-badge');
      if (el) el.textContent = rem;
      if (badge) {
        badge.className = 'api-badge' + (rem <= 5 ? ' api-low' : rem <= 12 ? ' api-med' : '');
      }
      const reset = Store.api.nextReset();
      const resetEl = document.getElementById('api-reset');
      if (resetEl && reset) {
        const diffMs = reset - Date.now();
        const h = Math.floor(diffMs / 3600000);
        const m = Math.floor((diffMs % 3600000) / 60000);
        resetEl.textContent = `resets ${h}h ${m}m`;
      } else if (resetEl) {
        resetEl.textContent = '';
      }
    },
  };

  // ── Topic Grid ─────────────────────────────────────────────────────────────
  const TopicGrid = {
    activeFilter: 'all',
    init() {
      this.buildFilterBar();
      this.render();
      document.getElementById('search-input').addEventListener('input', () => this.render());
      document.getElementById('random-btn').addEventListener('click', () => Quiz.generate());
      document.getElementById('study-due-btn').addEventListener('click', () => Nav.show('due'));
    },
    buildFilterBar() {
      const bar = document.getElementById('filter-bar');
      const groups = {};
      SECTIONS.forEach(s => {
        if (!groups[s.section]) groups[s.section] = [];
        groups[s.section].push(s);
      });

      const all = this._chip('All', null, true);
      bar.appendChild(all);
      Object.entries(groups).forEach(([sec, items]) => {
        bar.appendChild(this._chip(`§${sec} ${items[0].sectionLabel}`, sec, false));
      });
    },
    _chip(label, sec, active) {
      const b = document.createElement('button');
      b.className = 'filter-chip' + (active ? ' active' : '');
      b.textContent = label;
      b.dataset.section = sec || 'all';
      b.addEventListener('click', () => {
        this.activeFilter = sec || 'all';
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        b.classList.add('active');
        this.render();
      });
      return b;
    },
    render() {
      const q = document.getElementById('search-input').value.toLowerCase();
      const filtered = SECTIONS.filter(s => {
        const matchSec = this.activeFilter === 'all' || s.section === this.activeFilter;
        const matchQ = !q || s.title.toLowerCase().includes(q) || s.chapter.includes(q);
        return matchSec && matchQ;
      });
      const grid = document.getElementById('topic-grid');
      grid.innerHTML = '';
      if (!filtered.length) {
        grid.innerHTML = '<p class="empty-hint" style="grid-column:1/-1">No topics match.</p>';
        return;
      }
      filtered.forEach(s => {
        const saved = Store.cards.forChapter(s.id).length;
        const srsState = saved > 0 ? Store.srs.dueCards().filter(c => c.chapterId === s.id).length : 0;
        const card = document.createElement('div');
        card.className = 'topic-card';
        card.innerHTML = `
          <div class="topic-ch">Ch. ${s.chapter} · pp.${s.start}–${s.end}</div>
          <div class="topic-title">${s.title}</div>
          ${saved > 0 ? `<div class="topic-meta">${saved} saved${srsState > 0 ? ` · <span class="due-dot">${srsState} due</span>` : ''}</div>` : ''}
        `;
        card.addEventListener('click', () => Quiz.generate(s));
        grid.appendChild(card);
      });
    },
    updateDueBadge() {
      const due = Store.srs.dueCards().length;
      const badge = document.getElementById('due-count');
      if (badge) badge.textContent = due > 0 ? due : '';
    },
  };

  // ── Quiz ───────────────────────────────────────────────────────────────────
  const Quiz = {
    async generate(sec) {
      const s = sec || SECTIONS[Math.floor(Math.random() * SECTIONS.length)];
      currentSection = s;
      currentQData = null;

      Nav.show('quiz');
      this._showLoading(true);
      document.getElementById('loading-chapter').textContent = `Chapter ${s.chapter}: ${s.title}`;

      const prompt = `You are an expert palliative medicine examiner. Using ONLY this excerpt from the Oxford Textbook of Palliative Medicine 6th Edition, Chapter ${s.chapter} "${s.title}" (pages ${s.start}-${s.end}):

${s.text}

Generate ONE high-quality single-best-answer exam question in EXACTLY this format:

QUESTION: [clinical scenario or knowledge question from the text]

OPTIONS:
A. [option]
B. [option]
C. [option]
D. [option]
E. [option]

ANSWER: [single letter only]

EXPLANATION: [2-3 sentences explaining why the correct answer is right and why key distractors are wrong, citing specific content from the text]

SOURCE: Oxford Textbook of Palliative Medicine, 6th Edition, Chapter ${s.chapter}: ${s.title}

PAGE: ${s.start}-${s.end}

Rules: must be answerable from the provided text; clinically relevant; plausible but clearly wrong distractors.`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        Store.api.recordCall();
        ApiBadge.update();
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        const text = data.content.map(b => b.text || '').join('');
        currentQData = this._parse(text);
        this._render();
      } catch (e) {
        this._showLoading(false);
        document.getElementById('quiz-error').style.display = 'block';
        document.getElementById('error-msg').textContent = 'Error: ' + e.message;
      }
    },

    _parse(text) {
      const get = (key, next) => {
        const r = new RegExp(key + ':[\\s\\S]*?(?=' + next + '|$)');
        const m = text.match(r);
        if (!m) return '';
        return m[0].replace(new RegExp('^' + key + ':'), '').trim();
      };
      const optStr = get('OPTIONS', 'ANSWER|EXPLANATION|SOURCE|PAGE');
      const opts = optStr.split('\n').map(l => l.trim()).filter(l => /^[A-E][.)]/i.test(l));
      return {
        question: get('QUESTION', 'OPTIONS|ANSWER|EXPLANATION'),
        options: opts,
        answer: get('ANSWER', 'EXPLANATION|SOURCE|PAGE').slice(0, 1).toUpperCase(),
        explanation: get('EXPLANATION', 'SOURCE|PAGE'),
        source: get('SOURCE', 'PAGE') || 'Oxford Textbook of Palliative Medicine, 6th Ed.',
        pages: get('PAGE', 'ZZZZ'),
      };
    },

    _showLoading(show) {
      document.getElementById('quiz-loading').style.display = show ? 'block' : 'none';
      document.getElementById('quiz-content').style.display = show ? 'none' : 'block';
      document.getElementById('quiz-error').style.display = 'none';
    },

    _render() {
      this._showLoading(false);
      document.getElementById('ans-card').style.display = 'none';
      document.getElementById('q-hint').style.display = 'block';
      document.getElementById('saved-note').style.display = 'none';
      document.getElementById('sr-buttons').style.display = 'none';

      const s = currentSection;
      document.getElementById('q-tag').textContent = `📖 Ch. ${s.chapter} · ${s.title} · pp.${s.start}–${s.end}`;
      document.getElementById('q-text').textContent = currentQData.question;

      const optsDiv = document.getElementById('q-options');
      optsDiv.innerHTML = '';
      currentQData.options.forEach(opt => {
        const letter = opt[0];
        const txt = opt.slice(2).trim();
        const btn = document.createElement('button');
        btn.className = 'opt-btn';
        btn.dataset.letter = letter;
        btn.innerHTML = `<span class="opt-ltr">${letter}.</span><span>${txt}</span><span class="opt-mark"></span>`;
        btn.addEventListener('click', () => this._answer(letter));
        optsDiv.appendChild(btn);
      });
    },

    _answer(letter) {
      const q = currentQData;
      const s = currentSection;
      const isCorrect = letter === q.answer;

      // Lock options
      document.querySelectorAll('#q-options .opt-btn').forEach(btn => {
        btn.disabled = true;
        const l = btn.dataset.letter;
        if (l === q.answer) { btn.classList.add('correct'); btn.querySelector('.opt-mark').textContent = ' ✓'; }
        else if (l === letter) { btn.classList.add('wrong'); btn.querySelector('.opt-mark').textContent = ' ✗'; }
      });

      document.getElementById('q-hint').style.display = 'none';
      const ansCard = document.getElementById('ans-card');
      ansCard.style.display = 'block';

      const title = document.getElementById('ans-title');
      title.textContent = isCorrect ? '✓ Correct!' : `✗ Incorrect — Correct answer: ${q.answer}`;
      title.className = 'ans-title ' + (isCorrect ? 'ok' : 'bad');
      document.getElementById('ans-explanation').textContent = q.explanation;
      document.getElementById('ans-source').innerHTML = `📚 ${q.source}<br>📄 Pages: ${q.pages}`;

      // Save card and show SR buttons
      const cardId = this._saveCard(q, s);
      const srState = Store.srs.get(cardId);
      const intervals = SM2.previewIntervals(srState);
      document.getElementById('sr-hard-days').textContent = SM2.intervalLabel(intervals[2]);
      document.getElementById('sr-good-days').textContent = SM2.intervalLabel(intervals[3]);
      document.getElementById('sr-easy-days').textContent = SM2.intervalLabel(intervals[4]);
      document.getElementById('sr-buttons').style.display = 'flex';

      // SR button handlers
      document.querySelectorAll('#sr-buttons .sr-btn').forEach(btn => {
        btn.onclick = () => {
          const rating = parseInt(btn.dataset.rating);
          Store.srs.review(cardId, rating);
          document.getElementById('sr-buttons').style.display = 'none';
        };
      });

      // Session + persistent stats
      Store.sessionStats.record(isCorrect, { chapterId: s.id, chapterTitle: s.title, question: q.question, correct: isCorrect, answer: q.answer, selected: letter });
      Store.stats.record(s.id, isCorrect);
      this._updateStreak();
      TopicGrid.updateDueBadge();
    },

    _saveCard(q, s) {
      const id = 'card_' + s.id + '_' + Date.now();
      // Check if identical question already exists
      const existing = Store.cards.forChapter(s.id).find(c => c.question === q.question);
      if (existing) {
        document.getElementById('saved-note').style.display = 'none';
        return existing.id;
      }
      const card = {
        id, chapterId: s.id, chapterTitle: s.title,
        chapter: s.chapter, pages: q.pages,
        question: q.question, options: q.options,
        answer: q.answer, explanation: q.explanation,
        source: q.source, createdAt: new Date().toISOString(),
      };
      Store.cards.save(card);
      document.getElementById('saved-note').style.display = 'block';
      return id;
    },

    _updateStreak() {
      const streak = Store.sessionStats.streak;
      const badge = document.getElementById('streak-badge');
      const num = document.getElementById('streak-num');
      if (streak > 1) { badge.style.display = 'flex'; num.textContent = streak; }
      else { badge.style.display = 'none'; }
    },

    initActions() {
      document.getElementById('next-btn').addEventListener('click', () => Quiz.generate());
      document.getElementById('same-topic-btn').addEventListener('click', () => Quiz.generate(currentSection));
      document.getElementById('back-btn').addEventListener('click', () => Nav.show('home'));
      document.getElementById('retry-btn').addEventListener('click', () => Quiz.generate(currentSection));
    },
  };

  // ── Due Study (SRS mode) ───────────────────────────────────────────────────
  const DueStudy = {
    queue: [],
    index: 0,
    answered: false,

    start() {
      this.queue = Store.srs.dueCards();
      this.index = 0;
      this.answered = false;
      const empty = document.getElementById('due-empty');
      const content = document.getElementById('due-content');
      if (!this.queue.length) {
        empty.style.display = 'block';
        content.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      content.style.display = 'block';
      this._show();
    },

    _show() {
      this.answered = false;
      const card = this.queue[this.index];
      if (!card) { this.start(); return; }

      // Update progress
      const fill = document.getElementById('due-progress-fill');
      const txt = document.getElementById('due-progress-txt');
      const pct = Math.round(this.index / this.queue.length * 100);
      fill.style.width = pct + '%';
      txt.textContent = `${this.index} / ${this.queue.length}`;

      // Show question
      document.getElementById('due-ans-card').style.display = 'none';
      document.getElementById('due-hint').style.display = 'block';

      const sec = SECTIONS.find(s => s.id === card.chapterId) || { chapter: card.chapter, title: card.chapterTitle, start: card.pages?.split('-')[0] || '', end: card.pages?.split('-')[1] || '' };
      document.getElementById('due-tag').textContent = `📖 Ch. ${card.chapter} · ${card.chapterTitle} · pp.${card.pages}`;
      document.getElementById('due-q-text').textContent = card.question;

      const optsDiv = document.getElementById('due-options');
      optsDiv.innerHTML = '';
      card.options.forEach(opt => {
        const letter = opt[0];
        const txt = opt.slice(2).trim();
        const btn = document.createElement('button');
        btn.className = 'opt-btn';
        btn.dataset.letter = letter;
        btn.innerHTML = `<span class="opt-ltr">${letter}.</span><span>${txt}</span><span class="opt-mark"></span>`;
        btn.addEventListener('click', () => this._answer(letter, card));
        optsDiv.appendChild(btn);
      });
    },

    _answer(letter, card) {
      if (this.answered) return;
      this.answered = true;
      const isCorrect = letter === card.answer;

      document.querySelectorAll('#due-options .opt-btn').forEach(btn => {
        btn.disabled = true;
        const l = btn.dataset.letter;
        if (l === card.answer) { btn.classList.add('correct'); btn.querySelector('.opt-mark').textContent = ' ✓'; }
        else if (l === letter) { btn.classList.add('wrong'); btn.querySelector('.opt-mark').textContent = ' ✗'; }
      });

      document.getElementById('due-hint').style.display = 'none';
      const ansCard = document.getElementById('due-ans-card');
      ansCard.style.display = 'block';

      const title = document.getElementById('due-ans-title');
      title.textContent = isCorrect ? '✓ Correct!' : `✗ Incorrect — Correct answer: ${card.answer}`;
      title.className = 'ans-title ' + (isCorrect ? 'ok' : 'bad');
      document.getElementById('due-explanation').textContent = card.explanation;
      document.getElementById('due-source').innerHTML = `📚 ${card.source}<br>📄 Pages: ${card.pages}`;

      const srState = Store.srs.get(card.id);
      const intervals = SM2.previewIntervals(srState);
      document.getElementById('due-hard-days').textContent = SM2.intervalLabel(intervals[2]);
      document.getElementById('due-good-days').textContent = SM2.intervalLabel(intervals[3]);
      document.getElementById('due-easy-days').textContent = SM2.intervalLabel(intervals[4]);

      Store.sessionStats.record(isCorrect, { chapterId: card.chapterId, chapterTitle: card.chapterTitle, question: card.question, correct: isCorrect, answer: card.answer, selected: letter });
      Store.stats.record(card.chapterId, isCorrect);

      // SR buttons
      const rateAndNext = (rating) => {
        Store.srs.review(card.id, rating);
        this.index++;
        if (this.index >= this.queue.length) {
          this.start(); // done — will show empty or restart
        } else {
          this._show();
        }
        TopicGrid.updateDueBadge();
      };

      document.getElementById('due-sr-1').onclick = () => rateAndNext(1);
      document.getElementById('due-sr-2').onclick = () => rateAndNext(2);
      document.getElementById('due-sr-3').onclick = () => rateAndNext(3);
      document.getElementById('due-sr-4').onclick = () => rateAndNext(4);
    },
  };

  // ── History ────────────────────────────────────────────────────────────────
  const History = {
    activeTab: 'session',
    init() {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
          this.activeTab = btn.dataset.tab;
          this.render();
        });
      });
      document.getElementById('export-btn').addEventListener('click', () => this._export());
      document.getElementById('clear-saved-btn').addEventListener('click', () => {
        if (confirm('Delete all saved cards? This cannot be undone.')) { Store.cards.clear(); Store.srs._data && Store.srs.all(); this.render(); TopicGrid.render(); }
      });
      document.getElementById('saved-search').addEventListener('input', () => this._renderSaved());
    },
    render() {
      document.getElementById('saved-count').textContent = Store.cards.list().length;
      if (this.activeTab === 'session') this._renderSession();
      if (this.activeTab === 'saved') this._renderSaved();
      if (this.activeTab === 'stats') this._renderStats();
    },
    _renderSession() {
      const h = Store.sessionStats;
      const list = document.getElementById('session-list');
      const bar = document.getElementById('score-bar');
      if (!h.history.length) {
        list.innerHTML = '<div class="empty-hint">No questions answered yet this session.</div>';
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'flex';
      document.getElementById('score-pct').textContent = h.pct() + '%';
      document.getElementById('score-fill').style.width = h.pct() + '%';
      document.getElementById('score-tally').textContent = `${h.correct}/${h.answered}`;
      list.innerHTML = h.history.map(item => `
        <div class="hist-item ${item.correct ? 'ok' : 'bad'}">
          <div class="hist-ch">Ch. ${item.chapterId?.replace('s', '')} · ${item.chapterTitle}</div>
          <div class="hist-result ${item.correct ? 'ok' : 'bad'}">${item.correct ? '✓ Correct' : `✗ Incorrect — Ans: ${item.answer}${item.selected !== item.answer ? ` (you chose ${item.selected})` : ''}`}</div>
          <div class="hist-q">${item.question.slice(0, 90)}…</div>
        </div>
      `).join('');
    },
    _renderSaved() {
      const q = document.getElementById('saved-search').value.toLowerCase();
      let cards = Store.cards.list();
      if (q) cards = cards.filter(c => c.question.toLowerCase().includes(q) || c.chapterTitle.toLowerCase().includes(q));
      cards.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const list = document.getElementById('saved-list');
      document.getElementById('saved-count').textContent = Store.cards.list().length;
      if (!cards.length) {
        list.innerHTML = '<div class="empty-hint">No saved cards yet. Generate questions to build your deck.</div>';
        return;
      }
      list.innerHTML = cards.map(card => {
        const srsState = Store.srs.get(card.id);
        const due = SM2.isDue(srsState);
        const nextDue = srsState.dueDate ? SM2.intervalLabel(Math.max(0, Math.round((new Date(srsState.dueDate) - new Date()) / 86400000))) : 'New';
        return `
          <div class="saved-card">
            <div class="saved-card-header">
              <span class="topic-ch">Ch. ${card.chapter} · ${card.chapterTitle}</span>
              <span class="srs-chip ${due ? 'due' : ''}">${due ? '⚡ Due' : `Next: ${nextDue}`}</span>
              <button class="delete-card" data-id="${card.id}" title="Delete card">✕</button>
            </div>
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
      list.querySelectorAll('.delete-card').forEach(btn => {
        btn.addEventListener('click', () => {
          Store.cards.delete(btn.dataset.id);
          this._renderSaved();
          TopicGrid.render();
        });
      });
    },
    _renderStats() {
      const s = Store.stats.get();
      const pct = s.totalAnswered ? Math.round(s.totalCorrect / s.totalAnswered * 100) : 0;
      const totalCards = Store.cards.list().length;
      const dueCount = Store.srs.dueCards().length;
      const grid = document.getElementById('stats-grid');
      const by = s.byChapter || {};
      const weakest = Object.entries(by).sort((a, b) => (a[1].correct/a[1].answered||0) - (b[1].correct/b[1].answered||0)).slice(0, 5);
      grid.innerHTML = `
        <div class="stat-card"><div class="stat-num">${s.totalAnswered || 0}</div><div class="stat-lbl">Questions answered</div></div>
        <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-lbl">Overall accuracy</div></div>
        <div class="stat-card"><div class="stat-num">${totalCards}</div><div class="stat-lbl">Cards in deck</div></div>
        <div class="stat-card"><div class="stat-num">${dueCount}</div><div class="stat-lbl">Due for review</div></div>
        ${weakest.length ? `
        <div class="stat-card wide">
          <div class="stat-lbl" style="margin-bottom:10px">Weakest chapters</div>
          ${weakest.map(([id, d]) => {
            const sec = SECTIONS.find(s => s.id === id);
            const p = Math.round(d.correct / d.answered * 100);
            return `<div class="weak-row"><span>${sec?.title || id}</span><span>${p}% (${d.correct}/${d.answered})</span></div>`;
          }).join('')}
        </div>` : ''}
      `;
    },
    _export() {
      const data = { exportDate: new Date().toISOString(), cards: Store.cards.list(), srsStates: Store.srs.all() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `oxford-pallcare-cards-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
    },
  };

  // ── Settings page ──────────────────────────────────────────────────────────
  const Settings = {
    init() {
      const s = Store.settings.get();
      document.getElementById('daily-new-limit').value = s.dailyNewLimit;
      document.getElementById('daily-review-limit').value = s.dailyReviewLimit;
      document.getElementById('daily-new-limit').addEventListener('change', e => Store.settings.set({ dailyNewLimit: parseInt(e.target.value) }));
      document.getElementById('daily-review-limit').addEventListener('change', e => Store.settings.set({ dailyReviewLimit: parseInt(e.target.value) }));
      document.getElementById('reset-api-btn').addEventListener('click', () => { Store.api.reset(); ApiBadge.update(); });
      document.getElementById('nuke-btn').addEventListener('click', () => {
        if (confirm('Reset ALL data? This will delete all saved cards, SRS progress, and stats.')) {
          ['cards', 'srs', 'api', 'settings', 'stats'].forEach(k => localStorage.removeItem('oxpal_' + k));
          location.reload();
        }
      });
      document.getElementById('go-topics-btn')?.addEventListener('click', () => Nav.show('home'));
    },
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    Theme.init();
    Nav.init();
    TopicGrid.init();
    Quiz.initActions();
    History.init();
    Settings.init();
    ApiBadge.update();
    setInterval(ApiBadge.update.bind(ApiBadge), 60000);
    TopicGrid.updateDueBadge();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
