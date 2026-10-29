// Everything that depends on WhatsApp Web's page lives here, so a WhatsApp
// update means fixing one file. Buttons are found by their accessible
// label or icon name (English and Indonesian), never by generated classes.

const CALL_BUTTONS = {
    hangup: [/end call/i, /hang ?up/i, /leave call/i, /akhiri/i, /tutup panggilan/i, /call-end|end-call|hangup/i],
    accept: [/^accept/i, /^answer/i, /terima/i, /call-accept|accept-call/i],
    decline: [/^decline/i, /^reject/i, /tolak/i, /call-decline|decline-call/i],
    mute: [/^mute/i, /unmute/i, /bisukan/i, /microphone|mic-/i],
};

function isVisible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** What a button says about itself: aria-label, title, text, or its icon's name. */
function describe(el) {
    return [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.querySelector('[data-icon]')?.getAttribute('data-icon'),
        el.getAttribute('data-icon'),
        el.textContent?.trim().slice(0, 40),
    ].filter(Boolean).join(' | ');
}

function buttons() {
    return [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
}

function findButton(patterns) {
    const all = buttons();
    for (const re of patterns) {
        const found = all.find(b => re.test(describe(b)));
        if (found)
            return found;
    }
    return null;
}

const CALL_POLL_MS = 1000;
const CALL_GONE_POLLS = 2; // the end button missing this many polls in a row

/**
 * Reports when a call screen appears and when it goes away, by whether an
 * end-call button is on screen. The notch ends its call view on 'ended'.
 */
function watchCalls(onChange) {
    let state = 'idle';
    let missing = 0;
    const timer = setInterval(() => {
        if (findButton(CALL_BUTTONS.hangup)) {
            missing = 0;
            if (state !== 'active') {
                state = 'active';
                onChange(state);
            }
        } else if (state === 'active' && ++missing >= CALL_GONE_POLLS) {
            state = 'ended';
            onChange(state);
        }
    }, CALL_POLL_MS);
    return () => clearInterval(timer);
}

globalThis.GnotchWA = {
    watchCalls,

    async handle(msg) {
        switch (msg.type) {
        case 'call': {
            const patterns = CALL_BUTTONS[msg.action];
            if (!patterns)
                throw new Error(`unknown call action ${msg.action}`);
            const button = findButton(patterns);
            if (!button) {
                // Tell the notch what is on screen, so the patterns can be fixed
                const seen = buttons().map(describe).filter(Boolean).slice(0, 40);
                throw new Error(`no-call-button: ${msg.action}; visible buttons: ${seen.join(' ; ')}`);
            }
            button.click();
            return {clicked: describe(button)};
        }
        case 'debug-buttons':
            return buttons().map(describe).filter(Boolean);
        default:
            throw new Error(`unknown request ${msg.type}`);
        }
    },
};
