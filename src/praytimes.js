// Prayer times from the sun's position, after the PrayTimes.org algorithm.
// Everything is computed in UTC, so no timezone handling is needed.

export const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
export const PRAYER_NAMES = {
    fajr: 'Fajr',
    sunrise: 'Sunrise',
    dhuhr: 'Dhuhr',
    asr: 'Asr',
    maghrib: 'Maghrib',
    isha: 'Isha',
};

// fajr/isha: sun angle below the horizon; ishaMinutes: fixed time after maghrib.
// offsets: built-in minute adjustments per prayer (e.g. Kemenag's ihtiyat)
export const METHODS = {
    kemenag: {name: 'Kemenag (Indonesia)', fajr: 20, isha: 18, offsets: [2, -2, 2, 2, 2, 2]},
    jakim: {name: 'JAKIM (Malaysia)', fajr: 20, isha: 18},
    mwl: {name: 'Muslim World League', fajr: 18, isha: 17},
    isna: {name: 'ISNA (North America)', fajr: 15, isha: 15},
    egypt: {name: 'Egyptian Authority', fajr: 19.5, isha: 17.5},
    makkah: {name: 'Umm al-Qura (Makkah)', fajr: 18.5, ishaMinutes: 90},
    karachi: {name: 'Karachi', fajr: 18, isha: 18},
    diyanet: {name: 'Diyanet (Turkey)', fajr: 18, isha: 17},
};

const RISE_SET_ANGLE = 0.833; // refraction plus the sun's radius

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const fix = (a, b) => ((a % b) + b) % b;

function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = fix(357.529 + 0.98560028 * D, 360);
    const q = fix(280.459 + 0.98564736 * D, 360);
    const L = fix(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)), 360);
    const e = 23.439 - 0.00000036 * D;
    const RA = fix(deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15, 24);
    return {
        declination: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L)))),
        equation: q / 15 - RA,
    };
}

function julian(year, month, day) {
    if (month <= 2) {
        year -= 1;
        month += 12;
    }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

/**
 * Prayer times for the local calendar day containing `date`.
 *
 * @param {Date} date
 * @param {number} lat
 * @param {number} lon
 * @param {object} opts
 * @param {string} [opts.method] - a key of METHODS
 * @param {string} [opts.asr] - 'standard' or 'hanafi'
 * @param {number[]} [opts.offsets] - extra minutes per prayer, in PRAYERS order
 * @returns {Object<string, Date>} prayer -> time
 */
export function computeTimes(date, lat, lon, {method = 'mwl', asr = 'standard', offsets = []} = {}) {
    const params = METHODS[method] ?? METHODS.mwl;
    const asrFactor = asr === 'hanafi' ? 2 : 1;
    const jd = julian(date.getFullYear(), date.getMonth() + 1, date.getDate()) - lon / (15 * 24);

    const midDay = t => fix(12 - sunPosition(jd + t).equation, 24);
    const sunAngleTime = (angle, t, ccw) => {
        const {declination} = sunPosition(jd + t);
        const T = deg(Math.acos(
            (-Math.sin(rad(angle)) - Math.sin(rad(declination)) * Math.sin(rad(lat))) /
            (Math.cos(rad(declination)) * Math.cos(rad(lat))))) / 15;
        return midDay(t) + (ccw ? -T : T);
    };
    const asrTime = t => {
        const {declination} = sunPosition(jd + t);
        const angle = -deg(Math.atan(1 / (asrFactor + Math.tan(rad(Math.abs(lat - declination))))));
        return sunAngleTime(angle, t);
    };

    // Two passes: the first estimate refines the sun position for the second
    let h = {fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18, isha: 18};
    for (let i = 0; i < 2; i++) {
        const t = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v / 24]));
        h = {
            fajr: sunAngleTime(params.fajr, t.fajr, true),
            sunrise: sunAngleTime(RISE_SET_ANGLE, t.sunrise, true),
            dhuhr: midDay(t.dhuhr),
            asr: asrTime(t.asr),
            maghrib: sunAngleTime(RISE_SET_ANGLE, t.maghrib),
            isha: params.ishaMinutes ? 0 : sunAngleTime(params.isha, t.isha),
        };
    }
    if (params.ishaMinutes)
        h.isha = h.maghrib + params.ishaMinutes / 60;

    // Polar nights: no twilight angle reached, fall back to the middle of the night
    const night = 24 - (h.maghrib - h.sunrise);
    if (!Number.isFinite(h.fajr))
        h.fajr = h.sunrise - night / 2;
    if (!Number.isFinite(h.isha))
        h.isha = h.maghrib + night / 2;

    const base = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const times = {};
    PRAYERS.forEach((p, i) => {
        const minutes = (params.offsets?.[i] ?? 0) + (offsets[i] ?? 0);
        // hours are local solar time; shift to UTC by longitude
        const utcHours = h[p] - lon / 15 + minutes / 60;
        times[p] = new Date(base + Math.round(utcHours * 60) * 60000);
    });
    return times;
}
