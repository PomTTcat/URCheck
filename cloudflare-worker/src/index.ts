type Env = {
  UR_STATE: KVNamespace;
  TARGET_URL: string;
  ACTIVE_START_HOUR?: string;
  ACTIVE_END_HOUR?: string;
  HEARTBEAT_HOUR?: string;
  STATE_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  MANUAL_RUN_TOKEN?: string;
};

type RawRoom = Record<string, unknown>;

type Room = {
  id: string;
  name: string;
  rent: string;
  common_fee: string;
  layout: string;
  area: string;
  floor: string;
  floor_all: string;
  detail_url: string;
};

type MonitorState = {
  rooms: Room[];
  hash: string;
  checked_at: string;
  target_url: string;
  last_heartbeat_date?: string;
};

type MonitorResult = {
  status: "baseline_created" | "no_change" | "changed" | "skipped" | "error";
  rooms: number;
  added: number;
  heartbeatSent: boolean;
  message: string;
};

const API_URL = "https://chintai.r6.ur-net.go.jp/chintai/api/bukken/detail/detail_bukken_room/";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ROOM_STATE_KEYS: Array<keyof Room> = [
  "id",
  "name",
  "rent",
  "common_fee",
  "layout",
  "area",
  "floor",
  "floor_all",
  "detail_url",
];

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runMonitorWithErrorReport(env, {
        forceAlert: false,
        source: `cron:${controller.cron}`,
      }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "urcheck-monitor",
        endpoints: [
          "/run?token=...",
          "/run?force_alert=true&token=...",
          "/run?force_heartbeat=true&token=...",
        ],
      });
    }

    if (url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }

    const authError = requireManualToken(request, url, env);
    if (authError) {
      return authError;
    }

    const forceAlert = url.searchParams.get("force_alert") === "true";
    const forceHeartbeat = url.searchParams.get("force_heartbeat") === "true";
    const result = await runMonitorWithErrorReport(env, {
      forceAlert,
      forceHeartbeat,
      source: forceAlert ? "manual:force_alert" : forceHeartbeat ? "manual:force_heartbeat" : "manual",
    });
    return jsonResponse(result);
  },
};

async function runMonitorWithErrorReport(
  env: Env,
  options: { forceAlert: boolean; forceHeartbeat?: boolean; source: string },
): Promise<MonitorResult> {
  try {
    return await runMonitor(env, options);
  } catch (error) {
    const now = getJstParts();
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("Monitor failed:", message);

    try {
      await sendTelegramMessage(
        env,
        [
          "[UR monitor diagnostic error]",
          "",
          `Source: ${options.source}`,
          `Time: ${now.timestamp}`,
          `Error: ${message}`,
        ].join("\n"),
      );
    } catch (telegramError) {
      console.error("Telegram error report failed:", telegramError);
    }

    return {
      status: "error",
      rooms: 0,
      added: 0,
      heartbeatSent: false,
      message: `${options.source} failed at ${now.timestamp}: ${message}`,
    };
  }
}

