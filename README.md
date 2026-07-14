# Tab to Group

Brave/Chrome extension that looks at the current window's ungrouped tabs, classifies each one against a hierarchical category list using the Claude API, shows you the proposed assignments, and moves the tabs into tab groups when you hit Apply.

## How it works

- The popup's **Analyze** button sends the window's ungrouped tabs (title + URL only — no page content is read) to the background service worker.
- The service worker calls `claude-haiku-4-5` with a structured-output JSON schema, so the response is guaranteed valid JSON with categories constrained to the taxonomy. Tabs are sent in batches of 50 (parallel requests), so large windows don't blow past request/response limits.
- Classification weighs the **title over the domain**. Domains listed in `site-rules.json` (search engines, social media, AI chats, streaming) are suppressed entirely — for those, only the title is sent, so a Google search about flights lands in Travel, not Research.
- The popup shows each tab with its inferred category/subcategory in a dropdown; fix any you disagree with, then **Apply**.
- Closing the popup doesn't lose the analysis — it's kept per window (in `chrome.storage.session`) until you apply it or close the browser. On reopen, tabs that were closed or grouped in the meantime are dropped from the list.
- Tab groups can't nest, so each subcategory becomes its own group (titled with the subcategory name) and the **parent category decides the color** — sibling groups look related. Tabs with no subcategory go into a group named after the parent. Existing groups with a matching title are reused.

## Setup

1. `brave://extensions` (or `chrome://extensions`) → enable **Developer mode** → **Load unpacked** → select this directory.
2. Right-click the extension icon → **Options** → paste your Anthropic API key (stored in `chrome.storage.local`, never synced).

## Config files

Everything tunable lives in JSON config files — no UI, no code edits. Change a file, reload the extension:

| File | Contains |
|---|---|
| `config.json` | Model, API URL, batch size, max output tokens, title/URL truncation lengths |
| `prompts.json` | System prompt, user prompt template, the `[title only]` marker text |
| `categories.json` | The category → subcategory taxonomy and group colors |
| `site-rules.json` | Aggregator domains classified by title only |

The user prompt in `prompts.json` is an array of lines (joined with newlines) with `{{taxonomy}}`, `{{tabs}}`, and `{{titleOnlyMarker}}` placeholders filled in at request time.

## Editing categories

Categories live in `categories.json` — no UI, just edit the file and reload the extension:

```json
{
    "Dev": { "color": "blue", "subs": ["Code", "Docs", "AI", "Infra"] }
}
```

- `color` must be one of Chrome's group colors: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`.
- Keep subcategory names **unique across all parents** — the group title is how existing groups are found and reused.
- Keep an `Other` category; it's the fallback when the model returns something invalid.

## Site rules

`site-rules.json` lists aggregator domains whose URL carries no signal about the tab's content. For tabs on these domains, the URL is dropped from the classification request and the model is told to judge by the title alone. Matching is by hostname suffix, so `google.com` also covers `www.google.com` and any other subdomain. Edit the list and reload the extension:

```json
{
    "titleOnly": ["google.com", "chatgpt.com", "youtube.com", "reddit.com"]
}
```

## Batching

Tabs are classified in batches (`batchSize` in `config.json`, default 50) per API request, run in parallel, so any number of tabs works. The limit per batch is response size, not request size — if you ever see a "response truncated" error, lower `batchSize`.

## Notes / limitations

- Pinned tabs and internal pages (`brave://`, `chrome://`, extension pages) are skipped.
- Sleeping/discarded tabs are fine — classification only uses title + URL.
- One request per Analyze click; a few hundred tabs may hit the output cap (the popup will say so).
