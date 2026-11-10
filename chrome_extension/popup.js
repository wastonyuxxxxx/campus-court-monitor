const CONFIG = globalThis.TENNIS_MONITOR_CONFIG;
const EXTENSION_MODE = typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;
const DEFAULTS = {
  enabled: false,
  venues: CONFIG.venues.map((venue) => venue.name).filter((name) => name !== "张江学生活动中心-网球"),
  weekdays: CONFIG.weekdays.map((day) => day.value),
  startTime: "",
  endTime: "",
  intervalMinutes: 1
};

function byId(id) {
  return document.getElementById(id);
}

function checkbox(label, value, checked, name) {
  const wrapper = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = String(value);
  input.name = name;
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(input, text);
  return wrapper;
}

function renderOptions(settings) {
  const venues = byId("venues");
  venues.replaceChildren();
  CONFIG.venues.forEach((venue) => {
    venues.append(checkbox(venue.name, venue.name, settings.venues.includes(venue.name), "venue"));
  });

  const weekdays = byId("weekdays");
  weekdays.replaceChildren();
  CONFIG.weekdays.forEach((day) => {
    weekdays.append(checkbox(day.label, day.value, settings.weekdays.includes(day.value), "weekday"));
  });

  byId("startTime").value = settings.startTime;
  byId("endTime").value = settings.endTime;
  byId("interval").value = String(settings.intervalMinutes);
  byId("status").textContent = settings.enabled ? "监控中" : "已停止";
}

function readOptions() {
  return {
    venues: Array.from(document.querySelectorAll('input[name="venue"]:checked')).map((input) => input.value),
    weekdays: Array.from(document.querySelectorAll('input[name="weekday"]:checked')).map((input) => Number(input.value)),
    startTime: byId("startTime").value,
    endTime: byId("endTime").value,
    intervalMinutes: Number(byId("interval").value)
  };
}

function send(message) {
  if (!EXTENSION_MODE) return Promise.resolve(null);
  return chrome.runtime.sendMessage(message);
}

function renderAvailability(status) {
  const slots = status.openSlots || [];
  const list = byId("openSlots");
  list.replaceChildren();
  for (const slot of slots) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = slot.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `${slot.venue} · ${slot.date} ${slot.time} ↗`;
    item.append(link);
    list.append(item);
  }
  list.hidden = slots.length === 0;
  const label = status.lastError || !status.settings?.enabled ? "最近记录开放" : "开放";
  byId("lastCheck").textContent = status.lastCheck
    ? `上次检查：${new Date(status.lastCheck).toLocaleString()} · ${label} ${slots.length} 场`
    : "尚未检查";
  byId("lastError").textContent = status.lastError || "";
  byId("lastError").hidden = !status.lastError;
}

async function refresh() {
  if (!EXTENSION_MODE) {
    renderOptions(DEFAULTS);
    byId("status").textContent = "设置预览（尚未安装）";
    byId("lastCheck").textContent = "默认：每天全天 · 每分钟检查";
    byId("start").disabled = true;
    byId("stop").disabled = true;
    byId("save").disabled = true;
    return;
  }
  const status = await send({ type: "GET_STATE" });
  renderOptions(status.settings || DEFAULTS);
  renderAvailability(status);
}

async function save() {
  const response = await send({ type: "SAVE_SETTINGS", settings: readOptions() });
  if (!response?.ok) {
    byId("lastError").textContent = response?.error || "设置未保存";
    byId("lastError").hidden = false;
    return false;
  }
  await refresh();
  return true;
}

byId("save").addEventListener("click", save);
byId("start").addEventListener("click", async () => {
  if (!(await save())) return;
  await send({ type: "START" });
  await refresh();
});
byId("stop").addEventListener("click", async () => {
  await send({ type: "STOP" });
  await refresh();
});

if (EXTENSION_MODE) {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.lastCheck) {
      renderAvailability(await send({ type: "GET_STATE" }));
    }
  });
}
refresh();
