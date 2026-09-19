// UNOFFICIAL. No YouTube Data API involved and no API key required — this
// fetches a video's public watch page (the same HTML any signed-out visitor
// gets) and parses out the `videoDetails` block YouTube embeds for its own
// player to read the description and channel name. This is not a sanctioned
// API: YouTube can change its page structure at any time and silently break
// this, and scraping it programmatically may not comply with YouTube's terms
// of service. Every failure mode (network error, missing blob, JSON shape
// change) degrades to empty strings rather than throwing, so one bad video
// never blocks the rest of a check.
export async function fetchVideoPageInfo(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    if (!res.ok) return { description: '', channelTitle: '' };

    const html = await res.text();
    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
    if (!match) return { description: '', channelTitle: '' };

    const details = JSON.parse(match[1])?.videoDetails || {};
    return {
      description: typeof details.shortDescription === 'string' ? details.shortDescription : '',
      channelTitle: typeof details.author === 'string' ? details.author : ''
    };
  } catch {
    return { description: '', channelTitle: '' };
  }
}

// Fetches page info for every entry in parallel and merges it in. Entries
// that fail (see above) just end up with empty description/channelTitle —
// Jev still gets a title and video id to classify on.
export async function enrichEntriesWithPageInfo(entries) {
  const infos = await Promise.all(entries.map((entry) => fetchVideoPageInfo(entry.videoId)));
  return entries.map((entry, i) => ({ ...entry, ...infos[i] }));
}
