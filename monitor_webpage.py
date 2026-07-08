import argparse
import hashlib
import html
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from email_sender import load_config, send_change_email


# URL = "https://www.ur-net.go.jp/chintai/kanto/tokyo/20_4840.html"
URL = "https://www.ur-net.go.jp/chintai/kanto/saitama/50_1310.html"

INTERVAL_SECONDS = 600
ACTIVE_START_HOUR = 7
ACTIVE_END_HOUR = 22
HEARTBEAT_HOUR = 9
API_URL = "https://chintai.r6.ur-net.go.jp/chintai/api/bukken/detail/detail_bukken_room/"
STATE_FILE = Path(__file__).with_name("monitor_state.json")
LOCAL_TIMEZONE = timezone(timedelta(hours=9), "JST")
ROOM_STATE_KEYS = {
    "id",
    "name",
    "rent",
    "common_fee",
    "layout",
    "area",
    "floor",
    "floor_all",
    "detail_url",
}


def parse_ur_codes(url: str) -> tuple[str, str, str]:
    match = re.search(r"/(\d{2})_(\d+)(\d)\.html(?:\?|$)", url)
    if not match:
        raise ValueError("URL format is not recognized. Expected something like 20_4840.html.")

    shisya = match.group(1)
    danchi = match.group(2)
    shikibetu = match.group(3)
    return shisya, danchi, shikibetu


def post_json(url: str, data: dict[str, str]) -> list[dict] | None:
    encoded = urlencode(data).encode("utf-8")
    request = Request(
        url,
        data=encoded,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0 Safari/537.36"
            ),
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": "https://www.ur-net.go.jp",
            "Referer": URL,
        },
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        body = response.read().decode(charset, errors="replace")
        return json.loads(body)


def fetch_room_page(page_index: int) -> list[dict]:
    shisya, danchi, shikibetu = parse_ur_codes(URL)
    data = {
        "shisya": shisya,
        "danchi": danchi,
        "shikibetu": shikibetu,
        "orderByField": "0",
        "orderBySort": "0",
        "pageIndex": str(page_index),
        "sp": "",
    }
    return post_json(API_URL, data) or []


def clean_text(value) -> str:
    if value is None:
        return ""
    return html.unescape(str(value)).replace("\xa0", " ").strip()


def normalize_room(row: dict) -> dict[str, str]:
    detail_link = row.get("roomDetailLink") or ""
    if detail_link.startswith("/"):
        detail_link = "https://www.ur-net.go.jp" + detail_link

    return {
        "id": clean_text(row.get("id")),
        "name": clean_text(row.get("name")),
        "rent": clean_text(row.get("rent")),
        "common_fee": clean_text(row.get("commonfee")),
        "layout": clean_text(row.get("type")),
        "area": clean_text(row.get("floorspace")),
        "floor": clean_text(row.get("floor")),
        "floor_all": clean_text(row.get("floorAll")),
        "detail_url": detail_link,
    }


def fetch_rooms() -> list[dict[str, str]]:
    rooms: list[dict[str, str]] = []
    page_index = 0
    all_count = None

    while True:
        rows = fetch_room_page(page_index)
        if not rows:
            break

        rooms.extend(normalize_room(row) for row in rows)

        first = rows[0]
        all_count = int(first.get("allCount") or len(rooms))
        row_max = int(first.get("rowMax") or len(rows))

        if len(rooms) >= all_count or row_max <= 0:
            break
        page_index += 1

    rooms.sort(key=lambda room: room["id"])
    return rooms[:all_count] if all_count is not None else rooms


def room_key(room: dict[str, str]) -> tuple[str, str, str, str, str, str, str, str]:
    return (
        room["id"],
        room["name"],
        room["rent"],
        room["common_fee"],
        room["layout"],
        room["area"],
        room["floor"],
        room["floor_all"],
    )


def rooms_are_same(old_rooms: list[dict[str, str]], new_rooms: list[dict[str, str]]) -> bool:
    return [room_key(room) for room in old_rooms] == [room_key(room) for room in new_rooms]


def format_room(room: dict[str, str]) -> str:
    return (
        f"{room['name']} | {room['rent']}({room['common_fee']}) | "
        f"{room['layout']} | {room['area']} | {room['floor']}／{room['floor_all']}"
    )


def format_rooms(rooms: list[dict[str, str]]) -> str:
    if not rooms:
        return "No rooms found."
    return "\n".join(format_room(room) for room in rooms)


def get_added_rooms(old_rooms: list[dict[str, str]], new_rooms: list[dict[str, str]]) -> list[dict[str, str]]:
    old_by_id = {room["id"]: room for room in old_rooms}
    return [room for room in new_rooms if room["id"] not in old_by_id]


def build_added_message(added_rooms: list[dict[str, str]], current_rooms: list[dict[str, str]]) -> str:
    lines = [
        f"New rooms found at: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Target URL: {URL}",
        "",
        "Added rooms:",
    ]

    for room in added_rooms:
        lines.append(format_room(room))
        if room["detail_url"]:
            lines.append("  Detail: " + room["detail_url"])

    lines.extend(["", f"Open page: {URL}"])
    lines.extend(["", "Added rooms JSON:", json.dumps(added_rooms, ensure_ascii=False, indent=2)])
    lines.extend(["", "Current rooms:", format_rooms(current_rooms)])
    return "\n".join(lines)


def is_active_time(now: datetime) -> bool:
    return ACTIVE_START_HOUR <= now.hour < ACTIVE_END_HOUR


def should_send_heartbeat(now: datetime, last_heartbeat_date: date | None) -> bool:
    return now.hour == HEARTBEAT_HOUR and last_heartbeat_date != now.date()


