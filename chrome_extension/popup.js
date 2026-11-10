const CONFIG = globalThis.TENNIS_MONITOR_CONFIG;
const EXTENSION_MODE = typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;
const BACKGROUND_API_VERSION = 2;
const PREVIEW_STORAGE_KEY = "tennisMonitorPreview";
document.body.classList.toggle("preview-mode", !EXTENSION_MODE);
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let backgroundCompatible = !EXTENSION_MODE;
let toastTimer = null;

const DEFAULTS = {
  autoEnabled: true,
  venues: CONFIG.venues.map((venue) => venue.name).filter((name) => name !== "张江学生活动中心-网球"),
  weekdays: CONFIG.weekdays.map((day) => day.value),
  startTime: "",
  endTime: "",
  rushStartTime: "06:30",
  rushEndTime: "07:30",
  rushIntervalSeconds: 30,
  regularIntervalMinutes: 30
};

function byId(id) {
  return document.getElementById(id);
}

function showToast(message, type = "error", duration = 4500) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  toast.classList.remove("is-leaving");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("is-leaving");
    setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove("is-leaving");
    }, 200);
  }, duration);
}

function setBackgroundCompatible(compatible) {
  backgroundCompatible = compatible || !EXTENSION_MODE;
  if (EXTENSION_MODE) {
    document.querySelectorAll("main input, main button").forEach((control) => {
      control.disabled = !backgroundCompatible;
    });
  }
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

function updateVenueAndFilterSummary() {
  const selectedVenues = Array.from(document.querySelectorAll('input[name="venue"]:checked'));
  byId("venueSummary").textContent = `当前选择 ${selectedVenues.length} 个场馆`;

  const selectedWeekdays = new Set(
    Array.from(document.querySelectorAll('input[name="weekday"]:checked')).map((input) => Number(input.value))
  );
  const selected = CONFIG.weekdays.filter((day) => selectedWeekdays.has(day.value));
  const days = selected.length === 0 || selected.length === CONFIG.weekdays.length
    ? "每天"
    : selected.map((day) => WEEKDAY_SHORT[day.value]).join("/");
  const start = byId("startTime").value;
  const end = byId("endTime").value;
  const time = start && end ? `${start}–${end}` : (start || end ? "时段待补全" : "全天");
  byId("filterSummary").textContent = `${days} · ${time}`;
}

function updateScheduleSummary() {
  const start = byId("rushStartTime").value || "--:--";
  const end = byId("rushEndTime").value || "--:--";
  const rushSeconds = byId("rushInterval").value || "—";
  const regularMinutes = byId("regularInterval").value || "—";
  byId("autoSummary").textContent = byId("autoEnabled").checked
    ? `开启 · ${start}–${end}`
    : "已关闭";
  byId("scheduleSummary").textContent =
    `当前：每天 ${start}–${end} 每 ${rushSeconds} 秒，其余时间每 ${regularMinutes} 分钟。`;
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
    weekdays.append(checkbox(WEEKDAY_SHORT[day.value], day.value, settings.weekdays.includes(day.value), "weekday"));
  });

  byId("startTime").value = settings.startTime;
  byId("endTime").value = settings.endTime;
  byId("rushStartTime").value = settings.rushStartTime;
  byId("rushEndTime").value = settings.rushEndTime;
  byId("autoEnabled").checked = settings.autoEnabled !== false;
  byId("rushInterval").value = String(settings.rushIntervalSeconds);
  byId("regularInterval").value = String(settings.regularIntervalMinutes);
  updateVenueAndFilterSummary();
  updateScheduleSummary();
  byId("status").textContent = settings.autoEnabled === false ? "自动检查已关闭" : "自动检查已开启";
}

