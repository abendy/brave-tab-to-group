const analyzeBtn = document.getElementById("analyze");
const applyBtn = document.getElementById("apply");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("proposals");

let categories = {};
let proposals = [];
let windowId = null;

init();

async function init() {
    categories = await fetch(chrome.runtime.getURL("categories.json")).then((r) => r.json());
    windowId = (await chrome.windows.getCurrent()).id;
}

analyzeBtn.addEventListener("click", async () => {
    setStatus("Analyzing…");
    analyzeBtn.disabled = true;
    applyBtn.hidden = true;
    listEl.replaceChildren();

    const res = await chrome.runtime.sendMessage({ type: "analyze", windowId });
    analyzeBtn.disabled = false;

    if (res.error) {
        setStatus(res.error, true);
        return;
    }
    proposals = res.proposals;
    if (proposals.length === 0) {
        setStatus("No ungrouped tabs in this window.");
        return;
    }

    setStatus(`${proposals.length} tab${proposals.length === 1 ? "" : "s"} — adjust and apply.`);
    renderProposals();
    applyBtn.hidden = false;
});

applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    setStatus("Grouping…");

    const res = await chrome.runtime.sendMessage({ type: "apply", windowId, assignments: proposals });
    applyBtn.disabled = false;

    if (res.error) {
        setStatus(res.error, true);
        return;
    }
    setStatus(`Moved ${res.grouped} tabs into ${res.groups} groups.`);
    applyBtn.hidden = true;
    listEl.replaceChildren();
});

function renderProposals() {
    listEl.replaceChildren();
    for (const p of proposals) {
        const li = document.createElement("li");

        const title = document.createElement("span");
        title.className = "title";
        title.textContent = p.title || p.url;
        title.title = p.url;

        const select = buildCategorySelect(p);
        select.addEventListener("change", () => {
            const [category, sub] = select.value.split("|");
            p.category = category;
            p.subcategory = sub || null;
        });

        li.append(title, select);
        listEl.append(li);
    }
}

function buildCategorySelect(p) {
    const select = document.createElement("select");
    for (const [name, def] of Object.entries(categories)) {
        select.append(new Option(name, `${name}|`));
        for (const sub of def.subs) {
            select.append(new Option(`${name} › ${sub}`, `${name}|${sub}`));
        }
    }
    select.value = `${p.category}|${p.subcategory || ""}`;
    return select;
}

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.className = isError ? "error" : "";
}
