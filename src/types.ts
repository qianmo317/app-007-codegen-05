export type Guest = {
  id: string;
  name: string;
  tags: string[];
  partySize: number;
  childSeat?: boolean;
  note?: string;
};

export type TableShape = 'round' | 'rect';

export type Table = {
  id: string;
  label: string;
  x: number;
  y: number;
  shape: TableShape;
  capacity: number;
  seatOrder: string[]; // guest ids, length <= capacity
};

export type RuleType = 'together' | 'apart' | 'adjacent' | 'separate';

export type Rule = {
  id: string;
  type: RuleType;
  a: string; // guest id
  b: string; // guest id
};

/* ---------- 宴会厅平面布局 ---------- */

export type DoorSide = 'top' | 'bottom' | 'left' | 'right';

export type Pillar = {
  id: string;
  x: number; // 中心，米
  y: number;
  size: number; // 边长，米
};

export type HallConfig = {
  width: number; // 场地横向，米
  length: number; // 场地纵向，米
  doorSide: DoorSide; // 门开在哪一侧墙
  doorWidth: number; // 门宽，米
  doorOffset: number; // 门中心沿所在墙的位置，米
  pillars: Pillar[];
};

export type LayoutTableKind = 'normal' | 'head' | 'reception';

export type LayoutTable = {
  id: string;
  label: string;
  kind: LayoutTableKind; // 普通桌 / 主桌 / 接待桌
  x: number; // 中心坐标，米
  y: number;
  diameter: number; // 桌直径，米
};

export type LayoutRound = {
  n: number; // 第几轮
  issues: number; // 本轮不妥处数
  time: number;
};

export type VenueLayout = {
  hall: HallConfig;
  tables: LayoutTable[];
  minTableGap: number; // 桌边净距下限，米
  mainAisleWidth: number; // 主通道宽度，米
  wallGap: number; // 沿墙过道下限，米
  doorClearance: number; // 门口净空深度，米
  rounds: LayoutRound[]; // 每轮调整的问题数记录
};

export type Plan = {
  id: string;
  name: string;
  tables: Table[];
  guests: Guest[];
  rules: Rule[];
  updatedAt: number;
  layout?: VenueLayout;
};

export type Command =
  | { type: 'updatePlan'; plan: Plan }
  | { type: 'updateTables'; tables: Table[] }
  | { type: 'updateGuests'; guests: Guest[] }
  | { type: 'updateRules'; rules: Rule[] }
  | { type: 'updateTable'; table: Table }
  | { type: 'updateLayout'; layout: VenueLayout }
  | { type: 'addGuest'; guest: Guest }
  | { type: 'removeGuest'; guestId: string }
  | { type: 'addTable'; table: Table }
  | { type: 'removeTable'; tableId: string }
  | { type: 'moveGuest'; guestId: string; fromTableId: string | null; toTableId: string | null; toIndex?: number }
  | { type: 'batch'; commands: Command[] };

export const TAG_OPTIONS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食'];