async function runMonitor(
  env: Env,
  options: { forceAlert: boolean; forceHeartbeat?: boolean; source: string },
): Promise<MonitorResult> {
  const now = getJstParts();
  const state = await loadState(env);
  const previousRooms = options.forceAlert ? [] : state?.rooms ?? null;

  if (!isActiveHour(env, now.hour) && !options.forceAlert && !options.forceHeartbeat) {
    const message = `Inactive window at ${now.timestamp}. Room check skipped.`;
    console.log(message);
    return {
      status: "skipped",
      rooms: previousRooms?.length ?? 0,
      added: 0,
      heartbeatSent: false,
      message,
    };
  }

  const currentRooms = await fetchRooms(env);
  let status: MonitorResult["status"] = "no_change";
  let addedRooms: Room[] = [];

  if (previousRooms === null) {
    status = "baseline_created";
    console.log(`First check. Monitoring baseline created with ${currentRooms.length} rooms.`);
  } else if (options.forceAlert) {
    status = "changed";
    addedRooms = currentRooms;
    console.log("Force alert enabled. Current rooms will be treated as newly added.");
  } else if (!roomsAreSame(previousRooms, currentRooms)) {
    status = "changed";
    addedRooms = getAddedRooms(previousRooms, currentRooms);
  }

  if (addedRooms.length > 0) {
    const message = buildAddedMessage(env, now.timestamp, addedRooms, currentRooms);
    await sendTelegramMessage(
      env,
      `${options.forceAlert ? "[UR monitor test alert]" : "[UR new rooms found]"}\n\n${message}`,
    );
    console.log(`Telegram alert sent. Added rooms: ${addedRooms.length}`);
  } else if (status === "changed") {
    console.log("Room list changed, but no new rooms. Telegram alert skipped.");
  } else {
    console.log(`No new alert. Status: ${status}. Rooms: ${currentRooms.length}`);
  }

  let lastHeartbeatDate = state?.last_heartbeat_date;
  let heartbeatSent = false;
  if (options.forceHeartbeat || shouldSendHeartbeat(env, now.hour, now.dateKey, lastHeartbeatDate)) {
    const message = buildHeartbeatMessage(env, now.timestamp, currentRooms);
    await sendTelegramMessage(env, `[UR monitor heartbeat]\n\n${message}`);
    if (!options.forceHeartbeat) {
      lastHeartbeatDate = now.dateKey;
    }
    heartbeatSent = true;
    console.log("Heartbeat flag recorded.");
  }

  await saveState(env, {
    rooms: currentRooms,
    hash: await roomStateHash(currentRooms),
    checked_at: now.timestamp,
    target_url: env.TARGET_URL,
    ...(lastHeartbeatDate ? { last_heartbeat_date: lastHeartbeatDate } : {}),
  });

  return {
    status,
    rooms: currentRooms.length,
    added: addedRooms.length,
    heartbeatSent,
    message: `${options.source} completed at ${now.timestamp}`,
  };
}

function parseUrCodes(url: string): { shisya: string; danchi: string; shikibetu: string } {
  const match = /\/(\d{2})_(\d+)(\d)\.html(?:\?|$)/.exec(url);
  if (!match) {
    throw new Error("TARGET_URL format is not recognized. Expected something like 20_4840.html.");
  }

  return {
    shisya: match[1],
    danchi: match[2],
    shikibetu: match[3],
  };
}

async function fetchRooms(env: Env): Promise<Room[]> {
  const rooms: Room[] = [];
  let pageIndex = 0;
  let allCount: number | null = null;

  while (true) {
    const rows = await fetchRoomPage(env, pageIndex);
    if (rows.length === 0) {
      break;
    }

    rooms.push(...rows.map(normalizeRoom));

    const first = rows[0];
    allCount = Number(first.allCount ?? rooms.length);
    const rowMax = Number(first.rowMax ?? rows.length);

    if (rooms.length >= allCount || rowMax <= 0) {
      break;
    }
    pageIndex += 1;
  }

  rooms.sort((a, b) => a.id.localeCompare(b.id));
  return allCount === null ? rooms : rooms.slice(0, allCount);
}

