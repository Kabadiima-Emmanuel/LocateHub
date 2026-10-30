const $ = (id) => document.getElementById(id);
const token = window.LOCATEHUB_TOKEN;
const API = `/api/share/${encodeURIComponent(token)}`;
let watchId = null, active = false, flushing = false, lowPower = false, wakeLock = null, lastQueued = 0;
let queue = [];                                   // points waiting to be sent (kept if the signal drops)
function status(message, kind = "") {
  $("share-status").textContent = message;
  $("share-status").className = "message" + (kind ? ` ${kind}` : "");
}
function updateControls() {
  $("start-btn").classList.toggle("hidden", active);
  $("stop-btn").classList.toggle("hidden", !active);
  $("consent").disabled = active;
}
async function post(url, data = {}) {
  const response = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(result.message || "Request failed."); e.status = response.status; throw e; }
  return result;
}
async function keepScreenOn() {                    // phones pause GPS in the background; this keeps the screen awake
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch (_) {}
}
function stopWatch() { if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId = null; }
async function stopSharing(message) {
  stopWatch(); active = false; queue = [];
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  updateControls();
  try { await post(`${API}/stop`); } catch (_) {}
  status(message || "Location sharing stopped. No new GPS updates will be sent.", "success-text");
}
async function flush(accuracy) {
  if (flushing || !queue.length || !active) return;
  flushing = true;
  const batch = queue.splice(0, 100);
  try {
    await post(`${API}/location`, {points: batch});
    const how = lowPower ? "Wi-Fi/mobile-network location" : "GPS";
    status(`Sharing is active (${how}, about ${Math.round(accuracy)} m accuracy). Last sent: ${new Date().toLocaleTimeString()}`, "success-text");
  } catch (e) {
    if (e.status === 403 || e.status === 410) { flushing = false; return stopSharing(e.message + " Sharing has stopped."); }
    queue = batch.concat(queue).slice(-1000);      // network problem: keep the points and retry
    status("No connection. Your movement is being saved and will be sent when you are back online.", "error-text");
  } finally { flushing = false; }
}
function onPosition(position) {
  if (!active) return;
  const c = position.coords, now = Date.now();
  if (now - lastQueued >= 2000) {                  // at most one point every 2 seconds
    lastQueued = now;
    queue.push({lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading, t: position.timestamp});
  }
  flush(c.accuracy);
}
function beginWatch(high) {
  stopWatch();
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: high, maximumAge: high ? 2000 : 15000, timeout: high ? 20000 : 40000
  });
}
function onPositionError(error) {
  if (error.code === 1) return stopSharing("Location permission was denied. Allow location for this site in your browser settings, then start again.");
  if (!lowPower) {                                 // weak GPS (indoors): let the phone use Wi-Fi / mobile-network location
    lowPower = true; beginWatch(false);
    status("GPS signal is weak. Switching to Wi-Fi and mobile-network location (less precise).", "error-text");
    return;
  }
  status(error.code === 3 ? "Still waiting for a position. Keep this page open." : "Your phone could not determine a location. Check that Location Services are on.", "error-text");
}
$("consent").addEventListener("change", () => { $("start-btn").disabled = !$("consent").checked; });
$("start-btn").addEventListener("click", async () => {
  if (!$("consent").checked) return;
  if (!window.isSecureContext) return status("GPS sharing requires HTTPS. Open the hosted HTTPS link.", "error-text");
  if (!navigator.geolocation) return status("This browser does not support location sharing. Try Chrome or Safari.", "error-text");
  $("start-btn").disabled = true;
  status("Starting. Your browser will ask for location permission. Choose Allow.");
  try {
    await post(`${API}/start`, {consent: true});
    active = true; lowPower = false; updateControls(); keepScreenOn();
    beginWatch(true);                              // called inside the tap, so the browser prompt can appear
    status("Waiting for your phone's position… Keep this page open and the screen on.");
  } catch (e) {
    active = false; updateControls(); $("start-btn").disabled = !$("consent").checked; status(e.message, "error-text");
  }
});
$("stop-btn").addEventListener("click", () => stopSharing());
document.addEventListener("visibilitychange", () => {
  if (!active) return;
  if (document.visibilityState === "visible") { keepScreenOn(); status("Sharing resumed."); }
  else status("This page is in the background. Your phone may pause location until you return.", "error-text");
});
setInterval(() => { if (active && queue.length) flush(0); }, 10000);   // retry unsent points
