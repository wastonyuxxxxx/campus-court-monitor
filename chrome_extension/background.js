importScripts("config.js");

const BACKGROUND_API_VERSION = 2;
const CONFIG = globalThis.TENNIS_MONITOR_CONFIG;
const VENUE_BY_NAME = new Map(CONFIG.venues.map((venue) => [venue.name, venue]));
const DEFAULT_SETTINGS = {
  autoEnabled: true,
  venues: CONFIG.venues
    .map((venue) => venue.name)
    .filter((name) => name !== "张江学生活动中心-网球"),
  weekdays: CONFIG.weekdays.map((day) => day.value),
  startTime: "",
  endTime: "",
  rushStartTime: "06:30",
  rushEndTime: "07:30",
  rushIntervalSeconds: 30,
  regularIntervalMinutes: 30
};

let pollInFlight = false;
const pendingReads = new Map();

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) return { ...DEFAULT_SETTINGS };
  const normalized = { ...DEFAULT_SETTINGS, ...settings };
  if (typeof settings.autoEnabled !== "boolean") {
    // Migrate the previous monitor switch to the new automatic-check switch.
    normalized.autoEnabled = settings.enabled === true;
  }
  delete normalized.enabled;
  delete normalized.intervalMinutes;
  delete normalized.rushIntervalMinutes;
  return normalized;
}

function validSettings(settings) {
  const allowed = new Set(CONFIG.venues.map((venue) => venue.name));
  const noTimeFilter = settings.startTime === "" && settings.endTime === "";
  const start = /^\d{2}:\d{2}$/.test(settings.startTime) ? settings.startTime : "";
  const end = /^\d{2}:\d{2}$/.test(settings.endTime) ? settings.endTime : "";
  const rushStart = /^\d{2}:\d{2}$/.test(settings.rushStartTime) ? settings.rushStartTime : "";
  const rushEnd = /^\d{2}:\d{2}$/.test(settings.rushEndTime) ? settings.rushEndTime : "";
  return (
    typeof settings.autoEnabled === "boolean" &&
    Array.isArray(settings.venues) &&
    settings.venues.length > 0 &&
    settings.venues.every((name) => allowed.has(name)) &&
    Array.isArray(settings.weekdays) &&
    settings.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    (noTimeFilter || (start && end && start < end)) &&
    rushStart && rushEnd && rushStart < rushEnd &&
    Number.isInteger(settings.rushIntervalSeconds) && settings.rushIntervalSeconds >= 30 && settings.rushIntervalSeconds <= 600 &&
    Number.isInteger(settings.regularIntervalMinutes) && settings.regularIntervalMinutes >= 1 && settings.regularIntervalMinutes <= 180
  );
}

async function getStatus() {
  const stored = await chrome.storage.local.get([
    "lastCheck",
    "previousAvailability",
    "lastError"
  ]);
  const settings = await getSettings();
  const now = new Date();
  const openSlots = [];
  for (const [key, available] of Object.entries(stored.previousAvailability || {})) {
    if (available !== true) continue;
    const [venue, date, time] = key.split("|");
    const target = VENUE_BY_NAME.get(venue);
    if (!target || !settings.venues.includes(venue)) continue;
    if (!date || !time || !isWithinSettings(date, time, settings, now)) continue;
    openSlots.push({ venue, date, time, url: target.url });
  }
  openSlots.sort((a, b) => formatSlot(a).localeCompare(formatSlot(b)) || a.venue.localeCompare(b.venue, "zh-CN"));
  return {
    apiVersion: BACKGROUND_API_VERSION,
    settings,
    lastCheck: stored.lastCheck || null,
    openSlots,
    lastError: stored.lastError || "",
    checking: pollInFlight
  };
}

function notify(title, message) {
  chrome.notifications.create("tennis-" + Date.now(), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title,
    message,
    priority: 2
  });
}

function readVenue(tabId, venue) {
  const target = VENUE_BY_NAME.get(venue);
  if (!target) return Promise.reject(new Error("配置中包含未知场馆"));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingReads.delete(tabId);
      reject(new Error("页面未返回周历"));
    }, 30000);

    pendingReads.set(tabId, {
      url: target.url,
      resolve(data) {
        clearTimeout(timeout);
        pendingReads.delete(tabId);
        resolve(data);
      },
      reject(error) {
        clearTimeout(timeout);
        pendingReads.delete(tabId);
        reject(error);
      }
    });

    chrome.tabs.update(tabId, { url: target.url }).catch((error) => {
      const pending = pendingReads.get(tabId);
      if (pending) pending.reject(error);
    });
  });
}

