const input = document.getElementById("apiKey");
const savedEl = document.getElementById("saved");

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
    if (apiKey) input.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
    await chrome.storage.local.set({ apiKey: input.value.trim() });
    savedEl.textContent = "Saved";
    setTimeout(() => (savedEl.textContent = ""), 1500);
});