function readOptions() {
  return {
    autoEnabled: byId("autoEnabled").checked,
    venues: Array.from(document.querySelectorAll('input[name="venue"]:checked')).map((input) => input.value),
    weekdays: Array.from(document.querySelectorAll('input[name="weekday"]:checked')).map((input) => Number(input.value)),
    startTime: byId("startTime").value,
    endTime: byId("endTime").value,
    rushStartTime: byId("rushStartTime").value,
    rushEndTime: byId("rushEndTime").value,
    rushIntervalSeconds: Number(byId("rushInterval").value),
    regularIntervalMinutes: Number(byId("regularInterval").value)
  };
}

function normalizeSettings(raw = {}) {
  const settings = {
    ...DEFAULTS,
    ...raw,
    venues: Array.isArray(raw.venues) ? raw.venues : [...DEFAULTS.venues],
    weekdays: Array.isArray(raw.weekdays) ? raw.weekdays : [...DEFAULTS.weekdays]
  };
  if (typeof raw.autoEnabled !== "boolean" && typeof raw.enabled === "boolean") {
    settings.autoEnabled = raw.enabled;
  }
  if (typeof settings.startTime !== "string") settings.startTime = "";
  if (typeof settings.endTime !== "string") settings.endTime = "";
  if (!/^\d{2}:\d{2}$/.test(settings.rushStartTime || "")) settings.rushStartTime = DEFAULTS.rushStartTime;
  if (!/^\d{2}:\d{2}$/.test(settings.rushEndTime || "")) settings.rushEndTime = DEFAULTS.rushEndTime;
  if (!Number.isInteger(settings.rushIntervalSeconds) && Number.isFinite(raw.rushIntervalMinutes)) {
    settings.rushIntervalSeconds = Math.round(raw.rushIntervalMinutes * 60);
  }
  if (!Number.isInteger(settings.regularIntervalMinutes) && Number.isFinite(raw.intervalMinutes)) {
    settings.regularIntervalMinutes = raw.intervalMinutes;
  }
  delete settings.rushIntervalMinutes;
  delete settings.intervalMinutes;
  delete settings.enabled;
  return settings;
}

function previewSettings(preview) {
  return normalizeSettings(preview.settings || {});
}

function send(message) {
  if (EXTENSION_MODE) return chrome.runtime.sendMessage(message);

  let preview = {};
  try {
    preview = JSON.parse(localStorage.getItem(PREVIEW_STORAGE_KEY) || "{}");
  } catch (_error) {
    preview = {};
  }
  const settings = previewSettings(preview);

  if (message.type === "GET_STATE") {
    return Promise.resolve({
      settings,
      lastCheck: preview.lastCheck || null,
      openSlots: [],
      lastError: "",
      checking: false
    });
  }
  if (message.type === "SAVE_SETTINGS") {
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ ...preview, settings: message.settings }));
    return Promise.resolve({ ok: true });
  }
  if (message.type === "MANUAL_CHECK") {
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ ...preview, lastCheck: new Date().toISOString() }));
    return Promise.resolve({ ok: true, started: true });
  }
  return Promise.resolve(null);
}

function renderAvailability(status) {
  status = status || {};
  const slots = status.openSlots || [];
  const list = byId("openSlots");
  byId("status").textContent = status.settings?.autoEnabled === false ? "自动检查已关闭" : "自动检查已开启";
  if (status.checking) byId("status").textContent += " · 正在检查";
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
  const label = status.lastError ? "最近记录开放" : "开放";
  byId("lastCheck").textContent = status.lastCheck
    ? `上次检查：${new Date(status.lastCheck).toLocaleString()} · ${label} ${slots.length} 场`
    : "尚未检查";
  byId("lastError").textContent = status.lastError || "";
  byId("lastError").hidden = !status.lastError;
}