function slotStart(dateText, timeText) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function isWithinSettings(dateText, timeText, settings, now) {
  const start = slotStart(dateText, timeText);
  if (Number.isNaN(start.getTime()) || start <= now) return false;
  if (settings.weekdays.length && !settings.weekdays.includes(start.getDay())) return false;
  if (settings.startTime && (timeText < settings.startTime || timeText >= settings.endTime)) return false;
  return true;
}

function formatSlot(slot) {
  return `${slot.date} ${slot.time}`;
}

function nextAutoCheckAt(now, settings) {
  const today = new Date(now);
  const rushStart = new Date(today);
  const [startHour, startMinute] = settings.rushStartTime.split(":").map(Number);
  rushStart.setHours(startHour, startMinute, 0, 0);
  const rushEnd = new Date(today);
  const [endHour, endMinute] = settings.rushEndTime.split(":").map(Number);
  rushEnd.setHours(endHour, endMinute, 0, 0);
  const inRushWindow = now >= rushStart && now < rushEnd;
  const intervalMs = inRushWindow
    ? settings.rushIntervalSeconds * 1_000
    : settings.regularIntervalMinutes * 60_000;
  let next = new Date(now.getTime() + intervalMs);

  if (inRushWindow && next > rushEnd) next = rushEnd;
  if (!inRushWindow) {
    const upcomingRushStart = new Date(rushStart);
    if (now >= rushStart) upcomingRushStart.setDate(upcomingRushStart.getDate() + 1);
    if (next > upcomingRushStart) next = upcomingRushStart;
  }
  return next;
}

async function scheduleNextAutoCheck(baseTime = new Date()) {
  const settings = await getSettings();
  if (!settings.autoEnabled) {
    await chrome.alarms.clear("tennis-poll");
    await closeMonitorTab();
    return;
  }
  const now = new Date();
  let next = nextAutoCheckAt(baseTime, settings);
  while (next <= now) next = nextAutoCheckAt(next, settings);
  await chrome.alarms.create("tennis-poll", { when: next.getTime() });
}

async function closeMonitorTab() {
  if (pollInFlight) return;
  const { monitorTabId } = await chrome.storage.local.get("monitorTabId");
  if (!Number.isInteger(monitorTabId)) return;
  try {
    await chrome.tabs.remove(monitorTabId);
  } catch (_error) {
    // The tab may already have been closed by Chrome or the user.
  }
  await chrome.storage.local.remove("monitorTabId");
}

