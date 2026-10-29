// Keeps a WebSocket to the Gnotch GNOME Shell extension and passes its
// requests to the WhatsApp Web tab (content.js), answering with the result.

const DEFAULT_PORT = 53319;
const MAX_BACKOFF_MS = 30000;
const PING_MS = 20000; // WebSocket traffic keeps this service worker alive

let socket = null;
let status = 'Not connected';
let backoff = 1000;
let retryTimer = null;

async function config() {
    const {port = DEFAULT_PORT, token = ''} = await chrome.storage.local.get(['port', 'token']);
    return {port, token};
}

function setStatus(text) {
    status = text;
}

function send(data) {
    if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(data));
}

async function connect() {
    if (socket && socket.readyState <= WebSocket.OPEN)
        return; // connecting or connected
    clearTimeout(retryTimer);
    // Without a token the notch asks the user to pair, then sends one
    const {port, token} = await config();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gnotch`);
    socket = ws;
    setStatus('Connecting…');
    ws.onopen = () => ws.send(JSON.stringify({type: 'hello', token, version: chrome.runtime.getManifest().version}));
    ws.onmessage = event => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }
        onShellMessage(msg);
    };
    ws.onclose = event => {
        if (socket !== ws)
            return;
        socket = null;
        if (event.reason === 'declined') {
            // Asked again only after Chrome or Gnotch restarts
            setStatus('Pairing declined in the notch');
            return;
        }
        setStatus('Not connected (is Gnotch running?)');
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
}

const PAGE_SCRIPTS = ['whatsapp-dom.js', 'content.js'];

/**
 * Chrome only adds content scripts to tabs opened after the extension was
 * (re)loaded, so a WhatsApp tab that was already open has none: add them.
 */
async function injectInto(tabId) {
    await chrome.scripting.executeScript({target: {tabId}, files: PAGE_SCRIPTS});
}

async function sendToTab(tabId, msg) {
    try {
        return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
        if (!/Receiving end does not exist/.test(e.message))
            throw e;
        await injectInto(tabId);
        return chrome.tabs.sendMessage(tabId, msg);
    }
}

async function whatsappTab() {
    const [tab] = await chrome.tabs.query({url: 'https://web.whatsapp.com/*'});
    return tab ?? null;
}

let receivedToken = null;

async function onShellMessage(msg) {
    if (msg.type === 'welcome' || msg.type === 'paired') {
        setStatus('Connected');
        backoff = 1000;
        if (msg.type === 'paired') {
            // Keep the token for next time (storing it must not reconnect)
            receivedToken = msg.token;
            await chrome.storage.local.set({token: msg.token});
        }
        return;
    }
    if (msg.reqId === undefined)
        return;
    const reply = (ok, dataOrError) => send(ok
        ? {type: 'result', reqId: msg.reqId, ok, data: dataOrError}
        : {type: 'result', reqId: msg.reqId, ok, error: dataOrError});
    try {
        const tab = await whatsappTab();
        if (!tab) {
            reply(false, 'WhatsApp Web is not open in Chrome');
            return;
        }
        if (msg.type === 'focus') {
            await chrome.tabs.update(tab.id, {active: true});
            await chrome.windows.update(tab.windowId, {focused: true});
            reply(true);
            return;
        }
        const answer = await sendToTab(tab.id, msg);
        reply(!!answer?.ok, answer?.ok ? answer.data : answer?.error ?? 'no answer from the WhatsApp tab');
    } catch (e) {
        reply(false, e.message);
    }
}

// Events from the WhatsApp tab go to the notch; the options page asks for status
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'event')
        send(msg.event);
    else if (msg?.type === 'status')
        sendResponse({status});
    connect();
});

chrome.storage.onChanged.addListener(changes => {
    if (Object.keys(changes).length === 1 && changes.token?.newValue === receivedToken)
        return;
    socket?.close();
    socket = null;
    backoff = 1000;
    connect();
});

setInterval(() => send({type: 'ping'}), PING_MS);
// Wakes the worker if Chrome stopped it while disconnected
chrome.alarms.create('gnotch-reconnect', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(async () => {
    // Open WhatsApp tabs get the page scripts right away (calls, hang up)
    for (const tab of await chrome.tabs.query({url: 'https://web.whatsapp.com/*'}))
        injectInto(tab.id).catch(() => {});
    connect();
});
connect();
