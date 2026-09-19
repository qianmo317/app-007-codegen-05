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

export type Plan = {
  id: string;
  name: string;
  tables: Table[];
  guests: Guest[];
  rules: Rule[];
  layout?: VenueLayout;
  updatedAt: number;
};

// ---- 宴会厅摆桌规划（单位：米）----

export type DoorSide = 'top' | 'bottom' | 'left' | 'right';

export type Pillar = {
  id: string;
  x: number; // 柱中心 x
  y: number; // 柱中心 y
  size: number; // 边长
};

export type Venue = {
  width: number; // 场地宽（x 方向）
  length: number; // 场地长（y 方向）
  doorSide: DoorSide; // 门开在哪一侧墙
  doorOffset: number; // 门中心沿墙距墙角
  doorWidth: number; // 门宽
  pillars: Pillar[];
};

export type LayoutTableKind = 'head' | 'reception' | 'guest';

export type LayoutTable = {
  id: string;
  label: string;
  x: number; // 桌中心 x
  y: number; // 桌中心 y
  diameter: number; // 圆桌直径
  kind: LayoutTableKind;
};

export type LayoutSettings = {
  tableGap: number; // 桌与桌最小净距
  mainAisleWidth: number; // 主通道宽度
  wallGap: number; // 桌边离墙最小距离
  pillarGap: number; // 桌边离柱最小净距
  doorClearance: number; // 门前留空深度
};

export type LayoutIssueKind =
  | 'table-gap'
  | 'main-aisle'
  | 'wall-gap'
  | 'pillar-gap'
  | 'door-blocked'
  | 'out-of-bounds';

export type LayoutIssue = {
  id: string;
  kind: LayoutIssueKind;
  tableIds: string[];
  actual: number; // 实际距离/宽度
  required: number; // 要求距离/宽度
  message: string;
  x: number; // 图上标注位置
  y: number;
};

export type LayoutRound = {
  round: number;
  at: number;
  issueCount: number;
  issues: LayoutIssue[];
};

export type VenueLayout = {
  venue: Venue;
  settings: LayoutSettings;
  tables: LayoutTable[];
  rounds: LayoutRound[];
  currentRound: number;
};

export type Command =
  | { type: 'updatePlan'; plan: Plan }
  | { type: 'updateTables'; tables: Table[] }
  | { type: 'updateGuests'; guests: Guest[] }
  | { type: 'updateRules'; rules: Rule[] }
  | { type: 'updateLayout'; layout: VenueLayout }
  | { type: 'updateTable'; table: Table }
  | { type: 'addGuest'; guest: Guest }
  | { type: 'removeGuest'; guestId: string }
  | { type: 'addTable'; table: Table }
  | { type: 'removeTable'; tableId: string }
  | { type: 'moveGuest'; guestId: string; fromTableId: string | null; toTableId: string | null; toIndex?: number }
  | { type: 'batch'; commands: Command[] };

export const TAG_OPTIONS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食'];
