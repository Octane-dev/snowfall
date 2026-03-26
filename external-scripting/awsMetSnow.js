require('dotenv').config();
const fs = require('fs');
const fetch = require('node-fetch');
const path = './json/conditions.json';

// --- CONFIG ---
const AWS_URL = 'https://cairngormweather.eps.hw.ac.uk/CurrentYear.txt';
const METOFFICE_API_KEY = process.env.METOFFICE_API_KEY;
const LAT_SUMMIT = 57.11636;
const LON_SUMMIT = -3.64165;
const LAT_MID = 57.12699;
const LON_MID = -3.66032;
const LAT_BASE = 57.13316;
const LON_BASE = -3.67151;
const SUMMIT_ALT = 1245;
const MID_ALT = 780;
const BASE_ALT = 645;

// --- Helper functions ---
function loadData() {
  if (!fs.existsSync(path)) return { conditions: [] };
  const data = JSON.parse(fs.readFileSync(path));
  if (!data.conditions) data.conditions = [];
  return data;
}

function saveData(data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function degToCardinal(deg) {
  const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S",
                      "SSW","SW","WSW","W","WNW","NW","NNW"];
  return directions[Math.round(deg / 22.5) % 16];
}

function round(n) { return Math.round(n*10)/10; }

// Simple lapse rate adjustment
function lapseRateAdjust(tempC, fromAlt, toAlt) {
  return tempC - ((toAlt - fromAlt) * 0.0065);
}

