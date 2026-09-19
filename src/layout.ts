import type { HallConfig, LayoutTable, VenueLayout } from './types';
import { generateId } from './utils';

/** 布局经验参数默认值（米） */
export const DEFAULTS = {
  minTableGap: 1.5, // 桌边净距：拉开椅子后仍能过人
  mainAisleWidth: 2.0, // 主通道：门口到主桌
  wallGap: 1.2, // 沿墙过道
  doorClearance: 2.5, // 门口净空深度
  diameter: 1.8, // 10 人圆桌直径
  pillarSize: 0.6,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const fmt = (v: number) => v.toFixed(1);
/** 浮点容差：恰好达到标准的距离不算违规 */
const EPS = 0.01;

export function createDefaultLayout(tableCount = 12): VenueLayout {
  const layout: VenueLayout = {
    hall: {
      width: 24,
      length: 16,
      doorSide: 'bottom',
      doorWidth: 3,
      doorOffset: 12,
      pillars: [],
    },
    tables: [],
    minTableGap: DEFAULTS.minTableGap,
    mainAisleWidth: DEFAULTS.mainAisleWidth,
    wallGap: DEFAULTS.wallGap,
    doorClearance: DEFAULTS.doorClearance,
    rounds: [],
  };
  layout.tables = autoLayout(layout, Math.max(2, tableCount), DEFAULTS.diameter);
  return layout;
}

/** 圆心到矩形的最短距离（在矩形内为 0） */
function circleRectDist(cx: number, cy: number, x1: number, y1: number, x2: number, y2: number): number {
  const nx = clamp(cx, x1, x2);
  const ny = clamp(cy, y1, y2);
  return Math.hypot(cx - nx, cy - ny);
}

/** 门口净空矩形（室内侧），单位米 */
export function doorZoneRect(hall: HallConfig, clearance: number): { x: number; y: number; w: number; h: number } {
  const half = hall.doorWidth / 2;
  const c = hall.doorOffset;
  switch (hall.doorSide) {
    case 'top':
      return { x: c - half, y: 0, w: hall.doorWidth, h: clearance };
    case 'bottom':
      return { x: c - half, y: hall.length - clearance, w: hall.doorWidth, h: clearance };
    case 'left':
      return { x: 0, y: c - half, w: clearance, h: hall.doorWidth };
    case 'right':
      return { x: hall.width - clearance, y: c - half, w: clearance, h: hall.doorWidth };
  }
}

/** 某点到门所在墙的垂直距离（米） */
function distToDoorSide(hall: HallConfig, x: number, y: number): number {
  switch (hall.doorSide) {
    case 'top':
      return y;
    case 'bottom':
      return hall.length - y;
    case 'left':
      return x;
    case 'right':
      return hall.width - x;
  }
}

/**
 * 主通道矩形：从门口直通主桌前方，宽 mainAisleWidth，
 * 在离远墙 reserve 米处收住（给主桌留位）。
 */
export function mainAisleRect(
  hall: HallConfig,
  aisleWidth: number,
  reserve: number,
): { x: number; y: number; w: number; h: number } {
  const half = aisleWidth / 2;
  const c = hall.doorOffset;
  switch (hall.doorSide) {
    case 'top':
      return { x: c - half, y: 0, w: aisleWidth, h: Math.max(0, hall.length - reserve) };
    case 'bottom':
      return { x: c - half, y: reserve, w: aisleWidth, h: Math.max(0, hall.length - reserve) };
    case 'left':
      return { x: 0, y: c - half, w: Math.max(0, hall.width - reserve), h: aisleWidth };
    case 'right':
      return { x: reserve, y: c - half, w: Math.max(0, hall.width - reserve), h: aisleWidth };
  }
}

/* ---------------- 自动排布 ---------------- */

/**
 * 按场地平面自动排桌：
 * - 主桌放在远离门口一侧的正中；
 * - 接待桌放在门内、门口净空之外、靠边不挡路；
 * - 普通桌按网格排列，桌间留 minTableGap，中间沿门到主桌方向留 mainAisleWidth 主通道；
 * - 自动避开柱子和门口净空。
 */
export function autoLayout(layout: VenueLayout, totalCount: number, diameter: number): LayoutTable[] {
  const { hall, minTableGap, mainAisleWidth, wallGap, doorClearance } = layout;
  const r = diameter / 2;
  const tables: LayoutTable[] = [];

  // 在 (u, v) 坐标系里排布：u 沿门所在墙，v 从门口向场内纵深
  const horizontal = hall.doorSide === 'top' || hall.doorSide === 'bottom';
  const U = horizontal ? hall.width : hall.length;
  const V = horizontal ? hall.length : hall.width;
  const doorU = clamp(hall.doorOffset, hall.doorWidth / 2, U - hall.doorWidth / 2);

  const toXY = (u: number, v: number): { x: number; y: number } => {
    switch (hall.doorSide) {
      case 'top':
        return { x: u, y: v };
      case 'bottom':
        return { x: u, y: hall.length - v };
      case 'left':
        return { x: v, y: u };
      case 'right':
        return { x: hall.width - v, y: u };
    }
  };

  // 主桌：远离门口一侧正中
  const headV = V - wallGap - r;
  const headPos = toXY(U / 2, headV);
  tables.push({ id: generateId(), label: '主桌', kind: 'head', x: headPos.x, y: headPos.y, diameter });

  // 接待桌：门内、净空区之外、门的一侧
  const recV = doorClearance + r + 0.3;
  let recU = doorU + hall.doorWidth / 2 + 0.8 + r;
  if (recU + r > U - wallGap) recU = doorU - hall.doorWidth / 2 - 0.8 - r;
  recU = clamp(recU, wallGap + r, U - wallGap - r);
  const recPos = toXY(recU, recV);
  tables.push({ id: generateId(), label: '接待桌', kind: 'reception', x: recPos.x, y: recPos.y, diameter: Math.min(diameter, 1.6) });

  // 普通桌网格
  const n = Math.max(0, totalCount - 2);
  if (n > 0) {
    const availU = U - 2 * (wallGap + r);
    let cols = Math.max(1, Math.floor((availU + minTableGap) / (diameter + minTableGap)));
    // 列数 >= 3 时中间留主通道（用主通道宽度替换一处桌间距）
    const useAisle = cols >= 3;
    const span = (c: number) => c * diameter + (useAisle ? c - 2 : c - 1) * minTableGap + (useAisle ? mainAisleWidth : 0);
    while (cols > 1 && span(cols) > availU) cols--;
    const totalSpan = span(cols);
    const u0 = U / 2 - totalSpan / 2 + r;
    // 主通道插在哪一列之后：选让通道中线最接近门口的位置
    let aisleAfter = Math.ceil(cols / 2);
    if (useAisle) {
      let best = Infinity;
      for (let k = 1; k <= cols - 1; k++) {
        const center = u0 - r + k * diameter + (k - 1) * minTableGap + mainAisleWidth / 2;
        if (Math.abs(center - doorU) < best) {
          best = Math.abs(center - doorU);
          aisleAfter = k;
        }
      }
    }
    const colU: number[] = [];
    for (let c = 0; c < cols; c++) {
      colU.push(u0 + c * (diameter + minTableGap) + (useAisle && c >= aisleAfter ? mainAisleWidth - minTableGap : 0));
    }

    const vStart = headV - r - minTableGap - r; // 第一排（从主桌往门口数）
    const vEnd = wallGap + r; // 最靠门口允许的中心位置
    const pitch = diameter + minTableGap;
    const rows = Math.max(1, Math.floor((vStart - vEnd) / pitch) + 1);

    const dz = doorZoneRect(hall, doorClearance);
    const aisleRect = mainAisleRect(hall, mainAisleWidth, wallGap + diameter);
    const blocked = (x: number, y: number): boolean => {
      if (circleRectDist(x, y, dz.x, dz.y, dz.x + dz.w, dz.y + dz.h) < r + 0.1) return true;
      if (circleRectDist(x, y, aisleRect.x, aisleRect.y, aisleRect.x + aisleRect.w, aisleRect.y + aisleRect.h) < r + 0.05) return true;
      for (const p of hall.pillars) {
        const d = circleRectDist(x, y, p.x - p.size / 2, p.y - p.size / 2, p.x + p.size / 2, p.y + p.size / 2) - r;
        if (d < wallGap) return true;
      }
      const rec = tables[1];
      if (Math.hypot(x - rec.x, y - rec.y) - r - rec.diameter / 2 < minTableGap) return true;
      return false;
    };

    const cells: { x: number; y: number }[] = [];
    const skipped: { x: number; y: number }[] = [];
    for (let row = 0; row < rows; row++) {
      const v = vStart - row * pitch;
      for (const u of colU) {
        const pos = toXY(u, v);
        if (blocked(pos.x, pos.y)) skipped.push(pos);
        else cells.push(pos);
      }
    }
    // 位置不够时把避开的格子也用上（校验会标出来，交给人工微调）
    const all = [...cells, ...skipped];
    for (let i = 0; i < n; i++) {
      const pos = all[i % all.length] ?? toXY(U / 2, V / 2);
      tables.push({ id: generateId(), label: `${i + 1}号桌`, kind: 'normal', x: pos.x, y: pos.y, diameter });
    }
  }
  return tables;
}

/* ---------------- 布局校验 ---------------- */

export type LayoutIssueType = 'tableGap' | 'wall' | 'pillar' | 'door' | 'aisle' | 'bounds' | 'head' | 'reception';

export type LayoutIssue = {
  id: string;
  type: LayoutIssueType;
  tableIds: string[];
  message: string; // 哪里不妥、实测多少
  suggestion: string; // 离多少才合适
  actual: number; // 实测值（米），无意义时为 0
  required: number; // 建议值（米）
};

export const ISSUE_TYPE_LABELS: Record<LayoutIssueType, string> = {
  tableGap: '桌距',
  wall: '过道',
  pillar: '柱子',
  door: '门口',
  aisle: '主通道',
  bounds: '出界',
  head: '主桌',
  reception: '接待',
};

export function checkLayout(layout: VenueLayout): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const { hall, tables, minTableGap, wallGap, doorClearance } = layout;

  // 出界 + 沿墙过道
  for (const t of tables) {
    const r = t.diameter / 2;
    const gaps = [
      { side: '左墙', g: t.x - r },
      { side: '右墙', g: hall.width - t.x - r },
      { side: '上墙', g: t.y - r },
      { side: '下墙', g: hall.length - t.y - r },
    ];
    const minEntry = gaps.reduce((a, b) => (b.g < a.g ? b : a));
    if (minEntry.g < -EPS) {
      issues.push({
        id: `bounds-${t.id}`,
        type: 'bounds',
        tableIds: [t.id],
        message: `「${t.label}」超出${minEntry.side} ${fmt(-minEntry.g)} 米`,
        suggestion: `请移回场地内，桌边距墙建议 ≥ ${fmt(wallGap)} 米`,
        actual: minEntry.g,
        required: wallGap,
      });
    } else if (minEntry.g < wallGap - EPS) {
      issues.push({
        id: `wall-${t.id}`,
        type: 'wall',
        tableIds: [t.id],
        message: `「${t.label}」靠${minEntry.side}的过道仅 ${fmt(minEntry.g)} 米`,
        suggestion: `沿墙过道建议 ≥ ${fmt(wallGap)} 米，还需内移 ${fmt(wallGap - minEntry.g)} 米`,
        actual: minEntry.g,
        required: wallGap,
      });
    }
  }

  // 桌与桌净距
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const gap = dist - a.diameter / 2 - b.diameter / 2;
      if (gap < minTableGap - EPS) {
        issues.push({
          id: `gap-${a.id}-${b.id}`,
          type: 'tableGap',
          tableIds: [a.id, b.id],
          message: `「${a.label}」与「${b.label}」桌边净距仅 ${fmt(Math.max(0, gap))} 米${gap < 0 ? '（桌面已重叠）' : ''}`,
          suggestion: `桌间净距建议 ≥ ${fmt(minTableGap)} 米（拉椅+通行），还差 ${fmt(minTableGap - gap)} 米`,
          actual: gap,
          required: minTableGap,
        });
      }
    }
  }

  // 柱子
  for (const t of tables) {
    const r = t.diameter / 2;
    for (const p of hall.pillars) {
      const d = circleRectDist(t.x, t.y, p.x - p.size / 2, p.y - p.size / 2, p.x + p.size / 2, p.y + p.size / 2) - r;
      if (d < wallGap - EPS) {
        issues.push({
          id: `pillar-${t.id}-${p.id}`,
          type: 'pillar',
          tableIds: [t.id],
          message: `「${t.label}」桌边距柱子仅 ${fmt(Math.max(0, d))} 米${d < 0 ? '（已压柱）' : ''}`,
          suggestion: `桌边距柱建议 ≥ ${fmt(wallGap)} 米，需移开 ${fmt(wallGap - d)} 米`,
          actual: d,
          required: wallGap,
        });
      }
    }
  }

  // 门口净空
  const dz = doorZoneRect(hall, doorClearance);
  for (const t of tables) {
    const d = circleRectDist(t.x, t.y, dz.x, dz.y, dz.x + dz.w, dz.y + dz.h) - t.diameter / 2;
    if (d < -EPS) {
      issues.push({
        id: `door-${t.id}`,
        type: 'door',
        tableIds: [t.id],
        message: `「${t.label}」挡住了门口通道`,
        suggestion: `门口 ${fmt(doorClearance)} 米净空内不要摆桌，需移出 ${fmt(-d)} 米`,
        actual: d,
        required: 0,
      });
    }
  }

  // 主通道（门口 → 主桌）
  const headTable = tables.find((t) => t.kind === 'head');
  const reserve = wallGap + (headTable ? headTable.diameter : DEFAULTS.diameter);
  const aisle = mainAisleRect(hall, layout.mainAisleWidth, reserve);
  for (const t of tables) {
    if (t.kind === 'head') continue; // 主桌在通道尽头，不参与
    const d = circleRectDist(t.x, t.y, aisle.x, aisle.y, aisle.x + aisle.w, aisle.y + aisle.h) - t.diameter / 2;
    if (d < -EPS) {
      issues.push({
        id: `aisle-${t.id}`,
        type: 'aisle',
        tableIds: [t.id],
        message: `「${t.label}」压住了门口到主桌的主通道`,
        suggestion: `主通道建议留宽 ≥ ${fmt(layout.mainAisleWidth)} 米，需移出 ${fmt(-d)} 米`,
        actual: d,
        required: 0,
      });
    }
  }

  // 主桌位置
  const depth = hall.doorSide === 'top' || hall.doorSide === 'bottom' ? hall.length : hall.width;
  const heads = tables.filter((t) => t.kind === 'head');
  if (heads.length === 0) {
    issues.push({
      id: 'head-none',
      type: 'head',
      tableIds: [],
      message: '尚未设置主桌',
      suggestion: '主桌一般设在远离门口、面向全场的正中位置',
      actual: 0,
      required: 0,
    });
  } else {
    for (const h of heads) {
      const d = distToDoorSide(hall, h.x, h.y);
      if (d < depth / 2) {
        issues.push({
          id: `head-pos-${h.id}`,
          type: 'head',
          tableIds: [h.id],
          message: `主桌「${h.label}」离门口偏近（距门侧仅 ${fmt(d)} 米）`,
          suggestion: `主桌宜设在远离门口的一侧（距门侧 > ${fmt(depth / 2)} 米）`,
          actual: d,
          required: depth / 2,
        });
      }
    }
  }

  // 接待桌位置
  const recs = tables.filter((t) => t.kind === 'reception');
  if (recs.length === 0) {
    issues.push({
      id: 'rec-none',
      type: 'reception',
      tableIds: [],
      message: '尚未设置门口接待桌',
      suggestion: '接待桌宜放在门内 2~4 米、不挡通道的位置，方便签到迎宾',
      actual: 0,
      required: 0,
    });
  } else {
    for (const t of recs) {
      const d = distToDoorSide(hall, t.x, t.y);
      if (d > 4) {
        issues.push({
          id: `rec-pos-${t.id}`,
          type: 'reception',
          tableIds: [t.id],
          message: `接待桌「${t.label}」距门口 ${fmt(d)} 米，离门太远`,
          suggestion: '接待桌宜放在门内 2~4 米处，方便签到迎宾',
          actual: d,
          required: 4,
        });
      }
    }
  }

  return issues;
}

