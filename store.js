// ── Store: all localStorage persistence ────────────────────────────────────
// Keys:
//   oxpal_cards      : { [cardId]: CardRecord }
//   oxpal_srs        : { [chapterId]: SM2State }
//   oxpal_api        : { calls: [], windowMs: 18000000 }  (5-hour window)
//   oxpal_settings   : { theme, dailyNewLimit, dailyReviewLimit }
//   oxpal_stats      : { totalAnswered, totalCorrect, streakDays, lastStudy }

const Store = (() => {
  const PREFIX = 'oxpal_';
  const get = (k) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch(e) { console.error('Store write error', e); } };

  // ── Cards ──────────────────────────────────────────────────────────────────
  // CardRecord: { id, chapterId, chapterTitle, question, options, answer, explanation, source, pages, createdAt }
  const cards = {
    all() { return get('cards') || {}; },
    save(card) {
      const cards = this.all();
      cards[card.id] = card;
      set('cards', cards);
    },
    delete(id) {
      const cards = this.all();
      delete cards[id];
      set('cards', cards);
    },
    clear() { set('cards', {}); },
    list() { return Object.values(this.all()); },
    forChapter(chapterId) { return this.list().filter(c => c.chapterId === chapterId); },
  };

  // ── SRS (spaced repetition state per card) ─────────────────────────────────
  // { [cardId]: SM2State }
  const srs = {
    all() { return get('srs') || {}; },
    get(cardId) { return (this.all())[cardId] || SM2.newCard(); },
    set(cardId, state) {
      const all = this.all();
      all[cardId] = state;
      set('srs', all);
    },
    review(cardId, rating) {
      const current = this.get(cardId);
      const updated = SM2.review(current, rating);
      this.set(cardId, updated);
      return updated;
    },
    dueCards() {
      const allCards = cards.list();
      const srsAll = this.all();
      return allCards.filter(card => {
        const state = srsAll[card.id] || SM2.newCard();
        return SM2.isDue(state);
      });
    },
    statsForCard(cardId) { return this.get(cardId); },
  };

  // ── API call tracking ──────────────────────────────────────────────────────
  const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
  const FREE_ESTIMATE = 25; // conservative estimate for free plan

  const api = {
    _data() { return get('api') || { calls: [] }; },
    _save(d) { set('api', d); },

    recordCall() {
      const d = this._data();
      d.calls.push(Date.now());
      this._save(d);
    },

    // Remove calls older than 5 hours, return remaining estimate
    remaining() {
      const d = this._data();
      const cutoff = Date.now() - WINDOW_MS;
      d.calls = d.calls.filter(t => t > cutoff);
      this._save(d);
      const used = d.calls.length;
      return Math.max(0, FREE_ESTIMATE - used);
    },

    // Time until oldest call expires (next reset)
    nextReset() {
      const d = this._data();
      const cutoff = Date.now() - WINDOW_MS;
      const live = d.calls.filter(t => t > cutoff);
      if (!live.length) return null;
      const oldest = Math.min(...live);
      return new Date(oldest + WINDOW_MS);
    },

    reset() { this._save({ calls: [] }); },
  };

  // ── Settings ───────────────────────────────────────────────────────────────
  const settings = {
    defaults: { theme: 'auto', dailyNewLimit: 10, dailyReviewLimit: 50 },
    get() { return { ...this.defaults, ...(get('settings') || {}) }; },
    set(updates) { set('settings', { ...this.get(), ...updates }); },
  };

  // ── Session stats ──────────────────────────────────────────────────────────
  const sessionStats = {
    answered: 0, correct: 0,
    history: [], // { chapterId, chapterTitle, question, correct, answer, selected }
    streak: 0,
    record(isCorrect, entry) {
      this.answered++;
      if (isCorrect) { this.correct++; this.streak++; } else { this.streak = 0; }
      this.history.unshift(entry);
    },
    pct() { return this.answered ? Math.round(this.correct / this.answered * 100) : 0; },
  };

  // ── Persistent stats ───────────────────────────────────────────────────────
  const stats = {
    get() { return get('stats') || { totalAnswered: 0, totalCorrect: 0, byChapter: {} }; },
    record(chapterId, isCorrect) {
      const s = this.get();
      s.totalAnswered = (s.totalAnswered || 0) + 1;
      if (isCorrect) s.totalCorrect = (s.totalCorrect || 0) + 1;
      if (!s.byChapter) s.byChapter = {};
      if (!s.byChapter[chapterId]) s.byChapter[chapterId] = { answered: 0, correct: 0 };
      s.byChapter[chapterId].answered++;
      if (isCorrect) s.byChapter[chapterId].correct++;
      s.lastStudy = new Date().toISOString().slice(0, 10);
      set('stats', s);
    },
    clear() { set('stats', {}); },
  };

  return { cards, srs, api, settings, sessionStats, stats };
})();
