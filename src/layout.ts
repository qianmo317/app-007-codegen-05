import type {
  LayoutIssue,
  LayoutRound,
  LayoutSettings,
  LayoutTable,
  Pillar,
  Venue,
  VenueLayout,
} from './types';
import { generateId } from './utils';

export const DEFAULT_SETTINGS: LayoutSettings = {
  tableGap: 1.2, // 桌与桌之间至少留 1.2m，椅子拉开后人才走得过去
  mainAisleWidth: 2.4, // 主通道要走得开新人与礼服
  wallGap: 1.0,
  pillarGap: 0.8,
  doorClearance: 2.0,
};

export const GUEST_TABLE_DIAMETER = 1.8; // 10 人圆桌
export const HEAD_TABLE_DIAMETER = 2.2;
export const RECEPTION_TABLE_DIAMETER = 1.2;

const MARGIN = 0.1; // 建议挪动时多留的余量

export function createDefaultVenue(): Venue {
  return { width: 24, length: 14, doorSide: 'bottom', doorOffset: 12, doorWidth: 2.4, pillars: [] };
}

export function createDefaultLayout(): VenueLayout {
  return {
    venue: createDefaultVenue(),
    settings: { ...DEFAULT_SETTINGS },
    tables: [],
    rounds: [],
    currentRound: 1,
  };
}

// ---------- 基础几何 ----------

type Rect = { x: number; y: number; w: number; h: number };

export function clamp(v: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, v));
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function fmt(v: number): string {
  return v.toFixed(1);
}

export function pillarRect(p: Pillar): Rect {
  return { x: p.x - p.size / 2, y: p.y - p.size / 2, w: p.size, h: p.size };
}

/** 圆边到矩形边的净距，负数表示重叠 */
export function circleRectGap(cx: number, cy: number, r: number, rect: Rect): number {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const d = Math.hypot(cx - nx, cy - ny);
  if (d > 1e-9) return d - r;
  const dEdge = Math.min(cx - rect.x, rect.x + rect.w - cx, cy - rect.y, rect.y + rect.h - cy);
  return -dEdge - r;
}

export function doorCenter(venue: Venue): { x: number; y: number } {
  switch (venue.doorSide) {
    case 'top':
      return { x: venue.doorOffset, y: 0 };
    case 'bottom':
      return { x: venue.doorOffset, y: venue.length };
    case 'left':
      return { x: 0, y: venue.doorOffset };
    case 'right':
      return { x: venue.width, y: venue.doorOffset };
  }
}

/** 主通道：从门口直通主桌的带状区域 */
export function aisleRect(venue: Venue, settings: LayoutSettings): Rect {
  const dc = doorCenter(venue);
  const w = settings.mainAisleWidth;
  if (venue.doorSide === 'top' || venue.doorSide === 'bottom') {
    return { x: dc.x - w / 2, y: 0, w, h: venue.length };
  }
  return { x: 0, y: dc.y - w / 2, w: venue.width, h: w };
}

/** 门前留空区 */
export function doorZoneRect(venue: Venue, settings: LayoutSettings): Rect {
  const dc = doorCenter(venue);
  const depth = settings.doorClearance;
  const halfW = venue.doorWidth / 2 + 0.5;
  switch (venue.doorSide) {
    case 'top':
      return { x: dc.x - halfW, y: 0, w: halfW * 2, h: depth };
    case 'bottom':
      return { x: dc.x - halfW, y: venue.length - depth, w: halfW * 2, h: depth };
    case 'left':
      return { x: 0, y: dc.y - halfW, w: depth, h: halfW * 2 };
    case 'right':
      return { x: venue.width - depth, y: dc.y - halfW, w: depth, h: halfW * 2 };
  }
}

/** 把圆推出矩形的最短位移（含余量） */
function pushOutOfRect(cx: number, cy: number, r: number, rect: Rect, margin: number): { dx: number; dy: number } {
  const cands = [
    { dx: rect.x - r - margin - cx, dy: 0 },
    { dx: rect.x + rect.w + r + margin - cx, dy: 0 },
    { dx: 0, dy: rect.y - r - margin - cy },
    { dx: 0, dy: rect.y + rect.h + r + margin - cy },
  ];
  cands.sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  return cands[0];
}

// ---------- 自动摆桌 ----------

