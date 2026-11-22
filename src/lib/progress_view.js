// src/lib/progress_view.js
// Turns the server's progress report into what the report screens show.

const LEVEL_NAME = { '5': 'Grade V', '6': 'Grade VI', '7': 'Grade VII', '8': 'Grade VIII', '9': 'Grade IX', '10': 'Grade X' };
const tl = t => String(t || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Same fields the old full report used, but mastery and scores come from the server
export function topicBreakdown(topics, subject) {
  return (topics || [])
    .filter(t => t.subject === subject)
    .map(t => {
      const score = t.score === undefined ? null : t.score;
      return {
        level: String(t.level), levelLabel: LEVEL_NAME[String(t.level)] || String(t.level),
        topic: t.topic, label: tl(t.topic),
        answered: t.answered, correct: t.correct, score,
        diffLevel: t.diff_level, mastered: !!t.mastered,
        needsWork: (score === null ? 100 : score) < 60,
        easyScore: t.easy_score ?? null, mediumScore: t.medium_score ?? null, hardScore: t.hard_score ?? null,
        daysPracticed: t.days || 0,
      };
    })
    .sort((a, b) => (a.level !== b.level ? a.level.localeCompare(b.level) : (a.score || 0) - (b.score || 0)));
}

// topicRecords-shaped data for the screens that only need answered / correct
export function recordsFromTopics(topics) {
  const rec = {};
  for (const t of topics || []) {
    rec[`${t.subject}_${t.level}_${t.topic}`] = {
      answered: t.answered, correct: t.correct, slow: 0, lastWrong: 0, diffLevel: t.diff_level || 0,
      easy: { answered: 0, correct: 0, slow: 0 }, medium: { answered: 0, correct: 0, slow: 0 }, hard: { answered: 0, correct: 0, slow: 0 },
      daysPracticed: new Array(t.days || 0).fill('d'),
    };
  }
  return rec;
}
