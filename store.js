// ── Store: all localStorage persistence ──────────────────────────────────────
// Keys: oxpal_cards, oxpal_srs, oxpal_api, oxpal_settings, oxpal_stats, oxpal_qcache

const Store = (() => {
  const P = 'oxpal_';
  const get = k => { try { return JSON.parse(localStorage.getItem(P+k)); } catch { return null; } };
  const set = (k,v) => { try { localStorage.setItem(P+k, JSON.stringify(v)); } catch(e) { console.error('Store write error',e); } };

  // Cards — keyed by card.id
  const cards = {
    all()          { return get('cards')||{}; },
    save(card)     { const c=this.all(); c[card.id]=card; set('cards',c); },
    delete(id)     { const c=this.all(); delete c[id]; set('cards',c); },
    clear()        { set('cards',{}); },
    list()         { return Object.values(this.all()); },
    forChunk(cid)  { return this.list().filter(c=>c.chunkId===cid); },
  };

  // SRS — SM2 state per card.id
  const srs = {
    all()              { return get('srs')||{}; },
    get(cardId)        { return (this.all())[cardId] || SM2.newCard(); },
    set(cardId,state)  { const a=this.all(); a[cardId]=state; set('srs',a); },
    review(cardId,rating) { const u=SM2.review(this.get(cardId),rating); this.set(cardId,u); return u; },
    
    dueCards() {
      const allCards = cards.list();  // ← FIXED: use cards.list()
      const due = [];
      
      for (const card of allCards) {
        const srsData = this.get(card.id);
        if (srsData && srsData.dueDate) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const dueDate = new Date(srsData.dueDate);
          dueDate.setHours(0, 0, 0, 0);
          
          if (dueDate <= today) {
            due.push(card);
          }
        }
      }
      
      due.sort((a, b) => {
        const srsA = this.get(a.id);
        const srsB = this.get(b.id);
        return new Date(srsA.dueDate) - new Date(srsB.dueDate);
      });
      
      return due;
    },
  };

  // Question cache — keyed by chunk.id, stores array of question objects
  const questionCache = {
    all()          { return get('qcache')||{}; },
    get(chunkId)   { return (this.all())[chunkId]||null; },
    set(chunkId,qs){ const a=this.all(); a[chunkId]=qs; set('qcache',a); },
    clear()        { set('qcache',{}); },
    size()         { return Object.keys(this.all()).length; },
  };

  // API call tracking (simplified - no badge display needed)
  const api = {
    recordCall() { return; },
    remaining() { return 999; },
    nextReset() { return null; },
    reset() {},
  };

  // Settings
  const settings = {
    defaults: {theme:'auto',dailyNewLimit:10,dailyReviewLimit:50},
    get()          { return {...this.defaults,...(get('settings')||{})}; },
    set(updates)   { set('settings',{...this.get(),...updates}); },
  };

  // In-session stats (not persisted across page loads)
  const sessionStats = {
    answered:0, correct:0, streak:0, history:[],
    record(isCorrect,entry) {
      this.answered++; 
      this.history.unshift(entry);
      if (isCorrect){
        this.correct++;
        this.streak++;
      } else { 
        this.streak=0;
      }
    },
    pct() { return this.answered?Math.round(this.correct/this.answered*100):0; },
  };

  // Persistent stats — survives page loads
  const stats = {
    get()            { return get('stats')||{totalAnswered:0,totalCorrect:0,byChapter:{}}; },
    record(chunkId,isCorrect) {
      const s=this.get();
      s.totalAnswered=(s.totalAnswered||0)+1;
      if (isCorrect) s.totalCorrect=(s.totalCorrect||0)+1;
      if (!s.byChapter) s.byChapter={};
      if (!s.byChapter[chunkId]) s.byChapter[chunkId]={answered:0,correct:0};
      s.byChapter[chunkId].answered++;
      if (isCorrect) s.byChapter[chunkId].correct++;
      s.lastStudy=new Date().toISOString().slice(0,10);
      set('stats',s);
    },
    clear() { set('stats',{}); },
  };

  return { cards, srs, questionCache, api, settings, sessionStats, stats };
})();