// Turns chrome.history entries into a prompt Alux can reflect on.
// Only reads history on demand (when the user clicks "Check now") — nothing
// here runs automatically or in the background.

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // last 7 days
const MAX_VIDEOS = 50;

// Pulls recent YouTube *watch* visits from the browser's history, de-duped
// by video id and sorted most-recent-first. This only sees what chrome.history
// already has, i.e. the same YouTube activity the browser itself recorded.
export async function queryYoutubeHistory() {
  const results = await chrome.history.search({
    text: 'youtube.com',
    startTime: Date.now() - LOOKBACK_MS,
    maxResults: 1000
  });

  const byVideoId = new Map();
  for (const item of results) {
    if (!item.url || !item.title) continue;

    let url;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (!url.hostname.endsWith('youtube.com') || url.pathname !== '/watch') continue;

    const videoId = url.searchParams.get('v');
    if (!videoId) continue;

    const lastVisitTime = item.lastVisitTime || 0;
    const existing = byVideoId.get(videoId);
    if (!existing || lastVisitTime > existing.lastVisitTime) {
      byVideoId.set(videoId, { title: item.title, lastVisitTime });
    }
  }

  return Array.from(byVideoId.values())
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
    .slice(0, MAX_VIDEOS);
}

export function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 1) return 'less than an hour ago';
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

export function buildWatchMessages(instruction, entries) {
  const historyList = entries
    .map((e) => `- "${e.title}" (last watched ${formatRelativeTime(e.lastVisitTime)})`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You are Alux, a small unseen spirit who quietly watches over the user and gently guides ' +
        "them in the right direction. You've been given the user's recent YouTube watch history and " +
        'an instruction describing what they specifically want you to pay attention to. Speak directly ' +
        "to the user, briefly (3-5 sentences), warm but honest. Only comment on what's relevant to " +
        'their instruction — do not just summarize everything they watched.'
    },
    {
      role: 'user',
      content: `What I want you to watch for: "${instruction}"\n\nMy recent YouTube watch history:\n${historyList}`
    }
  ];
}
