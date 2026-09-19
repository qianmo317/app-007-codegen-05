import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getPlan, savePlan, setRecentPlanId } from '../db';
import { createHistoryManager } from '../history';
import type {
  DoorSide,
  LayoutIssue,
  LayoutTable,
  LayoutTableKind,
  Plan as PlanType,
  Venue,
  VenueLayout,
} from '../types';
import {
  GUEST_TABLE_DIAMETER,
  aisleRect,
  applySuggestions,
  autoLayoutTables,
  clamp,
  compareWithLastRound,
  createDefaultLayout,
  detectIssues,
  doorCenter,
  doorZoneRect,
  pillarRect,
  round2,
  suggestMoves,
} from '../layout';
import type { MoveSuggestion } from '../layout';
import { generateId } from '../utils';

const DOOR_SIDE_LABEL: Record<DoorSide, string> = {
  top: '上墙',
  bottom: '下墙',
  left: '左墙',
  right: '右墙',
};

const KIND_LABEL: Record<LayoutTableKind, string> = {
  head: '主桌',
  reception: '接待桌',
  guest: '客桌',
};

const ISSUE_KIND_LABEL: Record<LayoutIssue['kind'], string> = {
  'table-gap': '桌距不足',
  'main-aisle': '压住通道',
  'wall-gap': '离墙太近',
  'pillar-gap': '离柱太近',
  'door-blocked': '挡住门口',
  'out-of-bounds': '超出场地',
};

type DragState = {
  kind: 'table' | 'pillar';
  id: string;
  grabDX: number;
  grabDY: number;
  x: number;
  y: number;
};

type Hints = {
  movedLabel: string;
  affected: LayoutIssue[];
  suggestions: MoveSuggestion[];
};

function Num({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 0.1}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

function wallSegs(venue: Venue): [number, number, number, number][] {
  const { width: W, length: L, doorSide, doorOffset, doorWidth } = venue;
  const d0 = doorOffset - doorWidth / 2;
  const d1 = doorOffset + doorWidth / 2;
  const segs: [number, number, number, number][] = [];
  if (doorSide === 'top') segs.push([0, 0, d0, 0], [d1, 0, W, 0]);
  else segs.push([0, 0, W, 0]);
  if (doorSide === 'bottom') segs.push([0, L, d0, L], [d1, L, W, L]);
  else segs.push([0, L, W, L]);
  if (doorSide === 'left') segs.push([0, 0, 0, d0], [0, d1, 0, L]);
  else segs.push([0, 0, 0, L]);
  if (doorSide === 'right') segs.push([W, 0, W, d0], [W, d1, W, L]);
  else segs.push([W, 0, W, L]);
  return segs;
}

function doorPanel(venue: Venue): { x1: number; y1: number; x2: number; y2: number } {
  const dw = venue.doorWidth;
  const d0 = venue.doorOffset - dw / 2;
  const a = Math.PI / 4;
  switch (venue.doorSide) {
    case 'bottom':
      return { x1: d0, y1: venue.length, x2: d0 + Math.cos(a) * dw, y2: venue.length - Math.sin(a) * dw };
    case 'top':
      return { x1: d0, y1: 0, x2: d0 + Math.cos(a) * dw, y2: Math.sin(a) * dw };
    case 'left':
      return { x1: 0, y1: d0, x2: Math.sin(a) * dw, y2: d0 + Math.cos(a) * dw };
    case 'right':
      return { x1: venue.width, y1: d0, x2: venue.width - Math.sin(a) * dw, y2: d0 + Math.cos(a) * dw };
  }
}

function dirText(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dy < -0.01) parts.push('上');
  else if (dy > 0.01) parts.push('下');
  if (dx > 0.01) parts.push('右');
  else if (dx < -0.01) parts.push('左');
  return `向${parts.join('') || '原处'}挪 ${Math.hypot(dx, dy).toFixed(1)}m`;
}