def build_heartbeat_message(now: datetime, previous_rooms: list[dict[str, str]] | None) -> str:
    if previous_rooms is None:
        room_status = "Monitoring baseline has not been created yet."
    else:
        room_status = f"Current baseline rooms: {len(previous_rooms)}"

    return "\n".join(
        [
            f"Heartbeat at: {now.strftime('%Y-%m-%d %H:%M:%S')}",
            "UR monitor is running.",
            f"Target URL: {URL}",
            f"Active check window: {ACTIVE_START_HOUR}:00 - {ACTIVE_END_HOUR}:00",
            room_status,
        ]
    )


def room_state_hash(rooms: list[dict[str, str]]) -> str:
    state_data = [room_key(room) for room in rooms]
    encoded = json.dumps(state_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def now_local() -> datetime:
    return datetime.now(LOCAL_TIMEZONE)


def read_state() -> dict:
    if not STATE_FILE.exists():
        return {}

    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"State file could not be read. A new baseline will be created: {error}")
        return {}

    return state if isinstance(state, dict) else {}


def load_previous_rooms() -> list[dict[str, str]] | None:
    if not STATE_FILE.exists():
        print(f"No state file found. A new baseline will be created: {STATE_FILE}")
        return None

    state = read_state()
    rooms = state.get("rooms")
    if not isinstance(rooms, list):
        print("State file has no rooms list. A new baseline will be created.")
        return None

    if any(not isinstance(room, dict) or not ROOM_STATE_KEYS.issubset(room) for room in rooms):
        print("State file uses an old or unknown format. A new baseline will be created.")
        return None

    print(f"Loaded previous baseline: {len(rooms)} rooms")
    return rooms


def load_last_heartbeat_date() -> date | None:
    value = read_state().get("last_heartbeat_date")
    if not isinstance(value, str) or not value:
        return None

    try:
        return date.fromisoformat(value)
    except ValueError:
        print("State file has an invalid last_heartbeat_date. Heartbeat may be sent again.")
        return None


def save_rooms_state(rooms: list[dict[str, str]], last_heartbeat_date: date | None = None) -> None:
    state = {
        "rooms": rooms,
        "hash": room_state_hash(rooms),
        "checked_at": now_local().strftime("%Y-%m-%d %H:%M:%S"),
        "target_url": URL,
    }
    if last_heartbeat_date is not None:
        state["last_heartbeat_date"] = last_heartbeat_date.isoformat()

    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved state: {len(rooms)} rooms -> {STATE_FILE}")


def send_heartbeat(now: datetime, previous_rooms: list[dict[str, str]] | None) -> None:
    message = build_heartbeat_message(now, previous_rooms)
    config = load_config()
    send_change_email(message, subject="UR monitor heartbeat", mail_to=config["mail_to_heartbeat"])


def check_once(previous_rooms: list[dict[str, str]] | None) -> list[dict[str, str]]:
    current_rooms = fetch_rooms()

    if previous_rooms is None:
        print("First check. Monitoring baseline created:")
        print(format_rooms(current_rooms))
        return current_rooms

    if rooms_are_same(previous_rooms, current_rooms):
        print(time.strftime("%Y-%m-%d %H:%M:%S"), f"No change. Rooms: {len(current_rooms)}")
        return previous_rooms

    added_rooms = get_added_rooms(previous_rooms, current_rooms)
    if added_rooms:
        message = build_added_message(added_rooms, current_rooms)
        print("New rooms found!")
        print(message)

        try:
            config = load_config()
            send_change_email(message, subject="UR new rooms found", mail_to=config["mail_to_alert"])
            print("Email sent.")
        except Exception as error:
            print("Email failed:", error)
    else:
        print(
            time.strftime("%Y-%m-%d %H:%M:%S"),
            "Changed, but no new rooms. Email skipped.",
        )

    return current_rooms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="check once and exit")
    parser.add_argument(
        "--force-alert",
        action="store_true",
        help="treat all current rooms as new; intended for manual email tests",
    )
    args = parser.parse_args()

    if args.once:
        now = now_local()
        previous_rooms = load_previous_rooms()
        if args.force_alert:
            print("Force alert enabled. Current rooms will be treated as newly added.")
            previous_rooms = []

        current_rooms = check_once(previous_rooms)
        last_heartbeat_date = load_last_heartbeat_date()
        if should_send_heartbeat(now, last_heartbeat_date):
            try:
                send_heartbeat(now, current_rooms)
                last_heartbeat_date = now.date()
                print(now.strftime("%Y-%m-%d %H:%M:%S"), "Heartbeat email sent.")
            except Exception as error:
                print(now.strftime("%Y-%m-%d %H:%M:%S"), "Heartbeat email failed:", error)

        save_rooms_state(current_rooms, last_heartbeat_date)
        return

    previous_rooms = None
    last_heartbeat_date = None
    while True:
        now = now_local()
        try:
            if should_send_heartbeat(now, last_heartbeat_date):
                try:
                    send_heartbeat(now, previous_rooms)
                    last_heartbeat_date = now.date()
                    print(now.strftime("%Y-%m-%d %H:%M:%S"), "Heartbeat email sent.")
                except Exception as error:
                    print(now.strftime("%Y-%m-%d %H:%M:%S"), "Heartbeat email failed:", error)

            if is_active_time(now):
                previous_rooms = check_once(previous_rooms)
                save_rooms_state(previous_rooms, last_heartbeat_date)
            else:
                print(
                    now.strftime("%Y-%m-%d %H:%M:%S"),
                    f"Inactive window. Room check skipped until {ACTIVE_START_HOUR}:00.",
                )
        except Exception as error:
            print(time.strftime("%Y-%m-%d %H:%M:%S"), "Check failed:", error)

        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
