// Figures out how the user responded to previous notes, so the next one can
// be tailored instead of repeating the same tone every time. Pure logic only
// — background.js owns reading/writing the message log in chrome.storage.local.

// A meaningful drop in match rate (fraction of recent videos Jev classified
// as matching the user's instruction) counts as "the user cut back".
const IMPROVEMENT_RATIO = 0.5;

// messageLog: array of past { at, matchRate, flagged }, oldest first.
// currentMatchRate: this check's fraction of matching videos.
// Returns { reaction, note }: `note` is a sentence to fold into the write-up
// prompt (or null for the default tone), `reaction` is a label for storage.
export function describeReaction(messageLog, currentMatchRate) {
  const lastFlagged = [...messageLog].reverse().find((m) => m.flagged);
  if (!lastFlagged) {
    return { reaction: 'first_message', note: null };
  }

  const since = messageLog.filter((m) => m.at > lastFlagged.at);
  const rateSince = [...since.map((m) => m.matchRate), currentMatchRate];
  const minRateSince = Math.min(...rateSince);

  const improvedAtSomePoint = minRateSince <= lastFlagged.matchRate * IMPROVEMENT_RATIO;
  const backUpNow = currentMatchRate > lastFlagged.matchRate * IMPROVEMENT_RATIO;

  if (improvedAtSomePoint && backUpNow) {
    return {
      reaction: 'relapsed_after_improvement',
      note:
        'The user visibly cut back on this pattern after your last note, but has now slipped back into ' +
        "it. They've already proven they can change — reward that with genuine words of encouragement " +
        "and acknowledge the progress they showed, rather than scolding them for the relapse."
    };
  }

  if (!improvedAtSomePoint) {
    return {
      reaction: 'no_change',
      note:
        "The user has been flagged for this same pattern before and hasn't changed since your last note. " +
        'Stay warm, but feel free to be a bit more direct than usual.'
    };
  }

  return { reaction: 'improved', note: null };
}
