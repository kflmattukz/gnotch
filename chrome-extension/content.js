// Runs in the WhatsApp Web tab: does what the notch asks (see whatsapp-dom.js).
// The background worker may inject this again into a tab that already has
// it, and copies left over from before an extension reload stop working
// ("Extension context invalidated"); both cases are handled here.

(() => {
    const alive = () => {
        try {
            return !!chrome.runtime?.id;
        } catch {
            return false;
        }
    };
    // Already running in this tab with a working connection to the extension
    if (globalThis.gnotchContentAlive?.())
        return;
    globalThis.gnotchContentAlive = alive;

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        GnotchWA.handle(msg).then(
            data => sendResponse({ok: true, data}),
            e => sendResponse({ok: false, error: e.message}));
        return true; // answers asynchronously
    });

    const tell = message => {
        if (!alive())
            return false;
        try {
            chrome.runtime.sendMessage(message).catch(() => {});
        } catch {
            return false;
        }
        return true;
    };

    // Wakes the background worker so it connects to the notch
    tell({type: 'hello-from-tab'});

    // Tell the notch when a call starts and ends on this page; a copy whose
    // extension was reloaded stops itself
    const stop = GnotchWA.watchCalls(state => {
        if (!tell({type: 'event', event: {type: 'call', state}}))
            stop();
    });
})();
