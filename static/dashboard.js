const $ = (id) => document.getElementById(id);
let map, markers = {}, circles = {}, routeLine = null, selectedId = null;
const routeCache = {};
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function niceTime(value) {
  if (!value) return "No GPS update yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}
function setMessage(message, error=false) {
  $("create-message").textContent = message;
  $("create-message").className = "message" + (error ? " error-text" : " success-text");
}
function initMap() {
  map = L.map("map").setView([0.3476, 32.5825], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
}
async function createInvitation() {
  const label = $("device-label").value.trim() || "Phone";
  $("create-btn").disabled = true;
  setMessage("Creating a secure invitation…");
  try {
    const response = await fetch("/api/invitations", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({label})});
    if (!response.ok) throw new Error("Could not create invitation. Please sign in again and retry.");
    const result = await response.json();
    $("share-url").value = result.url;
    $("created-link").classList.remove("hidden");
    $("device-label").value = "";
    setMessage("Invitation created. Copy and send the link to the phone owner.");
    await refreshDevices();
  } catch (e) { setMessage(e.message, true); }
  finally { $("create-btn").disabled = false; }
}
async function refreshDevices() {
  try {
    const response = await fetch("/api/locations", {cache:"no-store"});
    if (response.status === 401 || response.redirected) { location.href="/login"; return; }
    if (!response.ok) throw new Error("Unable to load devices.");
    const devices = await response.json();
    renderDevices(devices);
    for (const d of devices) {
      if (d.lat != null && d.lng != null) {
        const point = [d.lat, d.lng];
        const popup = `<b>${escapeHtml(d.label)}</b><br>${d.sharing ? "Sharing location" : "Last known location"}<br>Accuracy: ${Math.round(d.accuracy || 0)} m<br>${escapeHtml(niceTime(d.last_seen))}`;
        if (!markers[d.id]) markers[d.id] = L.marker(point).addTo(map);
        markers[d.id].setLatLng(point).bindPopup(popup);
        if (!circles[d.id]) circles[d.id] = L.circle(point, {radius: 0, weight: 1, color: "#2563eb"}).addTo(map);
        circles[d.id].setLatLng(point).setRadius(d.accuracy || 0);
        if (d.sharing && selectedId === d.id && $("follow").checked) map.panTo(point);
      }
    }
    if (!selectedId) { const live = devices.find(x => x.sharing && x.lat != null); if (live) await showRoute(live.id); }
    if (selectedId && devices.some(d => d.id === selectedId)) await showRoute(selectedId, false);
  } catch (e) {
    $("devices").innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}
function renderDevices(devices) {
  if (!devices.length) { $("devices").innerHTML = '<p class="muted">No invitations yet. Create one above to get started.</p>'; return; }
  $("devices").innerHTML = devices.map(d => {
    const active = d.active;
    const status = !active ? "Expired / revoked" : d.sharing ? (d.last_seen && Date.now() - new Date(d.last_seen) > 45000 ? "Signal lost" : "Sharing live") : d.consented ? "Not sharing" : "Awaiting consent";
    const cls = d.sharing && active ? "status sharing" : "status";
    const coord = d.lat == null ? "No GPS coordinates received" : `${Number(d.lat).toFixed(5)}, ${Number(d.lng).toFixed(5)} · ±${Math.round(d.accuracy || 0)} m${d.speed != null ? ` · ${(d.speed * 3.6).toFixed(1)} km/h` : ""}`;
    return `<div class="device"><div><div class="device-title">${escapeHtml(d.label)} <span class="${cls}">${status}</span></div><div class="device-meta">${escapeHtml(coord)}<br>Last update: ${escapeHtml(niceTime(d.last_seen))}<br>Invitation expires: ${escapeHtml(niceTime(d.expires_at))}</div></div><div class="device-actions"><button class="secondary" data-action="route" data-id="${d.id}">Show route</button><button class="ghost" data-action="clear" data-id="${d.id}">Delete history</button><button class="secondary" data-action="copy" data-id="${d.id}">Copy link</button>${active ? `<button class="ghost" data-action="revoke" data-id="${d.id}">Revoke</button>` : ""}</div></div>`;
  }).join("");
}
async function showRoute(id, fit=true) {
  selectedId = Number(id);
  try {
    const response = await fetch(`/api/locations/${id}/history`, {cache:"no-store"});
    if (!response.ok) return;
    const points = await response.json();
    routeCache[id] = points;
    const latlngs = points.map(p => [p.lat,p.lng]);
    if (routeLine) map.removeLayer(routeLine);
    routeLine = latlngs.length ? L.polyline(latlngs, {color:"#2563eb",weight:4,opacity:.8}).addTo(map) : null;
    if (latlngs.length) {
      $("map-status").textContent = `${points.length} point${points.length===1?"":"s"} · ${km(points).toFixed(2)} km travelled`;
      if (fit) map.fitBounds(routeLine.getBounds().pad(.2), {maxZoom:16});
    } else {
      $("map-status").textContent = "No GPS points recorded yet";
    }
  } catch (_) { $("map-status").textContent = "Could not load route"; }
}
function km(pts) {
  let t = 0; const r = Math.PI / 180;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i], h = Math.sin((b.lat-a.lat)*r/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;
    t += 12742 * Math.asin(Math.sqrt(h));
  }
  return t;
}
async function clearHistory(id) {
  if (!confirm("Permanently delete this device's location history?")) return;
  const response = await fetch(`/api/locations/${id}/clear`, {method: "POST"});
  if (response.ok) { if (routeLine) { map.removeLayer(routeLine); routeLine = null; } await refreshDevices(); }
}
async function revoke(id) {
  if (!confirm("Revoke this invitation and stop future location updates?")) return;
  const response = await fetch(`/api/invitations/${id}/revoke`, {method:"POST"});
  if (response.ok) await refreshDevices();
}
async function copyInvite(id) {
  try {
    const response = await fetch("/api/locations", {cache:"no-store"});
    if (!response.ok) throw new Error("Could not retrieve invitations.");
    const devices = await response.json();
    const d = devices.find(x => x.id === Number(id));
    if (!d || !d.share_url) throw new Error("Invitation link is unavailable.");
    await navigator.clipboard.writeText(d.share_url);
    alert("Invitation link copied. Send it only to the intended phone owner.");
  } catch (_) {
    alert("Could not copy the link. Open the invitation you created, or create a new invitation and copy its link.");
  }
}
$("create-btn").addEventListener("click", createInvitation);
$("refresh-btn").addEventListener("click", refreshDevices);
$("copy-btn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("share-url").value); $("copy-btn").textContent = "Copied!"; setTimeout(() => $("copy-btn").textContent = "Copy link", 1400); }
  catch (_) { $("share-url").select(); document.execCommand("copy"); }
});
$("devices").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "route") await showRoute(id);
  if (btn.dataset.action === "revoke") await revoke(id);
  if (btn.dataset.action === "clear") await clearHistory(id);
  if (btn.dataset.action === "copy") await copyInvite(id);
});
initMap();
refreshDevices();
setInterval(refreshDevices, 3000);
