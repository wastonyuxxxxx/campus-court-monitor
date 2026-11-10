#!/usr/bin/env python3
"""Monitor configured tennis slots through the visible booking website."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
import smtplib
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, time as day_time
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from playwright.sync_api import BrowserContext, Error as PlaywrightError, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


SPECIAL_URL = "https://booking.fudan.edu.cn/reservation/fe/site/special/special?id=48"
BOOKING_HOST = "booking.fudan.edu.cn"
UIS_HOST = "id.fudan.edu.cn"
DEFAULT_MAC_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
CHROME_PATH = (
    Path(os.environ["CHROME_PATH"])
    if os.environ.get("CHROME_PATH")
    else DEFAULT_MAC_CHROME if sys.platform == "darwin" and DEFAULT_MAC_CHROME.exists() else None
)
APP_DATA = Path(os.environ.get("MONITOR_DATA_DIR", Path(__file__).resolve().parent / "state"))
PROFILE_PATH = APP_DATA / "profile"
POLL_MIN_SECONDS = 10
LOGIN_TIMEOUT_SECONDS = 600
NOTICE_TIMEOUT_SECONDS = 600
DEFAULT_VENUES = [
    "本北高速室外网球场-网球",
    "国权路运动场-网球",
    "南区网球场-网球",
    "江湾综合体育馆-网球",
    "江湾室外体育场-网球",
]


class ManualIntervention(Exception):
    """The website needs a person to resolve a prompt or uncertain result."""


@dataclass(frozen=True)
class Target:
    venue: str
    date_text: str
    time_text: str

    @property
    def key(self) -> str:
        return "|".join((self.venue, self.date_text, self.time_text))

    @property
    def starts_at(self) -> datetime:
        return datetime.combine(
            date.fromisoformat(self.date_text),
            day_time.fromisoformat(self.time_text),
        )


@dataclass(frozen=True)
class Settings:
    venues: list[str]
    timezone: str
    normal_interval_seconds: int
    peak_start: day_time
    peak_end: day_time
    peak_interval_seconds: int


def load_settings(path: Path, allow_empty_venues: bool = False) -> Settings:
    if not path.is_file():
        raise ValueError(
            "找不到监控配置。先复制 booking_targets.example.json 为 booking_targets.json。"
        )

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("预约配置无法读取，请检查 JSON 格式。") from exc
    if not isinstance(config, dict):
        raise ValueError("预约配置的最外层必须是 JSON 对象。")

    raw_venues = config.get("venues", DEFAULT_VENUES)
    if not isinstance(raw_venues, list) or (not raw_venues and not allow_empty_venues):
        raise ValueError("venues 不能为空，至少保留一个网球场馆。")
    if any(not isinstance(venue, str) or not venue.strip() for venue in raw_venues):
        raise ValueError("venues 中的每个场馆名称都必须是非空字符串。")
    venues = [venue.strip() for venue in raw_venues]
    if len(set(venues)) != len(venues):
        raise ValueError("venues 中存在重复场馆。")

    schedule = config.get("schedule", {})
    if not isinstance(schedule, dict):
        raise ValueError("schedule 必须是 JSON 对象。")

    timezone_name = schedule.get("timezone", "Asia/Shanghai")
    if not isinstance(timezone_name, str) or not timezone_name.strip():
        raise ValueError("schedule.timezone 必须是有效的时区名称。")
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("无法识别监控时区：{}。".format(timezone_name)) from exc

    normal_interval = schedule.get("normal_interval_seconds", 1800)
    peak_interval = schedule.get("peak_interval_seconds", 10)
    if (
        not isinstance(normal_interval, int)
        or isinstance(normal_interval, bool)
        or normal_interval < 60
    ):
        raise ValueError("schedule.normal_interval_seconds 必须是不少于 60 秒的整数。")
    if (
        not isinstance(peak_interval, int)
        or isinstance(peak_interval, bool)
        or peak_interval < POLL_MIN_SECONDS
    ):
        raise ValueError(
            "schedule.peak_interval_seconds 必须是不少于 {} 秒的整数。".format(
                POLL_MIN_SECONDS
            )
        )

    try:
        peak_start = day_time.fromisoformat(schedule.get("peak_start", "06:55"))
        peak_end = day_time.fromisoformat(schedule.get("peak_end", "07:05"))
    except (TypeError, ValueError) as exc:
        raise ValueError("schedule.peak_start 和 peak_end 必须使用 HH:MM 格式。") from exc
    if peak_start >= peak_end:
        raise ValueError("当前配置要求高频监控开始时间早于结束时间。")

    return Settings(
        venues,
        timezone_name,
        normal_interval,
        peak_start,
        peak_end,
        peak_interval,
    )


def seconds_until_next_scan(settings: Settings) -> int:
    zone = ZoneInfo(settings.timezone)
    now = datetime.now(zone)
    peak_start = datetime.combine(now.date(), settings.peak_start, tzinfo=zone)
    peak_end = datetime.combine(now.date(), settings.peak_end, tzinfo=zone)

    if peak_start <= now < peak_end:
        return settings.peak_interval_seconds
    if now < peak_start:
        seconds_to_peak = max(1, math.ceil((peak_start - now).total_seconds()))
        return min(settings.normal_interval_seconds, seconds_to_peak)
    return settings.normal_interval_seconds


def normalize_status(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def visible_calendar(page: Page) -> tuple[list[str], list[dict[str, Any]]]:
    data = page.locator("dl").evaluate_all(
        "elements => elements.map((element, index) => {"
        "const children = Array.from(element.children);"
        "return {"
        "index,"
        "headers: children.filter(child => child.tagName === 'DT').map(child => child.innerText.trim()),"
        "cells: children.filter(child => child.tagName === 'DD').map(child => child.innerText.trim())"
        "};"
        "})"
    )

    time_column = next(
        (item for item in data if any("时段" in header for header in item["headers"])),
        None,
    )
    if time_column is None:
        raise ManualIntervention("无法识别网页的时段表格，已暂停以免选错场次。")

    times = time_column["cells"]
    days: list[dict[str, Any]] = []
    for item in data:
        heading = " ".join(item["headers"])
        match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", heading)
        if not match or not item["cells"]:
            continue
        days.append(
            {
                "date": match.group(1),
                "index": item["index"],
                "cells": [normalize_status(cell) for cell in item["cells"]],
            }
        )

    if not times or not days:
        raise ManualIntervention("网页日历结构与预期不符，已暂停以免误选。")
    if any(len(day["cells"]) != len(times) for day in days):
        raise ManualIntervention("网页日历的日期和时段数量不一致，已暂停以免误判空场。")
    return times, days


def manual_notice_visible(page: Page) -> bool:
    heading = page.get_by_role("heading", name=re.compile("阅读须知"))
    return heading.count() > 0 and heading.first.is_visible()


def login_pending(url: str) -> bool:
    parsed = urlsplit(url)
    return parsed.scheme == "https" and (
        parsed.netloc == UIS_HOST
        or (parsed.netloc == BOOKING_HOST and parsed.path.startswith("/reservation/api/login"))
    )


def wait_for_login(page: Page) -> None:
    if not login_pending(page.url):
        return
    print("请在打开的浏览器窗口中登录校园预约平台。")
    deadline = time.monotonic() + LOGIN_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not login_pending(page.url):
            destination = urlsplit(page.url)
            if destination.scheme != "https" or destination.netloc != BOOKING_HOST:
                raise ManualIntervention("认证流程未返回校园预约平台。")
            return
        page.wait_for_timeout(250)
    raise TimeoutError("等待登录超时。")


def wait_for_notice_confirmation(page: Page) -> None:
    if not manual_notice_visible(page):
        return
    print("请阅读浏览器中的预约须知，并由你本人点击确认。")
    deadline = time.monotonic() + NOTICE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not manual_notice_visible(page):
            return
        page.wait_for_timeout(1000)
    raise TimeoutError("等待预约须知确认超时。")


def wait_for_booking_content(
    page: Page,
    ready: Callable[[], bool],
    failure: str,
) -> None:
    deadline = time.monotonic() + 20
    tried_login = False
    while time.monotonic() < deadline:
        if login_pending(page.url):
            if tried_login:
                raise ManualIntervention("登录后再次跳回校园认证页，已停止本轮检查。")
            tried_login = True
            wait_for_login(page)
            deadline = time.monotonic() + 20
        elif ready():
            return
        page.wait_for_timeout(250)
    raise ManualIntervention(failure)


def find_reservation_link(page: Page, venue: str):
    venue_label = page.get_by_text(venue, exact=True).first
    wait_for_booking_content(page, venue_label.is_visible, f"场馆列表未显示：{venue}。")

    card = venue_label
    for _ in range(8):
        reservation_link = card.get_by_text("去预约", exact=True)
        if reservation_link.count() == 1:
            return reservation_link
        card = card.locator("xpath=..")
    raise ManualIntervention("无法在场馆卡片中唯一定位“去预约”：{}。".format(venue))


class SingleInstance:
    def __enter__(self) -> "SingleInstance":
        APP_DATA.mkdir(parents=True, exist_ok=True)
        self.file = (APP_DATA / "running.lock").open("a", encoding="utf-8")
        try:
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.file.close()
            raise ManualIntervention("已有一个脚本实例正在运行。") from exc
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback) -> None:
        fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        self.file.close()


class BookingFlow:
    def __init__(self, context: BrowserContext, page: Page) -> None:
        self.context = context
        self.page = page
        self.home_page = page

    def open_venue(self, venue: str) -> Page:
        if self.home_page.url != SPECIAL_URL and not login_pending(self.home_page.url):
            self.home_page.goto(SPECIAL_URL, wait_until="domcontentloaded", timeout=30000)

        reservation_link = find_reservation_link(self.home_page, venue)
        previous_url = self.home_page.url
        try:
            with self.context.expect_page(timeout=1500) as page_event:
                reservation_link.click(timeout=5000)
            venue_page = page_event.value
            venue_page.wait_for_load_state("domcontentloaded", timeout=15000)
        except PlaywrightTimeoutError:
            if self.home_page.url == previous_url:
                raise ManualIntervention("点击“去预约”后没有打开场馆页面。")
            venue_page = self.home_page

        date_heading = venue_page.locator("dl dt").filter(has_text=re.compile(r"\d{4}-\d{2}-\d{2}")).first
        calendar_ready = date_heading.is_visible
        failure = f"场馆详情页未显示预约周历：{venue}。"
        wait_for_booking_content(
            venue_page, lambda: manual_notice_visible(venue_page) or calendar_ready(), failure,
        )
        if manual_notice_visible(venue_page):
            wait_for_notice_confirmation(venue_page)
            wait_for_booking_content(venue_page, calendar_ready, failure)
        venue_url = urlsplit(venue_page.url)
        if (venue_url.scheme, venue_url.netloc, venue_url.path) != (
            "https", BOOKING_HOST, "/reservation/fe/site/reservationInfo",
        ):
            raise ManualIntervention("场馆周历未出现在校园预约详情页。")
        self.page = venue_page
        return venue_page

    def close_venue(self) -> None:
        if self.page is not self.home_page and not self.page.is_closed():
            self.page.close()
        elif self.home_page.url != SPECIAL_URL and not self.home_page.is_closed():
            self.home_page.goto(SPECIAL_URL, wait_until="domcontentloaded", timeout=30000)
        self.page = self.home_page

    def inspect(self, venue: str) -> None:
        page = self.open_venue(venue)
        try:
            times, days = visible_calendar(page)
            print("场馆：{}".format(venue))
            print("页面：{}".format(page.url))
            print("时段：{}".format("、".join(times)))
            for day in days:
                print("{}  {}".format(day["date"], " | ".join(day["cells"])))
        finally:
            self.close_venue()

def notify_desktop(targets: list[Target]) -> bool:
    details = "；".join(
        "{} {} {}".format(target.venue, target.date_text, target.time_text)
        for target in targets
    )
    print("发现可预约场次：{}".format(details), flush=True)
    title = "网球场有空场"
    preview = "；".join(
        "{} {} {}".format(target.venue, target.date_text, target.time_text)
        for target in targets[:4]
    )
    if len(targets) > 4:
        preview += "；另有 {} 场".format(len(targets) - 4)
    body = "请尽快打开预约页面查看：{}".format(preview)

    def applescript_string(value: str) -> str:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return '"{}"'.format(escaped.replace("\n", " "))

    script = "display notification {} with title {}".format(
        applescript_string(body),
        applescript_string(title),
    )
    try:
        subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        print("系统通知未送达，请留意终端窗口。原因：{}".format(exc), file=sys.stderr)
        print("\a", end="", flush=True)
        return False


def notify_targets(targets: list[Target]) -> bool:
    smtp_host = os.environ.get("SMTP_HOST", "").strip()
    if not smtp_host:
        return notify_desktop(targets)

    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "")
    sender = os.environ.get("SMTP_FROM", username).strip()
    recipient = os.environ.get("SMTP_TO", "").strip()
    if not all((username, password, sender, recipient)):
        print(
            "邮件提醒配置不完整；请设置 SMTP_USERNAME、SMTP_PASSWORD、SMTP_FROM 和 SMTP_TO。",
            file=sys.stderr,
        )
        return False

    details = "\n".join(
        "{} {} {}".format(target.venue, target.date_text, target.time_text)
        for target in targets
    )
    message = EmailMessage()
    message["Subject"] = "🎾 网球场有空场"
    message["From"] = sender
    message["To"] = recipient
    message.set_content("检测到新开放场次：\n\n{}\n\n请打开预约页面查看并由你本人完成预约。".format(details))

    try:
        context = ssl.create_default_context()
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=20) as server:
                server.login(username, password)
                server.send_message(message)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(username, password)
                server.send_message(message)
        print("提醒邮件已提交给 SMTP 服务。", flush=True)
        return True
    except (OSError, smtplib.SMTPException) as exc:
        print("邮件提醒失败：{}".format(exc), file=sys.stderr)
        return False


def start_page(context: BrowserContext) -> Page:
    pages = context.pages
    page = pages[0] if pages else context.new_page()
    page.goto(SPECIAL_URL, wait_until="domcontentloaded", timeout=30000)
    return page


def run_monitor(
    flow: BookingFlow,
    settings: Settings,
    mode: str,
) -> int:
    watch = mode == "watch"
    previous_availability: dict[str, bool] = {}

    while True:
        availability: dict[str, tuple[Target, bool]] = {}
        for venue in settings.venues:
            page = flow.open_venue(venue)
            try:
                times, days = visible_calendar(page)
                now = datetime.now(ZoneInfo(settings.timezone)).replace(tzinfo=None)
                for day in days:
                    for index, time_label in enumerate(times):
                        if index >= len(day["cells"]):
                            continue
                        time_text = time_label.split("-", 1)[0].strip()
                        try:
                            target = Target(venue, day["date"], time_text)
                        except ValueError:
                            continue
                        if target.starts_at <= now:
                            continue
                        available = day["cells"][index].startswith("可预约")
                        availability[target.key] = (target, available)
            finally:
                flow.close_venue()

        newly_available = [
            target
            for key, (target, available) in availability.items()
            if available and not previous_availability.get(key, False)
        ]
        open_count = sum(available for _target, available in availability.values())
        print(
            "扫描到 {} 个未来场次，其中可预约 {} 个；新增开放 {} 个。".format(
                len(availability), open_count, len(newly_available)
            ),
            flush=True,
        )

        notification_sent = True
        newly_available_keys = {target.key for target in newly_available}
        if newly_available:
            notification_sent = notify_targets(newly_available)

        if not watch:
            if not newly_available:
                print("本轮没有新增开放的场次。")
            return 0

        previous_availability = {
            key: (
                False
                if key in newly_available_keys and not notification_sent
                else available
            )
            for key, (_target, available) in availability.items()
        }
        sleep_seconds = seconds_until_next_scan(settings)
        if not newly_available:
            print("下一轮将在 {} 秒后开始。".format(sleep_seconds))
        time.sleep(sleep_seconds)


def main() -> int:
    parser = argparse.ArgumentParser(description="网球场空场监控与本机通知")
    parser.add_argument("--config", type=Path, default=Path("booking_targets.json"))
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--inspect", action="store_true", help="只检查场馆周历，不操作场次")
    action.add_argument("--once", action="store_true", help="只查询一轮，不操作场次")
    action.add_argument("--watch", action="store_true", help="持续监控并在出现空场时发送本机通知")
    parser.add_argument("--venue", help="--inspect 时指定场馆名称")
    args = parser.parse_args()

    try:
        settings = load_settings(args.config, allow_empty_venues=args.inspect)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    mode = "inspect" if args.inspect else "watch" if args.watch else "once"
    if mode != "inspect" and not settings.venues:
        print("venues 不能为空，至少保留一个网球场馆。", file=sys.stderr)
        return 2

    if CHROME_PATH is not None and not CHROME_PATH.exists():
        print("没有找到 Google Chrome：{}".format(CHROME_PATH), file=sys.stderr)
        return 2

    if mode == "inspect":
        venue = args.venue or (settings.venues[0] if settings.venues else "南区网球场-网球")
    else:
        venue = None

    APP_DATA.mkdir(parents=True, exist_ok=True)
    PROFILE_PATH.mkdir(parents=True, exist_ok=True)
    try:
        with SingleInstance(), sync_playwright() as playwright:
            browser_options = {
                "headless": False,
                "viewport": {"width": 1360, "height": 900},
            }
            if CHROME_PATH:
                browser_options["executable_path"] = str(CHROME_PATH)
            context = playwright.chromium.launch_persistent_context(str(PROFILE_PATH), **browser_options)
            try:
                page = start_page(context)
                flow = BookingFlow(context, page)
                if mode == "inspect":
                    flow.inspect(venue)
                    return 0
                return run_monitor(flow, settings, mode)
            finally:
                context.close()
    except (ManualIntervention, TimeoutError, PlaywrightError) as exc:
        print("暂停：{}".format(exc), file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("已停止监控。")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