async function fetchRoomPage(env: Env, pageIndex: number): Promise<RawRoom[]> {
  const codes = parseUrCodes(env.TARGET_URL);
  const body = new URLSearchParams({
    shisya: codes.shisya,
    danchi: codes.danchi,
    shikibetu: codes.shikibetu,
    orderByField: "0",
    orderBySort: "0",
    pageIndex: String(pageIndex),
    sp: "",
  });

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: "https://www.ur-net.go.jp",
      Referer: env.TARGET_URL,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`UR API request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json<unknown>();
  if (data === null) {
    return [];
  }
  if (!Array.isArray(data)) {
    throw new Error("UR API response was not a list.");
  }
  return data.filter((row): row is RawRoom => row !== null && typeof row === "object");
}

function normalizeRoom(row: RawRoom): Room {
  let detailUrl = cleanText(row.roomDetailLink);
  if (detailUrl.startsWith("/")) {
    detailUrl = "https://www.ur-net.go.jp" + detailUrl;
  }

  return {
    id: cleanText(row.id),
    name: cleanText(row.name),
    rent: cleanText(row.rent),
    common_fee: cleanText(row.commonfee),
    layout: cleanText(row.type),
    area: cleanText(row.floorspace),
    floor: cleanText(row.floor),
    floor_all: cleanText(row.floorAll),
    detail_url: detailUrl,
  };
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return decodeHtml(String(value)).replace(/\u00a0/g, " ").trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return named[body] ?? entity;
  });
}

function roomKey(room: Room): string[] {
  return [
    room.id,
    room.name,
    room.rent,
    room.common_fee,
    room.layout,
    room.area,
    room.floor,
    room.floor_all,
  ];
}

function roomsAreSame(oldRooms: Room[], newRooms: Room[]): boolean {
  return JSON.stringify(oldRooms.map(roomKey)) === JSON.stringify(newRooms.map(roomKey));
}

function getAddedRooms(oldRooms: Room[], newRooms: Room[]): Room[] {
  const oldIds = new Set(oldRooms.map((room) => room.id));
  return newRooms.filter((room) => !oldIds.has(room.id));
}

function formatRoom(room: Room): string {
  return `${room.name} | ${room.rent}(${room.common_fee}) | ${room.layout} | ${room.area} | ${room.floor}/${room.floor_all}`;
}

function formatRooms(rooms: Room[]): string {
  return rooms.length === 0 ? "No rooms found." : rooms.map(formatRoom).join("\n");
}

function buildAddedMessage(env: Env, timestamp: string, addedRooms: Room[], currentRooms: Room[]): string {
  const lines = [
    `New rooms found at: ${timestamp}`,
    `Target URL: ${env.TARGET_URL}`,
    "",
    "Added rooms:",
  ];

  for (const room of addedRooms) {
    lines.push(formatRoom(room));
    if (room.detail_url) {
      lines.push("  Detail: " + room.detail_url);
    }
  }

  lines.push("", `Open page: ${env.TARGET_URL}`);
  lines.push("", "Added rooms JSON:", JSON.stringify(addedRooms, null, 2));
  lines.push("", "Current rooms:", formatRooms(currentRooms));
  return lines.join("\n");
}

function buildHeartbeatMessage(env: Env, timestamp: string, currentRooms: Room[]): string {
  return [
    `Heartbeat at: ${timestamp}`,
    "UR monitor is running.",
    `Target URL: ${env.TARGET_URL}`,
    `Active check window: ${activeStartHour(env)}:00 - ${activeEndHour(env)}:00 JST`,
    `Current baseline rooms: ${currentRooms.length}`,
  ].join("\n");
}

async function loadState(env: Env): Promise<MonitorState | null> {
  const state = await env.UR_STATE.get(stateKey(env), "json");
  if (!isMonitorState(state)) {
    return null;
  }
  return state;
}

async function saveState(env: Env, state: MonitorState): Promise<void> {
  await env.UR_STATE.put(stateKey(env), JSON.stringify(state, null, 2));
}

function isMonitorState(value: unknown): value is MonitorState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<MonitorState>;
  return Array.isArray(state.rooms) && state.rooms.every(isRoom);
}

function isRoom(value: unknown): value is Room {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const room = value as Partial<Room>;
  return ROOM_STATE_KEYS.every((key) => typeof room[key] === "string");
}

async function roomStateHash(rooms: Room[]): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(rooms.map(roomKey)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }
  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: truncateTelegramText(text),
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

function truncateTelegramText(text: string): string {
  const maxLength = 3900;
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 80) + "\n\n[Message truncated. Open the UR page for full details.]";
}

function getJstParts(): { dateKey: string; hour: number; timestamp: string } {
  const shifted = new Date(Date.now() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = shifted.getUTCHours();
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  const hourText = String(hour).padStart(2, "0");
  const dateKey = `${year}-${month}-${day}`;
  return {
    dateKey,
    hour,
    timestamp: `${dateKey} ${hourText}:${minute}:${second} JST`,
  };
}

function shouldSendHeartbeat(env: Env, hour: number, dateKey: string, lastHeartbeatDate?: string): boolean {
  return hour === heartbeatHour(env) && lastHeartbeatDate !== dateKey;
}

function isActiveHour(env: Env, hour: number): boolean {
  return activeStartHour(env) <= hour && hour < activeEndHour(env);
}

function activeStartHour(env: Env): number {
  return readHour(env.ACTIVE_START_HOUR, 7);
}

function activeEndHour(env: Env): number {
  return readHour(env.ACTIVE_END_HOUR, 22);
}

function heartbeatHour(env: Env): number {
  return readHour(env.HEARTBEAT_HOUR, 9);
}

function readHour(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    return fallback;
  }
  return parsed;
}

function stateKey(env: Env): string {
  return env.STATE_KEY || "monitor_state";
}

function requireManualToken(request: Request, url: URL, env: Env): Response | null {
  if (!env.MANUAL_RUN_TOKEN) {
    return new Response("MANUAL_RUN_TOKEN is not configured.", { status: 500 });
  }

  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const token = url.searchParams.get("token") || bearer;
  if (token !== env.MANUAL_RUN_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}
