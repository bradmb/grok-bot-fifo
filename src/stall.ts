export type StallConfig = {
  timeZone: string;
  startHour: number;
  endHour: number;
  businessMinutes: number;
};

export const DEFAULT_STALL: StallConfig = {
  timeZone: "America/Denver",
  startHour: 8,
  endHour: 17,
  businessMinutes: 60,
};

export function stallConfigFromEnv(env: {
  STALL_TZ?: string;
  STALL_START_HOUR?: string;
  STALL_END_HOUR?: string;
  STALL_BUSINESS_MINUTES?: string;
}): StallConfig {
  return {
    timeZone: env.STALL_TZ || DEFAULT_STALL.timeZone,
    startHour: Number(env.STALL_START_HOUR || DEFAULT_STALL.startHour),
    endHour: Number(env.STALL_END_HOUR || DEFAULT_STALL.endHour),
    businessMinutes: Number(env.STALL_BUSINESS_MINUTES || DEFAULT_STALL.businessMinutes),
  };
}

export type ZonedWall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedWall(date: Date, timeZone: string): ZonedWall {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  let hour = Number(map.hour);
  if (hour === 24) {
    hour = 0;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function utcFromZoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const wall = zonedWall(new Date(guess), timeZone);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = target - asUtc;
    if (delta === 0) {
      break;
    }
    guess += delta;
  }
  return new Date(guess);
}

function addCalendarDays(year: number, month: number, day: number, days: number): {
  year: number;
  month: number;
  day: number;
} {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/**
 * Add N business minutes in [startHour, endHour) America/Denver (or configured TZ).
 * All calendar days count; holidays ignored for v1. No lunch gap.
 */
export function addBusinessMinutes(fromIso: string, minutes: number, cfg: StallConfig = DEFAULT_STALL): string {
  let remaining = minutes;
  const start = utcFromZoned(
    ...wallTuple(zonedWall(new Date(fromIso), cfg.timeZone)),
    cfg.timeZone,
  );
  let wall = zonedWall(start, cfg.timeZone);
  const windowStart = cfg.startHour * 60;
  const windowEnd = cfg.endHour * 60;

  while (remaining > 0) {
    const minutesOfDay = wall.hour * 60 + wall.minute;
    if (minutesOfDay >= windowEnd) {
      const next = addCalendarDays(wall.year, wall.month, wall.day, 1);
      wall = { ...next, hour: cfg.startHour, minute: 0, second: 0 };
      continue;
    }
    if (minutesOfDay < windowStart) {
      wall = { ...wall, hour: cfg.startHour, minute: 0, second: 0 };
      continue;
    }
    const available = windowEnd - minutesOfDay;
    if (remaining <= available) {
      const total = minutesOfDay + remaining;
      wall = {
        ...wall,
        hour: Math.floor(total / 60),
        minute: total % 60,
        second: 0,
      };
      remaining = 0;
      break;
    }
    remaining -= available;
    const next = addCalendarDays(wall.year, wall.month, wall.day, 1);
    wall = { ...next, hour: cfg.startHour, minute: 0, second: 0 };
  }

  return utcFromZoned(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second, cfg.timeZone).toISOString();
}

function wallTuple(wall: ZonedWall): [number, number, number, number, number, number] {
  return [wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second];
}

export function nextStallAt(fromIso: string, cfg: StallConfig = DEFAULT_STALL): string {
  return addBusinessMinutes(fromIso, cfg.businessMinutes, cfg);
}