// --- 1. Fetch AWS TXT and pick closest to top of hour ---
async function readAWS() {
  const target = new Date();
  target.setUTCHours(target.getUTCHours() - 1);
  target.setUTCMinutes(48, 0, 0);

  const MAX_DIFF_MS = 20 * 60 * 1000; // +/-20 min tolerance

  const res = await fetch(AWS_URL);
  if (!res.ok) throw new Error(`AWS fetch error: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n').filter(l => l.trim());

  let closest = null;
  let minDiff = Infinity;

  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length < 12) continue;

    const day = parseInt(cols[0],10);
    const time = parseInt(cols[1],10);
    const meanWindMph = parseFloat(cols[2]);
    const gustWindMph = parseFloat(cols[3]);
    const windDirDeg = parseFloat(cols[5]);
    const t1 = parseFloat(cols[7]);
    const t2 = parseFloat(cols[8]);

    const temp_c = (t1 + t2)/2;
    const wind_kmh = round(meanWindMph * 1.609);
    const gust_kmh = round(gustWindMph * 1.609);
    const wind_dir = degToCardinal(windDirDeg);

    // Build full UTC date
    const year = target.getUTCFullYear();
    const date = new Date(Date.UTC(year,0,1,0,0,0));
    date.setUTCDate(day);
    const hours = Math.floor(time/100);
    const minutes = time % 100;
    date.setUTCHours(hours);
    date.setUTCMinutes(minutes);

    const diff = Math.abs(date - target);

    if (diff < MAX_DIFF_MS && diff < minDiff) {
      minDiff = diff;
      closest = {
        timestamp: date.toISOString(),
        temp_c,
        wind_kmh,
        gust_kmh,
        wind_dir
      };
    }
  }

  if (!closest) {
    console.log("No suitable :48 reading yet — likely not published");
    return null;
  }

  return closest;
}

// --- Fetch Met Office data for a given lat/lon (precipitation + weather code) ---
async function fetchMetOfficeWeather(lat, lon) {
  const url = `https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly`;
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    excludeParameterMetadata: "true",
    includeLocationName: "true"
  });

  const res = await fetch(`${url}?${params.toString()}`, {
    headers: { "accept": "application/json", "apikey": METOFFICE_API_KEY }
  });
  if (!res.ok) throw new Error(`Met Office API error: ${res.status}`);
  const data = await res.json();
  const timeSeries = data.features?.[0]?.properties?.timeSeries ?? [];

  const now = new Date();
  now.setMinutes(0,0,0,0);

  let closest = null;
  let minDiff = Infinity;

  for (const entry of timeSeries) {
    const ts = new Date(entry.time);
    const diff = Math.abs(ts - now);
    if (diff < minDiff) {
      minDiff = diff;
      closest = entry;
    }
  }

  if (!closest) return { precip_mm: 0, weatherCode: 1 }; // fallback

  return {
    precip_mm: round(closest.totalPrecipAmount || 0),
    weatherCode: closest.weatherType?.value ?? 1 // 1=partly cloudy fallback
  };
}

// Find the fresh24 hours
function computeFresh24h(conditions, nowTs) {
  const cutoff = new Date(new Date(nowTs).getTime() - 24 * 3600 * 1000);

  let summit = 0, mid = 0, base = 0;

  for (const c of conditions) {
    const ts = new Date(c.timestamp);
    if (ts < cutoff) continue;

    // fresh_1h contributions
    summit += c.snow?.summit?.fresh_1h ?? 0;
    mid    += c.snow?.mid?.fresh_1h    ?? 0;
    base   += c.snow?.base?.fresh_1h   ?? 0;

    // Seed lump (entry has fresh_24h but no fresh_1h field at all)
    if (c.snow?.summit?.fresh_1h === undefined) summit += c.snow?.summit?.fresh_24h ?? 0;
    if (c.snow?.mid?.fresh_1h    === undefined) mid    += c.snow?.mid?.fresh_24h    ?? 0;
    if (c.snow?.base?.fresh_1h   === undefined) base   += c.snow?.base?.fresh_24h   ?? 0;
  }

  return { summit: round(summit), mid: round(mid), base: round(base) };
}

// --- Snow model ---
function computeSnow(prevSnow, weather) {
  const newSnow = {};

  function meltRate(tempC) {
    if (tempC <= 0) return 0;
    if (tempC <= 2) return 0.3 * tempC;   // slow melt
    return 0.5 * tempC;                    // faster above 2°C
  }

  function snowFraction(tempC) {
    if (tempC <= -1) return 1.0;
    if (tempC >= 2) return 0.0;
    return (2 - tempC) / 3;
  }

  // mm water equivalent → cm snow depth (density ratio by temp)
  function precipToCm(precip_mm, tempC) {
    const ratio = tempC <= -5 ? 12 : tempC >= 0 ? 6 : 12 - (tempC + 5) * 1.2;
    return precip_mm * snowFraction(tempC) * ratio / 10;
  }

  // Summit
  const summitFresh = round(precipToCm(weather.summit.precip_mm, weather.summit.temp_c));
  const summitMelt = round(meltRate(weather.summit.temp_c));  // cm/h flat rate, not % of base
  const summitWindLoss = round(summitFresh * (weather.summit.wind_kmh / 200)); // lose some to wind

  newSnow.summit = {
    base: round(Math.max(0, prevSnow.summit.base + summitFresh - summitMelt - summitWindLoss)),
    fresh_1h: summitFresh
  };

  // Mid — gets some wind-redistributed snow from summit
  const midFresh = round(precipToCm(weather.mid.precip_mm, weather.mid.temp_c));
  const midMelt = round(meltRate(weather.mid.temp_c));
  const midWindGain = round(summitWindLoss * 0.6); // 60% of summit loss deposits at mid

  newSnow.mid = {
    base: round(Math.max(0, prevSnow.mid.base + midFresh - midMelt + midWindGain)),
    fresh_1h: round(midFresh + midWindGain)
  };

  // Base — gets a little wind redistribution from mid
  const baseFresh = round(precipToCm(weather.base.precip_mm, weather.base.temp_c));
  const baseMelt = round(meltRate(weather.base.temp_c));
  const baseWindGain = round(summitWindLoss * 0.2);

  newSnow.base = {
    base: round(Math.max(0, prevSnow.base.base + baseFresh - baseMelt + baseWindGain)),
    fresh_1h: round(baseFresh + baseWindGain)
  };

  return newSnow;
}

// --- Main runner ---
(async function(){
  const data = loadData();
  const aws = await readAWS();
  if (!aws) { console.error("No AWS data"); return; }

    const lastTs = data.conditions.at(-1)?.timestamp;
    if (lastTs) {
    const gapHours = (new Date() - new Date(lastTs)) / 3600000;
    if (gapHours > 2) {
        console.warn(`⚠️  Gap detected: last entry was ${gapHours.toFixed(1)}h ago (${lastTs})`);
        console.warn(`   fresh_24h totals will be understated until gap closes`);
    }
    }

  if (data.conditions.some(c => c.timestamp === aws.timestamp)) {
    console.log("Already have data for this hour"); return;
  }

  const weather = { summit:{}, mid:{}, base:{} };

  weather.summit.temp_c = aws.temp_c;
  weather.summit.wind_kmh = aws.wind_kmh;
  weather.summit.wind_dir = aws.wind_dir;
  const summitMet = await fetchMetOfficeWeather(LAT_SUMMIT, LON_SUMMIT);
  weather.summit.precip_mm = summitMet.precip_mm;
  weather.summit.weatherCode = summitMet.weatherCode;

  weather.mid.temp_c = lapseRateAdjust(aws.temp_c, SUMMIT_ALT, MID_ALT);
  weather.mid.wind_kmh = round(aws.wind_kmh * 0.9);
  weather.mid.wind_dir = aws.wind_dir;
  const midMet = await fetchMetOfficeWeather(LAT_MID, LON_MID);
  weather.mid.precip_mm = midMet.precip_mm;
  weather.mid.weatherCode = midMet.weatherCode;

  weather.base.temp_c = lapseRateAdjust(aws.temp_c, SUMMIT_ALT, BASE_ALT);
  weather.base.wind_kmh = round(aws.wind_kmh * 0.7);
  weather.base.wind_dir = aws.wind_dir;
  const baseMet = await fetchMetOfficeWeather(LAT_BASE, LON_BASE);
  weather.base.precip_mm = baseMet.precip_mm;
  weather.base.weatherCode = baseMet.weatherCode;

  const prevSnow = data.conditions.at(-1)?.snow ?? {
    summit: { base: 0 }, mid: { base: 0 }, base: { base: 0 }
  };

  const snow = computeSnow(prevSnow, weather);

  // Push new entry
  data.conditions.push({
    timestamp: aws.timestamp,
    source: 'aws+metoffice',
    snow,
    weather
  });

  // Compute fresh_24h BEFORE trimming — sum fresh_1h across all entries in window
  // Use 0 for any entry missing fresh_1h (e.g. seed entries)
  const nowTs = new Date(aws.timestamp);
  const cutoff24 = new Date(nowTs.getTime() - 24 * 3600 * 1000);

//   const fresh24 = { summit: 0, mid: 0, base: 0 };
//   for (const c of data.conditions) {
//     if (new Date(c.timestamp) >= cutoff24) {
//       fresh24.summit += c.snow?.summit?.fresh_1h ?? 0;
//       fresh24.mid    += c.snow?.mid?.fresh_1h    ?? 0;
//       fresh24.base   += c.snow?.base?.fresh_1h   ?? 0;
//     }
//   }

  const fresh24 = computeFresh24h(data.conditions, aws.timestamp);

  const latest = data.conditions.at(-1);
  latest.snow.summit.fresh_24h = round(fresh24.summit);
  latest.snow.mid.fresh_24h    = round(fresh24.mid);
  latest.snow.base.fresh_24h   = round(fresh24.base);

  // Trim AFTER computing fresh_24h
  data.conditions = data.conditions.filter(c => new Date(c.timestamp) >= cutoff24);

  saveData(data);
  console.log("Updated:", data.conditions.at(-1));
})();