async function runPoll({ manual = false } = {}) {
  if (pollInFlight) return false;
  pollInFlight = true;
  const pollStartedAt = new Date();
  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    pollInFlight = false;
    await chrome.storage.local.set({ lastError: error.message || "读取监控设置失败" });
    return false;
  }
  if (!manual && !settings.autoEnabled) {
    pollInFlight = false;
    return false;
  }

  let tabId = null;
  const errors = [];
  const newlyAvailable = [];
  const current = {};
  const now = pollStartedAt;
  const { previousAvailability = {}, monitorTabId } = await chrome.storage.local.get([
    "previousAvailability",
    "monitorTabId"
  ]);

  for (const [key, value] of Object.entries(previousAvailability)) {
    const venue = key.split("|", 1)[0];
    if (settings.venues.includes(venue)) current[key] = value;
  }

  try {
    if (Number.isInteger(monitorTabId)) {
      try {
        await chrome.tabs.get(monitorTabId);
        tabId = monitorTabId;
      } catch (_error) {
        tabId = null;
      }
    }

    if (tabId === null) {
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      tabId = tab.id;
      await chrome.storage.local.set({ monitorTabId: tabId });
    }

    for (const venue of settings.venues) {
      if (!manual && !(await getSettings()).autoEnabled) break;
      const target = VENUE_BY_NAME.get(venue);
      if (!target) continue;
      try {
        const calendar = await readVenue(tabId, venue);
        const prefix = venue + "|";
        for (const key of Object.keys(current)) {
          if (key.startsWith(prefix)) delete current[key];
        }

        calendar.days.forEach((day) => {
          day.cells.forEach((rawStatus, index) => {
            const interval = calendar.times[index] || "";
            const time = interval.split("-", 1)[0].trim();
            if (!/^\d{2}:\d{2}$/.test(time)) return;
            if (!isWithinSettings(day.date, time, settings, now)) return;

            const key = `${venue}|${day.date}|${time}`;
            const available = rawStatus.startsWith("可预约");
            current[key] = available;
            if (available && previousAvailability[key] !== true) {
              newlyAvailable.push({ venue, date: day.date, time });
            }
          });
        });
      } catch (error) {
        errors.push(`${venue}：${error.message || "读取失败"}`);
      }
    }

    const openCount = Object.values(current).filter(Boolean).length;
    await chrome.storage.local.set({
      previousAvailability: current,
      lastCheck: new Date().toISOString(),
      lastError: errors.join("；")
    });

    if (newlyAvailable.length > 0) {
      const lines = newlyAvailable.slice(0, 4).map((slot) => `${slot.venue} ${formatSlot(slot)}`);
      if (newlyAvailable.length > 4) lines.push(`另有 ${newlyAvailable.length - 4} 个场次`);
      notify("网球场有空场", lines.join("；"));
    }

    if (errors.length > 0) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    } else {
      await chrome.action.setBadgeText({ text: openCount ? String(openCount) : "" });
      await chrome.action.setBadgeBackgroundColor({ color: "#167d55" });
    }
  } catch (error) {
    await chrome.storage.local.set({
      lastCheck: new Date().toISOString(),
      lastError: error.message || "监控检查失败"
    });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
  } finally {
    pollInFlight = false;
    try {
      await scheduleNextAutoCheck(pollStartedAt);
    } catch (error) {
      await chrome.storage.local.set({ lastError: `下次自动检查未能安排：${error.message || "未知错误"}` });
    }
  }
  return true;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, previousAvailability } = await chrome.storage.local.get([
    "settings",
    "previousAvailability"
  ]);
  await chrome.storage.local.set({
    settings: settings ? await getSettings() : { ...DEFAULT_SETTINGS },
    previousAvailability: previousAvailability || {}
  });
  const currentSettings = await getSettings();
  if (currentSettings.autoEnabled) runPoll().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.autoEnabled) {
    await chrome.alarms.clear("tennis-poll");
    runPoll().catch(() => {});
  } else {
    await chrome.alarms.clear("tennis-poll");
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tennis-poll") runPoll();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CALENDAR_DATA" || message.type === "CALENDAR_ERROR") {
    const tabId = sender.tab && sender.tab.id;
    const pending = pendingReads.get(tabId);
    if (!pending || !message.url || !message.url.startsWith(pending.url)) return;
    if (message.type === "CALENDAR_ERROR") {
      pending.reject(new Error(message.error || "读取周历失败"));
    } else {
      pending.resolve(message.data);
    }
    return;
  }

  if (message.type === "NOTICE_REQUIRED") {
    const tabId = sender.tab && sender.tab.id;
    if (Number.isInteger(tabId)) chrome.tabs.update(tabId, { active: true }).catch(() => {});
    notify("需要确认预约须知", "请在监控打开的页面由你本人阅读并确认须知。");
    return;
  }

  if (message.type === "GET_STATE") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    if (!validSettings(message.settings)) {
      sendResponse({ ok: false, error: "请检查场馆、星期、时段和自动检查设置。" });
      return;
    }
    getSettings().then(async (previous) => {
      const settings = { ...message.settings };
      await chrome.storage.local.set({ settings });
      await chrome.alarms.clear("tennis-poll");
      if (settings.autoEnabled) {
        if (previous.autoEnabled) {
          await scheduleNextAutoCheck();
        } else {
          runPoll().catch(() => {});
        }
      } else {
        await closeMonitorTab();
      }
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message || "设置保存失败。" }));
    return true;
  }

  if (message.type === "MANUAL_CHECK") {
    runPoll({ manual: true })
      .then((started) => sendResponse({ ok: true, started }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "手动检查失败。" }));
    return true;
  }
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({
    url: "https://booking.fudan.edu.cn/reservation/fe/site/special/special?id=48",
    active: true
  });
});
