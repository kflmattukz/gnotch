const token = document.getElementById('token');
const port = document.getElementById('port');
const status = document.getElementById('status');

chrome.storage.local.get(['token', 'port']).then(v => {
    token.value = v.token ?? '';
    port.value = v.port ?? 53319;
});

document.getElementById('save').addEventListener('click', async () => {
    await chrome.storage.local.set({token: token.value.trim(), port: Number(port.value) || 53319});
    status.textContent = 'Saved, connecting…';
});

async function refresh() {
    try {
        const {status: text} = await chrome.runtime.sendMessage({type: 'status'});
        status.textContent = `Status: ${text}`;
    } catch {
        status.textContent = 'Status: unknown';
    }
}
refresh();
setInterval(refresh, 1500);