function positionReception(venue: Venue, settings: LayoutSettings, rr: number): { x: number; y: number } {
  const dc = doorCenter(venue);
  const off = venue.doorWidth / 2 + 0.6 + rr;
  const cands: { x: number; y: number }[] = [];
  if (venue.doorSide === 'bottom' || venue.doorSide === 'top') {
    const y =
      venue.doorSide === 'bottom'
        ? venue.length - settings.doorClearance - rr - 0.1
        : settings.doorClearance + rr + 0.1;
    cands.push({ x: dc.x - off, y }, { x: dc.x + off, y });
  } else {
    const x =
      venue.doorSide === 'right'
        ? venue.width - settings.doorClearance - rr - 0.1
        : settings.doorClearance + rr + 0.1;
    cands.push({ x, y: dc.y - off }, { x, y: dc.y + off });
  }
  const zone = doorZoneRect(venue, settings);
  const score = (c: { x: number; y: number }): number => {
    let s = 0;
    if (c.x - rr < settings.wallGap || c.x + rr > venue.width - settings.wallGap) s += 100;
    if (c.y - rr < settings.wallGap || c.y + rr > venue.length - settings.wallGap) s += 100;
    if (circleRectGap(c.x, c.y, rr, zone) < 0) s += 100;
    for (const p of venue.pillars) {
      s += Math.max(0, settings.pillarGap - circleRectGap(c.x, c.y, rr, pillarRect(p))) * 50;
    }
    return s;
  };
  cands.sort((a, b) => score(a) - score(b));
  const best = cands[0];
  return {
    x: round2(clamp(best.x, settings.wallGap + rr, venue.width - settings.wallGap - rr)),
    y: round2(clamp(best.y, settings.wallGap + rr, venue.length - settings.wallGap - rr)),
  };
}

/**
 * 按场地长宽、柱子、门的位置自动排桌：
 * 主桌在门正对面、主通道轴线上；接待桌在门边不挡门的位置；
 * 客桌按网格填充，自动让开主通道、门前留空区、柱子和墙。
 */
export function autoLayoutTables(
  venue: Venue,
  settings: LayoutSettings,
  guestCount: number,
  labels: string[],
): { tables: LayoutTable[]; unplaced: number } {
  const tables: LayoutTable[] = [];
  const aisle = aisleRect(venue, settings);
  const doorZone = doorZoneRect(venue, settings);
  const dc = doorCenter(venue);

  // 主桌：门正对面、通道轴线上
  const hd = HEAD_TABLE_DIAMETER;
  const hr = hd / 2;
  let hx = dc.x;
  let hy = dc.y;
  if (venue.doorSide === 'bottom') hy = settings.wallGap + hr;
  if (venue.doorSide === 'top') hy = venue.length - settings.wallGap - hr;
  if (venue.doorSide === 'left') hx = venue.width - settings.wallGap - hr;
  if (venue.doorSide === 'right') hx = settings.wallGap + hr;
  if (venue.doorSide === 'top' || venue.doorSide === 'bottom') {
    hx = clamp(dc.x, settings.wallGap + hr, venue.width - settings.wallGap - hr);
  } else {
    hy = clamp(dc.y, settings.wallGap + hr, venue.length - settings.wallGap - hr);
  }
  const head: LayoutTable = { id: generateId(), label: '主桌', x: round2(hx), y: round2(hy), diameter: hd, kind: 'head' };
  tables.push(head);

  // 接待桌：门边一侧
  const rd = RECEPTION_TABLE_DIAMETER;
  const rr = rd / 2;
  const recep = positionReception(venue, settings, rr);
  tables.push({ id: generateId(), label: '接待桌', x: recep.x, y: recep.y, diameter: rd, kind: 'reception' } as LayoutTable);

  // 客桌：网格填充，离主桌近的优先
  const d = GUEST_TABLE_DIAMETER;
  const r = d / 2;
  const step = d + settings.tableGap;
  const candidates: { x: number; y: number }[] = [];
  for (let y = settings.wallGap + r; y <= venue.length - settings.wallGap - r + 1e-6; y += step) {
    for (let x = settings.wallGap + r; x <= venue.width - settings.wallGap - r + 1e-6; x += step) {
      if (circleRectGap(x, y, r, aisle) < 0) continue;
      if (circleRectGap(x, y, r, doorZone) < 0) continue;
      if (venue.pillars.some((p) => circleRectGap(x, y, r, pillarRect(p)) < settings.pillarGap)) continue;
      if (tables.some((t) => Math.hypot(t.x - x, t.y - y) - t.diameter / 2 - r < settings.tableGap)) continue;
      candidates.push({ x, y });
    }
  }
  candidates.sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));

  let unplaced = 0;
  for (let i = 0; i < guestCount; i++) {
    const c = candidates[i];
    if (!c) {
      unplaced = guestCount - i;
      break;
    }
    tables.push({
      id: generateId(),
      label: labels[i] ?? `${i + 1}号桌`,
      x: round2(c.x),
      y: round2(c.y),
      diameter: d,
      kind: 'guest',
    });
  }
  return { tables, unplaced };
}

// ---------- 问题检测 ----------

