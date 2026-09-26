import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, lineBraille, makeRule, outputText, pinLine, updateRuleInSet } from './braille';
import { createInitialProject } from './sample';
import type { HistoryState, ProofIssue, ProjectState, TextbookLine, VersionSnapshot } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

interface LineDiff {
  line: TextbookLine;
  index: number;
  before: string;
  after: string;
}

interface PendingRuleChange {
  title: string;
  detail: string;
  ruleSummary: string;
  apply: (state: ProjectState) => ProjectState;
  draft?: Map<string, { source: string; output: string }>;
}

function diffLines(before: ProjectState, after: ProjectState): LineDiff[] {
  const diffs: LineDiff[] = [];
  after.lines.forEach((line, index) => {
    const beforeLine = before.lines.find((item) => item.id === line.id);
    if (!beforeLine) return;
    if (line.override || beforeLine.override) return;
    const afterText = lineBraille(line);
    const beforeText = lineBraille(beforeLine);
    if (afterText !== beforeText) diffs.push({ line, index, before: beforeText, after: afterText });
  });
  return diffs;
}

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
      return analyzeProject(parsed);
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onToggleSuspicious,
  onPreviewChange,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onToggleSuspicious: (ruleId: string) => void;
  onPreviewChange: (change: PendingRuleChange) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const [drafts, setDrafts] = useState<Map<string, { source: string; output: string }>>(new Map());
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  const setDraft = (ruleId: string, patch: Partial<{ source: string; output: string }>) => {
    setDrafts((current) => {
      const rule = active.rules.find((item) => item.id === ruleId);
      if (!rule) return current;
      const base = current.get(ruleId) ?? { source: rule.source, output: rule.output };
      const next = { ...base, ...patch };
      const map = new Map(current);
      if (next.source === rule.source && next.output === rule.output) map.delete(ruleId);
      else map.set(ruleId, next);
      return map;
    });
  };

  const previewDrafts = () => {
    if (drafts.size === 0) return;
    const entries = [...drafts.entries()];
    const changed = entries.filter(([id, draft]) => {
      const rule = active.rules.find((item) => item.id === id);
      return rule && (rule.source !== draft.source || rule.output !== draft.output);
    });
    if (changed.length === 0) return;
    const detail = changed
      .map(([id, draft]) => {
        const rule = active.rules.find((item) => item.id === id)!;
        return `“${rule.source}” → “${draft.source || '（空）'}”，盲文 “${rule.output}” → “${draft.output || '（空）'}”`;
      })
      .join('；');
    onPreviewChange({
      title: `修改 ${changed.length} 条规则`,
      detail,
      ruleSummary: detail,
      draft: new Map(changed),
      apply: (current) => analyzeProject({
        ...current,
        ruleSets: current.ruleSets.map((set) => set.id === active.id
          ? { ...set, rules: set.rules.map((rule) => { const draft = changed.find(([id]) => id === rule.id); return draft ? { ...rule, source: draft[1].source, output: draft[1].output } : rule; }) }
          : set),
      }),
    });
  };

  const previewToggle = (ruleId: string) => {
    const rule = active.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    const label = rule.enabled ? '停用' : '启用';
    onPreviewChange({
      title: `${label}规则 “${rule.source}”`,
      detail: `${label}后，使用该规则转录的行会按新结果重新生成。`,
      ruleSummary: `${label}规则 “${rule.source}”`,
      apply: (current) => analyzeProject({
        ...current,
        ruleSets: current.ruleSets.map((set) => set.id === active.id ? updateRuleInSet(set, ruleId, { enabled: !rule.enabled }) : set),
      }),
    });
  };

  const previewContractions = () => {
    const label = active.contractions ? '关闭' : '开启';
    onPreviewChange({
      title: `${label}缩写规则`,
      detail: `${label}缩写后，所有缩写匹配都会重新转录。`,
      ruleSummary: `${label}缩写规则`,
      apply: (current) => analyzeProject({
        ...current,
        ruleSets: current.ruleSets.map((set) => set.id === active.id ? { ...set, contractions: !active.contractions } : set),
      }),
    });
  };

  const previewAddRule = () => {
    const source = newSource.trim();
    const output = newOutput.trim();
    if (!source || !output) return;
    onPreviewChange({
      title: `新增规则 “${source}”`,
      detail: `“${source}” → “${output}”${suspicious ? '（标记为可疑）' : ''}`,
      ruleSummary: `新增规则 “${source}” → “${output}”`,
      apply: (current) => analyzeProject({
        ...current,
        ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
      }),
    });
    setNewSource('');
    setNewOutput('');
  };

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行（已定稿的行除外）">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={previewContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="改动会先预览受影响行，再决定整份应用或只固定当前行">
        <div class="rule-list">
          {visibleRules.map((rule) => {
            const draft = drafts.get(rule.id);
            return (
              <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''} ${draft ? 'draft' : ''}`} key={rule.id}>
                <md-checkbox checked={rule.enabled} onInput={() => previewToggle(rule.id)} aria-label={`启用 ${rule.source}`} />
                <md-outlined-text-field
                  class="rule-source"
                  value={draft?.source ?? rule.source}
                  label="原文"
                  onInput={(event: any) => setDraft(rule.id, { source: event.currentTarget.value })}
                />
                <md-outlined-text-field
                  class="rule-output"
                  value={draft?.output ?? rule.output}
                  label="盲文"
                  onInput={(event: any) => setDraft(rule.id, { output: event.currentTarget.value })}
                />
                <md-icon-button
                  class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                  aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                  title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                  onClick={() => onToggleSuspicious(rule.id)}
                >
                  {rule.suspicious ? '!' : '○'}
                </md-icon-button>
                {draft && (
                  <div class="rule-draft-bar">
                    <span>未应用</span>
                    <md-text-button onClick={() => setDraft(rule.id, { source: rule.source, output: rule.output })}>还原</md-text-button>
                    <md-filled-tonal-button onClick={previewDrafts}>预览改动</md-filled-tonal-button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="新增规则" subtitle="添加前会先预览受影响的行">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button disabled={!newSource.trim() || !newOutput.trim()} onClick={previewAddRule}>
            预览并添加
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
  onClearOverride,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
  onClearOverride: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);
  const pinned = Boolean(line.override && line.override.source === line.source);

  return (
    <article class={`line-card ${selected ? 'selected' : ''} ${pinned ? 'pinned' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        {pinned ? (
          <span class="line-status pinned" title="老师定稿：重新检查也会保留；改动原文即失效" />
        ) : (
          <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
        )}
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        {pinned && (
          <div class="override-bar">
            <span class="override-badge">老师定稿</span>
            <span class="override-meta">单独处理 · 重新检查和切换规则集都会保留{line.override ? `（${formatTime(line.override.createdAt)}）` : ''}</span>
            <md-text-button onClick={(event: MouseEvent) => { event.stopPropagation(); onClearOverride(); }}>改回按规则生成</md-text-button>
          </div>
        )}
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : token.override ? (
              <span class="braille-token override" title={`老师定稿 → ${token.braille}`} key={token.id}>
                <i>老师定稿</i>
                <span>{token.braille}</span>
              </span>
            ) : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
  onClearOverride,
}: {
  state: ProjectState;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
  onClearOverride: (id: string) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
            onClearOverride={() => onClearOverride(line.id)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onPreviewChange }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onPreviewChange: (change: PendingRuleChange) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];

  const previewDelete = (ruleId: string) => {
    const rule = active.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    onPreviewChange({
      title: `删除规则 “${rule.source || '数字符'}”`,
      detail: `删除后，原先由该规则转录的字符将按剩余规则重新生成。`,
      ruleSummary: `删除规则 “${rule.source || '数字符'}”`,
      apply: (current) => analyzeProject({
        ...current,
        ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((item) => item.id !== ruleId) } : set),
      }),
    });
  };

  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => previewDelete(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleChangeDialog({
  state,
  pending,
  selectedLineId,
  onApplyAll,
  onPinLine,
  onCancel,
}: {
  state: ProjectState;
  pending: PendingRuleChange;
  selectedLineId: string;
  onApplyAll: () => void;
  onPinLine: (lineId: string) => void;
  onCancel: () => void;
}) {
  const projected = useMemo(() => pending.apply(cloneState(state)), [state, pending]);
  const diffs = useMemo(() => diffLines(state, projected), [state, projected]);
  const pinnedCount = state.lines.filter((line) => line.override && line.override.source === line.source).length;
  const selectedDiff = diffs.find((item) => item.line.id === selectedLineId);
  const selectedIndex = state.lines.findIndex((line) => line.id === selectedLineId) + 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div class="dialog-backdrop" onClick={onCancel}>
      <div class="change-dialog" role="dialog" aria-modal="true" aria-label="规则改动预览" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <header class="change-dialog-head">
          <div>
            <span class="eyebrow">规则改动预览</span>
            <h2>{pending.title}</h2>
            <p>{pending.detail}</p>
          </div>
          <md-icon-button aria-label="关闭预览" title="放弃改动 (Esc)" onClick={onCancel}>×</md-icon-button>
        </header>

        <div class="change-dialog-summary">
          <span class="diff-count-badge">{diffs.length} 行会变化</span>
          {pinnedCount > 0 && <span class="pinned-count-badge">{pinnedCount} 行已定稿，保持老师结果</span>}
          {diffs.length === 0 && <span class="no-diff-hint">当前没有任何行的盲文结果会改变，可以直接整份应用。</span>}
        </div>

        <div class="change-dialog-body scroll-pane">
          {diffs.length === 0 && <div class="empty-state compact"><strong>没有受影响的行</strong><p>规则已改，但现有课文转录结果不变。</p></div>}
          {diffs.map((item) => (
            <div class={`diff-row ${item.line.id === selectedLineId ? 'current' : ''}`} key={item.line.id}>
              <div class="diff-line-meta">
                <strong>第 {item.index + 1} 行</strong>
                {item.line.id === selectedLineId && <span class="current-line-tag">当前行</span>}
                <span class="diff-source" title={item.line.source}>{item.line.source || '（空行）'}</span>
              </div>
              <div class="diff-braille before"><span>改前</span><p>{item.before || '—'}</p></div>
              <div class="diff-arrow" aria-hidden="true">↓</div>
              <div class="diff-braille after"><span>改后</span><p>{item.after || '—'}</p></div>
            </div>
          ))}
        </div>

        <footer class="change-dialog-foot">
          <md-text-button onClick={onCancel}>放弃改动</md-text-button>
          <div class="foot-right">
            <md-filled-tonal-button
              disabled={!selectedDiff}
              title={selectedDiff ? '放弃规则修改，仅把当前行固定为改前的结果' : '当前行不受这次改动影响'}
              onClick={() => selectedDiff && onPinLine(selectedDiff.line.id)}
            >
              {selectedDiff ? `只固定第 ${selectedIndex} 行` : '当前行无变化'}
            </md-filled-tonal-button>
            <md-filled-button onClick={onApplyAll}>整份一起改（{diffs.length} 行）</md-filled-button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const [pendingChange, setPendingChange] = useState<PendingRuleChange | null>(null);
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const pinnedCount = state.lines.filter((line) => line.override && line.override.source === line.source).length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const closePendingChange = () => setPendingChange(null);

  const applyPendingChange = () => {
    const change = pendingChange;
    if (!change) return;
    commit(`整份应用规则改动：${change.title}`, (current) => change.apply(current));
    setPendingChange(null);
  };

  const pinLineFromPending = (lineId: string) => {
    const change = pendingChange;
    if (!change) return;
    commit('只固定当前行结果', (current) => ({
      ...current,
      lines: current.lines.map((line) => line.id === lineId ? pinLine(line, change.ruleSummary) : line),
      updatedAt: new Date().toISOString(),
    }));
    setPendingChange(null);
  };

  const clearOverride = (lineId: string) => {
    commit('改回按规则生成', (current) => analyzeProject({
      ...current,
      lines: current.lines.map((line) => line.id === lineId ? { ...line, override: undefined } : line),
    }));
  };

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <button
          class="status-stat pinned-stat"
          disabled={pinnedCount === 0}
          title={pinnedCount > 0 ? '定位到第一行单独定稿的课文' : '还没有单独定稿的行'}
          onClick={() => {
            const first = state.lines.find((line) => line.override && line.override.source === line.source);
            if (first) selectLine(first.id, true);
          }}
        >
          <strong>{pinnedCount}</strong><span>单独定稿行</span>
        </button>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onToggleSuspicious={(ruleId) => updateRule(ruleId, { suspicious: !(activeRuleSet.rules.find((rule) => rule.id === ruleId)?.suspicious ?? false) })}
          onPreviewChange={setPendingChange}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
          onClearOverride={clearOverride}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onPreviewChange={setPendingChange} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>

      {pendingChange && (
        <RuleChangeDialog
          state={state}
          pending={pendingChange}
          selectedLineId={state.selectedLineId}
          onApplyAll={applyPendingChange}
          onPinLine={pinLineFromPending}
          onCancel={closePendingChange}
        />
      )}
    </div>
  );
}