/* ---------------- 挪桌联动建议 ---------------- */

export type FollowMove = {
  tableId: string;
  label: string;
  dx: number; // 建议位移，米
  dy: number;
  reason: string;
};

/**
 * 挪动一张桌后重新计算：哪些相邻桌现在靠得太近，需要跟着挪。
 * 对每张受波及的桌给出沿连线的推开向量（已按场地边界收敛）。
 */
export function suggestFollowMoves(layout: VenueLayout, movedId: string): FollowMove[] {
  const moved = layout.tables.find((t) => t.id === movedId);
  if (!moved) return [];
  const moves = new Map<string, FollowMove>();

  for (const t of layout.tables) {
    if (t.id === movedId) continue;
    const dist = Math.hypot(t.x - moved.x, t.y - moved.y);
    const gap = dist - t.diameter / 2 - moved.diameter / 2;
    if (gap < layout.minTableGap - EPS) {
      const need = layout.minTableGap - gap;
      let ux = 1;
      let uy = 0;
      if (dist > 1e-6) {
        ux = (t.x - moved.x) / dist;
        uy = (t.y - moved.y) / dist;
      }
      const existing = moves.get(t.id);
      if (existing) {
        existing.dx += ux * need;
        existing.dy += uy * need;
      } else {
        moves.set(t.id, {
          tableId: t.id,
          label: t.label,
          dx: ux * need,
          dy: uy * need,
          reason: `与「${moved.label}」桌边净距不足，需外移约 ${fmt(need)} 米`,
        });
      }
    }
  }

  // 收敛到场地内（保留沿墙过道）
  for (const m of moves.values()) {
    const t = layout.tables.find((x) => x.id === m.tableId)!;
    const r = t.diameter / 2;
    const nx = clamp(t.x + m.dx, layout.wallGap + r, layout.hall.width - layout.wallGap - r);
    const ny = clamp(t.y + m.dy, layout.wallGap + r, layout.hall.length - layout.wallGap - r);
    m.dx = nx - t.x;
    m.dy = ny - t.y;
  }
  return [...moves.values()].filter((m) => Math.hypot(m.dx, m.dy) > 0.05);
}
