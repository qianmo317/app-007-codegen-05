import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getPlan, savePlan } from '../db';
import { createHistoryManager } from '../history';
import type { Command, DoorSide, LayoutTable, LayoutTableKind, Plan as PlanType, VenueLayout } from '../types';
import {
  DEFAULTS,
  ISSUE_TYPE_LABELS,
  autoLayout,
  checkLayout,
  createDefaultLayout,
  doorZoneRect,
  mainAisleRect,
  suggestFollowMoves,
  type FollowMove,
} from '../layout';
import { generateId } from '../utils';

const SCALE = 30; // 1 米 = 30 像素

const DOOR_SIDE_LABELS: Record<DoorSide, string> = {
  top: '上墙',
  bottom: '下墙',
  left: '左墙',
  right: '右墙',
};

const KIND_LABELS: Record<LayoutTableKind, string> = {
  normal: '普通桌',
  head: '主桌',
  reception: '接待桌',
};

/** 数字输入：失焦/回车才提交，避免每次击键都进撤销栈 */
function NumberField({
  value,
  min,
  max,
  step = 0.1,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    let v = parseFloat(text);
    if (Number.isNaN(v)) {
      setText(String(value));
      return;
    }
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onCommit(v);
    setText(String(v));
  };
  return (
    <input
      type="number"
      value={text}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export default function VenuePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanType | null>(null);
  const [loading, setLoading] = useState(true);
  const historyRef = useRef<ReturnType<typeof createHistoryManager> | null>(null);
  const planRef = useRef<PlanType | null>(null);
  planRef.current = plan;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [followMoves, setFollowMoves] = useState<FollowMove[]>([]);
  const [autoCount, setAutoCount] = useState(12);
  const [autoDiameter, setAutoDiameter] = useState(DEFAULTS.diameter);

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });
  const dragPosRef = useRef<{ x: number; y: number } | null>(null);

  // 加载方案；老方案没有布局数据时按桌数生成默认布局
  useEffect(() => {
    if (!id) return;
    getPlan(id).then((p) => {
      if (!p) {
        setLoading(false);
        return;
      }
      if (!p.layout) {
        p = { ...p, layout: createDefaultLayout(p.tables.length || 12) };
      }
      // 首轮记录：作为后续调整的对比基线
      if (p.layout!.rounds.length === 0) {
        const count = checkLayout(p.layout!).length;
        p = { ...p, layout: { ...p.layout!, rounds: [{ n: 1, issues: count, time: Date.now() }] } };
      }
      historyRef.current = createHistoryManager(p);
      setPlan(p);
      setAutoCount(Math.max(2, p.layout!.tables.length));
      setLoading(false);
    });
  }, [id]);

  // 防抖保存
  useEffect(() => {
    if (!plan) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => savePlan(plan), 500);
  }, [plan]);

  const dispatch = useCallback((command: Command) => {
    if (!historyRef.current) return;
    historyRef.current.push(historyRef.current.current(), command);
    setPlan(historyRef.current.current());
  }, []);

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

  const layout = plan?.layout ?? null;

  /** 拖动中的实时布局（未落库，用于即时重算问题） */
  const displayLayout: VenueLayout | null = useMemo(() => {
    if (!layout) return null;
    if (!dragId || !dragPos) return layout;
    return {
      ...layout,
      tables: layout.tables.map((t) => (t.id === dragId ? { ...t, x: dragPos.x, y: dragPos.y } : t)),
    };
  }, [layout, dragId, dragPos]);

  const issues = useMemo(() => (displayLayout ? checkLayout(displayLayout) : []), [displayLayout]);
  const issueTableIds = useMemo(() => new Set(issues.flatMap((i) => i.tableIds)), [issues]);

  const updateLayout = (fn: (l: VenueLayout) => VenueLayout) => {
    const p = planRef.current;
    if (!p?.layout) return;
    const next = fn(p.layout);
    // 场地尺寸/门宽变化后，把门位置收敛到墙边范围内
    const edge = next.hall.doorSide === 'top' || next.hall.doorSide === 'bottom' ? next.hall.width : next.hall.length;
    const half = next.hall.doorWidth / 2;
    const doorOffset = Math.max(half, Math.min(edge - half, next.hall.doorOffset));
    dispatch({ type: 'updateLayout', layout: { ...next, hall: { ...next.hall, doorOffset } } });
  };

  /* ---------- 拖动桌子 ---------- */
  const toMeters = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) / SCALE, y: (clientY - rect.top) / SCALE };
  };

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const l = planRef.current?.layout;
      if (!l || !svgRef.current) return;
      const m = toMeters(e.clientX, e.clientY);
      const pos = {
        x: Math.round(Math.max(0, Math.min(l.hall.width, m.x - dragOffset.current.dx)) * 20) / 20,
        y: Math.round(Math.max(0, Math.min(l.hall.length, m.y - dragOffset.current.dy)) * 20) / 20,
      };
      dragPosRef.current = pos;
      setDragPos(pos);
    };
    const onUp = () => {
      const l = planRef.current?.layout;
      const pos = dragPosRef.current;
      if (l && pos) {
        const next: VenueLayout = {
          ...l,
          tables: l.tables.map((t) => (t.id === dragId ? { ...t, x: pos.x, y: pos.y } : t)),
        };
        dispatch({ type: 'updateLayout', layout: next });
        // 挪完重新算：哪些邻桌被挤到、需要跟着挪
        setFollowMoves(suggestFollowMoves(next, dragId));
      }
      setDragId(null);
      setDragPos(null);
      dragPosRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragId, dispatch]);

  const startDrag = (e: React.PointerEvent, t: LayoutTable) => {
    e.stopPropagation();
    setSelectedId(t.id);
    setFollowMoves([]);
    const m = toMeters(e.clientX, e.clientY);
    dragOffset.current = { dx: m.x - t.x, dy: m.y - t.y };
    dragPosRef.current = { x: t.x, y: t.y };
    setDragPos({ x: t.x, y: t.y });
    setDragId(t.id);
  };

  /* ---------- 操作 ---------- */
  const applyFollowMoves = () => {
    if (!layout || followMoves.length === 0) return;
    updateLayout((l) => {
      const tables = l.tables.map((t) => {
        const m = followMoves.find((f) => f.tableId === t.id);
        return m ? { ...t, x: Math.round((t.x + m.dx) * 20) / 20, y: Math.round((t.y + m.dy) * 20) / 20 } : t;
      });
      const next = { ...l, tables };
      // 联动调整记为一轮，方便对比前后问题数
      const count = checkLayout(next).length;
      return { ...next, rounds: [...next.rounds, { n: next.rounds.length + 1, issues: count, time: Date.now() }] };
    });
    setFollowMoves([]);
  };

  const recordRound = () => {
    updateLayout((l) => {
      const count = checkLayout(l).length;
      const last = l.rounds[l.rounds.length - 1];
      if (last && last.issues === count) return l;
      return { ...l, rounds: [...l.rounds, { n: l.rounds.length + 1, issues: count, time: Date.now() }] };
    });
  };

  const handleAutoLayout = () => {
    if (!layout) return;
    if (layout.tables.length > 0 && !window.confirm('自动排布会重新摆放全部桌位，确定继续？')) return;
    updateLayout((l) => ({ ...l, tables: autoLayout(l, autoCount, autoDiameter) }));
    setFollowMoves([]);
    setSelectedId(null);
  };

  const addTable = (kind: LayoutTableKind) => {
    updateLayout((l) => {
      const n = l.tables.filter((t) => t.kind === 'normal').length;
      const label = kind === 'normal' ? `${n + 1}号桌` : KIND_LABELS[kind];
      const t: LayoutTable = {
        id: generateId(),
        label,
        kind,
        x: l.hall.width / 2,
        y: l.hall.length / 2,
        diameter: kind === 'reception' ? 1.4 : autoDiameter,
      };
      return { ...l, tables: [...l.tables, t] };
    });
  };

  const removeTable = (tableId: string) => {
    updateLayout((l) => ({ ...l, tables: l.tables.filter((t) => t.id !== tableId) }));
    setSelectedId(null);
  };

  if (loading) return <div className="plan-loading">加载中...</div>;
  if (!plan || !layout || !displayLayout) return <div className="plan-loading">方案不存在</div>;

  const hall = layout.hall;
  const doorZone = doorZoneRect(hall, layout.doorClearance);
  const headDiam = displayLayout.tables.find((t) => t.kind === 'head')?.diameter ?? DEFAULTS.diameter;
  const aisle = mainAisleRect(hall, layout.mainAisleWidth, layout.wallGap + headDiam);
  const selectedTable = layout.tables.find((t) => t.id === selectedId) ?? null;
  const rounds = layout.rounds;
  const lastRound = rounds[rounds.length - 1];
  const roundDelta = lastRound ? issues.length - lastRound.issues : 0;

  // 门在墙上的起止坐标（沿墙方向）
  const doorSpan = { a: hall.doorOffset - hall.doorWidth / 2, b: hall.doorOffset + hall.doorWidth / 2 };

  const gridLines = [];
  for (let x = 1; x < hall.width; x++) {
    gridLines.push(<line key={`gx${x}`} x1={x * SCALE} y1={0} x2={x * SCALE} y2={hall.length * SCALE} className="venue-grid" />);
  }
  for (let y = 1; y < hall.length; y++) {
    gridLines.push(<line key={`gy${y}`} x1={0} y1={y * SCALE} x2={hall.width * SCALE} y2={y * SCALE} className="venue-grid" />);
  }

  const gapIssues = issues.filter((i) => i.type === 'tableGap');

  return (
    <div className="plan-page">
      <header className="plan-header">
        <div className="header-left">
          <button className="btn-back" onClick={() => navigate(`/plan/${plan.id}`)}>返回座次</button>
          <span className="venue-title">场地布局 · {plan.name}</span>
        </div>
        <div className="header-actions">
          <button onClick={handleUndo} disabled={!historyRef.current?.canUndo()}>撤销</button>
          <button onClick={handleRedo} disabled={!historyRef.current?.canRedo()}>重做</button>
        </div>
      </header>
      <div className="stats-bar">
        <div className="stat-item">场地: <b>{hall.width}m × {hall.length}m</b></div>
        <div className="stat-item">桌数: <b>{layout.tables.length}</b></div>
        <div className="stat-item">
          当前不妥: <b style={{ color: issues.length > 0 ? '#c0392b' : '#27ae60' }}>{issues.length} 处</b>
        </div>
        {lastRound && (
          <div className="stat-item">
            第{lastRound.n}轮记录: <b>{lastRound.issues} 处</b>
            {roundDelta !== 0 && (
              <b style={{ color: roundDelta < 0 ? '#27ae60' : '#c0392b', marginLeft: 6 }}>
                {roundDelta < 0 ? `↓ 少 ${-roundDelta} 处` : `↑ 多 ${roundDelta} 处`}
              </b>
            )}
            {roundDelta === 0 && <span style={{ marginLeft: 6, color: '#888' }}>持平</span>}
          </div>
        )}
      </div>
      <div className="plan-body">
        {/* 左：场地设置 */}
        <div className="venue-settings">
          <h3>场地</h3>
          <div className="venue-field">
            <label>宽（米）</label>
            <NumberField value={hall.width} min={6} max={80} step={0.5} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, width: v } }))} />
          </div>
          <div className="venue-field">
            <label>长（米）</label>
            <NumberField value={hall.length} min={6} max={80} step={0.5} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, length: v } }))} />
          </div>
          <div className="venue-field">
            <label>门开在哪侧</label>
            <select
              value={hall.doorSide}
              onChange={(e) => {
                const doorSide = e.target.value as DoorSide;
                updateLayout((l) => {
                  const edge = doorSide === 'top' || doorSide === 'bottom' ? l.hall.width : l.hall.length;
                  return { ...l, hall: { ...l.hall, doorSide, doorOffset: Math.min(l.hall.doorOffset, edge / 2) } };
                });
              }}
            >
              {(Object.keys(DOOR_SIDE_LABELS) as DoorSide[]).map((s) => (
                <option key={s} value={s}>{DOOR_SIDE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="venue-field">
            <label>门宽（米）</label>
            <NumberField value={hall.doorWidth} min={0.8} max={8} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, doorWidth: v } }))} />
          </div>
          <div className="venue-field">
            <label>门距墙角的中心位置（米）</label>
            <NumberField
              value={hall.doorOffset}
              min={hall.doorWidth / 2}
              max={(hall.doorSide === 'top' || hall.doorSide === 'bottom' ? hall.width : hall.length) - hall.doorWidth / 2}
              step={0.5}
              onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, doorOffset: v } }))}
            />
          </div>

          <h3>柱子</h3>
          {hall.pillars.length === 0 && <p className="venue-hint">场地无柱可跳过</p>}
          {hall.pillars.length > 0 && (
            <div className="venue-pillar venue-pillar-head">
              <span>横向 x</span>
              <span>纵向 y</span>
              <span>边长</span>
              <span />
            </div>
          )}
          {hall.pillars.map((p) => (
            <div key={p.id} className="venue-pillar">
              <NumberField value={p.x} min={0} max={hall.width} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, pillars: l.hall.pillars.map((pp) => (pp.id === p.id ? { ...pp, x: v } : pp)) } }))} />
              <NumberField value={p.y} min={0} max={hall.length} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, pillars: l.hall.pillars.map((pp) => (pp.id === p.id ? { ...pp, y: v } : pp)) } }))} />
              <NumberField value={p.size} min={0.3} max={2} onCommit={(v) => updateLayout((l) => ({ ...l, hall: { ...l.hall, pillars: l.hall.pillars.map((pp) => (pp.id === p.id ? { ...pp, size: v } : pp)) } }))} />
              <button onClick={() => updateLayout((l) => ({ ...l, hall: { ...l.hall, pillars: l.hall.pillars.filter((pp) => pp.id !== p.id) } }))}>×</button>
            </div>
          ))}
          <button
            className="venue-add-btn"
            onClick={() =>
              updateLayout((l) => ({
                ...l,
                hall: {
                  ...l.hall,
                  pillars: [...l.hall.pillars, { id: generateId(), x: l.hall.width / 2, y: l.hall.length / 2, size: DEFAULTS.pillarSize }],
                },
              }))
            }
          >
            + 添加柱子（场中央，可再改）
          </button>

          <h3>间距标准（米）</h3>
          <div className="venue-field">
            <label>桌边净距 ≥</label>
            <NumberField value={layout.minTableGap} min={0.5} max={4} onCommit={(v) => updateLayout((l) => ({ ...l, minTableGap: v }))} />
          </div>
          <div className="venue-field">
            <label>主通道宽 ≥</label>
            <NumberField value={layout.mainAisleWidth} min={1} max={5} onCommit={(v) => updateLayout((l) => ({ ...l, mainAisleWidth: v }))} />
          </div>
          <div className="venue-field">
            <label>沿墙过道 ≥</label>
            <NumberField value={layout.wallGap} min={0.3} max={3} onCommit={(v) => updateLayout((l) => ({ ...l, wallGap: v }))} />
          </div>
          <div className="venue-field">
            <label>门口净空 ≥</label>
            <NumberField value={layout.doorClearance} min={1} max={5} onCommit={(v) => updateLayout((l) => ({ ...l, doorClearance: v }))} />
          </div>

          <h3>自动排布</h3>
          <div className="venue-field">
            <label>桌数（含主桌/接待桌）</label>
            <NumberField value={autoCount} min={2} max={60} step={1} onCommit={setAutoCount} />
          </div>
          <div className="venue-field">
            <label>桌直径（米）</label>
            <NumberField value={autoDiameter} min={1.2} max={2.6} onCommit={setAutoDiameter} />
          </div>
          <button className="venue-primary-btn" onClick={handleAutoLayout}>按场地自动排布</button>
          <div className="venue-add-table">
            <button onClick={() => addTable('normal')}>+ 普通桌</button>
            <button onClick={() => addTable('head')}>+ 主桌</button>
            <button onClick={() => addTable('reception')}>+ 接待桌</button>
          </div>
        </div>

        {/* 中：平面图 */}
        <div className="venue-canvas-wrap">
          <svg
            ref={svgRef}
            width={hall.width * SCALE}
            height={hall.length * SCALE}
            className="venue-svg"
            onClick={() => {
              setSelectedId(null);
              setActiveIssueId(null);
              setHighlightIds([]);
            }}
          >
            <rect x={0} y={0} width={hall.width * SCALE} height={hall.length * SCALE} fill="#fff" />
            {gridLines}

            {/* 主通道 */}
            <rect x={aisle.x * SCALE} y={aisle.y * SCALE} width={aisle.w * SCALE} height={aisle.h * SCALE} className="venue-aisle" />
            {/* 门口净空 */}
            <rect x={doorZone.x * SCALE} y={doorZone.y * SCALE} width={doorZone.w * SCALE} height={doorZone.h * SCALE} className="venue-doorzone" />

            {/* 外墙 */}
            <rect x={0} y={0} width={hall.width * SCALE} height={hall.length * SCALE} fill="none" className="venue-wall" />
            {/* 门：在墙上开缺口 */}
            {hall.doorSide === 'bottom' && (
              <line x1={doorSpan.a * SCALE} y1={hall.length * SCALE} x2={doorSpan.b * SCALE} y2={hall.length * SCALE} className="venue-door" />
            )}
            {hall.doorSide === 'top' && (
              <line x1={doorSpan.a * SCALE} y1={0} x2={doorSpan.b * SCALE} y2={0} className="venue-door" />
            )}
            {hall.doorSide === 'left' && (
              <line x1={0} y1={doorSpan.a * SCALE} x2={0} y2={doorSpan.b * SCALE} className="venue-door" />
            )}
            {hall.doorSide === 'right' && (
              <line x1={hall.width * SCALE} y1={doorSpan.a * SCALE} x2={hall.width * SCALE} y2={doorSpan.b * SCALE} className="venue-door" />
            )}
            <text
              x={hall.doorSide === 'left' ? 10 : hall.doorSide === 'right' ? hall.width * SCALE - 10 : hall.doorOffset * SCALE}
              y={hall.doorSide === 'top' ? 14 : hall.doorSide === 'bottom' ? hall.length * SCALE - 6 : hall.doorOffset * SCALE}
              className="venue-door-label"
              textAnchor={hall.doorSide === 'right' ? 'end' : 'middle'}
            >
              门
            </text>

            {/* 柱子 */}
            {hall.pillars.map((p) => (
              <g key={p.id}>
                <rect
                  x={(p.x - p.size / 2) * SCALE}
                  y={(p.y - p.size / 2) * SCALE}
                  width={p.size * SCALE}
                  height={p.size * SCALE}
                  className="venue-pillar-shape"
                />
                <text x={p.x * SCALE} y={(p.y - p.size / 2) * SCALE - 4} textAnchor="middle" className="venue-pillar-label">柱</text>
              </g>
            ))}

            {/* 桌距问题连线 */}
            {gapIssues.map((issue) => {
              const [a, b] = issue.tableIds.map((tid) => displayLayout.tables.find((t) => t.id === tid));
              if (!a || !b) return null;
              const mx = ((a.x + b.x) / 2) * SCALE;
              const my = ((a.y + b.y) / 2) * SCALE;
              return (
                <g key={issue.id} className="venue-gapline">
                  <line x1={a.x * SCALE} y1={a.y * SCALE} x2={b.x * SCALE} y2={b.y * SCALE} />
                  <text x={mx} y={my}>{Math.max(0, issue.actual).toFixed(1)}m</text>
                </g>
              );
            })}

            {/* 联动调整的目标位置（虚线幻影） */}
            {followMoves.map((m) => {
              const t = layout.tables.find((tt) => tt.id === m.tableId);
              if (!t) return null;
              return (
                <g key={`ghost-${m.tableId}`}>
                  <circle cx={(t.x + m.dx) * SCALE} cy={(t.y + m.dy) * SCALE} r={(t.diameter / 2) * SCALE} className="venue-ghost" />
                  <line x1={t.x * SCALE} y1={t.y * SCALE} x2={(t.x + m.dx) * SCALE} y2={(t.y + m.dy) * SCALE} className="venue-ghost-arrow" />
                </g>
              );
            })}

            {/* 桌子 */}
            {displayLayout.tables.map((t) => {
              const classes = [
                'venue-table',
                t.kind,
                issueTableIds.has(t.id) ? 'has-issue' : '',
                highlightIds.includes(t.id) ? 'highlight' : '',
                selectedId === t.id ? 'selected' : '',
              ].join(' ');
              return (
                <g
                  key={t.id}
                  className={classes}
                  transform={`translate(${t.x * SCALE}, ${t.y * SCALE})`}
                  onPointerDown={(e) => startDrag(e, t)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <circle r={(t.diameter / 2) * SCALE} />
                  <text textAnchor="middle" dy="-1" className="venue-table-label">{t.label}</text>
                  <text textAnchor="middle" dy="13" className="venue-table-sub">{t.diameter.toFixed(1)}m</text>
                </g>
              );
            })}
          </svg>
          <p className="venue-scale-hint">一格 = 1 米 · 金色虚带 = 主通道 · 红色虚框 = 门口净空 · 拖动圆桌可调整位置</p>
        </div>

        {/* 右：问题与轮次 */}
        <div className="venue-side">
          {followMoves.length > 0 && (
            <div className="venue-follow">
              <h4>跟着挪这几桌</h4>
              {followMoves.map((m) => (
                <div key={m.tableId} className="venue-follow-item">
                  <b>「{m.label}」</b>
                  <span>{m.reason}</span>
                  <span className="venue-follow-delta">
                    {m.dx !== 0 && `左右 ${m.dx > 0 ? '+' : ''}${m.dx.toFixed(1)}m `}
                    {m.dy !== 0 && `上下 ${m.dy > 0 ? '+' : ''}${m.dy.toFixed(1)}m`}
                  </span>
                </div>
              ))}
              <div className="venue-follow-actions">
                <button className="venue-primary-btn" onClick={applyFollowMoves}>一键跟随调整</button>
                <button onClick={() => setFollowMoves([])}>忽略</button>
              </div>
            </div>
          )}

          <div className="venue-rounds">
            <div className="venue-rounds-head">
              <h4>调整轮次</h4>
              <button onClick={recordRound}>记录本轮</button>
            </div>
            {rounds.length === 0 && <p className="venue-hint">调整后点「记录本轮」留下对比基线</p>}
            <div className="venue-round-list">
              {rounds.map((r, i) => {
                const prev = rounds[i - 1];
                const delta = prev ? r.issues - prev.issues : 0;
                return (
                  <span key={r.n} className="venue-round-chip">
                    第{r.n}轮 {r.issues}处
                    {prev && delta !== 0 && (
                      <em className={delta < 0 ? 'down' : 'up'}>{delta < 0 ? `↓${-delta}` : `↑${delta}`}</em>
                    )}
                  </span>
                );
              })}
              <span className="venue-round-chip current">当前 {issues.length}处</span>
            </div>
          </div>

          {selectedTable && (
            <div className="venue-selected">
              <h4>选中：{selectedTable.label}</h4>
              <div className="venue-field">
                <label>桌名</label>
                <input
                  value={selectedTable.label}
                  onChange={(e) =>
                    updateLayout((l) => ({ ...l, tables: l.tables.map((t) => (t.id === selectedTable.id ? { ...t, label: e.target.value } : t)) }))
                  }
                />
              </div>
              <div className="venue-field">
                <label>类型</label>
                <select
                  value={selectedTable.kind}
                  onChange={(e) =>
                    updateLayout((l) => ({
                      ...l,
                      tables: l.tables.map((t) => (t.id === selectedTable.id ? { ...t, kind: e.target.value as LayoutTableKind } : t)),
                    }))
                  }
                >
                  {(Object.keys(KIND_LABELS) as LayoutTableKind[]).map((k) => (
                    <option key={k} value={k}>{KIND_LABELS[k]}</option>
                  ))}
                </select>
              </div>
              <div className="venue-field">
                <label>直径（米）</label>
                <NumberField
                  value={selectedTable.diameter}
                  min={0.8}
                  max={3}
                  onCommit={(v) => updateLayout((l) => ({ ...l, tables: l.tables.map((t) => (t.id === selectedTable.id ? { ...t, diameter: v } : t)) }))}
                />
              </div>
              <button className="venue-delete-btn" onClick={() => removeTable(selectedTable.id)}>删除此桌</button>
            </div>
          )}

          <div className="venue-issues">
            <h4>问题清单（{issues.length}）</h4>
            {issues.length === 0 && <p className="venue-ok">布局妥当了：桌距、过道、门口都留够了 ✓</p>}
            {issues.map((issue) => (
              <div
                key={issue.id}
                className={`venue-issue ${activeIssueId === issue.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveIssueId(issue.id);
                  setHighlightIds(issue.tableIds);
                }}
              >
                <div className="venue-issue-head">
                  <span className={`venue-issue-tag t-${issue.type}`}>{ISSUE_TYPE_LABELS[issue.type]}</span>
                  <span>{issue.message}</span>
                </div>
                <div className="venue-issue-sug">建议：{issue.suggestion}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
