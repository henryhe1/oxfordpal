// SM-2 Spaced Repetition Algorithm - FIXED for correct due date comparison
// Based on SuperMemo 2 (Anki-compatible)
// Rating: 1=Again, 2=Hard, 3=Good, 4=Easy

const SM2 = {
  // Default card state for a new card
  newCard() {
    return {
      interval: 0,      // days until next review
      repetitions: 0,   // number of successful reviews
      easeFactor: 2.5,  // ease factor (min 1.3)
      dueDate: null,    // ISO date string
      lastReview: null,
    };
  },

  // Process a rating and return updated card state
  review(card, rating) {
    const c = { ...card };
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Normalize to start of day

    if (rating === 1) {
      // Fail: reset
      c.repetitions = 0;
      c.interval = 1;
      c.easeFactor = Math.max(1.3, c.easeFactor - 0.2);
    } else {
      // Pass
      if (c.repetitions === 0) {
        c.interval = 1;
      } else if (c.repetitions === 1) {
        c.interval = 6;
      } else {
        c.interval = Math.round(c.interval * c.easeFactor);
      }

      // Ease factor adjustments
      if (rating === 2) {
        // Hard: interval reduces, ease drops
        c.interval = Math.max(1, Math.round(c.interval * 1.2));
        c.easeFactor = Math.max(1.3, c.easeFactor - 0.15);
      } else if (rating === 3) {
        // Good: no change to ease
      } else if (rating === 4) {
        // Easy: ease increases
        c.easeFactor = Math.min(3.0, c.easeFactor + 0.1);
        c.interval = Math.round(c.interval * 1.3);
      }

      c.repetitions += 1;
    }

    // Set last review to today
    c.lastReview = today.toISOString().slice(0, 10);
    
    // Calculate due date
    const due = new Date(today);
    due.setDate(due.getDate() + c.interval);
    c.dueDate = due.toISOString().slice(0, 10);
    
    return c;
  },

  // Preview intervals for each rating without applying
  previewIntervals(card) {
    const ratings = [1, 2, 3, 4];
    const result = {};
    ratings.forEach(r => {
      const updated = SM2.review(card, r);
      result[r] = updated.interval;
    });
    return result;
  },

  // FIX #2: Is this card due today or overdue?
  isDue(card) {
    if (!card || !card.dueDate) return true; // new card = always due
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(card.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    
    // Card is due if due date is today or earlier
    return dueDate <= today;
  },

  // Human-readable interval label
  intervalLabel(days) {
    if (days === 0) return 'Today';
    if (days === 1) return '1 day';
    if (days < 7) return `${days} days`;
    if (days < 30) return `${Math.round(days / 7)}w`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${Math.round(days / 365)}y`;
  },
};