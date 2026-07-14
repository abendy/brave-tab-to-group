// All tunables live in config files: config.json (model, batching, limits),
// prompts.json (prompt text), categories.json (taxonomy), site-rules.json
// (title-only domains). Edit those and reload the extension — no code changes.

let assetsPromise = null;

function loadAssets() {
    if (!assetsPromise) {
        assetsPromise = Promise.all(
            ["config", "prompts", "categories", "site-rules"].map((name) =>
                fetch(chrome.runtime.getURL(`${name}.json`)).then((r) => r.json()),
            ),
        ).then(([config, prompts, categories, siteRules]) => ({
            config,
            prompts,
            categories,
            siteRules,
        }));
    }
    return assetsPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "analyze") {
        analyze(msg.windowId)
            .then(sendResponse)
            .catch((e) => sendResponse({ error: e.message }));
        return true;
    }
    if (msg.type === "apply") {
        apply(msg.windowId, msg.assignments)
            .then(sendResponse)
            .catch((e) => sendResponse({ error: e.message }));
        return true;
    }
});

async function analyze(windowId) {
    const { apiKey } = await chrome.storage.local.get("apiKey");
    if (!apiKey) {
        throw new Error("No API key set. Add one in the extension options.");
    }

    const assets = await loadAssets();
    const tabs = await getUngroupedTabs(windowId);
    if (tabs.length === 0) {
        return { proposals: [] };
    }

    const batches = chunk(tabs, assets.config.batchSize);
    const results = await Promise.all(
        batches.map((batch) => classifyTabs(apiKey, assets, batch)),
    );

    const proposals = [];
    batches.forEach((batch, b) => {
        // Assignment indices are local to each batch
        const byIndex = new Map(results[b].map((a) => [a.index, a]));
        batch.forEach((tab, i) => {
            const a = byIndex.get(i);
            const category = a && assets.categories[a.category] ? a.category : "Other";
            const subcategory =
                a && a.subcategory && assets.categories[category].subs.includes(a.subcategory)
                    ? a.subcategory
                    : null;
            proposals.push({ tabId: tab.id, title: tab.title, url: tab.url, category, subcategory });
        });
    });

    return { proposals };
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

async function getUngroupedTabs(windowId) {
    const tabs = await chrome.tabs.query({
        windowId,
        groupId: chrome.tabGroups.TAB_GROUP_ID_NONE,
        pinned: false,
    });
    // Internal pages (brave://, chrome://, extension pages) aren't worth categorizing
    return tabs.filter((t) => /^https?:/.test(t.url || ""));
}

// Aggregator sites (search, social, AI chat, streaming) where the domain says
// nothing about the content — suppress the URL so the title is the only signal
function isTitleOnly(url, siteRules) {
    try {
        const host = new URL(url).hostname;
        return siteRules.titleOnly.some((d) => host === d || host.endsWith("." + d));
    } catch {
        return false;
    }
}

function renderTemplate(lines, vars) {
    return lines.join("\n").replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// Truncating can split an emoji's surrogate pair, leaving a lone surrogate
// that makes the request body invalid JSON — repair after slicing
function truncate(str, max) {
    const s = (str || "").slice(0, max);
    if (s.toWellFormed) {
        return s.toWellFormed();
    }
    return s
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "�")
        .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1�");
}

async function classifyTabs(apiKey, assets, tabs) {
    const { config, prompts, categories, siteRules } = assets;

    const taxonomy = Object.entries(categories)
        .map(([name, def]) => `${name}: ${def.subs.length ? def.subs.join(", ") : "(no subcategories)"}`)
        .join("\n");

    const tabList = tabs
        .map((t, i) => {
            const title = truncate(t.title, config.titleMaxChars);
            if (isTitleOnly(t.url, siteRules)) {
                return `${i}. "${title}" — ${prompts.titleOnlyMarker}`;
            }
            return `${i}. "${title}" — ${truncate(t.url, config.urlMaxChars)}`;
        })
        .join("\n");

    const prompt = renderTemplate(prompts.user, {
        taxonomy,
        tabs: tabList,
        titleOnlyMarker: prompts.titleOnlyMarker,
    });

    const schema = {
        type: "object",
        properties: {
            assignments: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        index: { type: "integer" },
                        category: { type: "string", enum: Object.keys(categories) },
                        subcategory: { anyOf: [{ type: "string" }, { type: "null" }] },
                    },
                    required: ["index", "category", "subcategory"],
                    additionalProperties: false,
                },
            },
        },
        required: ["assignments"],
        additionalProperties: false,
    };

    const res = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            system: prompts.system,
            messages: [{ role: "user", content: prompt }],
            output_config: { format: { type: "json_schema", schema } },
        }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `API error (HTTP ${res.status})`);
    }

    const data = await res.json();
    if (data.stop_reason === "max_tokens") {
        throw new Error("Response truncated — lower batchSize in config.json.");
    }
    const text = data.content.find((b) => b.type === "text")?.text;
    if (!text) {
        throw new Error("Empty response from the API.");
    }
    return JSON.parse(text).assignments;
}

async function apply(windowId, assignments) {
    const { categories } = await loadAssets();

    // Tabs may have closed since analysis — only group ones that still exist
    const liveIds = new Set((await chrome.tabs.query({ windowId })).map((t) => t.id));

    // Group name is the subcategory when there is one, else the parent;
    // the parent always decides the color.
    const groups = new Map();
    for (const a of assignments) {
        if (!liveIds.has(a.tabId)) continue;
        const title = a.subcategory || a.category;
        if (!groups.has(title)) {
            groups.set(title, { color: categories[a.category].color, tabIds: [] });
        }
        groups.get(title).tabIds.push(a.tabId);
    }

    let grouped = 0;
    for (const [title, { color, tabIds }] of groups) {
        const existing = await chrome.tabGroups.query({ windowId, title });
        if (existing.length > 0) {
            await chrome.tabs.group({ tabIds, groupId: existing[0].id });
        } else {
            const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
            await chrome.tabGroups.update(groupId, { title, color });
        }
        grouped += tabIds.length;
    }

    return { grouped, groups: groups.size };
}