export function detectIssues(layout: VenueLayout): LayoutIssue[] {
  const { venue, settings, tables } = layout;
  const issues: LayoutIssue[] = [];
  const aisle = aisleRect(venue, settings);
  const doorZone = doorZoneRect(venue, settings);

  // 两桌靠得太近
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.diameter / 2 - b.diameter / 2;
      if (gap < settings.tableGap - 1e-9) {
        const actual = Math.max(0, gap);
        issues.push({
          id: `table-gap:${a.id}:${b.id}`,
          kind: 'table-gap',
          tableIds: [a.id, b.id],
          actual: round2(actual),
          required: settings.tableGap,
          message: `「${a.label}」与「${b.label}」桌边净距仅 ${fmt(actual)}m，应 ≥ ${fmt(settings.tableGap)}m，还需再分开 ${fmt(settings.tableGap - actual)}m`,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
        });
      }
    }
  }

  for (const t of tables) {
    const r = t.diameter / 2;

    // 超出场地
    const out = Math.max(r - t.x, t.x + r - venue.width, r - t.y, t.y + r - venue.length, 0);
    if (out > 1e-9) {
      issues.push({
        id: `out:${t.id}`,
        kind: 'out-of-bounds',
        tableIds: [t.id],
        actual: round2(out),
        required: 0,
        message: `「${t.label}」超出场地边界 ${fmt(out)}m，需往场内挪`,
        x: t.x,
        y: t.y,
      });
      continue;
    }

    // 离墙太近
    const wallDist = Math.min(t.x - r, venue.width - (t.x + r), t.y - r, venue.length - (t.y + r));
    if (wallDist < settings.wallGap - 1e-9) {
      const actual = Math.max(0, wallDist);
      issues.push({
        id: `wall:${t.id}`,
        kind: 'wall-gap',
        tableIds: [t.id],
        actual: round2(actual),
        required: settings.wallGap,
        message: `「${t.label}」桌边离墙 ${fmt(actual)}m，应 ≥ ${fmt(settings.wallGap)}m，还需往场内挪 ${fmt(settings.wallGap - actual)}m`,
        x: t.x,
        y: t.y,
      });
    }

    // 离柱太近
    venue.pillars.forEach((p, idx) => {
      const gap = circleRectGap(t.x, t.y, r, pillarRect(p));
      if (gap < settings.pillarGap - 1e-9) {
        const actual = Math.max(0, gap);
        issues.push({
          id: `pillar:${t.id}:${p.id}`,
          kind: 'pillar-gap',
          tableIds: [t.id],
          actual: round2(actual),
          required: settings.pillarGap,
          message: `「${t.label}」桌边离 ${idx + 1} 号柱 ${fmt(actual)}m，应 ≥ ${fmt(settings.pillarGap)}m，还需挪开 ${fmt(settings.pillarGap - actual)}m`,
          x: (t.x + p.x) / 2,
          y: (t.y + p.y) / 2,
        });
      }
    });

    // 压住主通道（主桌在通道尽头属正常，不参与检测）
    if (t.kind !== 'head') {
      const gap = circleRectGap(t.x, t.y, r, aisle);
      if (gap < 0) {
        const remain = Math.max(0, settings.mainAisleWidth + gap);
        issues.push({
          id: `aisle:${t.id}`,
          kind: 'main-aisle',
          tableIds: [t.id],
          actual: round2(remain),
          required: settings.mainAisleWidth,
          message: `「${t.label}」压住主通道，通道只剩 ${fmt(remain)}m，应 ≥ ${fmt(settings.mainAisleWidth)}m`,
          x: t.x,
          y: t.y,
        });
      }
    }

    // 挡住门口
    const dgap = circleRectGap(t.x, t.y, r, doorZone);
    if (dgap < 0) {
      issues.push({
        id: `door:${t.id}`,
        kind: 'door-blocked',
        tableIds: [t.id],
        actual: round2(Math.max(0, settings.doorClearance + dgap)),
        required: settings.doorClearance,
        message: `「${t.label}」挡住门口，门前应留空 ≥ ${fmt(settings.doorClearance)}m`,
        x: t.x,
        y: t.y,
      });
    }
  }
  return issues;
}

// ---------- 挪动联动建议 ----------

export type MoveSuggestion = {
  tableId: string;
  label: string;
  dx: number;
  dy: number;
  reason: string;
};