async function refresh() {
  try {
    const status = await send({ type: "GET_STATE" });
    if (EXTENSION_MODE && status?.apiVersion !== BACKGROUND_API_VERSION) {
      renderOptions(normalizeSettings(status?.settings || {}));
      renderAvailability({ ...status, lastError: "" });
      setBackgroundCompatible(false);
      byId("status").textContent = "插件需要重新加载";
      showToast("插件后台版本未同步。请到 chrome://extensions 点击此插件的“重新加载”，再试保存或检查。", "warning", 9000);
      return;
    }
    setBackgroundCompatible(true);
    renderOptions(normalizeSettings(status?.settings || {}));
    renderAvailability(status);
    if (!EXTENSION_MODE) {
      byId("status").textContent = "界面预览 · 模拟状态";
      if (!status.lastCheck) byId("lastCheck").textContent = "预览模式：检查按钮只模拟更新时间";
    }
  } catch (_error) {
    if (EXTENSION_MODE) {
      renderOptions(normalizeSettings({}));
      renderAvailability({ settings: DEFAULTS });
      setBackgroundCompatible(false);
      byId("status").textContent = "无法连接插件后台";
      showToast("无法连接插件后台。请重开弹窗；如果仍无响应，到 chrome://extensions 点击“重新加载”。", "warning", 9000);
    } else {
      showToast("界面预览暂时无法读取状态。", "warning");
    }
  }
}

async function save({ showSuccess = true } = {}) {
  if (!backgroundCompatible) {
    showToast("插件后台版本未同步。请到 chrome://extensions 点击此插件的“重新加载”后再试。", "warning", 9000);
    return false;
  }
  let response;
  try {
    response = await send({ type: "SAVE_SETTINGS", settings: readOptions() });
  } catch (_error) {
    showToast("设置未保存：无法连接插件后台。请重开弹窗，仍失败时重新加载插件。", "error", 6500);
    return false;
  }
  if (!response?.ok) {
    byId("lastError").textContent = response?.error || "设置未保存";
    byId("lastError").hidden = false;
    showToast(`保存失败：${response?.error || "设置未保存"}`, "error", 6500);
    return false;
  }
  await refresh();
  if (showSuccess && backgroundCompatible) showToast("设置已保存。", "success", 2200);
  return true;
}

byId("save").addEventListener("click", () => save());
byId("autoEnabled").addEventListener("change", () => {
  updateScheduleSummary();
  save({ showSuccess: false });
});
byId("resetAutoDefaults").addEventListener("click", async () => {
  byId("autoEnabled").checked = DEFAULTS.autoEnabled;
  byId("rushStartTime").value = DEFAULTS.rushStartTime;
  byId("rushEndTime").value = DEFAULTS.rushEndTime;
  byId("rushInterval").value = String(DEFAULTS.rushIntervalSeconds);
  byId("regularInterval").value = String(DEFAULTS.regularIntervalMinutes);
  updateScheduleSummary();
  await save({ showSuccess: false });
});
byId("venues").addEventListener("change", updateVenueAndFilterSummary);
byId("weekdays").addEventListener("change", updateVenueAndFilterSummary);
for (const id of ["startTime", "endTime"]) {
  byId(id).addEventListener("input", updateVenueAndFilterSummary);
}
for (const id of ["rushStartTime", "rushEndTime", "rushInterval", "regularInterval"]) {
  byId(id).addEventListener("input", updateScheduleSummary);
}
byId("manualCheck").addEventListener("click", async () => {
  if (!(await save({ showSuccess: false }))) return;
  const button = byId("manualCheck");
  button.disabled = true;
  button.textContent = "检查中…";
  try {
    const result = await send({ type: "MANUAL_CHECK" });
    if (!result?.ok) {
      const error = result?.error || "手动检查失败。";
      byId("lastError").textContent = error;
      byId("lastError").hidden = false;
      showToast(`检查未启动：${error}`, "error", 6500);
    } else if (result.started === false) {
      showToast("已有一轮检查正在进行，请稍后再看结果。", "warning", 4000);
    } else {
      showToast("已开始检查，完成后会更新开放场次。", "success", 3500);
    }
    await refresh();
  } catch (_error) {
    showToast("检查未启动：无法连接插件后台。请重新加载插件后再试。", "error", 6500);
  } finally {
    button.disabled = EXTENSION_MODE && !backgroundCompatible;
    button.textContent = "立即检查";
  }
});

if (EXTENSION_MODE) {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.lastCheck) {
      await refresh();
    }
  });
}
refresh();