export default function LayoutPlanner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanType | null>(null);
  const [loading, setLoading] = useState(true);
  const historyRef = useRef<ReturnType<typeof createHistoryManager> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [hints, setHints] = useState<Hints | null>(null);
  const [guestCount, setGuestCount] = useState(12);

  const defaultLayout = useMemo(() => createDefaultLayout(), []);
  const layout: VenueLayout = plan?.layout ?? defaultLayout;

  useEffect(() => {
    if (!id) return;
    getPlan(id).then((p) => {
      if (!p) {
        const fallback: PlanType = { id, name: '未命名方案', tables: [], guests: [], rules: [], updatedAt: Date.now() };
        historyRef.current = createHistoryManager(fallback);
        setPlan(fallback);
      } else {
        historyRef.current = createHistoryManager(p);
        setPlan(p);
        setRecentPlanId(id);
        setGuestCount(p.tables.length > 0 ? p.tables.length : 12);
      }
      setLoading(false);
    });
  }, [id]);

  useEffect(() => {
    if (!plan) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      savePlan(plan);
    }, 500);
  }, [plan]);

  const dispatchLayout = useCallback((newLayout: VenueLayout) => {
    if (!historyRef.current) return;
    const current = historyRef.current.current();
    historyRef.current.push(current, { type: 'updateLayout', layout: newLayout });
    setPlan(historyRef.current.current());
  }, []);

  const updateLayout = useCallback(
    (fn: (l: VenueLayout) => VenueLayout) => {
      if (!historyRef.current) return;
      const cur = historyRef.current.current().layout ?? createDefaultLayout();
      dispatchLayout(fn(cur));
    },
    [dispatchLayout],
  );

  const handleUndo = useCallback(() => {
    const p = historyRef.current?.undo();
    if (p) setPlan(p);
  }, []);

  const handleRedo = useCallback(() => {
    const p = historyRef.current?.redo();
    if (p) setPlan(p);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  // 拖动中的临时位置实时参与渲染与检测
  const displayLayout: VenueLayout = useMemo(() => {
    if (!drag) return layout;
    if (drag.kind === 'table') {
      return { ...layout, tables: layout.tables.map((t) => (t.id === drag.id ? { ...t, x: drag.x, y: drag.y } : t)) };
    }
    return {
      ...layout,
      venue: { ...layout.venue, pillars: layout.venue.pillars.map((p) => (p.id === drag.id ? { ...p, x: drag.x, y: drag.y } : p)) },
    };
  }, [layout, drag]);

  const issues = useMemo(() => detectIssues(displayLayout), [displayLayout]);
  const cmp = useMemo(() => compareWithLastRound(displayLayout, issues), [displayLayout, issues]);
  const issueTableIds = useMemo(() => new Set(issues.flatMap((i) => i.tableIds)), [issues]);
  const tableById = useMemo(() => new Map(displayLayout.tables.map((t) => [t.id, t])), [displayLayout.tables]);

  const toMeters = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (vb.width === 0 || vb.height === 0 || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
    const ox = (rect.width - vb.width * scale) / 2;
    const oy = (rect.height - vb.height * scale) / 2;
    return { x: vb.x + (clientX - rect.left - ox) / scale, y: vb.y + (clientY - rect.top - oy) / scale };
  };

  // 拖动中：更新临时位置；松手：落盘并重算联动
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const pos = toMeters(e.clientX, e.clientY);
      setDrag((d) => {
        if (!d) return d;
        let x = pos.x - d.grabDX;
        let y = pos.y - d.grabDY;
        if (d.kind === 'table') {
          x = clamp(x, -2, displayLayout.venue.width + 2);
          y = clamp(y, -2, displayLayout.venue.length + 2);
        } else {
          x = clamp(x, 0, displayLayout.venue.width);
          y = clamp(y, 0, displayLayout.venue.length);
        }
        return { ...d, x, y };
      });
    };
    const onUp = () => {
      const fx = round2(drag.x);
      const fy = round2(drag.y);
      if (drag.kind === 'table') {
        const newLayout: VenueLayout = {
          ...layout,
          tables: layout.tables.map((t) => (t.id === drag.id ? { ...t, x: fx, y: fy } : t)),
        };
        dispatchLayout(newLayout);
        const moved = layout.tables.find((t) => t.id === drag.id);
        const affected = detectIssues(newLayout).filter((i) => i.tableIds.includes(drag.id));
        const suggestions = suggestMoves(newLayout, drag.id);
        setHints({ movedLabel: moved?.label ?? '', affected, suggestions });
      } else {
        dispatchLayout({
          ...layout,
          venue: { ...layout.venue, pillars: layout.venue.pillars.map((p) => (p.id === drag.id ? { ...p, x: fx, y: fy } : p)) },
        });
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, displayLayout, layout, dispatchLayout]);

  const startDragTable = (e: React.PointerEvent, t: LayoutTable) => {
    e.stopPropagation();
    e.preventDefault();
    const pos = toMeters(e.clientX, e.clientY);
    setSelectedTableId(t.id);
    setHints(null);
    setDrag({ kind: 'table', id: t.id, grabDX: pos.x - t.x, grabDY: pos.y - t.y, x: t.x, y: t.y });
  };

  const startDragPillar = (e: React.PointerEvent, pillarId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const p = displayLayout.venue.pillars.find((pp) => pp.id === pillarId);
    if (!p) return;
    const pos = toMeters(e.clientX, e.clientY);
    setDrag({ kind: 'pillar', id: p.id, grabDX: pos.x - p.x, grabDY: pos.y - p.y, x: p.x, y: p.y });
  };

  const updateVenue = (patch: Partial<Venue>) => updateLayout((l) => ({ ...l, venue: { ...l.venue, ...patch } }));
  const updateSettings = (patch: Partial<VenueLayout['settings']>) =>
    updateLayout((l) => ({ ...l, settings: { ...l.settings, ...patch } }));
  const updateTable = (tableId: string, patch: Partial<LayoutTable>) =>
    updateLayout((l) => ({ ...l, tables: l.tables.map((t) => (t.id === tableId ? { ...t, ...patch } : t)) }));

  const handleAutoLayout = () => {
    const labels = (plan?.tables ?? []).map((t) => t.label);
    updateLayout((l) => {
      const { tables, unplaced } = autoLayoutTables(l.venue, l.settings, guestCount, labels);
      if (unplaced > 0) {
        window.setTimeout(() => alert(`场地摆不下：还有 ${unplaced} 桌排不进去，可加大场地、减小桌间距或减少桌数`), 0);
      }
      return { ...l, tables };
    });
    setHints(null);
    setSelectedTableId(null);
  };

  const handleAddTable = () => {
    updateLayout((l) => {
      const n = l.tables.filter((t) => t.kind === 'guest').length + 1;
      const t: LayoutTable = {
        id: generateId(),
        label: `${n}号桌`,
        x: round2(l.venue.width / 2),
        y: round2(l.venue.length / 2),
        diameter: GUEST_TABLE_DIAMETER,
        kind: 'guest',
      };
      return { ...l, tables: [...l.tables, t] };
    });
  };

  const handleFinishRound = () => {
    updateLayout((l) => ({
      ...l,
      rounds: [...l.rounds, { round: l.currentRound, at: Date.now(), issueCount: issues.length, issues }],
      currentRound: l.currentRound + 1,
    }));
  };

  const handleApplySuggestions = () => {
    if (!hints) return;
    updateLayout((l) => applySuggestions(l, hints.suggestions));
    setHints(null);
  };

  if (loading) return <div className="plan-loading">加载中...</div>;
  if (!plan) return <div className="plan-loading">方案不存在</div>;

  const { venue, settings } = displayLayout;
  const aisle = aisleRect(venue, settings);
  const doorZone = doorZoneRect(venue, settings);
  const dc = doorCenter(venue);
  const panel = doorPanel(venue);
  const aisleVertical = aisle.h > aisle.w;
  const selected = selectedTableId ? (tableById.get(selectedTableId) ?? null) : null;
  const maxCount = Math.max(1, issues.length, ...layout.rounds.map((r) => r.issueCount));

  return (
    <div className="plan-page">
      <header className="plan-header">
        <div className="header-left">
          <button className="btn-back" onClick={() => navigate(`/plan/${plan.id}`)}>返回</button>
          <span className="layout-title">摆桌规划 · {plan.name}</span>
        </div>
        <div className="header-actions">
          <button onClick={handleUndo} disabled={!historyRef.current?.canUndo()}>撤销</button>
          <button onClick={handleRedo} disabled={!historyRef.current?.canRedo()}>重做</button>
          <button onClick={handleAutoLayout}>自动摆桌</button>
          <button className="btn-primary-sm" onClick={handleFinishRound}>本轮完成，进入下一轮</button>
        </div>
      </header>
      <div className="layout-body">
        {/* 左：场地设置 */}
        <aside className="venue-panel">
          <section>
            <h4>场地（米）</h4>
            <div className="field-row">
              <label>宽</label>
              <Num value={venue.width} min={6} max={120} step={0.5} onChange={(v) => updateVenue({ width: v })} />
              <label>长</label>
              <Num value={venue.length} min={6} max={120} step={0.5} onChange={(v) => updateVenue({ length: v })} />
            </div>
          </section>
          <section>
            <h4>大门</h4>
            <div className="field-row">
              <label>开在哪侧</label>
              <select value={venue.doorSide} onChange={(e) => updateVenue({ doorSide: e.target.value as DoorSide })}>
                {(Object.keys(DOOR_SIDE_LABEL) as DoorSide[]).map((s) => (
                  <option key={s} value={s}>{DOOR_SIDE_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label>距墙角</label>
              <Num value={venue.doorOffset} min={0} max={venue.doorSide === 'top' || venue.doorSide === 'bottom' ? venue.width : venue.length} step={0.1} onChange={(v) => updateVenue({ doorOffset: v })} />
              <label>门宽</label>
              <Num value={venue.doorWidth} min={0.8} max={6} onChange={(v) => updateVenue({ doorWidth: v })} />
            </div>
          </section>
          <section>
            <h4>
              柱子
              <button
                className="mini-btn"
                onClick={() =>
                  updateVenue({
                    pillars: [...venue.pillars, { id: generateId(), x: round2(venue.width / 2), y: round2(venue.length / 2), size: 0.6 }],
                  })
                }
              >
                + 添加
              </button>
            </h4>
            {venue.pillars.length === 0 && <p className="muted">无柱子；也可点「添加」后在图上拖动</p>}
            {venue.pillars.map((p, i) => (
              <div className="pillar-row" key={p.id}>
                <span className="pillar-name">柱{i + 1}</span>
                <label>x</label>
                <Num value={p.x} min={0} max={venue.width} onChange={(v) => updateVenue({ pillars: venue.pillars.map((pp) => (pp.id === p.id ? { ...pp, x: v } : pp)) })} />
                <label>y</label>
                <Num value={p.y} min={0} max={venue.length} onChange={(v) => updateVenue({ pillars: venue.pillars.map((pp) => (pp.id === p.id ? { ...pp, y: v } : pp)) })} />
                <label>边长</label>
                <Num value={p.size} min={0.2} max={2} onChange={(v) => updateVenue({ pillars: venue.pillars.map((pp) => (pp.id === p.id ? { ...pp, size: v } : pp)) })} />
                <button className="mini-btn danger" onClick={() => updateVenue({ pillars: venue.pillars.filter((pp) => pp.id !== p.id) })}>删</button>
              </div>
            ))}
          </section>
          <section>
            <h4>间距标准（米）</h4>
            <div className="field-row"><label>桌间净距 ≥</label><Num value={settings.tableGap} min={0.4} max={3} onChange={(v) => updateSettings({ tableGap: v })} /></div>
            <div className="field-row"><label>主通道宽 ≥</label><Num value={settings.mainAisleWidth} min={1} max={5} onChange={(v) => updateSettings({ mainAisleWidth: v })} /></div>
            <div className="field-row"><label>离墙 ≥</label><Num value={settings.wallGap} min={0} max={3} onChange={(v) => updateSettings({ wallGap: v })} /></div>
            <div className="field-row"><label>离柱 ≥</label><Num value={settings.pillarGap} min={0} max={3} onChange={(v) => updateSettings({ pillarGap: v })} /></div>
            <div className="field-row"><label>门前留空 ≥</label><Num value={settings.doorClearance} min={0.5} max={5} onChange={(v) => updateSettings({ doorClearance: v })} /></div>
          </section>
          <section>
            <h4>摆桌</h4>
            <div className="field-row">
              <label>客桌数量</label>
              <Num value={guestCount} min={1} max={80} step={1} onChange={(v) => setGuestCount(Math.round(v))} />
            </div>
            <div className="field-row btn-row">
              <button className="gold-btn" onClick={handleAutoLayout}>自动摆桌</button>
              <button className="mini-btn" onClick={handleAddTable}>+ 加一桌</button>
              <button className="mini-btn danger" onClick={() => updateLayout((l) => ({ ...l, tables: [] }))}>清空</button>
            </div>
            <p className="muted">当前 {displayLayout.tables.length} 桌（主桌 {displayLayout.tables.filter((t) => t.kind === 'head').length} · 接待桌 {displayLayout.tables.filter((t) => t.kind === 'reception').length}）</p>
          </section>
        </aside>

        {/* 中：场地平面图 */}
        <main className="venue-svg-wrap">
          <svg
            ref={svgRef}
            className="venue-svg"
            viewBox={`${-0.6} ${-0.6} ${venue.width + 1.2} ${venue.length + 1.2}`}
            onPointerDown={() => {
              setSelectedTableId(null);
              setHighlightIds([]);
            }}
          >
            <rect x={0} y={0} width={venue.width} height={venue.length} className="venue-floor" />
            <rect x={aisle.x} y={aisle.y} width={aisle.w} height={aisle.h} className="aisle" />
            {aisleVertical ? (
              <text className="aisle-label" transform={`translate(${aisle.x + aisle.w / 2} ${venue.length / 2}) rotate(-90)`}>
                主通道 {settings.mainAisleWidth.toFixed(1)}m
              </text>
            ) : (
              <text className="aisle-label" x={venue.width / 2} y={aisle.y + aisle.h / 2}>
                主通道 {settings.mainAisleWidth.toFixed(1)}m
              </text>
            )}
            <rect x={doorZone.x} y={doorZone.y} width={doorZone.w} height={doorZone.h} className="door-zone" />
            <text className="door-zone-label" x={doorZone.x + doorZone.w / 2} y={doorZone.y + doorZone.h / 2}>门前留空</text>

            {/* 间距不足的连线标注 */}
            {issues.map((i) => {
              if (i.kind === 'table-gap') {
                const a = tableById.get(i.tableIds[0]);
                const b = tableById.get(i.tableIds[1]);
                if (!a || !b) return null;
                return (
                  <g key={i.id} className="gap-mark">
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                    <text x={i.x} y={i.y - 0.18}>{`${i.actual.toFixed(1)}m < ${i.required.toFixed(1)}m`}</text>
                  </g>
                );
              }
              if (i.kind === 'pillar-gap') {
                const a = tableById.get(i.tableIds[0]);
                const p = venue.pillars.find((pp) => pp.id === i.id.split(':')[2]);
                if (!a || !p) return null;
                return (
                  <g key={i.id} className="gap-mark">
                    <line x1={a.x} y1={a.y} x2={p.x} y2={p.y} />
                    <text x={i.x} y={i.y - 0.18}>{`${i.actual.toFixed(1)}m < ${i.required.toFixed(1)}m`}</text>
                  </g>
                );
              }
              return null;
            })}

            {/* 墙体与门 */}
            {wallSegs(venue).map((s, idx) => (
              <line key={idx} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} className="wall" />
            ))}
            <line x1={panel.x1} y1={panel.y1} x2={panel.x2} y2={panel.y2} className="door-panel" />
            <text className="door-label" x={dc.x} y={venue.doorSide === 'top' ? dc.y + 0.9 : venue.doorSide === 'bottom' ? dc.y - 0.5 : dc.y + 0.15} dx={venue.doorSide === 'left' ? 0.9 : venue.doorSide === 'right' ? -0.9 : 0}>门</text>

            {/* 柱子 */}
            {venue.pillars.map((p, i) => {
              const r = pillarRect(p);
              return (
                <g key={p.id} className="pillar" onPointerDown={(e) => startDragPillar(e, p.id)}>
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} />
                  <text x={p.x} y={p.y}>柱{i + 1}</text>
                </g>
              );
            })}

            {/* 桌子 */}
            {displayLayout.tables.map((t) => {
              const r = t.diameter / 2;
              const hasIssue = issueTableIds.has(t.id);
              const isSel = selectedTableId === t.id;
              const isHl = highlightIds.includes(t.id);
              const isDragging = drag?.kind === 'table' && drag.id === t.id;
              return (
                <g key={t.id} className={`ltable ${isDragging ? 'dragging' : ''}`} onPointerDown={(e) => startDragTable(e, t)}>
                  {isHl && <circle cx={t.x} cy={t.y} r={r + 0.22} className="hl-ring" />}
                  {isSel && <circle cx={t.x} cy={t.y} r={r + 0.14} className="sel-ring" />}
                  <circle cx={t.x} cy={t.y} r={r} className={`tbody k-${t.kind}`} />
                  {hasIssue && <circle cx={t.x} cy={t.y} r={r + 0.08} className="issue-ring" />}
                  <text x={t.x} y={t.y} className={`tlabel k-${t.kind}`}>{t.label}</text>
                  {hasIssue && (
                    <g className="badge">
                      <circle cx={t.x + r * 0.72} cy={t.y - r * 0.72} r={0.24} />
                      <text x={t.x + r * 0.72} y={t.y - r * 0.72}>!</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="venue-legend">
            单位：米 ｜ 桌间净距 ≥ {settings.tableGap.toFixed(1)} ｜ 主通道 ≥ {settings.mainAisleWidth.toFixed(1)} ｜ 离墙 ≥ {settings.wallGap.toFixed(1)} ｜ 离柱 ≥ {settings.pillarGap.toFixed(1)} ｜ 门前留空 ≥ {settings.doorClearance.toFixed(1)}
          </div>
        </main>

        {/* 右：轮次对比 + 联动提示 + 问题清单 */}
        <aside className="layout-side">
          <div className="side-box round-card">
            <div className="round-head">
              <span className="round-title">第 {layout.currentRound} 轮调整</span>
              <span className="round-count">现存 <b>{issues.length}</b> 处不妥</span>
            </div>
            {cmp ? (
              <div className={`round-delta ${cmp.delta > 0 ? 'good' : cmp.delta < 0 ? 'bad' : ''}`}>
                {cmp.delta > 0 && `比第 ${cmp.last.round} 轮（${cmp.last.issueCount} 处）少 ${cmp.delta} 处`}
                {cmp.delta < 0 && `比第 ${cmp.last.round} 轮（${cmp.last.issueCount} 处）多 ${-cmp.delta} 处`}
                {cmp.delta === 0 && `与第 ${cmp.last.round} 轮持平（${cmp.last.issueCount} 处）`}
              </div>
            ) : (
              <div className="round-delta">调整一轮后点上方「进入下一轮」，即可对比每轮少了多少处</div>
            )}
            {layout.rounds.length > 0 && (
              <div className="round-trend">
                {layout.rounds.map((r) => (
                  <div key={r.round} className="trend-item">
                    <span className="trend-count">{r.issueCount}</span>
                    <div className="trend-bar-wrap">
                      <div className="trend-bar" style={{ height: `${Math.max(4, (r.issueCount / maxCount) * 100)}%` }} />
                    </div>
                    <span className="trend-label">第{r.round}轮</span>
                  </div>
                ))}
                <div className="trend-item current">
                  <span className="trend-count">{issues.length}</span>
                  <div className="trend-bar-wrap">
                    <div className="trend-bar" style={{ height: `${Math.max(4, (issues.length / maxCount) * 100)}%` }} />
                  </div>
                  <span className="trend-label">当前</span>
                </div>
              </div>
            )}
            {cmp && (cmp.resolved.length > 0 || cmp.added.length > 0) && (
              <details className="round-detail">
                <summary>对比第 {cmp.last.round} 轮明细</summary>
                {cmp.resolved.length > 0 && (
                  <div className="resolved">
                    <div className="detail-title">已解决 {cmp.resolved.length} 处：</div>
                    {cmp.resolved.map((i) => <div key={i.id} className="detail-item">✓ {i.message}</div>)}
                  </div>
                )}
                {cmp.added.length > 0 && (
                  <div className="added">
                    <div className="detail-title">新出现 {cmp.added.length} 处：</div>
                    {cmp.added.map((i) => <div key={i.id} className="detail-item">✗ {i.message}</div>)}
                  </div>
                )}
              </details>
            )}
          </div>

          {hints && (
            <div className="side-box hint-box">
              <div className="hint-title">「{hints.movedLabel}」挪动后重新检测</div>
              {hints.affected.length === 0 ? (
                <div className="hint-ok">✓ 这一挪没有引起不妥</div>
              ) : (
                <>
                  <ul className="hint-list">
                    {hints.affected.map((i) => (
                      <li key={i.id}>{i.message}</li>
                    ))}
                  </ul>
                  {hints.suggestions.length > 0 && (
                    <>
                      <div className="hint-sub">建议跟着挪：</div>
                      <ul className="hint-list">
                        {hints.suggestions.map((s) => (
                          <li key={s.tableId}>「{s.label}」{dirText(s.dx, s.dy)}（{s.reason}）</li>
                        ))}
                      </ul>
                      <button className="gold-btn" onClick={handleApplySuggestions}>一键采纳建议</button>
                    </>
                  )}
                </>
              )}
              <button className="mini-btn hint-close" onClick={() => setHints(null)}>知道了</button>
            </div>
          )}

          {selected && (
            <div className="side-box table-editor">
              <h4>选中：{selected.label}</h4>
              <div className="field-row">
                <label>桌名</label>
                <input value={selected.label} onChange={(e) => updateTable(selected.id, { label: e.target.value })} />
              </div>
              <div className="field-row">
                <label>类型</label>
                <select value={selected.kind} onChange={(e) => updateTable(selected.id, { kind: e.target.value as LayoutTableKind })}>
                  {(Object.keys(KIND_LABEL) as LayoutTableKind[]).map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
                <label>直径</label>
                <Num value={selected.diameter} min={0.8} max={3} onChange={(v) => updateTable(selected.id, { diameter: v })} />
              </div>
              <div className="field-row">
                <label>X</label>
                <Num value={selected.x} min={0} max={venue.width} onChange={(v) => updateTable(selected.id, { x: v })} />
                <label>Y</label>
                <Num value={selected.y} min={0} max={venue.length} onChange={(v) => updateTable(selected.id, { y: v })} />
              </div>
              <button
                className="mini-btn danger"
                onClick={() => {
                  updateLayout((l) => ({ ...l, tables: l.tables.filter((t) => t.id !== selected.id) }));
                  setSelectedTableId(null);
                }}
              >
                删除此桌
              </button>
            </div>
          )}

          <div className="side-box issue-box">
            <h4>问题清单（{issues.length}）</h4>
            {issues.length === 0 && <div className="issue-ok">✓ 当前摆法没有不妥</div>}
            <div className="issue-list">
              {issues.map((i) => (
                <div
                  key={i.id}
                  className={`issue-item ${highlightIds.length > 0 && i.tableIds.some((tid) => highlightIds.includes(tid)) ? 'active' : ''}`}
                  onClick={() => setHighlightIds((prev) => (prev.join() === i.tableIds.join() ? [] : i.tableIds))}
                >
                  <span className={`issue-kind k-${i.kind}`}>{ISSUE_KIND_LABEL[i.kind]}</span>
                  <span className="issue-msg">{i.message}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
