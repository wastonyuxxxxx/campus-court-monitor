(function () {
  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message);
    } catch (_error) {
      // The service worker may be restarting; the next scheduled scan retries.
    }
  };

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function parseCalendar() {
    const lists = Array.from(document.querySelectorAll("dl")).map((element, index) => {
      const children = Array.from(element.children);
      return {
        index,
        headers: children
          .filter((child) => child.tagName === "DT")
          .map((child) => normalizedText(child.innerText)),
        cells: children
          .filter((child) => child.tagName === "DD")
          .map((child) => normalizedText(child.innerText))
      };
    });

    const timeColumn = lists.find((item) => item.headers.some((header) => header.includes("时段")));
    if (!timeColumn || timeColumn.cells.length === 0) return null;

    const days = lists
      .filter((item) => item.headers.some((header) => /\d{4}-\d{2}-\d{2}/.test(header)))
      .map((item) => {
        const match = item.headers.join(" ").match(/\d{4}-\d{2}-\d{2}/);
        return match ? { date: match[0], cells: item.cells } : null;
      })
      .filter(Boolean);

    if (days.length === 0) return null;
    if (days.some((day) => day.cells.length !== timeColumn.cells.length)) {
      return { error: "日历日期列和时段数量不一致" };
    }

    return { times: timeColumn.cells, days };
  }

  let finished = false;
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (finished) return;

    const heading = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .some((element) => element.offsetParent !== null && normalizedText(element.innerText).includes("阅读须知"));
    if (heading) {
      finished = true;
      window.clearInterval(timer);
      send({ type: "NOTICE_REQUIRED", url: location.href });
      return;
    }

    const data = parseCalendar();
    if (data) {
      finished = true;
      window.clearInterval(timer);
      if (data.error) {
        send({ type: "CALENDAR_ERROR", url: location.href, error: data.error });
      } else {
        send({ type: "CALENDAR_DATA", url: location.href, title: document.title, data });
      }
      return;
    }

    if (Date.now() - startedAt > 25000) {
      finished = true;
      window.clearInterval(timer);
      send({ type: "CALENDAR_ERROR", url: location.href, error: "预约周历未能加载" });
    }
  }, 400);
})();