/** 挪动一桌后，重算受影响的桌与通道，给出要跟着挪哪几桌、各挪多少 */
export function suggestMoves(layout: VenueLayout, movedId: string): MoveSuggestion[] {
  const issues = detectIssues(layout).filter((i) => i.tableIds.includes(movedId));
  const { tables, settings, venue } = layout;
  const byId = new Map(tables.map((t) => [t.id, t]));
  const moved = byId.get(movedId);
  if (!moved) return [];
  const out: MoveSuggestion[] = [];

  const push = (tableId: string, dx: number, dy: number, reason: string) => {
    const t = byId.get(tableId);
    if (!t) return;
    const existing = out.find((s) => s.tableId === tableId);
    if (existing) {
      existing.dx = round2(existing.dx + dx);
      existing.dy = round2(existing.dy + dy);
      existing.reason += `；${reason}`;
    } else {
      out.push({ tableId, label: t.label, dx: round2(dx), dy: round2(dy), reason });
    }
  };

  for (const issue of issues) {
    if (issue.kind === 'table-gap') {
      const otherId = issue.tableIds.find((id) => id !== movedId);
      const other = otherId ? byId.get(otherId) : undefined;
      if (!other) continue;
      // 用真实净距（可为负）计算缺口，而不是展示用的截断值
      const trueGap = Math.hypot(other.x - moved.x, other.y - moved.y) - moved.diameter / 2 - other.diameter / 2;
      const deficit = issue.required - trueGap + MARGIN;
      let ux = other.x - moved.x;
      let uy = other.y - moved.y;
      const len = Math.hypot(ux, uy);
      if (len < 1e-6) {
        ux = 1;
        uy = 0;
      } else {
        ux /= len;
        uy /= len;
      }
      push(other.id, ux * deficit, uy * deficit, `与「${moved.label}」净距不足，需向外挪 ${fmt(deficit)}m`);
    } else if (issue.kind === 'main-aisle') {
      const r = moved.diameter / 2;
      const d = pushOutOfRect(moved.x, moved.y, r, aisleRect(venue, settings), MARGIN);
      push(movedId, d.dx, d.dy, `压住主通道，需退出 ${fmt(Math.hypot(d.dx, d.dy))}m`);
    } else if (issue.kind === 'door-blocked') {
      const r = moved.diameter / 2;
      const d = pushOutOfRect(moved.x, moved.y, r, doorZoneRect(venue, settings), MARGIN);
      push(movedId, d.dx, d.dy, `挡住门口，需退出留空区 ${fmt(Math.hypot(d.dx, d.dy))}m`);
    } else if (issue.kind === 'wall-gap' || issue.kind === 'out-of-bounds') {
      const r = moved.diameter / 2;
      const target = issue.kind === 'wall-gap' ? settings.wallGap + r + MARGIN : r + MARGIN;
      let dx = 0;
      let dy = 0;
      if (moved.x < target) dx = target - moved.x;
      if (moved.x > venue.width - target) dx = venue.width - target - moved.x;
      if (moved.y < target) dy = target - moved.y;
      if (moved.y > venue.length - target) dy = venue.length - target - moved.y;
      push(movedId, dx, dy, issue.kind === 'wall-gap' ? '离墙太近，需往场内挪' : '超出边界，需挪回场内');
    } else if (issue.kind === 'pillar-gap') {
      const pid = issue.id.split(':')[2];
      const p = venue.pillars.find((pp) => pp.id === pid);
      if (p) {
        const rect = pillarRect(p);
        const nx = clamp(moved.x, rect.x, rect.x + rect.w);
        const ny = clamp(moved.y, rect.y, rect.y + rect.h);
        let ux = moved.x - nx;
        let uy = moved.y - ny;
        const len = Math.hypot(ux, uy);
        if (len < 1e-6) {
          ux = 1;
          uy = 0;
        } else {
          ux /= len;
          uy /= len;
        }
        const trueGap = circleRectGap(moved.x, moved.y, moved.diameter / 2, rect);
        const need = issue.required - trueGap + MARGIN;
        push(movedId, ux * need, uy * need, `离柱子太近，需挪开 ${fmt(need)}m`);
      }
    }
  }
  return out;
}

export function applySuggestions(layout: VenueLayout, sugs: MoveSuggestion[]): VenueLayout {
  const map = new Map(sugs.map((s) => [s.tableId, s]));
  return {
    ...layout,
    tables: layout.tables.map((t) => {
      const s = map.get(t.id);
      if (!s) return t;
      return {
        ...t,
        x: round2(clamp(t.x + s.dx, 0, layout.venue.width)),
        y: round2(clamp(t.y + s.dy, 0, layout.venue.length)),
      };
    }),
  };
}

// ---------- 轮次对比 ----------

export type RoundComparison = {
  last: LayoutRound;
  resolved: LayoutIssue[];
  added: LayoutIssue[];
  delta: number; // 正数 = 比上一轮少了几处
};

export function compareWithLastRound(layout: VenueLayout, currentIssues: LayoutIssue[]): RoundComparison | null {
  const last = layout.rounds[layout.rounds.length - 1];
  if (!last) return null;
  const curIds = new Set(currentIssues.map((i) => i.id));
  const prevIds = new Set(last.issues.map((i) => i.id));
  return {
    last,
    resolved: last.issues.filter((i) => !curIds.has(i.id)),
    added: currentIssues.filter((i) => !prevIds.has(i.id)),
    delta: last.issueCount - currentIssues.length,
  };
}
