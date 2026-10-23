# YouTube Transcript Pro: Subtitles, Captions, Translation & LLM Chunks

Get transcripts from YouTube **videos, Shorts, whole channels, playlists and search results** in one run. Every transcript comes back as clean text, **SRT**, **WebVTT**, timestamped lines, paragraphs, **chapters**, **keyword hits** and **LLM/RAG-ready chunks**, together with full video metadata. You can translate any transcript into 100+ languages. Videos with no captions at all can be transcribed by AI using your own Groq or OpenAI key.

**You only pay for transcripts you get.** Videos without captions, private or deleted videos, filtered videos and duplicates are free.

## What you can feed it

| Input | Example |
|---|---|
| Video / Shorts / live / embed | `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, `youtu.be/…`, `/shorts/…`, `m.youtube.com`, `music.youtube.com` |
| Video ID | `dQw4w9WgXcQ` |
| Channel | `https://www.youtube.com/@3blue1brown`, `@3blue1brown`, `/channel/UC…`, `/c/…`, `/user/…` (videos, Shorts or live tab) |
| Playlist | `https://www.youtube.com/playlist?list=PL…` |
| Search | any search phrase, e.g. `claude ai tutorial` |

## What you get for each video

- **Transcript** as clean text, plus `word_count` and `line_count`.
- **Subtitles**: a ready `.srt` and `.vtt` file as text. Overlapping auto-caption cues are clipped, so the files play cleanly.
- **Segments**: `data` (text, start, duration for every line) and `lines`.
- **Timestamped text**: `[1:23] …` per line, easy to read and to cite (optional).
- **Paragraphs**: the transcript split on pauses into readable paragraphs (optional).
- **Chapters**: taken from the description (`0:00 Intro …`). Each chapter gets its own transcript text and a link to that moment.
- **LLM/RAG chunks**: about N words each, with optional overlap, start/end times and a deep link (`&t=123s`).
- **Keyword hits**: every moment a word or phrase is said, with the line, its context and a link to that second.
- **Translation**: `transcript_translated` in any language. YouTube's own caption translation is tried first; if YouTube refuses, Google Translate is used line by line and the timings are kept.
- **Metadata**: title, channel, channel ID and URL, duration, views, likes, category, exact publish date, thumbnail, description, tags, Short or not, available caption languages and tracks.
- **Evidence columns**: `language`, `is_auto_generated`, `matched_preferred_language`, `transcript_source` (captions or AI) and `translation_source`, so you always know where the text came from.

## How it is better than a basic transcript scraper

| | Basic transcript scrapers | YouTube Transcript Pro |
|---|---|---|
| Channels, playlists, search | Videos only | ✅ All, with per-source limits and channel tabs |
| Human vs auto captions | Takes whatever comes first | ✅ Prefers human-made captions; you choose |
| Chapters with their own text | ❌ | ✅ |
| LLM/RAG chunks with deep links | ❌ | ✅ |
| Keyword moments with links | ❌ | ✅ |
| Translation when YouTube throttles it | Fails | ✅ Falls back to Google Translate, timings kept |
| Likes, category, exact publish date | Partial | ✅ |
| Filters (date, length, Shorts) | ❌ | ✅ Filtered videos are free |
| Skip videos from previous runs | ❌ | ✅ Ideal for scheduled channel monitoring |
| Failed videos | Silent, or charged | ✅ Free row with the reason and how to fix it |
| Proxy blocked | Run fails | ✅ Switches automatically: residential → datacenter → server IP |

## Pricing (pay per event)

| Event | When it is charged | Price |
|---|---|---|
| `transcript` | One transcript saved from YouTube captions (one per language if you choose "every language") | $0.004 ($4 per 1,000) |
| `ai-transcript` | One transcript made by AI from the audio of a video with no captions | $0.008 ($8 per 1,000) |

The AI provider bills you directly for AI transcription, using your own key: Groq costs about $0.04 per audio hour, OpenAI about $0.36 per audio hour.

The run stops cleanly at your **Maximum cost per run**. Nothing is charged for failed, filtered, duplicate or previously seen videos.

## Example input

```json
{
  "urls": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/@3blue1brown"],
  "maxVideosPerSource": 20,
  "languages": ["en"],
  "translateTo": "es",
  "chunkWords": 300,
  "transcriptKeywords": ["neural network"],
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## Example output (shortened)

```json
{
  "status": "ok",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "video_id": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "channel": "Rick Astley",
  "duration_seconds": 213,
  "view_count": 1829606583,
  "like_count": 19492345,
  "publish_date": "2009-10-24T23:57:33-07:00",
  "category": "Music",
  "language": "en",
  "is_auto_generated": false,
  "transcript_source": "youtube_captions",
  "word_count": 487,
  "transcript": "[♪♪♪] ♪ We're no strangers to love ♪ …",
  "srt": "1\n00:00:01,360 --> 00:00:03,040\n[♪♪♪]\n…",
  "translated_to": "es",
  "transcript_translated": "[♪♪♪] ♪ No somos ajenos al amor ♪ …",
  "chunks": [{ "index": 0, "start": 1.36, "end": 102.04, "word_count": 207, "text": "…", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s" }],
  "keyword_matches": [{ "keyword": "never gonna", "time_hms": "0:43", "text": "♪ Never gonna give you up ♪", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s" }]
}
```

Videos without a transcript come back as free rows, for example `"status": "no_captions"` with `error` and `fix_hint`. Possible statuses: `no_captions`, `no_matching_language`, `unavailable`, `age_restricted`, `upcoming`, `blocked`, `not_found`, `no_results`, `invalid_input`. Turn off "Show videos without a transcript" to hide them.

## Run summary

Each run saves a `RUN_SUMMARY` record in the key-value store. It contains:

- videos found and saved, and the charged events;
- the reasons videos were skipped;
- the status of each input, and its counts per channel, playlist or search;
- caption languages, and how many captions were human-made vs auto-generated;
- how many transcripts were translated, and by which service;
- which network routes were used and how often YouTube blocked each one.

## Tips

- **Use residential proxy (the default).** YouTube bot-checks datacenter and cloud IPs. Residential costs about $0.0002 per video (≈25 KB per video). Keep "Automatic proxy fallback" on.
- **Monitor a channel cheaply:** schedule the actor with the channel URL, `publishedAfter: "7 days"` and "Skip videos saved in previous runs" turned on.
- **For RAG / AI apps:** set `chunkWords` to 300–500 and `chunkOverlapWords` to about 50. Each chunk links to its exact second in the video.
- **Age-restricted and members-only videos** need sign-in, which this actor does not do. They come back as free `age_restricted` rows.

## FAQ

**Which languages are supported?** Every caption language YouTube has (100+). Translation also covers 100+ target languages.

**What happens if a video has no captions?** You get a free `no_captions` row. To get a transcript anyway, turn on AI transcription and add your Groq or OpenAI key. Audio over 25 MB, or longer than your AI minutes limit, is skipped and not charged. YouTube sometimes refuses audio downloads; when it does, the video comes back as a free `no_captions` row that gives the reason.

**Is my API key safe?** The key field is a secret input. Apify stores it encrypted, and it is only sent to the provider you choose.
